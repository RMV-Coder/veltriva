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
  return {
    id: tab.id,
    pinned: tab.pinned,
    title: tab.title,
    // A new-tab page shows an empty address bar (the shell shows a placeholder).
    address: tab.url === '' ? NO_ADDRESS : displayUrl(tab.url),
    favicon: tab.favicon,
    loading: tab.loading,
    canGoBack: tab.canGoBack,
    canGoForward: tab.canGoForward,
    runtime: tab.runtime,
    page,
  };
}

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
    };
  };

  return {
    markDirty() {
      if (pending !== undefined) {
        return;
      }
      pending = schedule(() => {
        pending = undefined;
        options.publish(snapshot());
      }, SNAPSHOT_INTERVAL_MS);
    },
    snapshot,
    dispose() {
      if (pending !== undefined) {
        cancel(pending);
        pending = undefined;
      }
    },
  };
}
