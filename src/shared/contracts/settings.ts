// The settings document (assessment §5.3: the `settings` table's one row). Main reads it at
// startup; nothing writes it until the settings page (Phase 5). Every field has a default, and a
// field that is missing or invalid takes its default alone: one bad value never resets the rest,
// and a document from a newer Veltriva keeps working (its unknown fields are ignored).
import { z } from 'zod';

import { PRESETS } from '../../core/lifecycle/policy';
import { DEFAULT_SEARCH_TEMPLATE, isValidSearchTemplate } from '../../core/url/omnibox';

/** §5.7: a year of visits. */
export const DEFAULT_HISTORY_RETENTION_DAYS = 365;

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** An advanced override of one preset value: dropped alone when it is out of range. */
const override = (schema: z.ZodNumber) => schema.optional().catch(undefined);

/**
 * Tab lifecycle (assessment §4.7, M3.2): a preset, the switches, and advanced overrides of the
 * preset's values (Phase 5's settings page writes them; core/lifecycle/policy.ts applies them).
 */
const lifecycleSchema = z.object({
  preset: z.enum(PRESETS).catch('balanced'),
  autoArchive: z.boolean().catch(true),
  /** The freezing experiment (§4.3). */
  freeze: z.boolean().catch(false),
  /** "Pause automation" (§4.12). */
  paused: z.boolean().catch(false),
  overrides: z
    .object({
      discardAfterMs: override(
        z
          .number()
          .int()
          .min(MINUTE_MS)
          .max(7 * DAY_MS),
      ),
      stripCap: override(z.number().int().min(1).max(500)),
      shelveAfterEngagedMs: override(
        z
          .number()
          .int()
          .min(MINUTE_MS)
          .max(30 * DAY_MS),
      ),
      archiveAfterActiveDays: override(z.number().int().min(1).max(365)),
      interactionGuardMs: override(z.number().int().min(0).max(DAY_MS)),
      discardPinned: z.boolean().optional().catch(undefined),
    })
    .catch({}),
});
export type LifecycleSettingsDocument = z.infer<typeof lifecycleSchema>;

export const DEFAULT_LIFECYCLE_DOCUMENT: LifecycleSettingsDocument = {
  preset: 'balanced',
  autoArchive: true,
  freeze: false,
  paused: false,
  overrides: {},
};

export const settingsSchema = z.object({
  search: z
    .object({
      /** The omnibox's search URL, `{searchTerms}` where the query goes (core/url/omnibox.ts). */
      template: z.string().max(2048).refine(isValidSearchTemplate).catch(DEFAULT_SEARCH_TEMPLATE),
    })
    .catch({ template: DEFAULT_SEARCH_TEMPLATE }),
  history: z
    .object({
      /** Visits older than this are deleted while the user is away (data/maintenance.ts). */
      retentionDays: z.number().int().min(1).max(36_500).catch(DEFAULT_HISTORY_RETENTION_DAYS),
    })
    .catch({ retentionDays: DEFAULT_HISTORY_RETENTION_DAYS }),
  lifecycle: lifecycleSchema.catch(DEFAULT_LIFECYCLE_DOCUMENT),
});
export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  search: { template: DEFAULT_SEARCH_TEMPLATE },
  history: { retentionDays: DEFAULT_HISTORY_RETENTION_DAYS },
  lifecycle: DEFAULT_LIFECYCLE_DOCUMENT,
};

/** The stored document as settings, whatever it holds: null or garbage is the defaults. */
export function parseSettings(stored: unknown): Settings {
  const parsed = settingsSchema.safeParse(
    typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? stored : {},
  );
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}
