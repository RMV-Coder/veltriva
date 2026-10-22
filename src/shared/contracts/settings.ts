// The settings document (assessment §5.3: the `settings` table's one row). Main reads it at
// startup and is the only writer: the settings page (M5.1) sends a change, which main checks
// against the strict schemas below and rejects whole if anything in it, or the document it would
// make, is invalid. Reading is lenient instead: a field that is missing or invalid takes its
// default alone, so one bad value never resets the rest, and a document from a newer Veltriva
// keeps working (its unknown fields are ignored).
//
// The user's site rules (protect a site, exclude it from the memory) are rows of the site_rules
// table, not part of this document; migration 3 moved M3.4's `lifecycle.protectedSites` there.
import { z } from 'zod';

import { PRESETS } from '../../core/lifecycle/policy';
import { DEFAULT_SEARCH_TEMPLATE, isValidSearchTemplate } from '../../core/url/omnibox';

/** §5.7: a year of visits. */
export const DEFAULT_HISTORY_RETENTION_DAYS = 365;

/**
 * What a new window shows at startup (§7.2, M5.1): the tabs as they were, or a new tab, with the
 * tabs that were open put in the Archive, where the memory still finds them.
 */
export const STARTUP_BEHAVIORS = ['restore', 'new-tab'] as const;
export type StartupBehavior = (typeof STARTUP_BEHAVIORS)[number];

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * The memory pressure levels (§4.7, src/main/lifecycle/memory-pressure.ts): pressure is moderate
 * when less than this share of physical memory is available, and critical below the second.
 */
export const DEFAULT_PRESSURE_PERCENT = { moderate: 10, critical: 4 } as const;

/** The advanced numbers (M5.1): a preset's values, then the pressure thresholds. */
export const NUMERIC_OVERRIDES = [
  'discardAfterMs',
  'stripCap',
  'shelveAfterEngagedMs',
  'archiveAfterActiveDays',
  'interactionGuardMs',
  'moderatePressurePercent',
  'criticalPressurePercent',
] as const;
export type NumericOverride = (typeof NUMERIC_OVERRIDES)[number];

/**
 * The range of each advanced number. The settings page offers these, main rejects a change outside
 * them, and a stored value outside them is dropped on reading, so the preset's applies.
 */
export const OVERRIDE_LIMITS: Readonly<
  Record<NumericOverride, { readonly min: number; readonly max: number }>
> = {
  discardAfterMs: { min: MINUTE_MS, max: 7 * DAY_MS },
  stripCap: { min: 1, max: 500 },
  shelveAfterEngagedMs: { min: MINUTE_MS, max: 30 * DAY_MS },
  archiveAfterActiveDays: { min: 1, max: 365 },
  interactionGuardMs: { min: 0, max: DAY_MS },
  moderatePressurePercent: { min: 2, max: 50 },
  criticalPressurePercent: { min: 1, max: 25 },
};

const limited = (key: NumericOverride) =>
  z.number().int().min(OVERRIDE_LIMITS[key].min).max(OVERRIDE_LIMITS[key].max);

const searchTemplate = z.string().max(2048).refine(isValidSearchTemplate);
const retentionDays = z.number().int().min(1).max(36_500);
const previewSetting = z.enum(['auto', 'off']);

/** The overrides as stored: each one optional. */
const overridesShape = {
  discardAfterMs: limited('discardAfterMs').optional(),
  stripCap: limited('stripCap').optional(),
  shelveAfterEngagedMs: limited('shelveAfterEngagedMs').optional(),
  archiveAfterActiveDays: limited('archiveAfterActiveDays').optional(),
  interactionGuardMs: limited('interactionGuardMs').optional(),
  discardPinned: z.boolean().optional(),
  moderatePressurePercent: limited('moderatePressurePercent').optional(),
  criticalPressurePercent: limited('criticalPressurePercent').optional(),
};
type Overrides = z.infer<z.ZodObject<typeof overridesShape>>;

/** The pressure thresholds the overrides make, each falling back to its default. */
export function pressurePercent(overrides: Overrides): { moderate: number; critical: number } {
  return {
    moderate: overrides.moderatePressurePercent ?? DEFAULT_PRESSURE_PERCENT.moderate,
    critical: overrides.criticalPressurePercent ?? DEFAULT_PRESSURE_PERCENT.critical,
  };
}

/** Critical pressure means less memory available than moderate does. */
function pressureInOrder(overrides: Overrides): boolean {
  const { moderate, critical } = pressurePercent(overrides);
  return critical < moderate;
}

/**
 * The document as main keeps it and the settings page shows it: every field present and valid.
 * Main checks the document a change would make against this before keeping it.
 */
export const strictSettingsSchema = z.strictObject({
  search: z.strictObject({
    /** The omnibox's search URL, `{searchTerms}` where the query goes (core/url/omnibox.ts). */
    template: searchTemplate,
  }),
  history: z.strictObject({
    /** Visits older than this are deleted while the user is away (data/maintenance.ts). */
    retentionDays,
  }),
  startup: z.enum(STARTUP_BEHAVIORS),
  /** "Pause memory" (§6.6): while on, no page or visit is recorded. */
  memory: z.strictObject({ paused: z.boolean() }),
  /**
   * Tab lifecycle (assessment §4.7, M3.2): a preset, the switches, and advanced overrides of the
   * preset's values (core/lifecycle/policy.ts applies them) and of the pressure thresholds.
   */
  lifecycle: z.strictObject({
    preset: z.enum(PRESETS),
    autoArchive: z.boolean(),
    /** The freezing experiment (§4.3). */
    freeze: z.boolean(),
    /** "Pause automation" (§4.12). */
    paused: z.boolean(),
    /**
     * Preview mode (§4.13, M3.4): `auto` previews automation's moves for the first active days;
     * `off` once the user started automation early (or a later version decides).
     */
    preview: previewSetting,
    overrides: z.strictObject(overridesShape).refine(pressureInOrder, 'pressure thresholds'),
  }),
});
export type Settings = z.infer<typeof strictSettingsSchema>;
export type LifecycleSettingsDocument = Settings['lifecycle'];

export const DEFAULT_LIFECYCLE_DOCUMENT: LifecycleSettingsDocument = {
  preset: 'balanced',
  autoArchive: true,
  freeze: false,
  paused: false,
  preview: 'auto',
  overrides: {},
};

export const DEFAULT_SETTINGS: Settings = {
  search: { template: DEFAULT_SEARCH_TEMPLATE },
  history: { retentionDays: DEFAULT_HISTORY_RETENTION_DAYS },
  startup: 'restore',
  memory: { paused: false },
  lifecycle: DEFAULT_LIFECYCLE_DOCUMENT,
};

/** An override that is out of its range is dropped alone on reading. */
const lenient = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

const lenientOverrides = z
  .object({
    discardAfterMs: lenient(limited('discardAfterMs')),
    stripCap: lenient(limited('stripCap')),
    shelveAfterEngagedMs: lenient(limited('shelveAfterEngagedMs')),
    archiveAfterActiveDays: lenient(limited('archiveAfterActiveDays')),
    interactionGuardMs: lenient(limited('interactionGuardMs')),
    discardPinned: lenient(z.boolean()),
    moderatePressurePercent: lenient(limited('moderatePressurePercent')),
    criticalPressurePercent: lenient(limited('criticalPressurePercent')),
  })
  .catch({})
  // Thresholds out of order were never written by main: both go, and the defaults apply.
  .transform((overrides) => {
    const kept = Object.fromEntries(
      Object.entries(overrides).filter(([, value]) => value !== undefined),
    ) as Overrides;
    if (pressureInOrder(kept)) {
      return kept;
    }
    return Object.fromEntries(
      Object.entries(kept).filter(
        ([key]) => key !== 'moderatePressurePercent' && key !== 'criticalPressurePercent',
      ),
    );
  });

const lenientLifecycle = z.object({
  preset: z.enum(PRESETS).catch('balanced'),
  autoArchive: z.boolean().catch(true),
  freeze: z.boolean().catch(false),
  paused: z.boolean().catch(false),
  preview: previewSetting.catch('auto'),
  overrides: lenientOverrides,
});

/** Reads a stored document leniently: what is wrong or missing takes its default alone. */
export const settingsSchema = z.object({
  search: z
    .object({ template: searchTemplate.catch(DEFAULT_SEARCH_TEMPLATE) })
    .catch({ template: DEFAULT_SEARCH_TEMPLATE }),
  history: z
    .object({ retentionDays: retentionDays.catch(DEFAULT_HISTORY_RETENTION_DAYS) })
    .catch({ retentionDays: DEFAULT_HISTORY_RETENTION_DAYS }),
  startup: z.enum(STARTUP_BEHAVIORS).catch('restore'),
  memory: z.object({ paused: z.boolean().catch(false) }).catch({ paused: false }),
  lifecycle: lenientLifecycle.catch(DEFAULT_LIFECYCLE_DOCUMENT),
});

/** The stored document as settings, whatever it holds: null or garbage is the defaults. */
export function parseSettings(stored: unknown): Settings {
  const parsed = settingsSchema.safeParse(
    typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? stored : {},
  );
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

/** An override in a change: a value, or null to go back to the preset's (or the default). */
const overrideChange = <T extends z.ZodType>(schema: T) => schema.nullable().optional();

/**
 * A change the settings page asks for (M5.1): only the fields it changes, each strictly valid. An
 * unknown field, a value of the wrong type or out of its range, or a template that isn't a safe
 * search address fails the whole change; main keeps nothing of it.
 */
export const settingsChangeSchema = z.strictObject({
  search: z.strictObject({ template: searchTemplate }).optional(),
  /** M5.2: how long visits are kept, in days (the memory's retention, §5.7). */
  history: z.strictObject({ retentionDays }).optional(),
  startup: z.enum(STARTUP_BEHAVIORS).optional(),
  memory: z.strictObject({ paused: z.boolean() }).optional(),
  lifecycle: z
    .strictObject({
      preset: z.enum(PRESETS).optional(),
      autoArchive: z.boolean().optional(),
      freeze: z.boolean().optional(),
      paused: z.boolean().optional(),
      preview: previewSetting.optional(),
      overrides: z
        .strictObject({
          discardAfterMs: overrideChange(limited('discardAfterMs')),
          stripCap: overrideChange(limited('stripCap')),
          shelveAfterEngagedMs: overrideChange(limited('shelveAfterEngagedMs')),
          archiveAfterActiveDays: overrideChange(limited('archiveAfterActiveDays')),
          interactionGuardMs: overrideChange(limited('interactionGuardMs')),
          discardPinned: overrideChange(z.boolean()),
          moderatePressurePercent: overrideChange(limited('moderatePressurePercent')),
          criticalPressurePercent: overrideChange(limited('criticalPressurePercent')),
        })
        .optional(),
    })
    .optional(),
});
export type SettingsChange = z.infer<typeof settingsChangeSchema>;

/**
 * The document `change` makes of `current`, or null when that document is invalid: a change can
 * be valid on its own and still make one, as a critical threshold at or above the moderate one.
 */
export function applySettingsChange(current: Settings, change: SettingsChange): Settings | null {
  // A field sent as undefined (structured clone keeps it) changes nothing, like one left out.
  const given = (fields: object): [string, unknown][] =>
    Object.entries(fields).filter(([, value]) => value !== undefined);
  // An override sent as null goes back to the preset's value: it leaves the document.
  const merged: Record<string, unknown> = {
    ...current.lifecycle.overrides,
    ...Object.fromEntries(given(change.lifecycle?.overrides ?? {})),
  };
  const overrides = Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== null),
  );
  const switches = given(change.lifecycle ?? {}).filter(([key]) => key !== 'overrides');
  const next = {
    search: change.search ?? current.search,
    history: change.history ?? current.history,
    startup: change.startup ?? current.startup,
    memory: change.memory ?? current.memory,
    lifecycle: { ...current.lifecycle, ...Object.fromEntries(switches), overrides },
  };
  const checked = strictSettingsSchema.safeParse(next);
  return checked.success ? checked.data : null;
}
