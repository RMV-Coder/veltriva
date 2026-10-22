import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3/win32-x64';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DATA_METHODS } from '../shared/contracts/data-rpc';
import { openDatabase } from './database';
import type { OpenedDatabase } from './database';
import { DataError } from './errors';
import { DATA_WRITES } from './handlers';
import { LATEST_VERSION } from './migrations';
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
      userVersion: LATEST_VERSION,
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
    const backup = handle(
      request('maintenance.run', { now: Date.UTC(2026, 9, 21), visitRetentionDays: 365 }, 10),
    );
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

describe('createDataServer: maintenance.run', () => {
  const NOW = Date.UTC(2026, 9, 21);
  const DAY = 86_400_000;
  const ran = {
    check: 'ok',
    backup: 'unchanged',
    backupFile: null,
    pruned: { visits: 3, pages: 2, closedTabs: 1 },
  } as const;

  it('passes the time and the visit retention it was given to Maintenance', async () => {
    const run = vi.spyOn(maintenance, 'run').mockResolvedValue(ran);

    await handle(request('maintenance.run', { now: NOW, visitRetentionDays: 30 }));

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(NOW, 30);
  });

  it.each([1, 365, 36_500])('passes a retention of %s days on as it is', async (days) => {
    const run = vi.spyOn(maintenance, 'run').mockResolvedValue(ran);

    await handle(request('maintenance.run', { now: NOW, visitRetentionDays: days }));

    expect(run).toHaveBeenCalledWith(NOW, days);
  });

  it('answers with what the run did, including what it pruned', async () => {
    vi.spyOn(maintenance, 'run').mockResolvedValue(ran);

    const { reply } = await handle(
      request('maintenance.run', { now: NOW, visitRetentionDays: 365 }, 21),
    );

    expect(reply).toEqual({ kind: 'response', id: 21, ok: true, value: ran });
    expect(
      DATA_METHODS['maintenance.run'].output.safeParse((reply as { value: unknown }).value).success,
    ).toBe(true);
  });

  it.each([
    ['no retention', { now: NOW }],
    ['a retention of 0', { now: NOW, visitRetentionDays: 0 }],
    ['a retention of 36,501 days', { now: NOW, visitRetentionDays: 36_501 }],
    ['a fractional retention', { now: NOW, visitRetentionDays: 1.5 }],
    ['a retention that is text', { now: NOW, visitRetentionDays: '365' }],
    ['no time', { visitRetentionDays: 365 }],
    ['a key more', { now: NOW, visitRetentionDays: 365, force: true }],
  ])('refuses %s as invalid input, without running anything', async (_what, input) => {
    const run = vi.spyOn(maintenance, 'run');

    const { reply } = await handle(request('maintenance.run', input));

    expect(reply).toEqual({
      kind: 'response',
      id: 7,
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('retains for real: only the visits older than the given retention go', async () => {
    opened.db
      .prepare(
        `INSERT INTO pages (url_key, url, host, site, first_visit_at, last_visit_at)
         VALUES ('k', 'https://x.example/', 'x.example', 'x.example', 1, 1)`,
      )
      .run();
    const insert = opened.db.prepare(
      "INSERT INTO visits (page_id, visited_at, transition) VALUES (1, ?, 'link')",
    );
    insert.run([NOW - 40 * DAY]);
    insert.run([NOW - 10 * DAY]);

    const { reply } = await handle(
      request('maintenance.run', { now: NOW, visitRetentionDays: 30 }),
    );

    expect(reply).toMatchObject({
      ok: true,
      value: { pruned: { visits: 1, pages: 0, closedTabs: 0 } },
    });
    expect(opened.db.prepare('SELECT COUNT(*) FROM visits').pluck().get()).toBe(1);
  });

  it('keeps all of them under a longer retention, from the same database', async () => {
    opened.db
      .prepare(
        `INSERT INTO pages (url_key, url, host, site, first_visit_at, last_visit_at)
         VALUES ('k', 'https://x.example/', 'x.example', 'x.example', 1, 1)`,
      )
      .run();
    opened.db
      .prepare("INSERT INTO visits (page_id, visited_at, transition) VALUES (1, ?, 'link')")
      .run([NOW - 40 * DAY]);

    const { reply } = await handle(
      request('maintenance.run', { now: NOW, visitRetentionDays: 365 }),
    );

    expect(reply).toMatchObject({
      ok: true,
      value: { pruned: { visits: 0, pages: 0, closedTabs: 0 } },
    });
  });

  it('reports a run that is turned away as the busy error', async () => {
    vi.spyOn(maintenance, 'run').mockRejectedValue(new DataError('busy'));

    const { reply } = await handle(
      request('maintenance.run', { now: NOW, visitRetentionDays: 365 }),
    );

    expect(reply).toMatchObject({ ok: false, error: { code: 'busy' } });
  });
});

describe('DATA_WRITES', () => {
  const visit = {
    page: {
      urlKey: 'https://example.com/',
      url: 'https://example.com/',
      host: 'example.com',
      site: 'example.com',
      title: '',
    },
    transition: 'link',
    visitedAt: 1,
    tabId: null,
  };

  it.each(['history.recordVisit', 'history.updatePage', 'favicons.put'] as const)(
    'includes %s, so a visit, a title or an icon makes the next backup worth taking',
    (method) => {
      expect(DATA_WRITES.has(method)).toBe(true);
    },
  );

  it('marks a backup as due after a recorded visit', async () => {
    repositories['history.recordVisit'] = () => ({ pageId: 1 });
    expect(maintenance.status().changedSinceBackup).toBe(false);

    expect((await handle(request('history.recordVisit', visit))).reply).toMatchObject({ ok: true });

    expect(maintenance.status().changedSinceBackup).toBe(true);
  });

  it('marks a backup as due after the title of a page is set', async () => {
    repositories['history.updatePage'] = () => ({ count: 1 });

    await handle(request('history.updatePage', { pageId: 1, title: 'x' }));

    expect(maintenance.status().changedSinceBackup).toBe(true);
  });

  it('marks one as due for a visit that the memory refused too, since the call succeeded', async () => {
    repositories['history.recordVisit'] = () => ({ pageId: null });

    await handle(request('history.recordVisit', visit));

    expect(maintenance.status().changedSinceBackup).toBe(true);
  });

  it('does not mark one for a write that failed', async () => {
    repositories['history.recordVisit'] = () => {
      throw new Database.SqliteError('full', 'SQLITE_FULL');
    };

    await handle(request('history.recordVisit', visit));

    expect(maintenance.status().changedSinceBackup).toBe(false);
  });

  it('does not mark one for input the schema refused', async () => {
    const handler = vi.fn();
    repositories['history.recordVisit'] = handler;

    await handle(request('history.recordVisit', { ...visit, transition: 'click' }));

    expect(handler).not.toHaveBeenCalled();
    expect(maintenance.status().changedSinceBackup).toBe(false);
  });

  it.each([
    ['history.pages', { limit: 5 }, { pages: [] }],
    ['history.visits', { pageId: 1, limit: 5 }, { visits: [] }],
    ['favicons.get', { ids: [1] }, { favicons: [] }],
  ] as const)('does not mark one for the read %s', async (method, input, answer) => {
    repositories[method] = () => answer;

    expect((await handle(request(method, input))).reply).toMatchObject({ ok: true });

    expect(maintenance.status().changedSinceBackup).toBe(false);
  });

  it('is exactly the writes: every other repository method only reads, or is a heartbeat', () => {
    const repositoryMethods = Object.keys(DATA_METHODS).filter(
      (method) => !method.startsWith('db.') && !method.startsWith('maintenance.'),
    );

    const notWrites = repositoryMethods.filter(
      (method) => !(DATA_WRITES as ReadonlySet<string>).has(method),
    );

    expect(notWrites.sort()).toEqual([
      'appRuns.end',
      'appRuns.heartbeat',
      'appRuns.recent',
      'appRuns.start',
      'appState.get',
      'downloads.list',
      'favicons.get',
      'history.pages',
      'history.visits',
      'permissions.list',
      'settings.get',
      'tabs.countArchived',
      'tabs.list',
      'tabs.listArchived',
      'tabs.listClosed',
    ]);
  });

  it('names only methods that exist', () => {
    for (const method of DATA_WRITES) {
      expect(Object.hasOwn(DATA_METHODS, method), method).toBe(true);
    }
  });
});
