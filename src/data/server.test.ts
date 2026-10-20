import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3/win32-x64';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DATA_METHODS } from '../shared/contracts/data-rpc';
import { openDatabase } from './database';
import type { OpenedDatabase } from './database';
import { DataError } from './errors';
import type { RepositoryHandlers } from './handlers';
import { createDataServer } from './server';
import type { DataServer } from './server';

let dir: string;
let opened: OpenedDatabase;
let server: DataServer;
let repositories: Record<string, (input: unknown) => unknown>;

function request(method: string, input: unknown, id = 7): unknown {
  return { kind: 'request', id, method, input };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veltriva-server-'));
  opened = await openDatabase({ file: join(dir, 'veltriva.db'), backupDir: join(dir, 'backups') });
  repositories = {};
  server = createDataServer(
    { db: opened.db, latestVersion: 1, threadId: 3 },
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
  it('runs the handler with the parsed input and answers with its value', () => {
    const handler = vi.fn(() => ({ value: { selected: null } }));
    repositories['appState.get'] = handler;
    const { reply, closed } = server.handle(request('appState.get', { key: 'session' }));
    expect(handler).toHaveBeenCalledWith({ key: 'session' });
    expect(reply).toEqual({
      kind: 'response',
      id: 7,
      ok: true,
      value: { value: { selected: null } },
    });
    expect(closed).toBe(false);
  });

  it('ignores a message without a valid envelope: there is no id to answer', () => {
    for (const message of [
      null,
      'x',
      { kind: 'request', id: 0, method: 'db.info', input: {} },
      { id: 1 },
    ]) {
      expect(server.handle(message).reply).toBeNull();
    }
  });

  it('refuses an unknown method, including ones inherited from Object', () => {
    for (const method of ['tabs.drop', 'toString', '__proto__', 'constructor']) {
      expect(server.handle(request(method, {})).reply).toMatchObject({
        ok: false,
        error: { code: 'unknown_method' },
      });
    }
  });

  it("refuses input that doesn't match the schema, without calling the handler", () => {
    const handler = vi.fn();
    repositories['appState.get'] = handler;
    for (const input of [
      { key: 'session', extra: true },
      { key: 'BAD KEY' },
      {},
      null,
      'session',
    ]) {
      expect(server.handle(request('appState.get', input)).reply).toEqual({
        kind: 'response',
        id: 7,
        ok: false,
        error: { code: 'invalid_input' },
      });
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('reports a row the schema refuses as invalid input, with only the SQLite code', () => {
    repositories['appState.delete'] = () => {
      opened.db.prepare("INSERT INTO app_state VALUES ('k', 'not json')").run();
      return { count: 0 };
    };
    expect(server.handle(request('appState.delete', { key: 'k' })).reply).toEqual({
      kind: 'response',
      id: 7,
      ok: false,
      error: { code: 'invalid_input', detail: 'SQLITE_CONSTRAINT_CHECK' },
    });
  });

  it("never sends an error's message: other SQLite failures carry a code, the rest none", () => {
    repositories['appState.delete'] = () => {
      throw new Database.SqliteError('database or disk is full: secret row text', 'SQLITE_FULL');
    };
    expect(server.handle(request('appState.delete', { key: 'k' })).reply).toMatchObject({
      error: { code: 'sqlite', detail: 'SQLITE_FULL' },
    });
    repositories['appState.delete'] = () => {
      throw new Error('https://example.com/?token=secret');
    };
    expect(server.handle(request('appState.delete', { key: 'k' })).reply).toEqual({
      kind: 'response',
      id: 7,
      ok: false,
      error: { code: 'internal' },
    });
    repositories['appState.delete'] = () => {
      throw new DataError('db_newer', '2 > 1');
    };
    expect(server.handle(request('appState.delete', { key: 'k' })).reply).toMatchObject({
      error: { code: 'db_newer', detail: '2 > 1' },
    });
  });

  it('db.info reports the versions, the pragmas and its thread, in the contract shape', () => {
    const { reply } = server.handle(request('db.info', {}));
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

  it('db.close closes the connection, and every later request is refused', () => {
    const { reply, closed } = server.handle(request('db.close', {}, 8));
    expect(reply).toEqual({ kind: 'response', id: 8, ok: true, value: {} });
    expect(closed).toBe(true);
    expect(opened.db.open).toBe(false);
    expect(server.handle(request('db.info', {}, 9))).toEqual({
      reply: { kind: 'response', id: 9, ok: false, error: { code: 'closed' } },
      closed: true,
    });
  });
});
