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
import type { ClosedTab, SessionTab, TabId } from '../tabs/tab-manager';
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
  const [strip, closed, session, window, runs] = await Promise.all([
    data.call('tabs.list', { workspaceId, placement: 'strip', limit: 10_000 }),
    data.call('tabs.listClosed', { workspaceId, limit: CLOSED_TABS_LOADED }),
    data.call('appState.get', { key: SESSION_DOCUMENT }),
    data.call('appState.get', { key: WINDOW_DOCUMENT }),
    data.call('appRuns.recent', { limit: 3 }),
  ]);
  return {
    workspaceId,
    tabs: strip.tabs.map(toSessionTab),
    closed: closed.tabs.flatMap((row) =>
      row.closedAt === null ? [] : [{ ...toSessionTab(row), closedAt: row.closedAt, index: 0 }],
    ),
    selectedTabId: selectedOf(session.value),
    window: parseSavedWindow(window.value),
    previousRuns: runs.runs
      .filter((run) => run.id !== options.runId)
      .map((run) => ({ startedAt: run.startedAt, endedAt: run.endedAt, exitKind: run.exitKind })),
    rows: [...strip.tabs, ...closed.tabs],
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
