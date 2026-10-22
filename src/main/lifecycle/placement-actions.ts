// What the user does to where a tab lives (assessment §4.4, M3.3): move it to Sleeping or the
// Archive, bring it back, protect it from automation. The commands and the tab menu both come
// here, so each of the user's moves offers the same Undo as an automated batch (§4.13).
import type { PlacementMove } from '../../core/lifecycle/placement';
import type { TabId, TabManager } from '../tabs/tab-manager';
import type { UndoManager } from './undo';

export interface PlacementActions {
  /** Moves a strip tab to Sleeping. False when it can't go (pinned, already there, closed). */
  shelve(tabId: TabId): boolean;
  /**
   * Archives a tab from the strip or Sleeping. False when it stays: its page objected to
   * unloading (unsaved changes), it is loading, or it can't be archived (a private tab).
   */
  archive(tabId: TabId): Promise<boolean>;
  /**
   * Brings a tab back from Sleeping or the Archive next to the current tab and selects it. Returns
   * its id (an archived tab may come back under a new one), or null when there is no such tab.
   */
  restore(tabId: TabId, options: { readonly focus: boolean }): TabId | null;
  setProtected(tabId: TabId, on: boolean): void;
}

export function createPlacementActions(deps: {
  readonly tabs: TabManager;
  readonly undo: UndoManager;
  /** Wall-clock time, as the lifecycle sees it. */
  readonly now: () => number;
  /** The user brought a tab back from Sleeping or the Archive (the regret metric, M3.4). */
  readonly onRestored?: (tabId: TabId) => void;
}): PlacementActions {
  let manualMoves = 0;
  const offer = (move: PlacementMove): void => {
    manualMoves += 1;
    deps.undo.offer(
      { id: `manual-${String(manualMoves)}`, at: deps.now(), moves: [move] },
      { automated: false },
    );
  };

  return {
    shelve(tabId) {
      const outcome = deps.tabs.shelve(tabId, { origin: 'user' });
      if (outcome.outcome !== 'moved') {
        return false;
      }
      offer(outcome.move);
      return true;
    },
    async archive(tabId) {
      const outcome = await deps.tabs.archive(tabId, { origin: 'user' });
      if (outcome.outcome !== 'moved') {
        return false;
      }
      offer(outcome.move);
      return true;
    },
    restore(tabId, { focus }) {
      const tabs = deps.tabs;
      if (tabs.has(tabId)) {
        const sleeping = tabs.get(tabId).placement === 'shelf';
        // In the strip already, or Sleeping: selecting brings a Sleeping tab back (§4.4).
        tabs.select(tabId, { focus });
        if (sleeping) {
          deps.onRestored?.(tabId);
        }
        return tabId;
      }
      const restored = tabs.restoreArchived(tabId, { select: true, focus });
      if (restored !== null) {
        deps.onRestored?.(tabId);
      }
      return restored;
    },
    setProtected(tabId, on) {
      deps.tabs.setProtected(tabId, on);
    },
  };
}
