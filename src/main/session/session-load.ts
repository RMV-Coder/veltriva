// Reads the saved session at startup (assessment §5.9): the default workspace, its tabs, Recently
// closed (purging what is older than 7 days, ADR-0003 item 8), the selected tab, the window, and
// the last runs, for crash-loop detection. Every history is sanitized again on the way in: the
// database file is not trusted to hold only what Veltriva wrote.
import { parseSavedWindow } from '../../core/layout/window-bounds';
import type { SavedWindow } from '../../core/layout/window-bounds';
import type { RunSummary } from '../../core/session/crash-loop';
import { sanitizeHistory } from '../../core/session/history';
import { UUID_V7_PATTERN } from '../../core/id/uuidv7';
import type { TabRow } from '../../shared/contracts/data-rpc';
import type { DataClient } from '../persistence/data-client';
import { MAX_ARCHIVED_IN_MEMORY } from '../tabs/tab-manager';
import type { ArchivedTab, ClosedTab, SessionTab, TabId } from '../tabs/tab-manager';
import { SESSION_DOCUMENT, WINDOW_DOCUMENT } from './session-store';

/** Closed tabs are kept this long (ADR-0003 item 8). */
export const CLOSED_TAB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Recently closed loaded at startup; older ones stay in the database until purged. */
export const CLOSED_TABS_LOADED = 100;
/** The workspace's name in the MVP (one default workspace). */
const DEFAULT_WORKSPACE_NAME = 'Default';

export interface LoadedSession {
  readonly workspaceId: string;
  readonly tabs: readonly SessionTab[];
  /** Sleeping, in shelf order (M3.3). */
  readonly shelf: readonly SessionTab[];
  /** The newest archived tabs, newest first, and how many the workspace has in all (M3.3). */
  readonly archived: readonly ArchivedTab[];
  readonly archivedCount: number;
  readonly closed: readonly ClosedTab[];
  readonly selectedTabId: TabId | null;
  readonly window: SavedWindow | null;
  /** The runs before this one, newest first. */
  readonly previousRuns: readonly RunSummary[];
  /** Every row read, for the session store's first flush. */
  readonly rows: readonly TabRow[];
}

export async function loadSession(
  data: Pick<DataClient, 'call'>,
  options: { readonly newWorkspaceId: string; readonly now: number; readonly runId: number },
): Promise<LoadedSession> {
  const { id: workspaceId } = await data.call('workspaces.ensureDefault', {
    candidateId: options.newWorkspaceId,
    name: DEFAULT_WORKSPACE_NAME,
    now: options.now,
  });
  await data.call('tabs.purgeClosed', {
    before: Math.max(0, options.now - CLOSED_TAB_RETENTION_MS),
    limit: 1000,
  });
  const [strip, shelf, archived, archivedCount, closed, session, window, runs] = await Promise.all([
    data.call('tabs.list', { workspaceId, placement: 'strip', limit: 10_000 }),
    data.call('tabs.list', { workspaceId, placement: 'shelf', limit: 10_000 }),
    data.call('tabs.listArchived', { workspaceId, limit: MAX_ARCHIVED_IN_MEMORY }),
    data.call('tabs.countArchived', { workspaceId }),
    data.call('tabs.listClosed', { workspaceId, limit: CLOSED_TABS_LOADED }),
    data.call('appState.get', { key: SESSION_DOCUMENT }),
    data.call('appState.get', { key: WINDOW_DOCUMENT }),
    data.call('appRuns.recent', { limit: 3 }),
  ]);
  return {
    workspaceId,
    tabs: strip.tabs.map(toSessionTab),
    shelf: shelf.tabs.map(toSessionTab),
    archived: archived.tabs.flatMap((row) =>
      row.archivedAt === null
        ? []
        : [
            {
              ...toSessionTab(row),
              archivedAt: row.archivedAt,
              reason: row.archiveReason ?? 'auto',
            },
          ],
    ),
    archivedCount: archivedCount.count,
    closed: closed.tabs.flatMap((row) =>
      row.closedAt === null
        ? []
        : [{ ...toSessionTab(row), closedAt: row.closedAt, index: row.position }],
    ),
    selectedTabId: selectedOf(session.value),
    window: parseSavedWindow(window.value),
    previousRuns: runs.runs
      .filter((run) => run.id !== options.runId)
      .map((run) => ({ startedAt: run.startedAt, endedAt: run.endedAt, exitKind: run.exitKind })),
    rows: [...strip.tabs, ...shelf.tabs, ...archived.tabs, ...closed.tabs],
  };
}

function toSessionTab(row: TabRow): SessionTab {
  return {
    id: row.id,
    pinned: row.pinned,
    url: row.url,
    title: row.title,
    history: row.restoreState === null ? null : sanitizeHistory(row.restoreState),
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    userProtected: row.userProtected,
    placementChangedAt: row.placementChangedAt,
    // Phase 2 wrote 0 for both: unknown, which TabManager reads as "now".
    ...(row.lastUsedEngaged > 0 ? { lastUsedEngaged: row.lastUsedEngaged } : {}),
    ...(row.lastUsedActiveDay > 0 ? { lastUsedActiveDay: row.lastUsedActiveDay } : {}),
  };
}

function selectedOf(value: unknown): TabId | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const { selectedTabId } = value as { selectedTabId?: unknown };
  return typeof selectedTabId === 'string' && UUID_V7_PATTERN.test(selectedTabId)
    ? selectedTabId
    : null;
}
