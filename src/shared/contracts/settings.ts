// The settings document (assessment §5.3: the `settings` table's one row). Main reads it at
// startup; nothing writes it until the settings page (Phase 5). Every field has a default, and a
// field that is missing or invalid takes its default alone: one bad value never resets the rest,
// and a document from a newer Veltriva keeps working (its unknown fields are ignored).
import { z } from 'zod';

import { DEFAULT_SEARCH_TEMPLATE, isValidSearchTemplate } from '../../core/url/omnibox';

/** §5.7: a year of visits. */
export const DEFAULT_HISTORY_RETENTION_DAYS = 365;

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
});
export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  search: { template: DEFAULT_SEARCH_TEMPLATE },
  history: { retentionDays: DEFAULT_HISTORY_RETENTION_DAYS },
};

/** The stored document as settings, whatever it holds: null or garbage is the defaults. */
export function parseSettings(stored: unknown): Settings {
  const parsed = settingsSchema.safeParse(
    typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? stored : {},
  );
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}
