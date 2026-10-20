import type { DatabaseConnection } from 'better-sqlite3/win32-x64';

import type { AppRunRow } from '../../shared/contracts/data-rpc';
import type { RepositoryHandlers } from '../handlers';

/**
 * One row per launch, for crash detection: a run that never got an `ended_at` is a crash. Only a
 * run that is still open changes, and its heartbeat never moves backwards.
 */
export function appRunHandlers(
  db: DatabaseConnection,
): Pick<
  RepositoryHandlers,
  'appRuns.start' | 'appRuns.heartbeat' | 'appRuns.end' | 'appRuns.recent'
> {
  const insert = db.prepare(
    'INSERT INTO app_runs (started_at, last_heartbeat_at, app_version) VALUES (@startedAt, @startedAt, @appVersion)',
  );
  const heartbeat = db.prepare(
    `UPDATE app_runs SET last_heartbeat_at = max(last_heartbeat_at, @at)
     WHERE id = @id AND ended_at IS NULL`,
  );
  const end = db.prepare(
    `UPDATE app_runs
     SET ended_at = @at, exit_kind = @exitKind, last_heartbeat_at = max(last_heartbeat_at, @at)
     WHERE id = @id AND ended_at IS NULL`,
  );
  const recent = db.prepare(
    `SELECT id, started_at AS startedAt, last_heartbeat_at AS lastHeartbeatAt, ended_at AS endedAt,
            exit_kind AS exitKind, app_version AS appVersion
     FROM app_runs
     ORDER BY id DESC
     LIMIT ?`,
  );

  return {
    'appRuns.start': (input) => ({ id: Number(insert.run(input).lastInsertRowid) }),
    'appRuns.heartbeat': (input) => ({ count: heartbeat.run(input).changes }),
    'appRuns.end': (input) => ({ count: end.run(input).changes }),
    'appRuns.recent': ({ limit }) => ({ runs: recent.all([limit]) as AppRunRow[] }),
  };
}
