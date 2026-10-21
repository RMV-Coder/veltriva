import { createHash } from 'node:crypto';

import type { DatabaseConnection } from 'better-sqlite3/win32-x64';

import { MAX_FAVICON_BYTES, sniffRasterType } from '../../core/net/favicon-format';
import type { RasterType } from '../../core/net/favicon-format';
import type { RepositoryHandlers } from '../handlers';
import { DataError } from '../errors';

/**
 * Favicons (migration 0002), once each by the SHA-256 of their bytes: a thousand pages on one site
 * share one row. The bytes are kept as the favicon service validated them, never decoded here or
 * in main; the worker sniffs them again (threat T5), since the file must only ever hold images.
 */
export function faviconHandlers(
  db: DatabaseConnection,
): Pick<RepositoryHandlers, 'favicons.put' | 'favicons.get'> {
  const put = db
    .prepare(
      `INSERT INTO favicons (sha256, bytes, mime, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(sha256) DO UPDATE SET updated_at = max(updated_at, excluded.updated_at)
       RETURNING id`,
    )
    .pluck();
  const get = db.prepare(
    'SELECT id, mime, bytes FROM favicons WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id',
  );

  return {
    'favicons.put': ({ bytes, mime, at }) => {
      const decoded = Buffer.from(bytes, 'base64');
      if (
        decoded.length === 0 ||
        decoded.length > MAX_FAVICON_BYTES ||
        sniffRasterType(decoded) !== mime
      ) {
        throw new DataError('invalid_input');
      }
      const sha256 = createHash('sha256').update(decoded).digest('hex');
      return { id: put.get([sha256, decoded, mime, at]) as number };
    },
    'favicons.get': ({ ids }) => ({
      favicons: (
        get.all([JSON.stringify(ids)]) as { id: number; mime: RasterType; bytes: Buffer }[]
      ).map((row) => ({ id: row.id, mime: row.mime, bytes: row.bytes.toString('base64') })),
    }),
  };
}
