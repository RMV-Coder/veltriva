import type { DatabaseConnection } from 'better-sqlite3/win32-x64';

import type { RepositoryHandlers } from '../handlers';
import { parseDocument } from './shared';

/** The settings document: one row, id 1. Its schema and defaults belong to the caller (M2.2b). */
export function settingsHandlers(
  db: DatabaseConnection,
): Pick<RepositoryHandlers, 'settings.get' | 'settings.set'> {
  const select = db.prepare('SELECT json FROM settings WHERE id = 1').pluck();
  const upsert = db.prepare(
    'INSERT INTO settings (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json',
  );

  return {
    'settings.get': () => {
      const json = select.get();
      return { value: typeof json === 'string' ? parseDocument(json) : null };
    },
    'settings.set': ({ value }) => {
      upsert.run([JSON.stringify(value)]);
      return {};
    },
  };
}
