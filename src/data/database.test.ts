// The opener and migration runner, on real files (ADR-0008 §3, assessment §5.6). Every historical
// schema version has a fixture here: 0 is a new file, 1 and 2 are migrations/fixtures/veltriva-v<n>.db.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3/win32-x64';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { KEPT_BACKUPS } from './backups';
import { BUSY_TIMEOUT_MS, CACHE_SIZE, openDatabase } from './database';
import type { OpenedDatabase } from './database';
import { DataError } from './errors';
import { LATEST_VERSION, MIGRATIONS } from './migrations';
import type { Migration } from './migrations';

const V1_FIXTURE = join(import.meta.dirname, 'migrations', 'fixtures', 'veltriva-v1.db');
const V2_FIXTURE = join(import.meta.dirname, 'migrations', 'fixtures', 'veltriva-v2.db');
const NOW = Date.UTC(2026, 9, 21, 8, 30, 15);

/** A harmless migration after the latest, to exercise the runner beyond the real history. */
const NEXT: Migration = {
  version: LATEST_VERSION + 1,
  name: 'next_test',
  sql: "ALTER TABLE workspaces ADD COLUMN color TEXT NOT NULL DEFAULT '';",
};

const TABLES = [
  'app_runs',
  'app_state',
  'downloads',
  'favicons',
  'pages',
  'pages_fts',
  'permission_decisions',
  'settings',
  'site_rules',
  'tabs',
  'visits',
  'workspaces',
];

let dir: string;
let file: string;
let backupDir: string;
const opened: OpenedDatabase[] = [];

async function open(migrations?: readonly Migration[]): Promise<OpenedDatabase> {
  const result = await openDatabase({
    file,
    backupDir,
    now: () => NOW,
    ...(migrations === undefined ? {} : { migrations }),
  });
  opened.push(result);
  return result;
}

async function openError(migrations?: readonly Migration[]): Promise<DataError> {
  const error: unknown = await open(migrations).then(
    () => new Error('opened'),
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DataError);
  return error as DataError;
}

/** Reads a file with a plain connection, as a person inspecting it would. */
function inspect<T>(path: string, read: (db: InstanceType<typeof Database>) => T): T {
  const db = new Database(path, { readonly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function userVersion(path: string): unknown {
  return inspect(path, (db) => db.pragma('user_version', { simple: true }));
}

function tables(db: InstanceType<typeof Database>): string[] {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'pages_fts_%' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .pluck()
    .all() as string[];
}

function count(db: InstanceType<typeof Database>, table: string): unknown {
  return db.prepare(`SELECT count(*) FROM ${table}`).pluck().get();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'veltriva-db-'));
  file = join(dir, 'veltriva.db');
  backupDir = join(dir, 'backups');
});

afterEach(() => {
  for (const { db } of opened.splice(0)) {
    if (db.open) {
      db.close();
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('a new database (version 0)', () => {
  it('gets every table of the latest schema, in one migration, with no backup', async () => {
    const { db, fromVersion, userVersion: version, backupFile } = await open();
    expect(fromVersion).toBe(0);
    expect(version).toBe(LATEST_VERSION);
    expect(backupFile).toBeNull();
    expect(existsSync(backupDir)).toBe(false);
    expect(tables(db)).toEqual(TABLES);
  });

  it('gets the ADR-0004 pragmas, read back from the connection', async () => {
    const { db } = await open();
    const pragma = (name: string): unknown => db.pragma(name, { simple: true });
    expect(pragma('journal_mode')).toBe('wal');
    // INCREMENTAL, which sticks only when set before journal_mode=WAL on a new file (S5).
    expect(pragma('auto_vacuum')).toBe(2);
    expect(pragma('synchronous')).toBe(1);
    expect(pragma('foreign_keys')).toBe(1);
    expect(pragma('busy_timeout')).toBe(BUSY_TIMEOUT_MS);
    expect(pragma('secure_delete')).toBe(1);
    expect(pragma('temp_store')).toBe(2);
    expect(pragma('cache_size')).toBe(CACHE_SIZE);
  });

  it('keeps auto_vacuum and WAL in the file itself', async () => {
    (await open()).db.close();
    inspect(file, (db) => {
      expect(db.pragma('auto_vacuum', { simple: true })).toBe(2);
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    });
  });

  it('is left with no tables when its first migration fails', async () => {
    const broken: Migration = {
      version: 1,
      name: 'broken',
      sql: 'CREATE TABLE a (x); SELECT no_such_function();',
    };
    const error = await openError([broken]);
    expect(error.code).toBe('migration_failed');
    expect(error.detail).toBe('1 SQLITE_ERROR');
    expect(userVersion(file)).toBe(0);
    inspect(file, (db) => {
      expect(tables(db)).toEqual([]);
    });
  });
});

describe('a database at the latest version', () => {
  it('reopens without migrating or backing up, and keeps its rows', async () => {
    const first = await open();
    first.db.prepare("INSERT INTO app_state VALUES ('session', '{}')").run();
    first.db.close();

    const again = await open();
    expect(again.fromVersion).toBe(LATEST_VERSION);
    expect(again.backupFile).toBeNull();
    expect(count(again.db, 'app_state')).toBe(1);
  });
});

describe('the version 1 fixture', () => {
  beforeEach(() => {
    copyFileSync(V1_FIXTURE, file);
  });

  it('opens with every row intact and passes the integrity checks', async () => {
    const { db, fromVersion, userVersion: version } = await open();
    expect(fromVersion).toBe(1);
    expect(version).toBe(LATEST_VERSION);
    expect(db.pragma('quick_check', { simple: true })).toBe('ok');
    db.exec("INSERT INTO pages_fts(pages_fts) VALUES ('integrity-check')");
    expect(
      Object.fromEntries(
        [
          'tabs',
          'pages',
          'visits',
          'downloads',
          'permission_decisions',
          'app_state',
          'app_runs',
        ].map((table) => [table, count(db, table)]),
      ),
    ).toEqual({
      tabs: 3,
      pages: 2,
      visits: 3,
      downloads: 1,
      permission_decisions: 3,
      app_state: 2,
      app_runs: 1,
    });
    const found = db
      .prepare('SELECT rowid FROM pages_fts WHERE pages_fts MATCH ?')
      .pluck()
      .all('"postgre"*');
    expect(found).toEqual([2]);
  });

  it('upgrades through every later version after one backup of the version 1 file', async () => {
    const { db, fromVersion, userVersion: version, backupFile } = await open([...MIGRATIONS, NEXT]);
    expect(fromVersion).toBe(1);
    expect(version).toBe(NEXT.version);
    expect(db.prepare('SELECT color FROM workspaces').pluck().all()).toEqual(['']);
    expect(count(db, 'tabs')).toBe(3);

    expect(backupFile).toBe(
      join(backupDir, `veltriva-v1-before-v${String(NEXT.version)}-2026-10-21T08-30-15Z.db`),
    );
    expect(userVersion(backupFile ?? '')).toBe(1);
    inspect(backupFile ?? '', (backup) => {
      expect(count(backup, 'tabs')).toBe(3);
      expect(backup.pragma('quick_check', { simple: true })).toBe('ok');
    });
  });

  it('rolls a failed upgrade back, keeping version 1 and the backup', async () => {
    const broken: Migration = {
      version: 2,
      name: 'broken',
      sql: 'CREATE TABLE half_done (x); SELECT no_such_function();',
    };
    // In place of the real migration 2.
    const error = await openError([...MIGRATIONS.slice(0, 1), broken]);
    expect(error.code).toBe('migration_failed');
    expect(error.detail).toBe('2 SQLITE_ERROR');
    expect(userVersion(file)).toBe(1);
    inspect(file, (db) => {
      expect(tables(db)).not.toContain('half_done');
      expect(count(db, 'tabs')).toBe(3);
    });
    expect(readdirSync(backupDir)).toHaveLength(1);
  });

  it('keeps only the newest upgrade backups, and leaves other files alone', async () => {
    mkdirSync(backupDir);
    const old = ['2026-01-01T00-00-00Z', '2026-02-01T00-00-00Z', '2026-03-01T00-00-00Z'];
    for (const stamp of old) {
      writeFileSync(join(backupDir, `veltriva-v0-before-v1-${stamp}.db`), '');
    }
    writeFileSync(join(backupDir, 'notes.txt'), 'mine');
    await open([...MIGRATIONS, NEXT]);
    expect(readdirSync(backupDir).sort()).toEqual([
      'notes.txt',
      'veltriva-v0-before-v1-2026-02-01T00-00-00Z.db',
      'veltriva-v0-before-v1-2026-03-01T00-00-00Z.db',
      `veltriva-v1-before-v${String(NEXT.version)}-2026-10-21T08-30-15Z.db`,
    ]);
    expect(KEPT_BACKUPS).toBe(3);
  });
});

describe('migration 2: favicons keep their bytes and type (M2.2b, threat T5)', () => {
  beforeEach(() => {
    copyFileSync(V1_FIXTURE, file);
  });

  it('upgrades the version 1 fixture after a backup, keeping its icon and every reference to it', async () => {
    const {
      db,
      fromVersion,
      userVersion: version,
      backupFile,
    } = await open(MIGRATIONS.slice(0, 2));
    expect(fromVersion).toBe(1);
    expect(version).toBe(2);
    expect(backupFile).toBe(join(backupDir, 'veltriva-v1-before-v2-2026-10-21T08-30-15Z.db'));

    const icon = db.prepare('SELECT id, sha256, mime, bytes FROM favicons').all() as {
      id: number;
      sha256: string;
      mime: string;
      bytes: Buffer;
    }[];
    expect(icon).toEqual([
      { id: 1, sha256: 'aa', mime: 'image/png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    ]);
    // No table rebuild, so no ON DELETE SET NULL ran: the fixture's page still has its icon.
    expect(db.prepare('SELECT favicon_id FROM pages WHERE id = 1').pluck().get()).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('quick_check', { simple: true })).toBe('ok');
  });

  it('renames png to bytes and adds mime', async () => {
    const { db } = await open();
    const columns = (db.pragma('table_info(favicons)') as { name: string }[]).map((c) => c.name);
    expect(columns).toEqual(['id', 'sha256', 'bytes', 'updated_at', 'mime']);
  });

  it('allows only the raster types the favicon service sniffs', async () => {
    const { db } = await open();
    const insert = db.prepare(
      "INSERT INTO favicons (sha256, bytes, mime, updated_at) VALUES (?, x'00', ?, 1)",
    );
    for (const mime of [
      'image/png',
      'image/x-icon',
      'image/gif',
      'image/jpeg',
      'image/webp',
      'image/bmp',
    ]) {
      expect(() => insert.run([`ok-${mime}`, mime])).not.toThrow();
    }
    for (const mime of ['image/svg+xml', 'text/html', 'IMAGE/PNG', '']) {
      expect(() => insert.run([`bad-${mime}`, mime])).toThrow(/CHECK/);
    }
  });

  it('leaves an upgraded file with the same schema as a new one', async () => {
    const schema = (db: { prepare: OpenedDatabase['db']['prepare'] }) =>
      db
        .prepare(
          "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .all();
    const upgraded = schema((await open()).db);
    // Closed before deleting: Windows refuses to delete an open file.
    for (const { db } of opened.splice(0)) {
      db.close();
    }
    rmSync(file);
    rmSync(`${file}-wal`, { force: true });
    rmSync(`${file}-shm`, { force: true });
    const fresh = schema((await open()).db);
    expect(upgraded).toEqual(fresh);
  });
});

describe('migration 3: site rules move to their table (M5.1)', () => {
  beforeEach(() => {
    copyFileSync(V2_FIXTURE, file);
  });

  const rules = (db: OpenedDatabase['db']) =>
    db
      .prepare(
        'SELECT site, protect, exclude_memory AS excludeMemory FROM site_rules ORDER BY site',
      )
      .all();
  const settings = (db: OpenedDatabase['db']): unknown =>
    JSON.parse(db.prepare('SELECT json FROM settings').pluck().get() as string);

  it('opens the version 2 fixture with every row intact, after a backup of it', async () => {
    const { db, fromVersion, userVersion: version, backupFile } = await open();
    expect(fromVersion).toBe(2);
    expect(version).toBe(LATEST_VERSION);
    expect(backupFile).toBe(join(backupDir, 'veltriva-v2-before-v3-2026-10-21T08-30-15Z.db'));
    expect(userVersion(backupFile ?? '')).toBe(2);
    expect(
      Object.fromEntries(
        ['tabs', 'pages', 'visits', 'permission_decisions', 'app_state', 'app_runs'].map(
          (table) => [table, count(db, table)],
        ),
      ),
    ).toEqual({
      tabs: 2,
      pages: 2,
      visits: 3,
      permission_decisions: 1,
      app_state: 1,
      app_runs: 1,
    });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('quick_check', { simple: true })).toBe('ok');
    db.exec("INSERT INTO pages_fts(pages_fts) VALUES ('integrity-check')");
  });

  it("makes each protected site a rule, keeping a site's exclusion and dropping what was never a site", async () => {
    const { db } = await open();
    expect(rules(db)).toEqual([
      // 'Example.com' was the same site; '', 5 and a name too long were dropped.
      { site: 'example.com', protect: 1, excludeMemory: 0 },
      // Already excluded from the memory, and protected too: one row with both.
      { site: 'github.com', protect: 1, excludeMemory: 1 },
    ]);
    const created = db
      .prepare('SELECT site, created_at AS createdAt FROM site_rules ORDER BY site')
      .all() as { site: string; createdAt: number }[];
    // The new row is stamped now (the migration's clock); the old one keeps its own.
    expect(created[0]?.createdAt).toBeGreaterThan(1_792_600_000_000);
    expect(created[1]?.createdAt).toBe(1_792_600_000_000);
  });

  it('removes the list from the settings document and keeps everything else in it', async () => {
    const { db } = await open();
    expect(settings(db)).toEqual({
      search: { template: 'https://duckduckgo.com/?q={searchTerms}' },
      history: { retentionDays: 365 },
      lifecycle: {
        preset: 'gentle',
        autoArchive: true,
        freeze: false,
        paused: false,
        preview: 'off',
        overrides: { stripCap: 12 },
      },
    });
  });

  it.each([
    ['no settings document', null],
    ['a document without the list', JSON.stringify({ lifecycle: { preset: 'gentle' } })],
    ['a list that is not an array', JSON.stringify({ lifecycle: { protectedSites: 'a.com' } })],
    ['an empty list', JSON.stringify({ lifecycle: { protectedSites: [] } })],
  ])('adds no rule for %s', async (_what, json) => {
    const fixture = new Database(file);
    fixture.exec('DELETE FROM site_rules; DELETE FROM settings;');
    if (json !== null) {
      fixture.prepare('INSERT INTO settings VALUES (1, ?)').run([json]);
    }
    fixture.close();

    const { db } = await open();
    expect(rules(db)).toEqual([]);
    if (json !== null) {
      expect(settings(db)).not.toHaveProperty('lifecycle.protectedSites');
    }
  });

  it('copies no more than the first 1,000 entries, as the document schema read them', async () => {
    const fixture = new Database(file);
    fixture.exec('DELETE FROM site_rules;');
    const sites = Array.from({ length: 1005 }, (_, index) => `site-${String(index)}.example`);
    fixture
      .prepare('UPDATE settings SET json = ?')
      .run([JSON.stringify({ lifecycle: { protectedSites: sites } })]);
    fixture.close();

    const { db } = await open();
    expect(count(db, 'site_rules')).toBe(1000);
    expect(
      db.prepare("SELECT count(*) FROM site_rules WHERE site = 'site-1004.example'").pluck().get(),
    ).toBe(0);
  });
});

describe('a database the app must refuse', () => {
  it('refuses a database from a newer Veltriva, and changes nothing', async () => {
    copyFileSync(V1_FIXTURE, file);
    const db = new Database(file);
    db.pragma(`user_version = ${String(LATEST_VERSION + 1)}`);
    db.close();

    const error = await openError();
    expect(error.code).toBe('db_newer');
    expect(error.detail).toBe(`${String(LATEST_VERSION + 1)} > ${String(LATEST_VERSION)}`);
    expect(userVersion(file)).toBe(LATEST_VERSION + 1);
    expect(existsSync(backupDir)).toBe(false);
  });

  it("refuses another app's SQLite file", async () => {
    const db = new Database(file);
    db.exec('CREATE TABLE notes (body TEXT)');
    db.close();
    expect((await openError()).code).toBe('db_foreign');
  });

  it('reports a file that is not a database', async () => {
    writeFileSync(file, 'this is not a database, just some text '.repeat(200));
    const error = await openError();
    expect(error.code).toBe('open_failed');
    expect(error.detail).toBe('SQLITE_NOTADB');
  });

  it('refuses to run a migration history with a gap', async () => {
    const error = await openError([{ ...NEXT, version: 2 }]);
    expect(error).toMatchObject({ code: 'internal', detail: 'migration history' });
    expect(existsSync(file)).toBe(false);
  });
});
