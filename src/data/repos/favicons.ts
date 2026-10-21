import { createHash } from 'node:crypto';

import type { DatabaseConnection } from 'better-sqlite3/win32-x64';

import type { RepositoryHandlers } from '../handlers';
import { DataError } from '../errors';

/** Every PNG starts with these eight bytes. Main re-encodes icons itself; this is a second check. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Favicons, once each by the SHA-256 of their PNG: a thousand pages on one site share one row. */
export function faviconHandlers(
  db: DatabaseConnection,
): Pick<RepositoryHandlers, 'favicons.put' | 'favicons.get'> {
  const put = db
    .prepare(
      `INSERT INTO favicons (sha256, png, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(sha256) DO UPDATE SET updated_at = max(updated_at, excluded.updated_at)
       RETURNING id`,
    )
    .pluck();
  const get = db.prepare(
    'SELECT id, png FROM favicons WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id',
  );

  return {
    'favicons.put': ({ png, at }) => {
      const bytes = Buffer.from(png, 'base64');
      if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new DataError('invalid_input');
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      return { id: put.get([sha256, bytes, at]) as number };
    },
    'favicons.get': ({ ids }) => ({
      favicons: (get.all([JSON.stringify(ids)]) as { id: number; png: Buffer }[]).map((row) => ({
        id: row.id,
        png: row.png.toString('base64'),
      })),
    }),
  };
}
