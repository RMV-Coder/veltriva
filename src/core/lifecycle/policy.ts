// The lifecycle policy (assessment §4.7): a pure function from facts to actions, each naming the
// rule that produced it, so every automatic change can be explained. No Electron, no timers.
//
// Rules, with the Balanced values:
//   1. discard-hidden: a live (or frozen) tab hidden for 60 min or more of wall-clock time,
//      unless a protection blocks discard. Pinned tabs only if the preset discards them.
//   2. shelve-beyond-cap: an unpinned strip tab outside the 10 most recently used unpinned tabs
//      AND unused for 2 engaged hours or more. A tab used recently never moves, even over the cap.
//   3. archive-dormant: a Sleeping tab unused for 3 active days or more, when auto-archive is on.
//      It is discarded first in the same operation; a blocked discard skips the archive.
//   4. pressure-discard: under memory pressure, hidden unprotected tabs, least recently used
//      first, a few per evaluation. Critical pressure overrides soft protections only. Pressure
//      never shelves or archives: what the user sees never changes for resource reasons.
//   5. freeze-hidden (experiment, off): a live tab hidden for 10 min or more.
// The selected tab is never planned, nor a tab with a lifecycle operation under way. A discard or
// a freeze also needs a web page that isn't loading. A shelve moves the tab only, so a page that
// loads or isn't a web page may go to Sleeping; an archive waits for a load to end (§4.10).
// A recent interaction is a soft protection (§4.10).

import { blockingProtection, protectionFor } from './protections';
import type { LifecycleActionKind, Protection } from './protections';
import type { RuntimeState } from './runtime-machine';

export const PRESETS = ['gentle', 'balanced', 'aggressive'] as const;
export type Preset = (typeof PRESETS)[number];

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** What a preset sets (§4.7's table). These are hypotheses, tuned by dogfooding (§4.13). */
export interface PresetValues {
  /** Wall-clock hidden time before a live tab is discarded. */
  readonly discardAfterMs: number;
  /** Unpinned tabs kept in the strip: the most recently used. */
  readonly stripCap: number;
  /** Engaged time unused before a tab beyond the cap moves to Sleeping. */
  readonly shelveAfterEngagedMs: number;
  /** Active days unused before a Sleeping tab is archived. */
  readonly archiveAfterActiveDays: number;
  /** A tab interacted with within this (wall clock) is softly protected. */
  readonly interactionGuardMs: number;
  /** Whether pinned tabs may be discarded. */
  readonly discardPinned: boolean;
}

export const PRESET_VALUES: Readonly<Record<Preset, PresetValues>> = {
  gentle: {
    discardAfterMs: 4 * HOUR,
    stripCap: 15,
    shelveAfterEngagedMs: 8 * HOUR,
    archiveAfterActiveDays: 14,
    interactionGuardMs: 30 * MINUTE,
    discardPinned: false,
  },
  balanced: {
    discardAfterMs: 60 * MINUTE,
    stripCap: 10,
    shelveAfterEngagedMs: 2 * HOUR,
    archiveAfterActiveDays: 3,
    interactionGuardMs: 15 * MINUTE,
    discardPinned: false,
  },
  aggressive: {
    discardAfterMs: 15 * MINUTE,
    stripCap: 6,
    shelveAfterEngagedMs: 30 * MINUTE,
    archiveAfterActiveDays: 1,
    interactionGuardMs: 5 * MINUTE,
    discardPinned: true,
  },
};

/** The settings the policy runs on: a preset's values, possibly overridden, and the switches. */
export interface LifecycleSettings extends PresetValues {
  readonly preset: Preset;
  readonly autoArchive: boolean;
  /** The freezing experiment (§4.3), off by default. */
  readonly freeze: boolean;
  /** Hidden time before a live tab is frozen, when freezing is on. */
  readonly freezeAfterMs: number;
  /** "Pause automation": nothing is planned. */
  readonly paused: boolean;
}

export const FREEZE_AFTER_MS = 10 * MINUTE;

export const DEFAULT_LIFECYCLE_SETTINGS: LifecycleSettings = {
  preset: 'balanced',
  ...PRESET_VALUES.balanced,
  autoArchive: true,
  freeze: false,
  freezeAfterMs: FREEZE_AFTER_MS,
  paused: false,
};

/** The settings document's lifecycle section (src/shared/contracts/settings.ts), as plain data. */
export interface LifecycleSettingsInput {
  readonly preset: Preset;
  readonly autoArchive: boolean;
  readonly freeze: boolean;
  readonly paused: boolean;
  /** Each one replaces the preset's value; an absent (or undefined) one doesn't. */
  readonly overrides: { readonly [K in keyof PresetValues]?: PresetValues[K] | undefined };
}

/** The preset's values with the overrides applied: what the policy runs on. */
export function resolveLifecycleSettings(input: LifecycleSettingsInput): LifecycleSettings {
  const values = PRESET_VALUES[input.preset];
  const pick = <K extends keyof PresetValues>(key: K): PresetValues[K] =>
    input.overrides[key] ?? values[key];
  return {
    preset: input.preset,
    discardAfterMs: pick('discardAfterMs'),
    stripCap: pick('stripCap'),
    shelveAfterEngagedMs: pick('shelveAfterEngagedMs'),
    archiveAfterActiveDays: pick('archiveAfterActiveDays'),
    interactionGuardMs: pick('interactionGuardMs'),
    discardPinned: pick('discardPinned'),
    autoArchive: input.autoArchive,
    freeze: input.freeze,
    freezeAfterMs: FREEZE_AFTER_MS,
    paused: input.paused,
  };
}

export type MemoryPressure = 'none' | 'moderate' | 'critical';

/**
 * Under pressure, a tab must have been hidden at least this long (so the tab just left isn't
 * reloaded when the user comes back to it), and at most this many are discarded per evaluation.
 */
export const PRESSURE_RULES: Readonly<
  Record<Exclude<MemoryPressure, 'none'>, { readonly minHiddenMs: number; readonly budget: number }>
> = {
  moderate: { minHiddenMs: 15 * MINUTE, budget: 1 },
  critical: { minHiddenMs: 2 * MINUTE, budget: 3 },
};

/** What the policy knows about one tab. */
export interface TabFacts {
  readonly id: string;
  readonly placement: 'strip' | 'shelf';
  readonly runtime: RuntimeState;
  readonly pinned: boolean;
  readonly selected: boolean;
  /** It shows a web page (not a new-tab or error page). */
  readonly webPage: boolean;
  readonly loading: boolean;
  /** A lifecycle operation is queued or running on it. */
  readonly busy: boolean;
  /** Its runtime epoch: a decision is void once it changes (I5). */
  readonly epoch: number;
  /** Wall-clock time it was last hidden; null while it is shown (selected). */
  readonly hiddenSince: number | null;
  /** Wall-clock time of its last use (selection). */
  readonly lastUsedAt: number;
  /** The engagement clock at its last use (§4.6). */
  readonly lastUsedEngaged: number;
  /** The active day of its last use (§4.6). */
  readonly lastUsedActiveDay: number;
  /** Wall-clock time of the user's last input in it, if any. */
  readonly lastInteractionAt: number | null;
  /** What keeps it as it is, from the protection monitor and the discard's lessons. */
  readonly protections: readonly Protection[];
}

export interface LifecycleClock {
  readonly wallNow: number;
  readonly engagedNow: number;
  readonly activeDay: number;
}

export const LIFECYCLE_RULES = [
  'discard-hidden',
  'shelve-beyond-cap',
  'archive-dormant',
  'pressure-discard',
  'freeze-hidden',
] as const;
export type LifecycleRule = (typeof LIFECYCLE_RULES)[number];

export interface LifecycleAction {
  readonly tabId: string;
  readonly kind: LifecycleActionKind;
  readonly rule: LifecycleRule;
  /** The tab's epoch when this was decided: carried into the request (I5). */
  readonly epoch: number;
  /** Critical pressure: soft protections don't count. */
  readonly overrideSoft: boolean;
}

export interface PlanInput {
  readonly tabs: readonly TabFacts[];
  readonly settings: LifecycleSettings;
  readonly clock: LifecycleClock;
  readonly pressure: MemoryPressure;
}

/** The protections of a tab for the policy: its own plus the recent-interaction guard. */
function protectionsOf(tab: TabFacts, settings: LifecycleSettings, wallNow: number): Protection[] {
  const recent =
    tab.lastInteractionAt !== null &&
    wallNow >= tab.lastInteractionAt &&
    wallNow - tab.lastInteractionAt < settings.interactionGuardMs;
  return recent ? [...tab.protections, protectionFor('recent-interaction')] : [...tab.protections];
}

/** A tab automation may consider at all. */
function actionable(tab: TabFacts): boolean {
  return !tab.selected && tab.webPage && !tab.loading && !tab.busy;
}

function hiddenFor(tab: TabFacts, wallNow: number): number {
  return tab.hiddenSince === null ? 0 : Math.max(0, wallNow - tab.hiddenSince);
}

function holdsRenderer(tab: TabFacts): boolean {
  return tab.runtime === 'live' || tab.runtime === 'frozen';
}

/**
 * The actions the rules call for now, in the order to carry them out: pressure discards (least
 * recently used first), then discards (longest hidden first), freezes, shelves (least recently
 * used first) and archives (longest unused first). A tab gets at most one action.
 */
export function planLifecycle(input: PlanInput): LifecycleAction[] {
  const { tabs, settings, clock, pressure } = input;
  if (settings.paused) {
    return [];
  }
  const planned = new Set<string>();
  const actions: LifecycleAction[] = [];
  const add = (tab: TabFacts, kind: LifecycleActionKind, rule: LifecycleRule, override = false) => {
    planned.add(tab.id);
    actions.push({ tabId: tab.id, kind, rule, epoch: tab.epoch, overrideSoft: override });
  };
  const protections = new Map(
    tabs.map((tab) => [tab.id, protectionsOf(tab, settings, clock.wallNow)]),
  );
  const blocked = (tab: TabFacts, kind: LifecycleActionKind, overrideSoft = false): boolean =>
    blockingProtection(protections.get(tab.id) ?? [], kind, { overrideSoft }) !== null;
  const mayDiscard = (tab: TabFacts): boolean =>
    actionable(tab) && holdsRenderer(tab) && (!tab.pinned || settings.discardPinned);

  // 4. Pressure: hidden, unprotected (soft ones count unless critical), least recently used first.
  if (pressure !== 'none') {
    const rules = PRESSURE_RULES[pressure];
    const critical = pressure === 'critical';
    const candidates = tabs
      .filter(
        (tab) =>
          mayDiscard(tab) &&
          hiddenFor(tab, clock.wallNow) >= rules.minHiddenMs &&
          !blocked(tab, 'discard', critical),
      )
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.id.localeCompare(b.id));
    for (const tab of candidates.slice(0, rules.budget)) {
      add(tab, 'discard', 'pressure-discard', critical);
    }
  }

  // 1. Discard what has been hidden long enough, longest hidden first.
  tabs
    .filter(
      (tab) =>
        !planned.has(tab.id) &&
        mayDiscard(tab) &&
        tab.hiddenSince !== null &&
        hiddenFor(tab, clock.wallNow) >= settings.discardAfterMs &&
        !blocked(tab, 'discard'),
    )
    .sort((a, b) => (a.hiddenSince ?? 0) - (b.hiddenSince ?? 0) || a.id.localeCompare(b.id))
    .forEach((tab) => {
      add(tab, 'discard', 'discard-hidden');
    });

  // 5. Freeze (the experiment) what has been hidden a while and isn't being discarded.
  if (settings.freeze) {
    tabs
      .filter(
        (tab) =>
          !planned.has(tab.id) &&
          actionable(tab) &&
          tab.runtime === 'live' &&
          tab.hiddenSince !== null &&
          hiddenFor(tab, clock.wallNow) >= settings.freezeAfterMs &&
          !blocked(tab, 'freeze'),
      )
      .sort((a, b) => (a.hiddenSince ?? 0) - (b.hiddenSince ?? 0) || a.id.localeCompare(b.id))
      .forEach((tab) => {
        add(tab, 'freeze', 'freeze-hidden');
      });
  }

  // 2. Shelve unpinned strip tabs beyond the cap of most recently used ones, if stale.
  const unpinned = tabs
    .filter((tab) => tab.placement === 'strip' && !tab.pinned)
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt || a.id.localeCompare(b.id));
  // The selected tab always counts among the kept ones, whatever its timestamp says.
  const kept = new Set(
    [...unpinned.filter((tab) => tab.selected), ...unpinned.filter((tab) => !tab.selected)]
      .slice(0, settings.stripCap)
      .map((tab) => tab.id),
  );
  unpinned
    .filter(
      (tab) =>
        !kept.has(tab.id) &&
        !planned.has(tab.id) &&
        !tab.selected &&
        !tab.busy &&
        clock.engagedNow - tab.lastUsedEngaged >= settings.shelveAfterEngagedMs &&
        !blocked(tab, 'shelve'),
    )
    // Least recently used first; ties by id, as in every rule.
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.id.localeCompare(b.id))
    .forEach((tab) => {
      add(tab, 'shelve', 'shelve-beyond-cap');
    });

  // 3. Archive Sleeping tabs unused for enough active days.
  if (settings.autoArchive) {
    tabs
      .filter(
        (tab) =>
          tab.placement === 'shelf' &&
          !planned.has(tab.id) &&
          !tab.pinned &&
          !tab.selected &&
          !tab.busy &&
          !tab.loading &&
          clock.activeDay - tab.lastUsedActiveDay >= settings.archiveAfterActiveDays &&
          !blocked(tab, 'archive') &&
          !(holdsRenderer(tab) && blocked(tab, 'discard')),
      )
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.id.localeCompare(b.id))
      .forEach((tab) => {
        add(tab, 'archive', 'archive-dormant');
      });
  }
  return actions;
}
