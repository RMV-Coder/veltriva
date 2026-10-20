import type { DatabaseConnection } from 'better-sqlite3/win32-x64';

import type { DownloadRow } from '../../shared/contracts/data-rpc';
import type { RepositoryHandlers } from '../handlers';
import { bit } from './shared';

/** A `downloads` row as SQLite returns it: the columns are aliased to the contract's field names. */
type StoredDownload = Omit<DownloadRow, 'dangerous' | 'confirmed'> & {
  readonly dangerous: number;
  readonly confirmed: number;
};

/** The download history: what main started, newest first. No page content, no headers. */
export function downloadHandlers(
  db: DatabaseConnection,
): Pick<
  RepositoryHandlers,
  'downloads.list' | 'downloads.upsert' | 'downloads.delete' | 'downloads.clear'
> {
  const list = db.prepare(
    `SELECT id, file_name AS fileName, path, url, site, state, dangerous, confirmed,
            received_bytes AS receivedBytes, total_bytes AS totalBytes, started_at AS startedAt,
            ended_at AS endedAt
     FROM downloads
     ORDER BY started_at DESC, id DESC
     LIMIT ?`,
  );
  const upsert = db.prepare(
    `INSERT INTO downloads (
       id, file_name, path, url, site, state, dangerous, confirmed, received_bytes, total_bytes,
       started_at, ended_at
     ) VALUES (
       @id, @fileName, @path, @url, @site, @state, @dangerous, @confirmed, @receivedBytes,
       @totalBytes, @startedAt, @endedAt
     )
     ON CONFLICT(id) DO UPDATE SET
       file_name = excluded.file_name,
       path = excluded.path,
       url = excluded.url,
       site = excluded.site,
       state = excluded.state,
       dangerous = excluded.dangerous,
       confirmed = excluded.confirmed,
       received_bytes = excluded.received_bytes,
       total_bytes = excluded.total_bytes,
       started_at = excluded.started_at,
       ended_at = excluded.ended_at`,
  );
  const remove = db.prepare('DELETE FROM downloads WHERE id = ?');
  const clear = db.prepare('DELETE FROM downloads');

  return {
    'downloads.list': ({ limit }) => ({
      downloads: (list.all([limit]) as StoredDownload[]).map(toDownloadRow),
    }),
    'downloads.upsert': (row) => {
      upsert.run({ ...row, dangerous: bit(row.dangerous), confirmed: bit(row.confirmed) });
      return {};
    },
    'downloads.delete': ({ id }) => ({ count: remove.run([id]).changes }),
    'downloads.clear': () => ({ count: clear.run().changes }),
  };
}

function toDownloadRow(row: StoredDownload): DownloadRow {
  return { ...row, dangerous: row.dangerous === 1, confirmed: row.confirmed === 1 };
}
