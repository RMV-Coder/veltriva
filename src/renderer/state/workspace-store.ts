// The shell's copy of main's workspace. Main owns every tab (ADR-0005); this store only holds the
// latest snapshot it was sent, so components render from it and nothing is updated optimistically.
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import type { TabSnapshot, WorkspaceSnapshot } from '../../shared/contracts/schemas';
import { findSelectedTab, fullscreenNotice, isNewerSnapshot } from './workspace-snapshot';

interface WorkspaceStore {
  /** Null until the first snapshot arrives. */
  readonly snapshot: WorkspaceSnapshot | null;
  /** Keeps `incoming` only if it is newer than the held snapshot. */
  readonly applySnapshot: (incoming: WorkspaceSnapshot) => void;
}

export const useWorkspaceStore = create<WorkspaceStore>()((set) => ({
  snapshot: null,
  applySnapshot: (incoming) => {
    set((state) => (isNewerSnapshot(state.snapshot, incoming) ? { snapshot: incoming } : state));
  },
}));

const NO_TABS: readonly TabSnapshot[] = [];

/** The tabs in strip order, pinned first. The same array until the next snapshot. */
export function useTabs(): readonly TabSnapshot[] {
  return useWorkspaceStore((state) => state.snapshot?.tabs ?? NO_TABS);
}

const NO_DOWNLOADS: WorkspaceSnapshot['downloads'] = [];

/** The downloads, newest first. The same array until the next snapshot. */
export function useDownloads(): WorkspaceSnapshot['downloads'] {
  return useWorkspaceStore((state) => state.snapshot?.downloads ?? NO_DOWNLOADS);
}

const NO_SLEEPING: WorkspaceSnapshot['sleeping'] = [];

/** The Sleeping tabs, most recently moved first. The same array until the next snapshot. */
export function useSleeping(): WorkspaceSnapshot['sleeping'] {
  return useWorkspaceStore((state) => state.snapshot?.sleeping ?? NO_SLEEPING);
}

const NO_ARCHIVED: WorkspaceSnapshot['archived'] = [];

/** The newest archived tabs, newest first. The same array until the next snapshot. */
export function useArchived(): WorkspaceSnapshot['archived'] {
  return useWorkspaceStore((state) => state.snapshot?.archived ?? NO_ARCHIVED);
}

const NO_COUNTS: WorkspaceSnapshot['counts'] = { sleeping: 0, archived: 0, archivedToday: 0 };

/** The sidebar's counts. Re-renders only when a number changes, not at every snapshot. */
export function useCounts(): WorkspaceSnapshot['counts'] {
  return useWorkspaceStore(useShallow((state) => state.snapshot?.counts ?? NO_COUNTS));
}

/** The Undo offer, or null. Re-renders only when the offer changes, not at every snapshot. */
export function useUndoOffer(): WorkspaceSnapshot['undo'] {
  return useWorkspaceStore(useShallow((state) => state.snapshot?.undo ?? null));
}

export function useSelectedTabId(): string | null {
  return useWorkspaceStore((state) => state.snapshot?.selectedTabId ?? null);
}

export function useSelectedTab(): TabSnapshot | undefined {
  return useWorkspaceStore((state) => findSelectedTab(state.snapshot));
}

/**
 * The fullscreen notice to draw right now, or null. Reads two strings, not one object, so the
 * component using it re-renders only when the notice itself changes.
 */
export function useFullscreenNotice(): { readonly tabId: string; readonly origin: string } | null {
  const tabId = useWorkspaceStore((state) => fullscreenNotice(state.snapshot)?.tabId ?? null);
  const origin = useWorkspaceStore((state) => fullscreenNotice(state.snapshot)?.origin ?? null);
  return tabId === null || origin === null ? null : { tabId, origin };
}

/**
 * Starts feeding the store from main: the `workspace.changed` event and one `getSnapshot()`.
 * The subscription comes first, so an event that lands while `getSnapshot()` is in flight is not
 * lost; version gating sorts out whichever arrives first. Returns a function that stops it, which
 * React StrictMode's double effect run needs.
 */
export function startWorkspaceSync(): () => void {
  const { applySnapshot } = useWorkspaceStore.getState();
  let stopped = false;

  const unsubscribe = window.veltriva.on('workspace.changed', applySnapshot);

  window.veltriva.workspace
    .getSnapshot()
    .then((result) => {
      if (stopped) {
        return;
      }
      if (result.ok) {
        applySnapshot(result.value);
      } else {
        console.warn(`veltriva: workspace.getSnapshot failed (${result.code})`);
      }
    })
    .catch((error: unknown) => {
      console.warn('veltriva: workspace.getSnapshot could not reach the main process', error);
    });

  return () => {
    stopped = true;
    unsubscribe();
  };
}
