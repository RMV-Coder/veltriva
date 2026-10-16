// WorkspaceProjector (ADR-0005 §2): turns TabManager state into the versioned snapshot the shell
// renders. Changes are coalesced: however many arrive, at most one snapshot goes out per frame.
import { displayUrl } from '../../core/url/display';
import type { TabSnapshot, WorkspaceSnapshot } from '../../shared/contracts/schemas';
import type { TabState } from './tab-manager';

/** About one animation frame. */
export const SNAPSHOT_INTERVAL_MS = 16;

const NO_ADDRESS = { text: '', security: 'neutral', hadCredentials: false } as const;

export function projectTab(tab: TabState): TabSnapshot {
  const page =
    tab.page.kind === 'web'
      ? { kind: 'web' as const }
      : tab.page.error === undefined
        ? { kind: 'internal' as const, name: tab.page.name }
        : { kind: 'internal' as const, name: tab.page.name, error: tab.page.error };
  // A new-tab page shows an empty address bar (the shell shows a placeholder).
  const address = tab.url === '' ? NO_ADDRESS : displayUrl(tab.url);
  return {
    id: tab.id,
    pinned: tab.pinned,
    title: tab.title,
    // Credentials are removed either from the committed URL (displayUrl) or, for a typed address,
    // before loading it (TabState.credentialsRemoved). Both warn.
    address: tab.credentialsRemoved ? { ...address, hadCredentials: true } : address,
    favicon: tab.favicon,
    loading: tab.loading,
    canGoBack: tab.canGoBack,
    canGoForward: tab.canGoForward,
    runtime: tab.runtime,
    page,
    zoomPercent: Math.min(Math.max(tab.zoomPercent, 25), 500),
    find: tab.find,
  };
}

/** Which tab is in HTML fullscreen, and whether the shell should draw the notice (T6). */
export type FullscreenSnapshot = WorkspaceSnapshot['fullscreen'];

export interface WorkspaceProjector {
  /** Something changed: schedule a snapshot (at most one per interval). */
  markDirty(): void;
  /** The current snapshot, with a new version. */
  snapshot(): WorkspaceSnapshot;
  dispose(): void;
}

export function createWorkspaceProjector(options: {
  readonly tabs: () => readonly TabState[];
  readonly selectedTabId: () => string | null;
  readonly fullscreen?: () => FullscreenSnapshot;
  readonly publish: (snapshot: WorkspaceSnapshot) => void;
  readonly schedule?: (callback: () => void, ms: number) => unknown;
  readonly cancel?: (handle: unknown) => void;
}): WorkspaceProjector {
  const schedule = options.schedule ?? ((callback, ms) => setTimeout(callback, ms));
  const cancel =
    options.cancel ??
    ((handle) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    });
  let version = 0;
  let pending: unknown;

  const snapshot = (): WorkspaceSnapshot => {
    version += 1;
    return {
      version,
      selectedTabId: options.selectedTabId(),
      tabs: options.tabs().map(projectTab),
      fullscreen: options.fullscreen?.() ?? null,
    };
  };

  let disposed = false;

  return {
    markDirty() {
      // Closing the window disposes the projector, then closes every tab, which marks it dirty.
      if (disposed || pending !== undefined) {
        return;
      }
      pending = schedule(() => {
        pending = undefined;
        options.publish(snapshot());
      }, SNAPSHOT_INTERVAL_MS);
    },
    snapshot,
    dispose() {
      disposed = true;
      if (pending !== undefined) {
        cancel(pending);
        pending = undefined;
      }
    },
  };
}
