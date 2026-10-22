import type { DatabaseConnection } from 'better-sqlite3/win32-x64';

import { restoreStateSchema } from '../../shared/contracts/data-rpc';
import type { RestoreState, TabRow } from '../../shared/contracts/data-rpc';
import type { RepositoryHandlers } from '../handlers';
import { pageLinker } from './page-links';
import { bit } from './shared';

/** A `tabs` row as SQLite returns it: the columns are aliased to the contract's field names. */
type StoredTab = Omit<TabRow, 'pinned' | 'userProtected' | 'restoreState'> & {
  readonly pinned: number;
  readonly userProtected: number;
  readonly restoreState: string | null;
};

const SELECT = `
  SELECT id, workspace_id AS workspaceId, placement, position, pinned,
         user_protected AS userProtected, page_id AS pageId, url, title, favicon_id AS faviconId,
         restore_state AS restoreState, opener_tab_id AS openerTabId, created_at AS createdAt,
         last_used_at AS lastUsedAt, last_used_engaged AS lastUsedEngaged,
         last_used_active_day AS lastUsedActiveDay, placement_changed_at AS placementChangedAt,
         archived_at AS archivedAt, archive_reason AS archiveReason, closed_at AS closedAt
  FROM tabs`;

const LIST = `${SELECT}
  WHERE workspace_id = ? AND placement = ?
  ORDER BY position, id
  LIMIT ?`;

/** Archived tabs, newest first; tabs_archived_idx serves it (M3.3). */
const LIST_ARCHIVED = `${SELECT}
  WHERE workspace_id = ? AND placement = 'archive'
  ORDER BY archived_at DESC, id DESC
  LIMIT ? OFFSET ?`;

/** Recently closed, newest first; tabs_closed_idx serves it. */
const LIST_CLOSED = `${SELECT}
  WHERE workspace_id = ? AND placement = 'closed'
  ORDER BY closed_at DESC, id DESC
  LIMIT ?`;

const UPSERT = `
  INSERT INTO tabs (
    id, workspace_id, placement, position, pinned, user_protected, page_id, url, title, favicon_id,
    restore_state, opener_tab_id, created_at, last_used_at, last_used_engaged,
    last_used_active_day, placement_changed_at, archived_at, archive_reason, closed_at
  ) VALUES (
    @id, @workspaceId, @placement, @position, @pinned, @userProtected, @pageId, @url, @title,
    @faviconId, @restoreState, @openerTabId, @createdAt, @lastUsedAt, @lastUsedEngaged,
    @lastUsedActiveDay, @placementChangedAt, @archivedAt, @archiveReason, @closedAt
  )
  ON CONFLICT(id) DO UPDATE SET
    workspace_id = excluded.workspace_id,
    placement = excluded.placement,
    position = excluded.position,
    pinned = excluded.pinned,
    user_protected = excluded.user_protected,
    page_id = excluded.page_id,
    url = excluded.url,
    title = excluded.title,
    favicon_id = excluded.favicon_id,
    restore_state = excluded.restore_state,
    opener_tab_id = excluded.opener_tab_id,
    created_at = excluded.created_at,
    last_used_at = excluded.last_used_at,
    last_used_engaged = excluded.last_used_engaged,
    last_used_active_day = excluded.last_used_active_day,
    placement_changed_at = excluded.placement_changed_at,
    archived_at = excluded.archived_at,
    archive_reason = excluded.archive_reason,
    closed_at = excluded.closed_at`;

export function tabHandlers(
  db: DatabaseConnection,
): Pick<
  RepositoryHandlers,
  | 'tabs.list'
  | 'tabs.upsertMany'
  | 'tabs.deleteMany'
  | 'tabs.listClosed'
  | 'tabs.listArchived'
  | 'tabs.countArchived'
  | 'tabs.purgeClosed'
  | 'tabs.get'
  | 'session.save'
> {
  const list = db.prepare(LIST);
  const listClosed = db.prepare(LIST_CLOSED);
  const listArchived = db.prepare(LIST_ARCHIVED);
  const countArchived = db.prepare(
    "SELECT count(*) AS count FROM tabs WHERE workspace_id = ? AND placement = 'archive'",
  );
  const purgeClosed = db.prepare(
    `DELETE FROM tabs WHERE id IN (
       SELECT id FROM tabs WHERE placement = 'closed' AND closed_at < ? ORDER BY closed_at LIMIT ?
     )`,
  );
  const getOne = db.prepare(`${SELECT} WHERE id = ?`);
  const upsert = db.prepare(UPSERT);
  const pageOf = pageLinker(db);
  const deleteMany = db.prepare('DELETE FROM tabs WHERE id IN (SELECT value FROM json_each(?))');
  const putDocument = db.prepare(
    'INSERT INTO app_state (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json',
  );
  const saveSession = db.transaction(
    (
      tabs: readonly TabRow[],
      deleteIds: readonly string[],
      documents: readonly { readonly key: string; readonly value: unknown }[],
    ): number => {
      for (const tab of tabs) {
        upsertRow(tab);
      }
      const deleted =
        deleteIds.length === 0 ? 0 : deleteMany.run([JSON.stringify(deleteIds)]).changes;
      for (const { key, value } of documents) {
        putDocument.run([key, JSON.stringify(value)]);
      }
      return tabs.length + deleted;
    },
  );
  // Each row is linked to the page its address is keyed by (./page-links.ts), so a search knows
  // which tab shows a page. A visit is recorded at the commit, before the save that follows it.
  const upsertRow = (tab: TabRow): void => {
    upsert.run({
      ...tab,
      pageId: tab.pageId ?? pageOf(tab.url),
      pinned: bit(tab.pinned),
      userProtected: bit(tab.userProtected),
      restoreState: tab.restoreState === null ? null : JSON.stringify(tab.restoreState),
    });
  };
  const upsertAll = db.transaction((tabs: readonly TabRow[]) => {
    for (const tab of tabs) {
      upsertRow(tab);
    }
  });

  return {
    'tabs.list': ({ workspaceId, placement, limit }) => ({
      tabs: (list.all([workspaceId, placement, limit]) as StoredTab[]).map(toTabRow),
    }),
    'tabs.upsertMany': ({ tabs }) => {
      upsertAll(tabs);
      return { count: tabs.length };
    },
    'tabs.deleteMany': ({ ids }) => ({ count: deleteMany.run([JSON.stringify(ids)]).changes }),
    'tabs.listClosed': ({ workspaceId, limit }) => ({
      tabs: (listClosed.all([workspaceId, limit]) as StoredTab[]).map(toTabRow),
    }),
    'tabs.listArchived': ({ workspaceId, limit, offset = 0 }) => ({
      tabs: (listArchived.all([workspaceId, limit, offset]) as StoredTab[]).map(toTabRow),
    }),
    'tabs.get': ({ id }) => {
      const row = getOne.get([id]) as StoredTab | undefined;
      return { tab: row === undefined ? null : toTabRow(row) };
    },
    'tabs.countArchived': ({ workspaceId }) => ({
      count: (countArchived.get([workspaceId]) as { count: number }).count,
    }),
    'session.save': ({ tabs, deleteIds, documents }) => ({
      count: saveSession(tabs, deleteIds, documents),
    }),
    'tabs.purgeClosed': ({ before, limit }) => ({
      count: purgeClosed.run([before, limit]).changes,
    }),
  };
}

function toTabRow(row: StoredTab): TabRow {
  return {
    ...row,
    pinned: row.pinned === 1,
    userProtected: row.userProtected === 1,
    restoreState: readRestoreState(row.restoreState),
  };
}

/** A back/forward stack that doesn't parse is dropped: the tab then restores from its URL alone. */
function readRestoreState(text: string | null): RestoreState | null {
  if (text === null) {
    return null;
  }
  try {
    const parsed = restoreStateSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
