import type { DatabaseConnection } from 'better-sqlite3/win32-x64';

import type { RepositoryHandlers } from '../handlers';
import { parseDocument } from './shared';

/** Small JSON documents by key: the session, the window, the client-hint opt-ins, … */
export function appStateHandlers(
  db: DatabaseConnection,
): Pick<RepositoryHandlers, 'appState.get' | 'appState.set' | 'appState.delete'> {
  const select = db.prepare('SELECT json FROM app_state WHERE key = ?').pluck();
  const upsert = db.prepare(
    'INSERT INTO app_state (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json',
  );
  const remove = db.prepare('DELETE FROM app_state WHERE key = ?');

  return {
    'appState.get': ({ key }) => {
      const json = select.get([key]);
      return { value: typeof json === 'string' ? parseDocument(json) : null };
    },
    'appState.set': ({ key, value }) => {
      upsert.run([key, JSON.stringify(value)]);
      return {};
    },
    'appState.delete': ({ key }) => ({ count: remove.run([key]).changes }),
  };
}
