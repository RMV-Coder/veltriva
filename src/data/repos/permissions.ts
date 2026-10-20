import type { DatabaseConnection } from 'better-sqlite3/win32-x64';

import type { PermissionRow } from '../../shared/contracts/data-rpc';
import type { RepositoryHandlers } from '../handlers';

/**
 * The user's "always" answers, keyed by origin and permission. An external protocol's "always
 * allow" is the permission `protocol:<scheme>`.
 */
export function permissionHandlers(
  db: DatabaseConnection,
): Pick<RepositoryHandlers, 'permissions.list' | 'permissions.set' | 'permissions.delete'> {
  const list = db.prepare(
    `SELECT origin, permission, decision, updated_at AS updatedAt
     FROM permission_decisions
     ORDER BY origin, permission
     LIMIT ?`,
  );
  const upsert = db.prepare(
    `INSERT INTO permission_decisions (origin, permission, decision, updated_at)
     VALUES (@origin, @permission, @decision, @updatedAt)
     ON CONFLICT(origin, permission) DO UPDATE SET
       decision = excluded.decision,
       updated_at = excluded.updated_at`,
  );
  const removeOne = db.prepare(
    'DELETE FROM permission_decisions WHERE origin = ? AND permission = ?',
  );
  const removeOrigin = db.prepare('DELETE FROM permission_decisions WHERE origin = ?');

  return {
    'permissions.list': ({ limit }) => ({ decisions: list.all([limit]) as PermissionRow[] }),
    'permissions.set': (row) => {
      upsert.run(row);
      return {};
    },
    'permissions.delete': ({ origin, permission }) => ({
      count: (permission === undefined
        ? removeOrigin.run([origin])
        : removeOne.run([origin, permission])
      ).changes,
    }),
  };
}
