// What the Undo toast says (assessment §4.12, §4.13), derived from the snapshot's `undo`. Pure, so
// Vitest covers it; the component only renders what this returns.
import type { WorkspaceSnapshot } from '../../../shared/contracts/schemas';
import { tabCount } from './placement-display';

export type UndoOffer = NonNullable<WorkspaceSnapshot['undo']>;

/** The button names. */
export const UNDO_LABEL = 'Undo';
export const DISMISS_UNDO_LABEL = 'Dismiss undo';

/**
 * The toast's sentence. Automation says how many tabs it moved ("Moved 3 tabs to Sleeping and
 * archived 1"); the user's own move needs no count ("Moved to Sleeping", "Archived").
 */
export function undoToastText(undo: Pick<UndoOffer, 'automated' | 'shelved' | 'archived'>): string {
  const { shelved, archived } = undo;
  if (undo.automated) {
    if (shelved > 0 && archived > 0) {
      return `Moved ${tabCount(shelved)} to Sleeping and archived ${String(archived)}`;
    }
    if (shelved > 0) {
      return `Moved ${tabCount(shelved)} to Sleeping`;
    }
    if (archived > 0) {
      return `Archived ${tabCount(archived)}`;
    }
    return 'Tabs were moved';
  }
  if (shelved > 0 && archived > 0) {
    return 'Moved to Sleeping and archived';
  }
  if (shelved > 0) {
    return 'Moved to Sleeping';
  }
  return archived > 0 ? 'Archived' : 'Moved';
}
