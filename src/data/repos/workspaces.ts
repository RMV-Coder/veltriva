import type { DatabaseConnection } from 'better-sqlite3/win32-x64';

import type { HandlerInput, RepositoryHandlers } from '../handlers';

export function workspaceHandlers(
  db: DatabaseConnection,
): Pick<RepositoryHandlers, 'workspaces.ensureDefault'> {
  const oldest = db.prepare('SELECT id FROM workspaces ORDER BY created_at, id LIMIT 1').pluck();
  const insert = db.prepare(
    'INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (@candidateId, @name, @now, @now)',
  );

  // One transaction, so the check and the insert can't be split by another write.
  const ensureDefault = db.transaction((input: HandlerInput<'workspaces.ensureDefault'>) => {
    const existing = oldest.get();
    if (typeof existing === 'string') {
      return { id: existing, created: false };
    }
    insert.run(input);
    return { id: input.candidateId, created: true };
  });

  return { 'workspaces.ensureDefault': ensureDefault };
}
