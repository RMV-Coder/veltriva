import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3/win32-x64';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DATA_METHODS } from '../shared/contracts/data-rpc';
import { openDatabase } from './database';
import type { OpenedDatabase } from './database';
import { DataError } from './errors';
import type { RepositoryHandlers } from './handlers';
import { NEEDS_CHECK_SUFFIX } from './integrity';
import { Maintenance } from './maintenance';
import { createDataServer } from './server';
import type { DataServer, HandledMessage } from './server';

let dir: string;
let file: string;
let opened: OpenedDatabase;
let maintenance: Maintenance;
let server: DataServer;
let repositories: Record<string, (input: unknown) => unknown>;

function request(method: string, input: unknown, id = 7): unknown {
  return { kind: 'request', id, method, input };
}

/** Every reply, whether the method answers at once or later. */
async function handle(message: unknown): Promise<HandledMessage> {
  return server.handle(message);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veltriva-server-'));
  file = join(dir, 'veltriva.db');
  const backupDir = join(dir, 'backups');
  opened = await openDatabase({ file, backupDir });
  maintenance = new Maintenance(opened.db, { file, backupDir });
  repositories = {};
  server = createDataServer(
    { db: opened.db, file, latestVersion: 1, threadId: 3, maintenance },
    // Only the handlers a test sets exist; the server must never reach any other.
    new Proxy(repositories, {
      get: (target, name: string) =>
        target[name] ??
        (() => {
          throw new Error(`unexpected handler ${name}`);
        }),
    }) as unknown as RepositoryHandlers,
  );
});

afterEach(() => {
  if (opened.db.open) {
    opened.db.close();
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('createDataServer', () => {
  it('runs the handler with the parsed input and answers at once with its value', () => {
    const handler = vi.fn(() => ({ value: { selected: null } }));
    repositories['appState.get'] = handler;
    // A plain object, not a promise: replies keep the order requests came in.
    const { reply, closed } = server.handle(
      request('appState.get', { key: 'session' }),
    ) as HandledMessage;
    expect(handler).toHaveBeenCalledWith({ key: 'session' });
    expect(reply).toEqual({
      kind: 'response',
      id: 7,
      ok: true,
      value: { value: { selected: null } },
    });
    expect(closed).toBe(false);
  });

  it('ignores a message without a valid envelope: there is no id to answer', async () => {
    for (const message of [
      null,
      'x',
      { kind: 'request', id: 0, method: 'db.info', input: {} },
      { id: 1 },
    ]) {
      expect((await handle(message)).reply).toBeNull();
    }
  });

  it('refuses an unknown method, including ones inherited from Object', async () => {
    for (const method of ['tabs.drop', 'toString', '__proto__', 'constructor']) {
      expect((await handle(request(method, {}))).reply).toMatchObject({
        ok: false,
        error: { code: 'unknown_method' },
      });
    }
  });

  it("refuses input that doesn't match the schema, without calling the handler", async () => {
    const handler = vi.fn();
    repositories['appState.get'] = handler;
    for (const input of [
      { key: 'session', extra: true },
      { key: 'BAD KEY' },
      // The worker's own document is out of bounds for appState.*.
      { key: 'maintenance' },
      {},
      null,
      'session',
    ]) {
      expect((await handle(request('appState.get', input))).reply).toEqual({
        kind: 'response',
        id: 7,
        ok: false,
        error: { code: 'invalid_input' },
      });
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('reports a row the schema refuses as invalid input, with only the SQLite code', async () => {
    repositories['appState.delete'] = () => {
      opened.db.prepare("INSERT INTO app_state VALUES ('k', 'not json')").run();
      return { count: 0 };
    };
    expect((await handle(request('appState.delete', { key: 'k' }))).reply).toEqual({
      kind: 'response',
      id: 7,
      ok: false,
      error: { code: 'invalid_input', detail: 'SQLITE_CONSTRAINT_CHECK' },
    });
  });

  it("never sends an error's message: other SQLite failures carry a code, the rest none", async () => {
    repositories['appState.delete'] = () => {
      throw new Database.SqliteError('database or disk is full: secret row text', 'SQLITE_FULL');
    };
    expect((await handle(request('appState.delete', { key: 'k' }))).reply).toMatchObject({
      error: { code: 'sqlite', detail: 'SQLITE_FULL' },
    });
    repositories['appState.delete'] = () => {
      throw new Error('https://example.com/?token=secret');
    };
    expect((await handle(request('appState.delete', { key: 'k' }))).reply).toEqual({
      kind: 'response',
      id: 7,
      ok: false,
      error: { code: 'internal' },
    });
    repositories['appState.delete'] = () => {
      throw new DataError('db_newer', '2 > 1');
    };
    expect((await handle(request('appState.delete', { key: 'k' }))).reply).toMatchObject({
      error: { code: 'db_newer', detail: '2 > 1' },
    });
  });

  it('leaves the needs-check marker when SQLite reports damage while serving', async () => {
    repositories['tabs.deleteMany'] = () => {
      throw new Database.SqliteError('database disk image is malformed', 'SQLITE_CORRUPT');
    };
    expect(existsSync(file + NEEDS_CHECK_SUFFIX)).toBe(false);
    const { reply } = await handle(
      request('tabs.deleteMany', { ids: ['0199f000-0000-7000-8000-000000000011'] }),
    );
    expect(reply).toMatchObject({ error: { code: 'sqlite', detail: 'SQLITE_CORRUPT' } });
    expect(existsSync(file + NEEDS_CHECK_SUFFIX)).toBe(true);
  });

  it('counts a successful write as a change for the next backup, and a read or a failure not', async () => {
    repositories['appState.get'] = () => ({ value: null });
    repositories['appState.set'] = () => ({});
    repositories['appRuns.heartbeat'] = () => ({ count: 1 });
    repositories['appState.delete'] = () => {
      throw new Database.SqliteError('full', 'SQLITE_FULL');
    };
    await handle(request('appState.get', { key: 'session' }));
    await handle(request('appRuns.heartbeat', { id: 1, at: 5 }));
    await handle(request('appState.delete', { key: 'session' }));
    expect(maintenance.status().changedSinceBackup).toBe(false);

    await handle(request('appState.set', { key: 'session', value: {} }));
    expect(maintenance.status().changedSinceBackup).toBe(true);
    expect((await handle(request('maintenance.status', {}))).reply).toMatchObject({
      ok: true,
      value: { changedSinceBackup: true, lastBackupAt: null },
    });
  });

  it('db.info reports the versions, the pragmas and its thread, in the contract shape', async () => {
    const { reply } = await handle(request('db.info', {}));
    expect(reply).toMatchObject({ ok: true });
    const value = (reply as { value: unknown }).value;
    expect(DATA_METHODS['db.info'].output.parse(value)).toMatchObject({
      userVersion: 1,
      latestVersion: 1,
      journalMode: 'wal',
      autoVacuum: 2,
      foreignKeys: 1,
      secureDelete: 1,
      threadId: 3,
    });
  });

  it('db.close closes the connection, and every later request is refused', async () => {
    const { reply, closed } = await handle(request('db.close', {}, 8));
    expect(reply).toEqual({ kind: 'response', id: 8, ok: true, value: {} });
    expect(closed).toBe(true);
    expect(opened.db.open).toBe(false);
    expect(await handle(request('db.info', {}, 9))).toEqual({
      reply: { kind: 'response', id: 9, ok: false, error: { code: 'closed' } },
      closed: true,
    });
  });

  it('db.close stops a running backup first, then closes', async () => {
    // Enough pages that the stepped backup is still running when the close arrives.
    opened.db.exec(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000) INSERT INTO app_state SELECT 'k' || i, json_object('pad', hex(randomblob(500))) FROM n",
    );
    maintenance.noteWrite();
    const backup = handle(request('maintenance.run', { now: Date.UTC(2026, 9, 21) }, 10));
    const closing = handle(request('db.close', {}, 11));
    expect((await backup).reply).toMatchObject({
      ok: true,
      value: { backup: 'failed', backupFile: null },
    });
    expect((await closing).reply).toMatchObject({ ok: true });
    expect(opened.db.open).toBe(false);
    expect(existsSync(join(dir, 'backups'))).toBe(true);
  });
});
