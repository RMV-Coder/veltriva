import type { DatabaseConnection } from 'better-sqlite3/win32-x64';

import { restoreStateSchema } from '../../shared/contracts/data-rpc';
import type { RestoreState, TabRow } from '../../shared/contracts/data-rpc';
import type { RepositoryHandlers } from '../handlers';
import { bit } from './shared';

/** A `tabs` row as SQLite returns it: the columns are aliased to the contract's field names. */
type StoredTab = Omit<TabRow, 'pinned' | 'userProtected' | 'restoreState'> & {
  readonly pinned: number;
  readonly userProtected: number;
  readonly restoreState: string | null;
};

const LIST = `
  SELECT id, workspace_id AS workspaceId, placement, position, pinned,
         user_protected AS userProtected, page_id AS pageId, url, title, favicon_id AS faviconId,
         restore_state AS restoreState, opener_tab_id AS openerTabId, created_at AS createdAt,
         last_used_at AS lastUsedAt, last_used_engaged AS lastUsedEngaged,
         last_used_active_day AS lastUsedActiveDay, placement_changed_at AS placementChangedAt,
         archived_at AS archivedAt, archive_reason AS archiveReason, closed_at AS closedAt
  FROM tabs
  WHERE workspace_id = ? AND placement = ?
  ORDER BY position, id
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
): Pick<RepositoryHandlers, 'tabs.list' | 'tabs.upsertMany' | 'tabs.deleteMany'> {
  const list = db.prepare(LIST);
  const upsert = db.prepare(UPSERT);
  const deleteMany = db.prepare('DELETE FROM tabs WHERE id IN (SELECT value FROM json_each(?))');
  const upsertAll = db.transaction((tabs: readonly TabRow[]) => {
    for (const tab of tabs) {
      upsert.run({
        ...tab,
        pinned: bit(tab.pinned),
        userProtected: bit(tab.userProtected),
        restoreState: tab.restoreState === null ? null : JSON.stringify(tab.restoreState),
      });
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
