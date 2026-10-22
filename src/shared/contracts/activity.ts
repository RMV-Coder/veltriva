// The activity log's entries (M3.3, assessment §4.13): what automation did to a tab, the rule that
// decided it, and the user's undos. Main keeps them, stores them in app_state and sends them to
// the shell; this schema checks all three.
import { z } from 'zod';

import { LIFECYCLE_RULES } from '../../core/lifecycle/policy';

/** The newest entries kept; older ones are dropped. */
export const MAX_ACTIVITY_ENTRIES = 500;
/**
 * A tab's title and address are cut to these lengths in the log, so the stored document stays
 * under app_state's 1 MiB even when every quote and backslash doubles (titles and display
 * addresses hold no control characters).
 */
export const MAX_ACTIVITY_TITLE = 200;
export const MAX_ACTIVITY_ADDRESS = 500;

export const ACTIVITY_ACTIONS = ['discard', 'freeze', 'shelve', 'archive', 'undo'] as const;
export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];

export const activityEntrySchema = z.strictObject({
  /** Increases with every entry. */
  id: z.number().int().positive(),
  /** Wall-clock time. */
  at: z.number().int().nonnegative(),
  action: z.enum(ACTIVITY_ACTIONS),
  /** The rule that decided it; null for the user's undo. */
  rule: z.enum(LIFECYCLE_RULES).nullable(),
  /**
   * The memory pressure that called for it, for a pressure discard: the "why" says so plainly
   * (M3.4). Null otherwise.
   */
  pressure: z.enum(['moderate', 'critical']).nullable(),
  tabId: z.string().min(1).max(64),
  title: z.string().max(MAX_ACTIVITY_TITLE),
  /** The address as the address bar would show it (display text, credentials removed). */
  address: z.string().max(MAX_ACTIVITY_ADDRESS),
  /** The automated batch it belongs to: its moves are undone together. */
  batchId: z.string().max(64).nullable(),
});

export type ActivityEntry = z.infer<typeof activityEntrySchema>;
