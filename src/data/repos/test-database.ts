// Test support for the repositories and the schema: a real database file in a temp folder,
// opened and migrated exactly as the worker does it. Never imported by the worker.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DatabaseConnection } from 'better-sqlite3/win32-x64';
import { afterEach, beforeEach } from 'vitest';

import { uuidv7 } from '../../core/id/uuidv7';
import { DATA_METHODS } from '../../shared/contracts/data-rpc';
import type { DataInput, DataOutput } from '../../shared/contracts/data-rpc';
import { openDatabase } from '../database';
import { sqliteCode } from '../errors';
import type { Handler, HandlerInput, RepositoryHandlers, RepositoryMethod } from '../handlers';

/** Gives each test its own fresh database; the returned function reads the current one. */
export function useTestDatabase(): () => DatabaseConnection {
  let folder = '';
  let current: DatabaseConnection | undefined;

  beforeEach(async () => {
    folder = mkdtempSync(join(tmpdir(), 'veltriva-data-'));
    const opened = await openDatabase({
      file: join(folder, 'veltriva.db'),
      backupDir: join(folder, 'backups'),
    });
    current = opened.db;
  });
  afterEach(() => {
    current?.close();
    current = undefined;
    rmSync(folder, { recursive: true, force: true });
  });

  return () => {
    if (current === undefined) {
      throw new Error('No test database: call it from inside a test.');
    }
    return current;
  };
}

/** A UUIDv7 that sorts by `n`, so tests can predict the `ORDER BY id` tie-break. */
export function testId(n: number): string {
  return uuidv7(1_700_000_000_000 + n, new Uint8Array(10).fill(n % 256));
}

/** The id of the workspace `addWorkspace` creates when it isn't given one. */
export const WORKSPACE_ID = testId(1);

export function addWorkspace(db: DatabaseConnection, id: string = WORKSPACE_ID): void {
  db.prepare('INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run([
    id,
    'Workspace',
    1_700_000_000_000,
    1_700_000_000_000,
  ]);
}

/** The SQLite extended code an action throws (`SQLITE_CONSTRAINT_CHECK`), or undefined. */
export function sqliteErrorCode(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return sqliteCode(error);
  }
  return undefined;
}

/**
 * Calls handlers the way the server does: the input goes through the method's input schema first,
 * and the result through its output schema, so a key or shape drift fails the test.
 */
export function callerFor<K extends RepositoryMethod>(handlers: Pick<RepositoryHandlers, K>) {
  return <M extends K>(method: M, input: DataInput<M>): DataOutput<M> => {
    const { input: inputSchema, output: outputSchema } = DATA_METHODS[method];
    const handler = handlers[method] as Handler<M>;
    const result = handler(inputSchema.parse(input) as HandlerInput<M>);
    return outputSchema.parse(result) as DataOutput<M>;
  };
}
