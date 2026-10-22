import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LIFECYCLE_SETTINGS,
  FREEZE_AFTER_MS,
  PRESETS,
  PRESET_VALUES,
  PRESSURE_RULES,
  planLifecycle,
  resolveLifecycleSettings,
} from './policy';
import type {
  LifecycleAction,
  LifecycleClock,
  LifecycleRule,
  LifecycleSettings,
  LifecycleSettingsInput,
  MemoryPressure,
  PlanInput,
  Preset,
  PresetValues,
  TabFacts,
} from './policy';
import { protectionFor } from './protections';
import type { LifecycleActionKind, ProtectionReason } from './protections';
import { RUNTIME_STATES } from './runtime-machine';
import type { RuntimeState } from './runtime-machine';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Every plan below is made at this wall-clock time, engaged time and active day, so a tab's age is
// the difference between the clock and its own timestamps.
const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);
const ENGAGED_NOW = 100 * HOUR;
const ACTIVE_DAY = 50;

/** Assessment §4.7's table, written out. A `Record` over `Preset`: a new preset fails `tsc -b`. */
const TABLE: Readonly<Record<Preset, PresetValues>> = {
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

/** What memory pressure asks of a tab and of one evaluation (policy.ts, rule 4). */
const PRESSURE = {
  moderate: { minHiddenMs: 15 * MINUTE, budget: 1 },
  critical: { minHiddenMs: 2 * MINUTE, budget: 3 },
} as const;

/**
 * Assessment §4.10, as far as the policy meets it: which actions each reason blocks, and whether it
 * is hard (always blocks) or soft (does not block under critical pressure). A `Record` over the
 * `ProtectionReason` union: a new reason fails `tsc -b` here until it is described.
 */
const PROTECTION_TABLE: Readonly<
  Record<ProtectionReason, { hard: boolean; blocks: readonly LifecycleActionKind[] }>
> = {
  'unsaved-input': { hard: true, blocks: ['discard', 'archive'] },
  'page-unsaved-changes': { hard: true, blocks: ['discard', 'archive'] },
  editing: { hard: false, blocks: ['discard', 'archive'] },
  'sensitive-page': { hard: false, blocks: ['discard'] },
  audio: { hard: true, blocks: ['freeze', 'discard', 'shelve'] },
  capture: { hard: true, blocks: ['freeze', 'discard', 'shelve', 'archive'] },
  devtools: { hard: true, blocks: ['discard'] },
  'open-popup': { hard: true, blocks: ['discard', 'archive'] },
  'recent-interaction': { hard: false, blocks: ['discard', 'shelve', 'archive'] },
};
const REASONS = Object.keys(PROTECTION_TABLE) as ProtectionReason[];

/** A live, unpinned strip tab, hidden for a minute and used a minute ago: nothing applies to it. */
const tab = (overrides: Partial<TabFacts> = {}): TabFacts => ({
  id: 'tab',
  placement: 'strip',
  runtime: 'live',
  pinned: false,
  selected: false,
  webPage: true,
  loading: false,
  busy: false,
  epoch: 1,
  hiddenSince: NOW - MINUTE,
  lastUsedAt: NOW - MINUTE,
  lastUsedEngaged: ENGAGED_NOW - MINUTE,
  lastUsedActiveDay: ACTIVE_DAY,
  lastInteractionAt: null,
  protections: [],
  ...overrides,
});

/** A tab hidden for `ms`. */
const hiddenFor = (ms: number): Partial<TabFacts> => ({ hiddenSince: NOW - ms });

/** The protections of these reasons, as the monitor would hand them over. */
const protect = (...reasons: ProtectionReason[]): Partial<TabFacts> => ({
  protections: reasons.map((reason) => protectionFor(reason)),
});

const clockAt = (overrides: Partial<LifecycleClock> = {}): LifecycleClock => ({
  wallNow: NOW,
  engagedNow: ENGAGED_NOW,
  activeDay: ACTIVE_DAY,
  ...overrides,
});

/** A preset's settings with auto-archive on and freezing off, then `overrides`. */
const settingsOf = (
  preset: Preset = 'balanced',
  overrides: Partial<LifecycleSettings> = {},
): LifecycleSettings => ({
  ...resolveLifecycleSettings({
    preset,
    autoArchive: true,
    freeze: false,
    paused: false,
    overrides: {},
  }),
  ...overrides,
});

interface PlanOptions {
  readonly settings?: LifecycleSettings;
  readonly pressure?: MemoryPressure;
  readonly clock?: Partial<LifecycleClock>;
}

function plan(tabs: readonly TabFacts[], options: PlanOptions = {}): LifecycleAction[] {
  return planLifecycle({
    tabs,
    settings: options.settings ?? settingsOf(),
    clock: clockAt(options.clock),
    pressure: options.pressure ?? 'none',
  });
}

/** The action the policy should return for `target`. */
const act = (
  target: TabFacts,
  kind: LifecycleActionKind,
  rule: LifecycleRule,
  overrideSoft = false,
): LifecycleAction => ({ tabId: target.id, kind, rule, epoch: target.epoch, overrideSoft });

/** `rule:tabId` for each action, in order. */
const summary = (actions: readonly LifecycleAction[]): string[] =>
  actions.map((action) => `${action.rule}:${action.tabId}`);

/** A small deterministic generator (mulberry32): the same seed always gives the same sequence. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Random = () => number;
const int = (random: Random, below: number): number => Math.floor(random() * below);
const chance = (random: Random, p: number): boolean => random() < p;
function pick<T>(random: Random, items: readonly T[]): T {
  const item = items[int(random, items.length)];
  if (item === undefined) {
    throw new Error('pick() needs a non-empty list of defined items');
  }
  return item;
}

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

describe('PRESETS', () => {
  it('lists gentle, balanced and aggressive, in that order', () => {
    expect([...PRESETS]).toStrictEqual(['gentle', 'balanced', 'aggressive']);
  });
});

describe('PRESET_VALUES (assessment §4.7)', () => {
  it.each(PRESETS)('%s is the table of §4.7', (preset) => {
    expect(PRESET_VALUES[preset]).toStrictEqual(TABLE[preset]);
  });

  it('has the three presets and no other', () => {
    expect(Object.keys(PRESET_VALUES).sort()).toStrictEqual(['aggressive', 'balanced', 'gentle']);
  });

  it('spells the table out: hours, counts, days and minutes as the document gives them', () => {
    expect(PRESET_VALUES.gentle).toStrictEqual({
      discardAfterMs: 14_400_000, // 4 h
      stripCap: 15,
      shelveAfterEngagedMs: 28_800_000, // 8 h
      archiveAfterActiveDays: 14,
      interactionGuardMs: 1_800_000, // 30 min
      discardPinned: false,
    });
    expect(PRESET_VALUES.balanced).toStrictEqual({
      discardAfterMs: 3_600_000, // 60 min
      stripCap: 10,
      shelveAfterEngagedMs: 7_200_000, // 2 h
      archiveAfterActiveDays: 3,
      interactionGuardMs: 900_000, // 15 min
      discardPinned: false,
    });
    expect(PRESET_VALUES.aggressive).toStrictEqual({
      discardAfterMs: 900_000, // 15 min
      stripCap: 6,
      shelveAfterEngagedMs: 1_800_000, // 30 min
      archiveAfterActiveDays: 1,
      interactionGuardMs: 300_000, // 5 min
      discardPinned: true,
    });
  });

  it('gets stricter from gentle to balanced to aggressive in every setting', () => {
    const [gentle, balanced, aggressive] = [
      PRESET_VALUES.gentle,
      PRESET_VALUES.balanced,
      PRESET_VALUES.aggressive,
    ];

    expect(gentle.discardAfterMs).toBeGreaterThan(balanced.discardAfterMs);
    expect(balanced.discardAfterMs).toBeGreaterThan(aggressive.discardAfterMs);
    expect(gentle.stripCap).toBeGreaterThan(balanced.stripCap);
    expect(balanced.stripCap).toBeGreaterThan(aggressive.stripCap);
    expect(gentle.shelveAfterEngagedMs).toBeGreaterThan(balanced.shelveAfterEngagedMs);
    expect(balanced.shelveAfterEngagedMs).toBeGreaterThan(aggressive.shelveAfterEngagedMs);
    expect(gentle.archiveAfterActiveDays).toBeGreaterThan(balanced.archiveAfterActiveDays);
    expect(balanced.archiveAfterActiveDays).toBeGreaterThan(aggressive.archiveAfterActiveDays);
    expect(gentle.interactionGuardMs).toBeGreaterThan(balanced.interactionGuardMs);
    expect(balanced.interactionGuardMs).toBeGreaterThan(aggressive.interactionGuardMs);
    expect([gentle.discardPinned, balanced.discardPinned, aggressive.discardPinned]).toStrictEqual([
      false,
      false,
      true,
    ]);
  });
});

describe('FREEZE_AFTER_MS and PRESSURE_RULES', () => {
  it('freezes after 10 minutes hidden (rule 5)', () => {
    expect(FREEZE_AFTER_MS).toBe(10 * MINUTE);
  });

  it('asks 15 minutes hidden and one discard of a moderate evaluation, 2 minutes and three of a critical one', () => {
    expect(PRESSURE_RULES).toStrictEqual(PRESSURE);
  });
});

describe('DEFAULT_LIFECYCLE_SETTINGS', () => {
  it('is Balanced with auto-archive on, freezing off and automation running', () => {
    expect(DEFAULT_LIFECYCLE_SETTINGS).toStrictEqual({
      preset: 'balanced',
      ...TABLE.balanced,
      autoArchive: true,
      freeze: false,
      freezeAfterMs: 10 * MINUTE,
      paused: false,
    });
  });

  it('is what resolving Balanced with the default switches gives', () => {
    expect(
      resolveLifecycleSettings({
        preset: 'balanced',
        autoArchive: true,
        freeze: false,
        paused: false,
        overrides: {},
      }),
    ).toStrictEqual(DEFAULT_LIFECYCLE_SETTINGS);
  });
});

describe('resolveLifecycleSettings', () => {
  const input = (
    preset: Preset,
    overrides: LifecycleSettingsInput['overrides'] = {},
    switches: Partial<Pick<LifecycleSettingsInput, 'autoArchive' | 'freeze' | 'paused'>> = {},
  ): LifecycleSettingsInput => ({
    preset,
    autoArchive: true,
    freeze: false,
    paused: false,
    overrides,
    ...switches,
  });

  /** What a preset resolves to with the default switches, then `extra`. */
  const resolved = (
    preset: Preset,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    preset,
    ...TABLE[preset],
    autoArchive: true,
    freeze: false,
    freezeAfterMs: 10 * MINUTE,
    paused: false,
    ...extra,
  });

  const SINGLE_OVERRIDES: readonly (readonly [string, LifecycleSettingsInput['overrides']])[] = [
    ['discardAfterMs', { discardAfterMs: 123_456 }],
    ['stripCap', { stripCap: 42 }],
    ['shelveAfterEngagedMs', { shelveAfterEngagedMs: 7 * HOUR }],
    ['archiveAfterActiveDays', { archiveAfterActiveDays: 9 }],
    ['interactionGuardMs', { interactionGuardMs: 90_000 }],
    ['discardPinned', { discardPinned: true }],
  ];

  it.each(PRESETS)(
    'gives %s the preset values and the default switches when nothing is overridden',
    (preset) => {
      expect(resolveLifecycleSettings(input(preset))).toStrictEqual(resolved(preset));
    },
  );

  describe.each(PRESETS)('on %s', (preset) => {
    it.each(SINGLE_OVERRIDES)('applies the %s override alone', (_key, overrides) => {
      expect(resolveLifecycleSettings(input(preset, overrides))).toStrictEqual(
        resolved(preset, overrides),
      );
    });

    it('applies all the overrides together', () => {
      const overrides = {
        discardAfterMs: 11 * MINUTE,
        stripCap: 3,
        shelveAfterEngagedMs: 5 * MINUTE,
        archiveAfterActiveDays: 30,
        interactionGuardMs: 2 * MINUTE,
        discardPinned: !TABLE[preset].discardPinned,
      };

      expect(resolveLifecycleSettings(input(preset, overrides))).toStrictEqual(
        resolved(preset, overrides),
      );
    });

    it('ignores overrides that are undefined', () => {
      const overrides = {
        discardAfterMs: undefined,
        stripCap: undefined,
        shelveAfterEngagedMs: undefined,
        archiveAfterActiveDays: undefined,
        interactionGuardMs: undefined,
        discardPinned: undefined,
      };

      expect(resolveLifecycleSettings(input(preset, overrides))).toStrictEqual(resolved(preset));
    });

    it('lets an override that is undefined sit beside one that is set', () => {
      expect(
        resolveLifecycleSettings(
          input(preset, { stripCap: undefined, discardAfterMs: 5 * MINUTE }),
        ),
      ).toStrictEqual(resolved(preset, { discardAfterMs: 5 * MINUTE }));
    });

    it('honours an override of zero or false, which are values and not absences', () => {
      const overrides = {
        discardAfterMs: 0,
        stripCap: 0,
        shelveAfterEngagedMs: 0,
        archiveAfterActiveDays: 0,
        interactionGuardMs: 0,
        discardPinned: false,
      };

      expect(resolveLifecycleSettings(input(preset, overrides))).toStrictEqual(
        resolved(preset, overrides),
      );
    });

    it('keeps the preset it was given, whatever the overrides', () => {
      expect(resolveLifecycleSettings(input(preset, { stripCap: 1 })).preset).toBe(preset);
    });
  });

  describe('the switches', () => {
    type Switches = Partial<Pick<LifecycleSettingsInput, 'autoArchive' | 'freeze' | 'paused'>>;
    const FLIPPED: readonly (readonly [string, Switches])[] = [
      ['auto-archive off', { autoArchive: false }],
      ['freezing on', { freeze: true }],
      ['automation paused', { paused: true }],
      ['all three flipped', { autoArchive: false, freeze: true, paused: true }],
    ];

    it.each(FLIPPED)('keeps %s', (_label, switches) => {
      expect(resolveLifecycleSettings(input('balanced', {}, switches))).toStrictEqual(
        resolved('balanced', switches),
      );
    });

    it('keeps them together with overrides', () => {
      expect(
        resolveLifecycleSettings(
          input('gentle', { stripCap: 4 }, { autoArchive: false, paused: true }),
        ),
      ).toStrictEqual(resolved('gentle', { stripCap: 4, autoArchive: false, paused: true }));
    });

    it('always freezes after 10 minutes hidden: the document has no override for it', () => {
      for (const preset of PRESETS) {
        expect(resolveLifecycleSettings(input(preset, {}, { freeze: true })).freezeAfterMs).toBe(
          FREEZE_AFTER_MS,
        );
      }
    });
  });

  it('does not change the preset table or the input it was given', () => {
    const overrides = Object.freeze({ stripCap: 3, discardPinned: true });
    const given = Object.freeze(input('balanced', overrides));

    resolveLifecycleSettings(given);

    expect(PRESET_VALUES.balanced).toStrictEqual(TABLE.balanced);
    expect(given.overrides).toStrictEqual({ stripCap: 3, discardPinned: true });
  });

  it('returns a new object each time, not a preset or the previous result', () => {
    const first = resolveLifecycleSettings(input('balanced'));
    const second = resolveLifecycleSettings(input('balanced'));

    expect(first).toStrictEqual(second);
    expect(first).not.toBe(second);
    expect(first).not.toBe(DEFAULT_LIFECYCLE_SETTINGS);
  });
});

// ---------------------------------------------------------------------------------------------
// The plan, rule by rule
// ---------------------------------------------------------------------------------------------

describe('planLifecycle', () => {
  describe('with nothing to do', () => {
    it('plans nothing for no tabs', () => {
      expect(plan([])).toStrictEqual([]);
    });

    it('plans nothing for a tab hidden a minute and used a minute ago', () => {
      expect(plan([tab()])).toStrictEqual([]);
    });

    it('never plans the selected tab, however stale its facts look', () => {
      const selected = tab({
        selected: true,
        hiddenSince: NOW - 10 * HOUR,
        lastUsedAt: NOW - 30 * DAY,
        lastUsedEngaged: 0,
        lastUsedActiveDay: 1,
      });

      for (const pressure of ['none', 'moderate', 'critical'] as const) {
        expect(
          plan([selected], { settings: settingsOf('aggressive', { freeze: true }), pressure }),
        ).toStrictEqual([]);
      }
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('rule 1, discard-hidden', () => {
    describe.each(PRESETS)('on %s', (preset) => {
      const settings = settingsOf(preset);
      const { discardAfterMs, interactionGuardMs } = TABLE[preset];

      it('discards a live tab hidden for exactly the preset time', () => {
        const target = tab({ epoch: 7, ...hiddenFor(discardAfterMs) });

        expect(plan([target], { settings })).toStrictEqual([
          act(target, 'discard', 'discard-hidden'),
        ]);
      });

      it('waits while it has been hidden 1 ms less', () => {
        expect(plan([tab(hiddenFor(discardAfterMs - 1))], { settings })).toStrictEqual([]);
      });

      it('discards a tab hidden 1 ms more', () => {
        const target = tab(hiddenFor(discardAfterMs + 1));

        expect(plan([target], { settings })).toStrictEqual([
          act(target, 'discard', 'discard-hidden'),
        ]);
      });

      it('discards a pinned tab only if the preset discards pinned tabs', () => {
        const target = tab({ pinned: true, ...hiddenFor(discardAfterMs + HOUR) });

        expect(plan([target], { settings })).toStrictEqual(
          TABLE[preset].discardPinned ? [act(target, 'discard', 'discard-hidden')] : [],
        );
      });

      describe('the recent-interaction guard', () => {
        const hidden = hiddenFor(discardAfterMs + HOUR);

        it.each([
          ['at this very moment', 0],
          ['1 ms ago', 1],
          ['1 ms inside the guard', interactionGuardMs - 1],
        ])('blocks the discard of a tab the user interacted with %s', (_label, ago) => {
          const target = tab({ ...hidden, lastInteractionAt: NOW - ago });

          expect(plan([target], { settings })).toStrictEqual([]);
        });

        it.each([
          ['exactly at the guard', interactionGuardMs],
          ['1 ms past the guard', interactionGuardMs + 1],
          ['a day ago', DAY],
        ])('lets a tab the user interacted with %s be discarded', (_label, ago) => {
          const target = tab({ ...hidden, lastInteractionAt: NOW - ago });

          expect(plan([target], { settings })).toStrictEqual([
            act(target, 'discard', 'discard-hidden'),
          ]);
        });

        it.each([
          ['1 ms', 1],
          ['a minute', MINUTE],
          ['an hour', HOUR],
        ])('does not count an interaction %s in the future', (_label, ahead) => {
          const target = tab({ ...hidden, lastInteractionAt: NOW + ahead });

          expect(plan([target], { settings })).toStrictEqual([
            act(target, 'discard', 'discard-hidden'),
          ]);
        });

        it('does not block a tab that was never interacted with', () => {
          const target = tab({ ...hidden, lastInteractionAt: null });

          expect(plan([target], { settings })).toStrictEqual([
            act(target, 'discard', 'discard-hidden'),
          ]);
        });
      });
    });

    it('takes the time and the pinned switch from an override, not only from the preset', () => {
      const short = settingsOf('balanced', { discardAfterMs: 5 * MINUTE });
      const pinned = tab({ pinned: true, ...hiddenFor(2 * HOUR) });

      expect(plan([tab(hiddenFor(5 * MINUTE))], { settings: short })).toHaveLength(1);
      expect(plan([tab(hiddenFor(5 * MINUTE - 1))], { settings: short })).toHaveLength(0);
      expect(
        plan([pinned], { settings: settingsOf('balanced', { discardPinned: true }) }),
      ).toHaveLength(1);
      expect(
        plan([pinned], { settings: settingsOf('aggressive', { discardPinned: false }) }),
      ).toHaveLength(0);
    });

    it('discards a frozen tab too, and says so with the tab epoch', () => {
      const target = tab({ runtime: 'frozen', epoch: 42, ...hiddenFor(2 * HOUR) });

      expect(plan([target])).toStrictEqual([act(target, 'discard', 'discard-hidden')]);
      expect(plan([target])[0]?.epoch).toBe(42);
    });

    it.each(RUNTIME_STATES)(
      'with the tab %s, plans a discard only if the tab is live or frozen',
      (runtime) => {
        const target = tab({ runtime, ...hiddenFor(2 * HOUR) });
        const holdsRenderer: readonly RuntimeState[] = ['live', 'frozen'];

        expect(plan([target])).toStrictEqual(
          holdsRenderer.includes(runtime) ? [act(target, 'discard', 'discard-hidden')] : [],
        );
      },
    );

    it.each([
      ['selected', { selected: true }],
      ['not showing a web page', { webPage: false }],
      ['loading', { loading: true }],
      ['under a lifecycle operation', { busy: true }],
    ] as const)('does not discard a tab that is %s', (_label, overrides) => {
      expect(plan([tab({ ...hiddenFor(5 * HOUR), ...overrides })])).toStrictEqual([]);
    });

    it('does not discard a tab that is shown: hiddenSince is null', () => {
      expect(
        plan([
          tab({ hiddenSince: null, lastUsedAt: NOW - 5 * HOUR }),
          tab({ id: 'b', hiddenSince: null }),
        ]),
      ).toStrictEqual([]);
    });

    it('does not count a hiddenSince in the future as time hidden', () => {
      expect(plan([tab({ hiddenSince: NOW + HOUR })])).toStrictEqual([]);
    });

    it('does not mind the shelf: a live tab on it is discarded like any other', () => {
      const target = tab({
        placement: 'shelf',
        ...hiddenFor(2 * HOUR),
        lastUsedActiveDay: ACTIVE_DAY,
      });

      expect(plan([target])).toStrictEqual([act(target, 'discard', 'discard-hidden')]);
    });

    it('has no budget: every tab that qualifies is discarded', () => {
      const tabs = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => tab({ id, ...hiddenFor(2 * HOUR) }));

      expect(plan(tabs)).toHaveLength(6);
    });

    describe('protections', () => {
      it.each(REASONS)('with the %s protection', (reason) => {
        const target = tab({ ...hiddenFor(2 * HOUR), ...protect(reason) });
        const blocked = PROTECTION_TABLE[reason].blocks.includes('discard');

        expect(plan([target])).toStrictEqual(
          blocked ? [] : [act(target, 'discard', 'discard-hidden')],
        );
      });

      it('blocks the discard for a hard protection', () => {
        expect(plan([tab({ ...hiddenFor(2 * HOUR), ...protect('unsaved-input') })])).toStrictEqual(
          [],
        );
      });

      it('blocks the discard for a soft protection too: only critical pressure lifts it', () => {
        expect(plan([tab({ ...hiddenFor(2 * HOUR), ...protect('editing') })])).toStrictEqual([]);
        expect(
          plan([tab({ ...hiddenFor(2 * HOUR), ...protect('sensitive-page') })], {
            pressure: 'moderate',
          }),
        ).toStrictEqual([]);
      });

      it('keeps one tab from stopping another', () => {
        const protectedTab = tab({ id: 'a', ...hiddenFor(2 * HOUR), ...protect('audio') });
        const other = tab({ id: 'b', ...hiddenFor(2 * HOUR) });

        expect(plan([protectedTab, other])).toStrictEqual([
          act(other, 'discard', 'discard-hidden'),
        ]);
      });

      it('goes by what a protection blocks, not by its name', () => {
        const freezeOnly = { reason: 'audio', hard: true, blocks: ['freeze'] } as const;
        const target = tab({ ...hiddenFor(2 * HOUR), protections: [freezeOnly] });

        expect(plan([target])).toStrictEqual([act(target, 'discard', 'discard-hidden')]);
      });

      it('lets several protections stack: one that blocks is enough', () => {
        expect(
          plan([
            tab({ ...hiddenFor(2 * HOUR), ...protect('devtools', 'sensitive-page', 'audio') }),
          ]),
        ).toStrictEqual([]);
      });
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('rule 2, shelve-beyond-cap', () => {
    const CAP2 = settingsOf('balanced', { stripCap: 2 });
    /** An unpinned strip tab used `minutesAgo`, and not for 3 engaged hours. */
    const stale = (id: string, minutesAgo: number, overrides: Partial<TabFacts> = {}): TabFacts =>
      tab({
        id,
        lastUsedAt: NOW - minutesAgo * MINUTE,
        lastUsedEngaged: ENGAGED_NOW - 3 * HOUR,
        ...overrides,
      });
    /** Two kept tabs, a and b, and a third, `c`, outside the cap of 2, with `overrides`. */
    const outsideCap = (overrides: Partial<TabFacts> = {}): TabFacts[] => [
      stale('a', 1, { lastUsedEngaged: ENGAGED_NOW - MINUTE }),
      stale('b', 2, { lastUsedEngaged: ENGAGED_NOW - MINUTE }),
      stale('c', 3, overrides),
    ];

    describe.each(PRESETS)('on %s', (preset) => {
      const settings = settingsOf(preset);
      const { stripCap, shelveAfterEngagedMs } = TABLE[preset];
      /** `count` unpinned strip tabs, `t00` the least recently used, all idle for `idle` engaged ms. */
      const strip = (count: number, idle: number): TabFacts[] =>
        Array.from({ length: count }, (_, index) =>
          tab({
            id: `t${String(index).padStart(2, '0')}`,
            lastUsedAt: NOW - (count - index) * MINUTE,
            lastUsedEngaged: ENGAGED_NOW - idle,
          }),
        );

      it('keeps the most recently used tabs of the cap and shelves the rest, least recently used first', () => {
        const tabs = strip(stripCap + 2, shelveAfterEngagedMs);

        expect(summary(plan([...tabs].reverse(), { settings }))).toStrictEqual([
          'shelve-beyond-cap:t00',
          'shelve-beyond-cap:t01',
        ]);
      });

      it('shelves nothing when the strip holds exactly the cap', () => {
        expect(plan(strip(stripCap, 10 * HOUR), { settings })).toStrictEqual([]);
      });

      it('shelves just the least recently used tab when the strip is one over', () => {
        const tabs = strip(stripCap + 1, shelveAfterEngagedMs);

        expect(plan(tabs, { settings })).toStrictEqual([
          act(tabs[0] ?? tab(), 'shelve', 'shelve-beyond-cap'),
        ]);
      });

      it('shelves a tab idle for exactly the preset engaged time', () => {
        expect(plan(strip(stripCap + 1, shelveAfterEngagedMs), { settings })).toHaveLength(1);
      });

      it('leaves a tab idle for 1 ms less, however far over the cap the strip is', () => {
        expect(plan(strip(stripCap + 5, shelveAfterEngagedMs - 1), { settings })).toStrictEqual([]);
      });
    });

    it('keeps the cap by recency, not by id or by the order the tabs come in', () => {
      const tabs = [stale('a', 30), stale('b', 10), stale('c', 20), stale('d', 40), stale('e', 5)];

      // Most recent two: e (5 min) and b (10 min). Shelved, least recently used first: d, a, c.
      expect(summary(plan(tabs, { settings: CAP2 }))).toStrictEqual([
        'shelve-beyond-cap:d',
        'shelve-beyond-cap:a',
        'shelve-beyond-cap:c',
      ]);
    });

    it('carries the epoch of each tab and says it was not decided under pressure', () => {
      const tabs = outsideCap({ epoch: 99 });

      expect(plan(tabs, { settings: CAP2 })).toStrictEqual([
        { tabId: 'c', kind: 'shelve', rule: 'shelve-beyond-cap', epoch: 99, overrideSoft: false },
      ]);
    });

    describe('the selected tab', () => {
      it('always counts among the tabs kept, whatever its timestamp', () => {
        // With a cap of 2 the selected tab takes one place, though it is the least recently used, so
        // only one other tab (a) is kept, and b and c are shelved.
        const tabs = [
          stale('selected', 1000, { selected: true, hiddenSince: null }),
          stale('a', 1),
          stale('b', 2),
          stale('c', 3),
        ];

        expect(summary(plan(tabs, { settings: CAP2 }))).toStrictEqual([
          'shelve-beyond-cap:c',
          'shelve-beyond-cap:b',
        ]);
      });

      it('is itself never shelved, however long it has been idle', () => {
        const tabs = [stale('selected', 5000, { selected: true, hiddenSince: null })];

        expect(plan(tabs, { settings: settingsOf('balanced', { stripCap: 0 }) })).toStrictEqual([]);
      });

      it('counts among the kept even when it is the most recently used', () => {
        const tabs = [
          stale('selected', 0, { selected: true, hiddenSince: null }),
          stale('a', 1),
          stale('b', 2),
        ];

        expect(summary(plan(tabs, { settings: CAP2 }))).toStrictEqual(['shelve-beyond-cap:b']);
      });

      it('takes no place from the others when it is pinned: pinned tabs are outside the cap', () => {
        const tabs = [
          stale('selected', 1000, { selected: true, pinned: true, hiddenSince: null }),
          stale('a', 1),
          stale('b', 2),
          stale('c', 3),
        ];

        expect(summary(plan(tabs, { settings: CAP2 }))).toStrictEqual(['shelve-beyond-cap:c']);
      });
    });

    describe('which tabs count', () => {
      it('never shelves a pinned tab, and does not count one toward the cap', () => {
        const tabs = [
          stale('p1', 5000, { pinned: true }),
          stale('p2', 6000, { pinned: true }),
          stale('a', 1),
          stale('b', 2),
        ];

        expect(plan(tabs, { settings: CAP2 })).toStrictEqual([]);
      });

      it('does not count a tab on the shelf toward the cap, and does not shelve it again', () => {
        const onShelf = tab({
          id: 'shelf',
          placement: 'shelf',
          runtime: 'unloaded',
          lastUsedAt: NOW - 30 * SECOND,
          lastUsedEngaged: ENGAGED_NOW - 3 * HOUR,
        });
        const tabs = [onShelf, stale('a', 1), stale('b', 2), stale('c', 3)];

        // The shelf's recent tab would have displaced b if it counted. Only c is outside the cap.
        expect(summary(plan(tabs, { settings: CAP2 }))).toStrictEqual(['shelve-beyond-cap:c']);
      });

      it('shelves nothing when the cap is at least the number of tabs', () => {
        expect(
          plan([stale('a', 1), stale('b', 2), stale('c', 3)], {
            settings: settingsOf('balanced', { stripCap: 3 }),
          }),
        ).toStrictEqual([]);
        expect(
          plan([stale('a', 1), stale('b', 2), stale('c', 3)], {
            settings: settingsOf('balanced', { stripCap: 50 }),
          }),
        ).toStrictEqual([]);
      });

      it('shelves every stale tab but the selected one when the cap is zero', () => {
        const tabs = [
          stale('a', 1),
          stale('b', 2, { selected: true, hiddenSince: null }),
          stale('c', 3),
        ];

        expect(
          summary(plan(tabs, { settings: settingsOf('balanced', { stripCap: 0 }) })),
        ).toStrictEqual(['shelve-beyond-cap:c', 'shelve-beyond-cap:a']);
      });

      it('does not shelve a tab under a lifecycle operation', () => {
        expect(plan(outsideCap({ busy: true }), { settings: CAP2 })).toStrictEqual([]);
      });
    });

    describe('engaged time', () => {
      it('shelves a tab outside the cap only after the preset engaged time, to the millisecond', () => {
        const at = (idle: number): TabFacts[] =>
          outsideCap({ lastUsedEngaged: ENGAGED_NOW - idle });

        expect(plan(at(2 * HOUR - 1), { settings: CAP2 })).toStrictEqual([]);
        expect(summary(plan(at(2 * HOUR), { settings: CAP2 }))).toStrictEqual([
          'shelve-beyond-cap:c',
        ]);
        expect(summary(plan(at(2 * HOUR + 1), { settings: CAP2 }))).toStrictEqual([
          'shelve-beyond-cap:c',
        ]);
      });

      it('does not shelve for wall-clock time alone: a weekend away leaves the strip as it was', () => {
        // Unused for 90 days by the wall clock, but only 1 ms short of 2 hours of engaged time.
        const awayForMonths = outsideCap({
          runtime: 'unloaded',
          lastUsedAt: NOW - 90 * DAY,
          lastUsedEngaged: ENGAGED_NOW - (2 * HOUR - 1),
        });

        expect(plan(awayForMonths, { settings: CAP2 })).toStrictEqual([]);
      });

      it('does not treat a tab stamped in the engaged future as stale', () => {
        expect(
          plan(outsideCap({ lastUsedEngaged: ENGAGED_NOW + HOUR }), { settings: CAP2 }),
        ).toStrictEqual([]);
      });

      it('uses the engaged time of the clock it is given', () => {
        const tabs = outsideCap({ lastUsedEngaged: ENGAGED_NOW - 90 * MINUTE });

        expect(plan(tabs, { settings: CAP2 })).toStrictEqual([]);
        expect(
          summary(plan(tabs, { settings: CAP2, clock: { engagedNow: ENGAGED_NOW + 30 * MINUTE } })),
        ).toStrictEqual(['shelve-beyond-cap:c']);
      });
    });

    describe('protections', () => {
      it.each(REASONS)('with the %s protection', (reason) => {
        const tabs = outsideCap(protect(reason));
        const blocked = PROTECTION_TABLE[reason].blocks.includes('shelve');

        expect(plan(tabs, { settings: CAP2 })).toStrictEqual(
          blocked ? [] : [act(tabs[2] ?? tab(), 'shelve', 'shelve-beyond-cap')],
        );
      });

      it('is blocked by audio, capture and a recent interaction, and not by DevTools', () => {
        const blockedBy = (...reasons: ProtectionReason[]): string[] =>
          summary(plan(outsideCap(protect(...reasons)), { settings: CAP2 }));

        expect(blockedBy('audio')).toStrictEqual([]);
        expect(blockedBy('capture')).toStrictEqual([]);
        expect(blockedBy('recent-interaction')).toStrictEqual([]);
        expect(blockedBy('devtools')).toStrictEqual(['shelve-beyond-cap:c']);
        expect(blockedBy('devtools', 'audio')).toStrictEqual([]);
      });

      it('applies the recent-interaction guard from lastInteractionAt, to the millisecond', () => {
        const guard = TABLE.balanced.interactionGuardMs;
        const interactedAgo = (ago: number): string[] =>
          summary(plan(outsideCap({ lastInteractionAt: NOW - ago }), { settings: CAP2 }));

        expect(interactedAgo(guard - 1)).toStrictEqual([]);
        expect(interactedAgo(guard)).toStrictEqual(['shelve-beyond-cap:c']);
        expect(interactedAgo(-1)).toStrictEqual(['shelve-beyond-cap:c']);
      });

      it('is not lifted by critical pressure: pressure never changes what the user sees', () => {
        const tabs = outsideCap(protect('recent-interaction'));

        expect(plan(tabs, { settings: CAP2, pressure: 'critical' })).toStrictEqual([]);
      });
    });

    describe('a tab gets one action', () => {
      it('is discarded rather than shelved when it qualifies for both', () => {
        const target = stale('c', 3, hiddenFor(2 * HOUR));
        const tabs = [stale('a', 1), stale('b', 2), target];

        expect(plan(tabs, { settings: CAP2 })).toStrictEqual([
          act(target, 'discard', 'discard-hidden'),
        ]);
      });

      it('is shelved when the discard is blocked and the shelve is not (DevTools open)', () => {
        const target = stale('c', 3, { ...hiddenFor(2 * HOUR), ...protect('devtools') });
        const tabs = [stale('a', 1), stale('b', 2), target];

        expect(plan(tabs, { settings: CAP2 })).toStrictEqual([
          act(target, 'shelve', 'shelve-beyond-cap'),
        ]);
      });

      it('is shelved on the next evaluation, once its discard has left it unloaded', () => {
        const live = stale('c', 3, hiddenFor(2 * HOUR));
        const discarded = { ...live, runtime: 'unloaded' as const, epoch: live.epoch + 1 };
        const tabsWith = (target: TabFacts): TabFacts[] => [stale('a', 1), stale('b', 2), target];

        expect(summary(plan(tabsWith(live), { settings: CAP2 }))).toStrictEqual([
          'discard-hidden:c',
        ]);
        expect(plan(tabsWith(discarded), { settings: CAP2 })).toStrictEqual([
          act(discarded, 'shelve', 'shelve-beyond-cap'),
        ]);
      });

      it('is frozen rather than shelved when freezing is on and it is hidden long enough', () => {
        const target = stale('c', 3, hiddenFor(20 * MINUTE));
        const tabs = [stale('a', 1), stale('b', 2), target];
        const settings = settingsOf('balanced', { stripCap: 2, freeze: true });

        expect(summary(plan(tabs, { settings }))).toStrictEqual(['freeze-hidden:c']);
      });
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('rule 3, archive-dormant', () => {
    /** A Sleeping tab, unloaded, last used 10 active days ago. */
    const dormant = (id: string, minutesAgo = 1, overrides: Partial<TabFacts> = {}): TabFacts =>
      tab({
        id,
        placement: 'shelf',
        runtime: 'unloaded',
        lastUsedAt: NOW - minutesAgo * MINUTE,
        lastUsedActiveDay: ACTIVE_DAY - 10,
        ...overrides,
      });

    describe.each(PRESETS)('on %s', (preset) => {
      const settings = settingsOf(preset);
      const days = TABLE[preset].archiveAfterActiveDays;

      it('archives a Sleeping tab unused for exactly the preset number of active days', () => {
        const target = dormant('s', 1, { epoch: 5, lastUsedActiveDay: ACTIVE_DAY - days });

        expect(plan([target], { settings })).toStrictEqual([
          act(target, 'archive', 'archive-dormant'),
        ]);
      });

      it('leaves it one active day short of that', () => {
        expect(
          plan([dormant('s', 1, { lastUsedActiveDay: ACTIVE_DAY - days + 1 })], { settings }),
        ).toStrictEqual([]);
      });

      it('archives one unused for more active days', () => {
        expect(
          plan([dormant('s', 1, { lastUsedActiveDay: ACTIVE_DAY - days - 5 })], { settings }),
        ).toHaveLength(1);
      });
    });

    it('counts active days, not wall-clock time: months away do not archive', () => {
      const target = dormant('s', 1, {
        lastUsedAt: NOW - 365 * DAY,
        lastUsedActiveDay: ACTIVE_DAY - 2,
      });

      expect(plan([target])).toStrictEqual([]);
    });

    it('does not archive a tab stamped with an active day after today', () => {
      expect(plan([dormant('s', 1, { lastUsedActiveDay: ACTIVE_DAY + 4 })])).toStrictEqual([]);
    });

    it('uses the active day of the clock it is given', () => {
      const target = dormant('s', 1, { lastUsedActiveDay: ACTIVE_DAY - 2 });

      expect(plan([target])).toStrictEqual([]);
      expect(plan([target], { clock: { activeDay: ACTIVE_DAY + 1 } })).toHaveLength(1);
    });

    it('archives only tabs on the shelf: a strip tab idle for as many days stays', () => {
      expect(
        plan([tab({ lastUsedActiveDay: ACTIVE_DAY - 30, runtime: 'unloaded' })]),
      ).toStrictEqual([]);
    });

    it('archives only when auto-archive is on', () => {
      const target = dormant('s');

      expect(
        plan([target], { settings: settingsOf('balanced', { autoArchive: false }) }),
      ).toStrictEqual([]);
      expect(
        plan([target], { settings: settingsOf('balanced', { autoArchive: true }) }),
      ).toHaveLength(1);
    });

    it('takes the days from an override', () => {
      const target = dormant('s', 1, { lastUsedActiveDay: ACTIVE_DAY - 7 });

      expect(
        plan([target], { settings: settingsOf('balanced', { archiveAfterActiveDays: 8 }) }),
      ).toStrictEqual([]);
      expect(
        plan([target], { settings: settingsOf('balanced', { archiveAfterActiveDays: 7 }) }),
      ).toHaveLength(1);
    });

    it.each([
      ['pinned', { pinned: true }],
      ['selected', { selected: true }],
      ['under a lifecycle operation', { busy: true }],
      ['loading', { loading: true }],
    ] as const)('never archives a tab that is %s', (_label, overrides) => {
      expect(plan([dormant('s', 1, overrides)])).toStrictEqual([]);
    });

    it.each(['unloaded', 'crashed'] as const)(
      'archives a %s tab: nothing to discard first',
      (runtime) => {
        const target = dormant('s', 1, { runtime });

        expect(plan([target])).toStrictEqual([act(target, 'archive', 'archive-dormant')]);
      },
    );

    it('does not mind the page being hidden for a long time or never hidden', () => {
      expect(
        plan([dormant('a', 1, { hiddenSince: null }), dormant('b', 1, hiddenFor(10 * DAY))]),
      ).toHaveLength(2);
    });

    describe('a Sleeping tab that still holds a renderer needs its discard too', () => {
      it.each(['live', 'frozen'] as const)(
        'and is archived when a %s tab may be discarded',
        (runtime) => {
          const target = dormant('s', 1, { runtime });

          expect(plan([target])).toStrictEqual([act(target, 'archive', 'archive-dormant')]);
        },
      );

      it.each(REASONS)('with the %s protection, on an unloaded tab', (reason) => {
        const target = dormant('s', 1, protect(reason));
        const blocked = PROTECTION_TABLE[reason].blocks.includes('archive');

        expect(plan([target])).toStrictEqual(
          blocked ? [] : [act(target, 'archive', 'archive-dormant')],
        );
      });

      it.each(REASONS)('with the %s protection, on a live tab', (reason) => {
        const target = dormant('s', 1, { runtime: 'live', ...protect(reason) });
        const blocked =
          PROTECTION_TABLE[reason].blocks.includes('archive') ||
          PROTECTION_TABLE[reason].blocks.includes('discard');

        expect(plan([target])).toStrictEqual(
          blocked ? [] : [act(target, 'archive', 'archive-dormant')],
        );
      });

      it('skips a live tab whose discard is blocked (DevTools) but archives an unloaded one with it', () => {
        expect(plan([dormant('s', 1, { runtime: 'live', ...protect('devtools') })])).toStrictEqual(
          [],
        );
        expect(
          plan([dormant('s', 1, { runtime: 'frozen', ...protect('devtools') })]),
        ).toStrictEqual([]);
        expect(
          plan([dormant('s', 1, { runtime: 'unloaded', ...protect('devtools') })]),
        ).toHaveLength(1);
      });

      it('is blocked by the recent-interaction guard on either kind of tab', () => {
        for (const runtime of ['unloaded', 'live'] as const) {
          expect(
            plan([dormant('s', 1, { runtime, lastInteractionAt: NOW - MINUTE })]),
          ).toStrictEqual([]);
        }
      });
    });

    describe('protections that block the archive', () => {
      it('applies the recent-interaction guard to the millisecond', () => {
        const guard = TABLE.balanced.interactionGuardMs;

        expect(plan([dormant('s', 1, { lastInteractionAt: NOW - guard + 1 })])).toStrictEqual([]);
        expect(plan([dormant('s', 1, { lastInteractionAt: NOW - guard })])).toHaveLength(1);
        expect(plan([dormant('s', 1, { lastInteractionAt: NOW + 1 })])).toHaveLength(1);
      });

      it('is not lifted by critical pressure', () => {
        expect(plan([dormant('s', 1, protect('editing'))], { pressure: 'critical' })).toStrictEqual(
          [],
        );
        expect(plan([dormant('s', 1, protect('editing'))])).toStrictEqual([]);
      });

      it('keeps one tab from stopping another', () => {
        const kept = dormant('a', 1, protect('open-popup'));
        const archived = dormant('b', 2);

        expect(plan([kept, archived])).toStrictEqual([act(archived, 'archive', 'archive-dormant')]);
      });
    });

    describe('a tab gets one action', () => {
      it('is discarded first when it is a live Sleeping tab hidden long enough', () => {
        const live = dormant('s', 1, { runtime: 'live', ...hiddenFor(2 * HOUR) });

        expect(plan([live])).toStrictEqual([act(live, 'discard', 'discard-hidden')]);
      });

      it('is archived on the next evaluation, once it is unloaded', () => {
        const unloaded = dormant('s', 1, { runtime: 'unloaded', ...hiddenFor(2 * HOUR), epoch: 2 });

        expect(plan([unloaded])).toStrictEqual([act(unloaded, 'archive', 'archive-dormant')]);
      });
    });

    it('has no budget: every Sleeping tab that qualifies is archived', () => {
      expect(plan(['a', 'b', 'c', 'd', 'e'].map((id) => dormant(id)))).toHaveLength(5);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('rule 4, pressure-discard', () => {
    /** A live tab hidden 20 minutes: enough for either level, too little for a plain discard. */
    const idleTab = (
      id: string,
      lastUsedMinutesAgo: number,
      overrides: Partial<TabFacts> = {},
    ): TabFacts =>
      tab({
        id,
        ...hiddenFor(20 * MINUTE),
        lastUsedAt: NOW - lastUsedMinutesAgo * MINUTE,
        ...overrides,
      });

    it('plans nothing at pressure none for tabs hidden 20 minutes', () => {
      expect(plan([idleTab('a', 30)], { pressure: 'none' })).toStrictEqual([]);
    });

    describe('moderate pressure', () => {
      it('discards a tab hidden exactly 15 minutes, as a pressure-discard that does not override soft protections', () => {
        const target = tab({ epoch: 3, ...hiddenFor(PRESSURE.moderate.minHiddenMs) });

        expect(plan([target], { pressure: 'moderate' })).toStrictEqual([
          {
            tabId: 'tab',
            kind: 'discard',
            rule: 'pressure-discard',
            epoch: 3,
            overrideSoft: false,
          },
        ]);
      });

      it('leaves a tab hidden 1 ms less than that', () => {
        expect(
          plan([tab(hiddenFor(PRESSURE.moderate.minHiddenMs - 1))], { pressure: 'moderate' }),
        ).toStrictEqual([]);
      });

      it('discards only one tab, the least recently used', () => {
        const tabs = [idleTab('x', 60), idleTab('y', 180), idleTab('z', 120)];

        expect(summary(plan(tabs, { pressure: 'moderate' }))).toStrictEqual(['pressure-discard:y']);
      });

      it('respects soft protections: an editor in focus, a sensitive page, a recent interaction', () => {
        for (const reason of ['editing', 'sensitive-page', 'recent-interaction'] as const) {
          expect(plan([idleTab('a', 30, protect(reason))], { pressure: 'moderate' })).toStrictEqual(
            [],
          );
        }
        expect(
          plan([idleTab('a', 30, { lastInteractionAt: NOW - MINUTE })], { pressure: 'moderate' }),
        ).toStrictEqual([]);
      });

      it.each(REASONS)('with the %s protection', (reason) => {
        // Every reason blocks a discard, and moderate pressure lifts none of them.
        expect(plan([idleTab('a', 30, protect(reason))], { pressure: 'moderate' })).toStrictEqual(
          [],
        );
      });

      it('does not spend its one discard on a protected tab', () => {
        const tabs = [
          idleTab('a', 300, protect('editing')),
          idleTab('b', 200, protect('audio')),
          idleTab('c', 100),
        ];

        expect(summary(plan(tabs, { pressure: 'moderate' }))).toStrictEqual(['pressure-discard:c']);
      });
    });

    describe('critical pressure', () => {
      const critical = { pressure: 'critical' } as const;

      it('discards a tab hidden exactly 2 minutes, and says it overrides soft protections', () => {
        const target = tab({ epoch: 8, ...hiddenFor(PRESSURE.critical.minHiddenMs) });

        expect(plan([target], critical)).toStrictEqual([
          { tabId: 'tab', kind: 'discard', rule: 'pressure-discard', epoch: 8, overrideSoft: true },
        ]);
      });

      it('leaves a tab hidden 1 ms less than that', () => {
        expect(plan([tab(hiddenFor(PRESSURE.critical.minHiddenMs - 1))], critical)).toStrictEqual(
          [],
        );
      });

      it('discards three tabs, the three least recently used, in that order', () => {
        const tabs = [
          idleTab('a', 50),
          idleTab('b', 400),
          idleTab('c', 90),
          idleTab('d', 300),
          idleTab('e', 200),
        ];

        expect(summary(plan(tabs, critical))).toStrictEqual([
          'pressure-discard:b',
          'pressure-discard:d',
          'pressure-discard:e',
        ]);
      });

      it('discards two tabs when only two qualify', () => {
        expect(
          plan([idleTab('a', 50), idleTab('b', 40), tab({ id: 'fresh' })], critical),
        ).toHaveLength(2);
      });

      it.each(REASONS)(
        'with the %s protection: a hard one still blocks, a soft one does not',
        (reason) => {
          const target = idleTab('a', 30, protect(reason));

          expect(plan([target], critical)).toStrictEqual(
            PROTECTION_TABLE[reason].hard ? [] : [act(target, 'discard', 'pressure-discard', true)],
          );
        },
      );

      it('ignores a recent interaction, which is soft', () => {
        const target = idleTab('a', 30, { lastInteractionAt: NOW - MINUTE });

        expect(plan([target], critical)).toStrictEqual([
          act(target, 'discard', 'pressure-discard', true),
        ]);
      });

      it('overrides a soft protection that stops the plain discard of a tab hidden for hours', () => {
        const target = tab({ ...hiddenFor(5 * HOUR), ...protect('editing') });

        expect(plan([target])).toStrictEqual([]);
        expect(plan([target], critical)).toStrictEqual([
          act(target, 'discard', 'pressure-discard', true),
        ]);
      });

      it('does not spend its budget on a tab with a hard protection', () => {
        const tabs = [
          idleTab('a', 500, protect('unsaved-input')),
          idleTab('b', 400, protect('audio')),
          idleTab('c', 300, protect('devtools')),
          idleTab('d', 200),
          idleTab('e', 100),
        ];

        expect(summary(plan(tabs, critical))).toStrictEqual([
          'pressure-discard:d',
          'pressure-discard:e',
        ]);
      });

      it('marks even a pressure discard with no soft protection as overriding them', () => {
        expect(plan([idleTab('a', 30)], critical)[0]?.overrideSoft).toBe(true);
      });
    });

    describe.each(['moderate', 'critical'] as const)('under %s pressure', (pressure) => {
      const minHidden = PRESSURE[pressure].minHiddenMs;

      it.each([
        ['selected', { selected: true }],
        ['not showing a web page', { webPage: false }],
        ['loading', { loading: true }],
        ['under a lifecycle operation', { busy: true }],
        ['pinned (Balanced does not discard pinned tabs)', { pinned: true }],
        ['never hidden', { hiddenSince: null }],
      ] as const)('does not discard a tab that is %s', (_label, overrides) => {
        expect(
          plan([tab({ ...hiddenFor(minHidden + HOUR), ...overrides })], { pressure }),
        ).toStrictEqual([]);
      });

      it.each(RUNTIME_STATES)(
        'with the tab %s, discards it only if it is live or frozen',
        (runtime) => {
          const target = tab({ runtime, ...hiddenFor(minHidden + HOUR) });
          const holdsRenderer: readonly RuntimeState[] = ['live', 'frozen'];

          expect(plan([target], { pressure })).toHaveLength(
            holdsRenderer.includes(runtime) ? 1 : 0,
          );
        },
      );

      it('discards a pinned tab when the preset allows it', () => {
        const target = tab({ pinned: true, ...hiddenFor(minHidden + HOUR) });
        const settings = settingsOf('aggressive');

        expect(plan([target], { pressure, settings })).toStrictEqual([
          act(target, 'discard', 'pressure-discard', pressure === 'critical'),
        ]);
      });

      it('ties on last use go to the lowest id', () => {
        const same = NOW - 3 * HOUR;
        const tabs = ['c', 'a', 'd', 'b'].map((id) =>
          tab({ id, ...hiddenFor(20 * MINUTE), lastUsedAt: same }),
        );
        const expected = ['pressure-discard:a', 'pressure-discard:b', 'pressure-discard:c'];

        expect(summary(plan(tabs, { pressure }))).toStrictEqual(
          expected.slice(0, PRESSURE[pressure].budget),
        );
      });

      it('takes a tab for itself so the plain discard does not plan it again', () => {
        const target = tab(hiddenFor(3 * HOUR));

        expect(plan([target], { pressure })).toStrictEqual([
          act(target, 'discard', 'pressure-discard', pressure === 'critical'),
        ]);
      });

      it('plans a tab on the shelf like any other live tab', () => {
        const target = tab({ placement: 'shelf', ...hiddenFor(minHidden + HOUR) });

        expect(summary(plan([target], { pressure }))).toStrictEqual(['pressure-discard:tab']);
      });
    });

    it('orders by least recent use, not by how long the tab has been hidden', () => {
      // Hidden: x 50 min, z 30 min, y 20 min. Last used: y 3 h ago, z 2 h ago, x 1 h ago.
      const tabs = [
        tab({ id: 'x', ...hiddenFor(50 * MINUTE), lastUsedAt: NOW - HOUR }),
        tab({ id: 'y', ...hiddenFor(20 * MINUTE), lastUsedAt: NOW - 3 * HOUR }),
        tab({ id: 'z', ...hiddenFor(30 * MINUTE), lastUsedAt: NOW - 2 * HOUR }),
      ];

      expect(summary(plan(tabs, { pressure: 'critical' }))).toStrictEqual([
        'pressure-discard:y',
        'pressure-discard:z',
        'pressure-discard:x',
      ]);
    });

    it('leaves the rest to the plain discard: four tabs hidden for hours at critical pressure', () => {
      const tabs = ['a', 'b', 'c', 'd'].map((id, index) =>
        tab({ id, ...hiddenFor((2 + index) * HOUR), lastUsedAt: NOW - (10 - index) * HOUR }),
      );

      // Least recently used: a (10 h), b, c. Then d is discarded as a plain discard.
      expect(summary(plan(tabs, { pressure: 'critical' }))).toStrictEqual([
        'pressure-discard:a',
        'pressure-discard:b',
        'pressure-discard:c',
        'discard-hidden:d',
      ]);
    });

    it('never produces anything but a discard, and never shelves or archives by itself', () => {
      // Within the cap, fresh in engaged time and active days: nothing for shelve or archive.
      const tabs = [
        idleTab('a', 30),
        idleTab('b', 40),
        tab({ id: 'shelf', placement: 'shelf', runtime: 'unloaded' }),
        tab({ id: 'pinned', pinned: true }),
      ];

      for (const pressure of ['moderate', 'critical'] as const) {
        const actions = plan(tabs, { pressure });

        expect(actions.length).toBeGreaterThan(0);
        expect(actions.every((action) => action.kind === 'discard')).toBe(true);
      }
    });

    it('does not change which tabs are shelved or archived when it takes none of them', () => {
      const settings = settingsOf('balanced', { stripCap: 2 });
      const staleOutside = (id: string, minutesAgo: number): TabFacts =>
        tab({ id, lastUsedAt: NOW - minutesAgo * MINUTE, lastUsedEngaged: ENGAGED_NOW - 5 * HOUR });
      const tabs = [
        staleOutside('a', 1),
        staleOutside('b', 2),
        staleOutside('c', 3),
        staleOutside('d', 4),
        tab({
          id: 'sleeper',
          placement: 'shelf',
          runtime: 'unloaded',
          lastUsedActiveDay: ACTIVE_DAY - 5,
        }),
      ];

      const calm = summary(plan(tabs, { settings }));

      expect(calm).toStrictEqual([
        'shelve-beyond-cap:d',
        'shelve-beyond-cap:c',
        'archive-dormant:sleeper',
      ]);
      // The same plan under pressure, for tabs that are not hidden long enough to be taken by it.
      for (const pressure of ['moderate', 'critical'] as const) {
        expect(summary(plan(tabs, { settings, pressure }))).toStrictEqual(calm);
      }
    });

    it('takes a tab that would have been shelved, and then shelves nothing of it', () => {
      const settings = settingsOf('balanced', { stripCap: 2 });
      const tabs = [
        tab({ id: 'a', lastUsedAt: NOW - MINUTE }),
        tab({ id: 'b', lastUsedAt: NOW - 2 * MINUTE }),
        tab({
          id: 'c',
          ...hiddenFor(20 * MINUTE),
          lastUsedAt: NOW - 3 * MINUTE,
          lastUsedEngaged: ENGAGED_NOW - 5 * HOUR,
        }),
      ];

      expect(summary(plan(tabs, { settings }))).toStrictEqual(['shelve-beyond-cap:c']);
      expect(summary(plan(tabs, { settings, pressure: 'critical' }))).toStrictEqual([
        'pressure-discard:c',
      ]);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('rule 5, freeze-hidden', () => {
    const FREEZING = settingsOf('balanced', { freeze: true });

    it('is off by default: a live tab hidden for 20 minutes is left alone', () => {
      expect(plan([tab(hiddenFor(20 * MINUTE))])).toStrictEqual([]);
      expect(
        plan([tab(hiddenFor(20 * MINUTE))], { settings: DEFAULT_LIFECYCLE_SETTINGS }),
      ).toStrictEqual([]);
    });

    it('freezes a live tab hidden exactly 10 minutes, once freezing is on', () => {
      const target = tab({ epoch: 4, ...hiddenFor(10 * MINUTE) });

      expect(plan([target], { settings: FREEZING })).toStrictEqual([
        { tabId: 'tab', kind: 'freeze', rule: 'freeze-hidden', epoch: 4, overrideSoft: false },
      ]);
    });

    it('leaves a tab hidden 1 ms under 10 minutes, and freezes one 1 ms over', () => {
      expect(plan([tab(hiddenFor(10 * MINUTE - 1))], { settings: FREEZING })).toStrictEqual([]);
      expect(plan([tab(hiddenFor(10 * MINUTE + 1))], { settings: FREEZING })).toHaveLength(1);
    });

    it('takes the time from the settings', () => {
      const settings = settingsOf('balanced', { freeze: true, freezeAfterMs: 5 * MINUTE });

      expect(plan([tab(hiddenFor(5 * MINUTE))], { settings })).toHaveLength(1);
      expect(plan([tab(hiddenFor(5 * MINUTE - 1))], { settings })).toHaveLength(0);
    });

    it.each(RUNTIME_STATES)('with the tab %s, freezes it only if it is live', (runtime) => {
      const target = tab({ runtime, ...hiddenFor(20 * MINUTE) });

      expect(plan([target], { settings: FREEZING })).toStrictEqual(
        runtime === 'live' ? [act(target, 'freeze', 'freeze-hidden')] : [],
      );
    });

    it.each([
      ['selected', { selected: true }],
      ['not showing a web page', { webPage: false }],
      ['loading', { loading: true }],
      ['under a lifecycle operation', { busy: true }],
      ['never hidden', { hiddenSince: null }],
    ] as const)('does not freeze a tab that is %s', (_label, overrides) => {
      expect(
        plan([tab({ ...hiddenFor(20 * MINUTE), ...overrides })], { settings: FREEZING }),
      ).toStrictEqual([]);
    });

    it('freezes a pinned tab: only a discard is held back for pinned tabs', () => {
      const target = tab({ pinned: true, ...hiddenFor(20 * MINUTE) });

      expect(plan([target], { settings: FREEZING })).toStrictEqual([
        act(target, 'freeze', 'freeze-hidden'),
      ]);
    });

    it.each(REASONS)('with the %s protection', (reason) => {
      const target = tab({ ...hiddenFor(20 * MINUTE), ...protect(reason) });
      const blocked = PROTECTION_TABLE[reason].blocks.includes('freeze');

      expect(plan([target], { settings: FREEZING })).toStrictEqual(
        blocked ? [] : [act(target, 'freeze', 'freeze-hidden')],
      );
    });

    it('is blocked by audio and capture only: a recent interaction does not keep a tab from freezing', () => {
      const interacted = tab({ ...hiddenFor(20 * MINUTE), lastInteractionAt: NOW - MINUTE });

      expect(plan([interacted], { settings: FREEZING })).toStrictEqual([
        act(interacted, 'freeze', 'freeze-hidden'),
      ]);
    });

    it('does not freeze a tab that is being discarded: one action per tab', () => {
      const target = tab(hiddenFor(2 * HOUR));

      expect(plan([target], { settings: FREEZING })).toStrictEqual([
        act(target, 'discard', 'discard-hidden'),
      ]);
    });

    it('freezes a tab whose discard is blocked, if the freeze is not (DevTools, a soft protection)', () => {
      for (const reason of ['devtools', 'sensitive-page', 'editing'] as const) {
        const target = tab({ ...hiddenFor(2 * HOUR), ...protect(reason) });

        expect(plan([target], { settings: FREEZING })).toStrictEqual([
          act(target, 'freeze', 'freeze-hidden'),
        ]);
      }
    });

    it('freezes a pinned tab Balanced will not discard, even hidden for hours', () => {
      const target = tab({ pinned: true, ...hiddenFor(5 * HOUR) });

      expect(plan([target], { settings: FREEZING })).toStrictEqual([
        act(target, 'freeze', 'freeze-hidden'),
      ]);
    });

    it('does not freeze a tab taken by pressure', () => {
      const target = tab(hiddenFor(20 * MINUTE));

      expect(summary(plan([target], { settings: FREEZING, pressure: 'moderate' }))).toStrictEqual([
        'pressure-discard:tab',
      ]);
      expect(summary(plan([target], { settings: FREEZING, pressure: 'critical' }))).toStrictEqual([
        'pressure-discard:tab',
      ]);
    });

    it('freezes a tab pressure was too light to take', () => {
      // Hidden 12 minutes: under moderate pressure's 15, over freezing's 10.
      const target = tab(hiddenFor(12 * MINUTE));

      expect(plan([target], { settings: FREEZING, pressure: 'moderate' })).toStrictEqual([
        act(target, 'freeze', 'freeze-hidden'),
      ]);
    });

    it('freezes a tab pressure had no budget for', () => {
      const tabs = [
        tab({ id: 'a', ...hiddenFor(20 * MINUTE), lastUsedAt: NOW - 5 * HOUR }),
        tab({ id: 'b', ...hiddenFor(20 * MINUTE), lastUsedAt: NOW - 4 * HOUR }),
      ];

      expect(summary(plan(tabs, { settings: FREEZING, pressure: 'moderate' }))).toStrictEqual([
        'pressure-discard:a',
        'freeze-hidden:b',
      ]);
    });

    it('has no budget: every tab that qualifies is frozen', () => {
      expect(
        plan(
          ['a', 'b', 'c', 'd'].map((id) => tab({ id, ...hiddenFor(20 * MINUTE) })),
          { settings: FREEZING },
        ),
      ).toHaveLength(4);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('paused', () => {
    const stale = tab({ ...hiddenFor(5 * HOUR), lastUsedEngaged: 0, lastUsedAt: NOW - 5 * HOUR });
    const everything = (): TabFacts[] => [
      stale,
      tab({ id: 'b', ...hiddenFor(20 * MINUTE) }),
      tab({ id: 'c', placement: 'shelf', runtime: 'unloaded', lastUsedActiveDay: 1 }),
      tab({ id: 'd', ...hiddenFor(HOUR), lastUsedEngaged: 0, lastUsedAt: NOW - 9 * HOUR }),
    ];

    it.each(['none', 'moderate', 'critical'] as const)(
      'plans nothing at pressure %s',
      (pressure) => {
        const paused = settingsOf('aggressive', { paused: true, freeze: true, stripCap: 0 });

        expect(plan(everything(), { settings: paused, pressure })).toStrictEqual([]);
      },
    );

    it('plans something for the same tabs once it is not paused', () => {
      const running = settingsOf('aggressive', { paused: false, freeze: true, stripCap: 0 });

      for (const pressure of ['none', 'moderate', 'critical'] as const) {
        expect(plan(everything(), { settings: running, pressure }).length).toBeGreaterThan(0);
      }
    });

    it('plans nothing for the tab that would otherwise be discarded', () => {
      expect(plan([stale], { settings: settingsOf('balanced', { paused: true }) })).toStrictEqual(
        [],
      );
      expect(plan([stale])).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('the order of the actions', () => {
    /**
     * Every rule fires: moderate pressure takes `p-lru`; `d-long` and `d-short` are hidden for
     * hours; `f-long` and `f-short` for a while (freezing is on); `s-old` and `s-new` are stale
     * and outside a cap of 3 (the k tabs are kept); `a-old` and `a-new` sleep and are dormant.
     */
    function scene() {
      const kept = (id: string, epoch: number, minutesAgo: number): TabFacts =>
        tab({ id, epoch, lastUsedAt: NOW - minutesAgo * MINUTE });
      const old = (id: string, epoch: number, overrides: Partial<TabFacts>): TabFacts =>
        tab({ id, epoch, lastUsedEngaged: ENGAGED_NOW - 10 * HOUR, ...overrides });
      const named = {
        k1: kept('k1', 11, 1),
        k2: kept('k2', 12, 2),
        k3: kept('k3', 13, 3),
        pLru: old('p-lru', 21, { ...hiddenFor(20 * MINUTE), lastUsedAt: NOW - 20 * HOUR }),
        dShort: old('d-short', 22, { ...hiddenFor(2 * HOUR), lastUsedAt: NOW - 10 * HOUR }),
        dLong: old('d-long', 23, { ...hiddenFor(5 * HOUR), lastUsedAt: NOW - 9 * HOUR }),
        fLong: old('f-long', 24, { ...hiddenFor(30 * MINUTE), lastUsedAt: NOW - 8 * HOUR }),
        fShort: old('f-short', 25, { ...hiddenFor(12 * MINUTE), lastUsedAt: NOW - 7 * HOUR }),
        sOld: old('s-old', 26, { runtime: 'unloaded', lastUsedAt: NOW - 30 * HOUR }),
        sNew: old('s-new', 27, { runtime: 'unloaded', lastUsedAt: NOW - 25 * HOUR }),
        aOld: old('a-old', 28, {
          placement: 'shelf',
          runtime: 'unloaded',
          lastUsedAt: NOW - 40 * HOUR,
          lastUsedActiveDay: ACTIVE_DAY - 10,
        }),
        aNew: old('a-new', 29, {
          placement: 'shelf',
          runtime: 'unloaded',
          lastUsedAt: NOW - 35 * HOUR,
          lastUsedActiveDay: ACTIVE_DAY - 10,
        }),
      };
      return {
        named,
        settings: settingsOf('balanced', { freeze: true, stripCap: 3 }),
        // Not in the order the plan will have.
        tabs: [
          named.aNew,
          named.k2,
          named.sNew,
          named.fShort,
          named.dShort,
          named.k1,
          named.pLru,
          named.aOld,
          named.dLong,
          named.k3,
          named.sOld,
          named.fLong,
        ],
      };
    }

    it('is pressure discards, then discards, freezes, shelves and archives, each in its own order', () => {
      const { named, settings, tabs } = scene();

      expect(plan(tabs, { settings, pressure: 'moderate' })).toStrictEqual([
        act(named.pLru, 'discard', 'pressure-discard'),
        act(named.dLong, 'discard', 'discard-hidden'),
        act(named.dShort, 'discard', 'discard-hidden'),
        act(named.fLong, 'freeze', 'freeze-hidden'),
        act(named.fShort, 'freeze', 'freeze-hidden'),
        act(named.sOld, 'shelve', 'shelve-beyond-cap'),
        act(named.sNew, 'shelve', 'shelve-beyond-cap'),
        act(named.aOld, 'archive', 'archive-dormant'),
        act(named.aNew, 'archive', 'archive-dormant'),
      ]);
    });

    it('is the same whatever order the tabs arrive in', () => {
      const { settings, tabs } = scene();
      const forward = plan(tabs, { settings, pressure: 'moderate' });

      expect(plan([...tabs].reverse(), { settings, pressure: 'moderate' })).toStrictEqual(forward);
      expect(
        plan(
          [...tabs].sort((a, b) => a.id.localeCompare(b.id)),
          { settings, pressure: 'moderate' },
        ),
      ).toStrictEqual(forward);
    });

    it('has one action for each tab at most, and none for the kept tabs', () => {
      const { named, settings, tabs } = scene();
      const actions = plan(tabs, { settings, pressure: 'moderate' });

      expect(new Set(actions.map((action) => action.tabId)).size).toBe(actions.length);
      expect(actions.map((action) => action.tabId)).not.toContain(named.k1.id);
      expect(actions).toHaveLength(9);
    });

    it("carries each tab's own epoch", () => {
      const { named, settings, tabs } = scene();
      const epochs = new Map(Object.values(named).map((target) => [target.id, target.epoch]));

      for (const action of plan(tabs, { settings, pressure: 'moderate' })) {
        expect(action.epoch).toBe(epochs.get(action.tabId));
      }
    });

    it("puts each rule's action kind where it belongs", () => {
      const { settings, tabs } = scene();
      const kinds: Record<string, string> = {
        'pressure-discard': 'discard',
        'discard-hidden': 'discard',
        'freeze-hidden': 'freeze',
        'shelve-beyond-cap': 'shelve',
        'archive-dormant': 'archive',
      };

      for (const action of plan(tabs, { settings, pressure: 'moderate' })) {
        expect(action.kind).toBe(kinds[action.rule]);
      }
    });

    it('breaks ties between equally recent or equally long hidden tabs by id', () => {
      const shuffled = ['c', 'a', 'd', 'b'];
      const discards = shuffled.map((id) =>
        tab({ id, ...hiddenFor(2 * HOUR), lastUsedAt: NOW - HOUR }),
      );
      const freezes = shuffled.map((id) =>
        tab({ id, ...hiddenFor(20 * MINUTE), lastUsedAt: NOW - HOUR }),
      );
      const archives = shuffled.map((id) =>
        tab({
          id,
          placement: 'shelf',
          runtime: 'unloaded',
          lastUsedActiveDay: 1,
          lastUsedAt: NOW - HOUR,
        }),
      );

      expect(summary(plan(discards))).toStrictEqual(
        ['a', 'b', 'c', 'd'].map((id) => `discard-hidden:${id}`),
      );
      expect(
        summary(plan(freezes, { settings: settingsOf('balanced', { freeze: true }) })),
      ).toStrictEqual(['a', 'b', 'c', 'd'].map((id) => `freeze-hidden:${id}`));
      expect(summary(plan(archives))).toStrictEqual(
        ['a', 'b', 'c', 'd'].map((id) => `archive-dormant:${id}`),
      );
    });

    it('discards the longest hidden first even when it was used more recently', () => {
      const tabs = [
        tab({ id: 'recent-long', ...hiddenFor(9 * HOUR), lastUsedAt: NOW - HOUR }),
        tab({ id: 'old-short', ...hiddenFor(2 * HOUR), lastUsedAt: NOW - 8 * HOUR }),
      ];

      expect(summary(plan(tabs))).toStrictEqual([
        'discard-hidden:recent-long',
        'discard-hidden:old-short',
      ]);
    });

    it('archives the longest unused first', () => {
      const archives = [
        tab({
          id: 'b',
          placement: 'shelf',
          runtime: 'unloaded',
          lastUsedActiveDay: 1,
          lastUsedAt: NOW - HOUR,
        }),
        tab({
          id: 'a',
          placement: 'shelf',
          runtime: 'unloaded',
          lastUsedActiveDay: 1,
          lastUsedAt: NOW - 9 * HOUR,
        }),
        tab({
          id: 'c',
          placement: 'shelf',
          runtime: 'unloaded',
          lastUsedActiveDay: 1,
          lastUsedAt: NOW - 20 * HOUR,
        }),
      ];

      expect(summary(plan(archives))).toStrictEqual([
        'archive-dormant:c',
        'archive-dormant:a',
        'archive-dormant:b',
      ]);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// A property test over random tab sets
// ---------------------------------------------------------------------------------------------

describe('planLifecycle over random tab sets', () => {
  const CASES = 2000;
  const PRESSURES: readonly MemoryPressure[] = ['none', 'none', 'moderate', 'critical'];
  const RUNTIMES: readonly RuntimeState[] = [
    'live',
    'live',
    'live',
    'live',
    'live',
    'frozen',
    'unloaded',
    'unloaded',
    'creating',
    'discarding',
    'crashed',
  ];
  const RULE_ORDER: readonly LifecycleRule[] = [
    'pressure-discard',
    'discard-hidden',
    'freeze-hidden',
    'shelve-beyond-cap',
    'archive-dormant',
  ];
  const KIND_OF: Readonly<Record<LifecycleRule, LifecycleActionKind>> = {
    'pressure-discard': 'discard',
    'discard-hidden': 'discard',
    'freeze-hidden': 'freeze',
    'shelve-beyond-cap': 'shelve',
    'archive-dormant': 'archive',
  };

  function randomTab(
    random: Random,
    index: number,
    settings: LifecycleSettings,
    selected: boolean,
  ): TabFacts {
    const guard = settings.interactionGuardMs;
    /** A duration near one of the thresholds (to the millisecond) or just anywhere under 6 hours. */
    const near = (anchors: readonly number[]): number =>
      chance(random, 0.65)
        ? Math.max(0, pick(random, anchors) + pick(random, [-1, 0, 1]))
        : int(random, 6 * HOUR);
    const hiddenAnchors = [
      PRESSURE.moderate.minHiddenMs,
      PRESSURE.critical.minHiddenMs,
      settings.discardAfterMs,
      settings.freezeAfterMs,
    ];
    const days = settings.archiveAfterActiveDays;

    let hiddenSince: number | null;
    if (selected) {
      hiddenSince = chance(random, 0.85) ? null : NOW - near(hiddenAnchors);
    } else if (chance(random, 0.12)) {
      hiddenSince = null;
    } else if (chance(random, 0.03)) {
      hiddenSince = NOW + 5 * SECOND;
    } else {
      hiddenSince = NOW - near(hiddenAnchors);
    }

    let lastInteractionAt: number | null = null;
    if (chance(random, 0.5)) {
      lastInteractionAt = chance(random, 0.05)
        ? NOW + 5 * SECOND
        : NOW - pick(random, [0, 1, guard - 1, guard, guard + 1, 5 * MINUTE, int(random, HOUR)]);
    }

    return {
      id: `t${String(index).padStart(2, '0')}`,
      placement: chance(random, 0.25) ? 'shelf' : 'strip',
      runtime: pick(random, RUNTIMES),
      pinned: chance(random, 0.12),
      selected,
      webPage: chance(random, 0.92),
      loading: chance(random, 0.08),
      busy: chance(random, 0.07),
      epoch: int(random, 1000),
      hiddenSince,
      lastUsedAt: chance(random, 0.35)
        ? NOW - int(random, 5) * HOUR
        : NOW - int(random, 48 * 60) * MINUTE,
      lastUsedEngaged: chance(random, 0.03)
        ? ENGAGED_NOW + SECOND
        : ENGAGED_NOW - near([settings.shelveAfterEngagedMs]),
      lastUsedActiveDay: chance(random, 0.03)
        ? ACTIVE_DAY + 1
        : ACTIVE_DAY -
          (chance(random, 0.6) ? pick(random, [days - 1, days, days + 1]) : int(random, 25)),
      lastInteractionAt,
      protections: chance(random, 0.6)
        ? []
        : Array.from({ length: 1 + int(random, 2) }, () => protectionFor(pick(random, REASONS))),
    };
  }

  function randomInput(random: Random): PlanInput {
    const preset = pick(random, PRESETS);
    const settings = resolveLifecycleSettings({
      preset,
      autoArchive: chance(random, 0.7),
      freeze: chance(random, 0.4),
      paused: chance(random, 0.05),
      overrides: {
        ...(chance(random, 0.5) ? { stripCap: int(random, 6) } : {}),
        ...(chance(random, 0.15) ? { discardPinned: !TABLE[preset].discardPinned } : {}),
      },
    });
    const count = int(random, 27);
    const selectedIndex = count > 0 && chance(random, 0.9) ? int(random, count) : -1;
    return {
      tabs: Array.from({ length: count }, (_, index) =>
        randomTab(random, index, settings, index === selectedIndex),
      ),
      settings,
      clock: clockAt(),
      pressure: pick(random, PRESSURES),
    };
  }

  /** Whether a protection of `target` (or the recent-interaction guard) blocks `kind`. */
  function blocked(
    target: TabFacts,
    kind: LifecycleActionKind,
    overrideSoft: boolean,
    input: PlanInput,
  ): boolean {
    const entries = target.protections.map((protection) => PROTECTION_TABLE[protection.reason]);
    const { lastInteractionAt } = target;
    if (
      lastInteractionAt !== null &&
      lastInteractionAt <= input.clock.wallNow &&
      input.clock.wallNow - lastInteractionAt < input.settings.interactionGuardMs
    ) {
      entries.push(PROTECTION_TABLE['recent-interaction']);
    }
    return entries.some((entry) => entry.blocks.includes(kind) && (entry.hard || !overrideSoft));
  }

  /** The conditions of each rule, derived from the facts without going through the policy. */
  function conditions(input: PlanInput) {
    const { tabs, settings, clock } = input;
    const hiddenAtLeast = (target: TabFacts, ms: number): boolean =>
      target.hiddenSince !== null && clock.wallNow - target.hiddenSince >= ms;
    const actionable = (target: TabFacts): boolean =>
      !target.selected && target.webPage && !target.loading && !target.busy;
    const holdsRenderer = (target: TabFacts): boolean =>
      target.runtime === 'live' || target.runtime === 'frozen';
    const discardable = (target: TabFacts): boolean =>
      actionable(target) && holdsRenderer(target) && (!target.pinned || settings.discardPinned);
    /** How many unpinned strip tabs come before `target` in recency; the selected one comes first. */
    const placesAhead = (target: TabFacts): number =>
      tabs.filter(
        (other) =>
          other.id !== target.id &&
          other.placement === 'strip' &&
          !other.pinned &&
          (other.selected ||
            other.lastUsedAt > target.lastUsedAt ||
            (other.lastUsedAt === target.lastUsedAt && other.id < target.id)),
      ).length;
    return {
      pressure: (target: TabFacts, level: 'moderate' | 'critical'): boolean =>
        discardable(target) &&
        hiddenAtLeast(target, PRESSURE[level].minHiddenMs) &&
        !blocked(target, 'discard', level === 'critical', input),
      discardHidden: (target: TabFacts): boolean =>
        discardable(target) &&
        hiddenAtLeast(target, settings.discardAfterMs) &&
        !blocked(target, 'discard', false, input),
      freeze: (target: TabFacts): boolean =>
        settings.freeze &&
        actionable(target) &&
        target.runtime === 'live' &&
        hiddenAtLeast(target, settings.freezeAfterMs) &&
        !blocked(target, 'freeze', false, input),
      shelve: (target: TabFacts): boolean =>
        target.placement === 'strip' &&
        !target.pinned &&
        !target.selected &&
        !target.busy &&
        placesAhead(target) >= settings.stripCap &&
        clock.engagedNow - target.lastUsedEngaged >= settings.shelveAfterEngagedMs &&
        !blocked(target, 'shelve', false, input),
      archive: (target: TabFacts): boolean =>
        settings.autoArchive &&
        target.placement === 'shelf' &&
        !target.pinned &&
        !target.selected &&
        !target.busy &&
        !target.loading &&
        clock.activeDay - target.lastUsedActiveDay >= settings.archiveAfterActiveDays &&
        !blocked(target, 'archive', false, input) &&
        !(holdsRenderer(target) && blocked(target, 'discard', false, input)),
    };
  }

  /** The rule each tab should get, worked out from scratch: the first that applies, in order. */
  function expectedRules(input: PlanInput): Map<string, LifecycleRule> {
    const { tabs, settings, pressure } = input;
    const rules = new Map<string, LifecycleRule>();
    if (settings.paused) {
      return rules;
    }
    const can = conditions(input);
    if (pressure !== 'none') {
      tabs
        .filter((target) => can.pressure(target, pressure))
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt || (a.id < b.id ? -1 : 1))
        .slice(0, PRESSURE[pressure].budget)
        .forEach((target) => rules.set(target.id, 'pressure-discard'));
    }
    for (const target of tabs) {
      if (rules.has(target.id)) {
        continue;
      }
      if (can.discardHidden(target)) {
        rules.set(target.id, 'discard-hidden');
      } else if (can.freeze(target)) {
        rules.set(target.id, 'freeze-hidden');
      } else if (can.shelve(target)) {
        rules.set(target.id, 'shelve-beyond-cap');
      } else if (can.archive(target)) {
        rules.set(target.id, 'archive-dormant');
      }
    }
    return rules;
  }

  /** What is wrong with `actions` as the plan for `input`: empty when nothing is. */
  function problemsWith(input: PlanInput, actions: readonly LifecycleAction[]): string[] {
    const problems: string[] = [];
    const { tabs, settings, pressure } = input;
    const byId = new Map(tabs.map((target) => [target.id, target]));
    const can = conditions(input);
    const seen = new Set<string>();
    let lastRank = 0;
    let pressureDiscards = 0;
    let previous: LifecycleAction | undefined;

    if (settings.paused && actions.length > 0) {
      problems.push('planned something while paused');
    }
    for (const action of actions) {
      const target = byId.get(action.tabId);
      if (target === undefined) {
        problems.push(`${action.tabId}: not one of the tabs`);
        continue;
      }
      if (seen.has(action.tabId)) {
        problems.push(`${action.tabId}: appears twice`);
      }
      seen.add(action.tabId);
      if (target.selected) {
        problems.push(`${action.tabId}: is the selected tab`);
      }
      if (action.kind !== KIND_OF[action.rule]) {
        problems.push(`${action.tabId}: ${action.rule} with kind ${action.kind}`);
      }
      if (action.epoch !== target.epoch) {
        problems.push(
          `${action.tabId}: epoch ${String(action.epoch)}, not ${String(target.epoch)}`,
        );
      }
      if (action.overrideSoft !== (action.rule === 'pressure-discard' && pressure === 'critical')) {
        problems.push(`${action.tabId}: overrideSoft is ${String(action.overrideSoft)}`);
      }

      // Its own rule's conditions hold.
      const holds =
        action.rule === 'pressure-discard'
          ? pressure !== 'none' && can.pressure(target, pressure)
          : action.rule === 'discard-hidden'
            ? can.discardHidden(target)
            : action.rule === 'freeze-hidden'
              ? can.freeze(target)
              : action.rule === 'shelve-beyond-cap'
                ? can.shelve(target)
                : can.archive(target);
      if (!holds) {
        problems.push(`${action.tabId}: the conditions of ${action.rule} do not hold`);
      }
      if (
        action.kind === 'discard' &&
        blocked(target, 'discard', false, input) &&
        action.rule === 'discard-hidden'
      ) {
        problems.push(`${action.tabId}: discarded despite a protection`);
      }
      if (action.kind === 'discard' && blocked(target, 'discard', true, input)) {
        problems.push(`${action.tabId}: discarded despite a hard protection`);
      }

      // The order: rules in sequence, and each rule's own order.
      const rank = RULE_ORDER.indexOf(action.rule);
      if (rank < lastRank) {
        problems.push(`${action.tabId}: ${action.rule} comes after a later rule`);
      }
      lastRank = Math.max(lastRank, rank);
      if (previous?.rule === action.rule) {
        const before = byId.get(previous.tabId);
        if (before !== undefined) {
          const wrongOrder =
            action.rule === 'discard-hidden' || action.rule === 'freeze-hidden'
              ? (before.hiddenSince ?? 0) > (target.hiddenSince ?? 0) ||
                ((before.hiddenSince ?? 0) === (target.hiddenSince ?? 0) && before.id > target.id)
              : action.rule === 'shelve-beyond-cap'
                ? before.lastUsedAt > target.lastUsedAt
                : before.lastUsedAt > target.lastUsedAt ||
                  (before.lastUsedAt === target.lastUsedAt && before.id > target.id);
          if (wrongOrder) {
            problems.push(
              `${previous.tabId} before ${action.tabId}: out of order for ${action.rule}`,
            );
          }
        }
      }
      if (action.rule === 'pressure-discard') {
        pressureDiscards += 1;
      }
      previous = action;
    }

    if (pressure === 'none' ? pressureDiscards > 0 : pressureDiscards > PRESSURE[pressure].budget) {
      problems.push(`${String(pressureDiscards)} pressure discards at pressure ${pressure}`);
    }

    // And the plan is complete: each tab gets exactly the rule it should, or nothing.
    const expected = expectedRules(input);
    for (const target of tabs) {
      const got = actions.find((action) => action.tabId === target.id)?.rule;
      if (got !== expected.get(target.id)) {
        problems.push(
          `${target.id}: got ${String(got)}, expected ${String(expected.get(target.id))}`,
        );
      }
    }
    return problems;
  }

  interface Run {
    readonly problems: string[];
    readonly rules: Record<LifecycleRule, number>;
    readonly paused: number;
    readonly byPressure: Record<MemoryPressure, number>;
    readonly budgetSpent: number;
    readonly selectedTabs: number;
  }
  let run: Run | undefined;

  /** All the cases, run once and shared by the tests below. */
  function runCases(): Run {
    if (run !== undefined) {
      return run;
    }
    const random = mulberry32(20_260_615);
    const problems: string[] = [];
    const rules: Record<LifecycleRule, number> = {
      'pressure-discard': 0,
      'discard-hidden': 0,
      'freeze-hidden': 0,
      'shelve-beyond-cap': 0,
      'archive-dormant': 0,
    };
    const byPressure: Record<MemoryPressure, number> = { none: 0, moderate: 0, critical: 0 };
    let paused = 0;
    let budgetSpent = 0;
    let selectedTabs = 0;

    for (let n = 0; n < CASES; n += 1) {
      const input = randomInput(random);
      const where = `case ${String(n)}`;
      const before = JSON.stringify(input);
      const actions = planLifecycle(input);

      if (JSON.stringify(input) !== before) {
        problems.push(`${where}: the input was changed`);
      }
      problems.push(...problemsWith(input, actions).map((problem) => `${where}: ${problem}`));

      // The same tabs in another order give the same plan.
      const reversed = planLifecycle({ ...input, tabs: [...input.tabs].reverse() });
      if (JSON.stringify(reversed) !== JSON.stringify(actions)) {
        problems.push(`${where}: the plan depends on the order of the tabs`);
      }

      // Pressure never shelves or archives: whatever it plans of those, calm would plan too.
      if (input.pressure !== 'none') {
        const calm = new Set(
          planLifecycle({ ...input, pressure: 'none' }).map(
            (action) => `${action.kind}:${action.tabId}`,
          ),
        );
        for (const action of actions) {
          if (
            (action.kind === 'shelve' || action.kind === 'archive') &&
            !calm.has(`${action.kind}:${action.tabId}`)
          ) {
            problems.push(`${where}: pressure caused ${action.kind} of ${action.tabId}`);
          }
        }
      }

      for (const action of actions) {
        rules[action.rule] += 1;
      }
      byPressure[input.pressure] += 1;
      if (input.settings.paused) {
        paused += 1;
      }
      if (
        input.pressure !== 'none' &&
        actions.filter((action) => action.rule === 'pressure-discard').length ===
          PRESSURE[input.pressure].budget
      ) {
        budgetSpent += 1;
      }
      selectedTabs += input.tabs.filter((target) => target.selected).length;
    }
    run = { problems, rules, paused, byPressure, budgetSpent, selectedTabs };
    return run;
  }

  it('plans each tab at most once, never the selected tab, and never more than the pressure budget', () => {
    const problems = runCases().problems.filter((problem) =>
      /appears twice|selected tab|pressure discards/.test(problem),
    );

    expect(problems.slice(0, 5)).toStrictEqual([]);
  });

  it('plans an action only when the conditions of its rule hold, and every tab that qualifies gets one', () => {
    expect(runCases().problems.slice(0, 5)).toStrictEqual([]);
  });

  it('never plans anything when paused, whatever the pressure', () => {
    expect(runCases().problems.filter((problem) => problem.includes('while paused'))).toStrictEqual(
      [],
    );
    expect(runCases().paused).toBeGreaterThan(50);
  });

  it('is the same plan for the same tabs in another order, and leaves its input alone', () => {
    expect(
      runCases().problems.filter((problem) =>
        /depends on the order|input was changed/.test(problem),
      ),
    ).toStrictEqual([]);
  });

  it('never lets pressure shelve or archive a tab that calm would not', () => {
    expect(
      runCases().problems.filter((problem) => problem.includes('pressure caused')),
    ).toStrictEqual([]);
  });

  it('exercised every rule, every pressure level, and a spent pressure budget (the test is not vacuous)', () => {
    const { rules, byPressure, budgetSpent, selectedTabs } = runCases();

    for (const rule of RULE_ORDER) {
      expect(rules[rule], rule).toBeGreaterThan(100);
    }
    expect(byPressure.none).toBeGreaterThan(500);
    expect(byPressure.moderate).toBeGreaterThan(300);
    expect(byPressure.critical).toBeGreaterThan(300);
    expect(budgetSpent).toBeGreaterThan(100);
    expect(selectedTabs).toBeGreaterThan(1000);
  });
});
