// Idle-time upkeep (assessment §5.6): the weekly full check and the daily backup, on a real
// database in a temp folder, with a real Maintenance. Time is the `now` each run is given, so a
// "day later" costs nothing.
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3/win32-x64';
import type { DatabaseConnection } from 'better-sqlite3/win32-x64';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DATA_METHODS, MAINTENANCE_STATE_KEY } from '../shared/contracts/data-rpc';
import type { DataOutput } from '../shared/contracts/data-rpc';
import { dailyBackupName, listBackups, upgradeBackupName } from './backups';
import { openDatabase } from './database';
import { DataError } from './errors';
import { needsCheck } from './integrity';
import {
  BACKUP_EVERY_MS,
  CHECK_EVERY_MS,
  CLOSED_TAB_RETENTION_MS,
  Maintenance,
  RETENTION_CHUNK,
  RETENTION_CHUNKS_PER_RUN,
  VACUUM_PAGES_PER_RUN,
} from './maintenance';
import type { MaintenanceState } from './maintenance';
import { LATEST_VERSION } from './migrations';
import { addWorkspace } from './repos/test-database';
import { damageTable } from './testing/damage';

type RunResult = DataOutput<'maintenance.run'>;

const T0 = Date.UTC(2026, 9, 21, 8, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = BACKUP_EVERY_MS;
const NOTHING_PRUNED = { visits: 0, pages: 0, closedTabs: 0 };
const FRESH: MaintenanceState = {
  lastBackupAt: null,
  changedSinceBackup: false,
  lastCheckAt: null,
  lastCheckOk: null,
};

let dir: string;
let file: string;
let backupDir: string;
let db: DatabaseConnection;
let maintenance: Maintenance;

async function openFresh(): Promise<void> {
  ({ db } = await openDatabase({ file, backupDir }));
  maintenance = new Maintenance(db, { file, backupDir });
}

/** Runs maintenance as main would, and checks the answer is one the contract allows. */
async function runAt(now: number, target: Maintenance = maintenance): Promise<RunResult> {
  const result = await target.run(now, 365);
  return DATA_METHODS['maintenance.run'].output.parse(result);
}

/** The user's data changes: a row is written and maintenance is told, as the worker does. */
function change(key = 'row'): void {
  db.prepare(
    'INSERT INTO app_state (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json',
  ).run([key, '{}']);
  maintenance.noteWrite();
}

/**
 * About 8 MB, so a backup takes twenty steps or more, each of which yields to the event loop. The
 * rows stay under the size where a row spills onto overflow pages, which would triple the file.
 */
function makeLarge(): void {
  db.exec(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 16000)
     INSERT INTO app_state (key, json) SELECT 'filler' || i, json_object('pad', hex(randomblob(200))) FROM n`,
  );
}

/** Makes `pages_fts` forget a page's index entries, though `pages` still holds the page. */
function desyncSearchIndex(): void {
  db.prepare(
    `INSERT INTO pages (url_key, url, host, site, title, first_visit_at, last_visit_at)
     VALUES ('example.com/', 'https://example.com/', 'example.com', 'example.com', 'Example', 1, 1)`,
  ).run();
  const id = db.prepare('SELECT id FROM pages').pluck().get();
  db.prepare(
    "INSERT INTO pages_fts(pages_fts, rowid, title, url, site) VALUES ('delete', ?, 'wrong', 'wrong', 'wrong')",
  ).run([id]);
}

function backupFiles(): string[] {
  return existsSync(backupDir) ? readdirSync(backupDir).sort() : [];
}

function dailyBackups(): string[] {
  return listBackups(backupDir)
    .filter((backup) => backup.kind === 'daily')
    .map((backup) => backup.name);
}

/** Opens a backup read-only, as recovery does, and hands it to `inspect`. */
function inspectBackup<T>(name: string, inspect: (copy: DatabaseConnection) => T): T {
  const copy = new Database(join(backupDir, name), { readonly: true, fileMustExist: true });
  try {
    return inspect(copy);
  } finally {
    copy.close();
  }
}

function userKeys(connection: DatabaseConnection): string[] {
  return connection
    .prepare('SELECT key FROM app_state WHERE key <> ? ORDER BY key')
    .pluck()
    .all([MAINTENANCE_STATE_KEY]) as string[];
}

function storedState(): unknown {
  const stored = db
    .prepare('SELECT json FROM app_state WHERE key = ?')
    .pluck()
    .get([MAINTENANCE_STATE_KEY]);
  return typeof stored === 'string' ? (JSON.parse(stored) as unknown) : undefined;
}

function storeState(json: string): void {
  db.prepare(
    'INSERT INTO app_state (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json',
  ).run([MAINTENANCE_STATE_KEY, json]);
}

function tick(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Waits for the backup that `run(now)` started to be under way: its `.partial` file exists, and
 * the first of its many steps has yet to run. Polls once per turn of the event loop, which is how
 * often the backup advances.
 */
async function untilBackupStarted(now: number): Promise<void> {
  const partial = join(backupDir, `${dailyBackupName(now)}.partial`);
  for (let turns = 0; turns < 100_000 && !existsSync(partial); turns++) {
    await tick();
  }
  expect(existsSync(partial), 'the backup should have started').toBe(true);
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veltriva-maintenance-'));
  file = join(dir, 'veltriva.db');
  backupDir = join(dir, 'backups');
  await openFresh();
});

afterEach(async () => {
  await maintenance.stop();
  if (db.open) {
    db.close();
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('Maintenance: what it remembers', () => {
  it('starts with nothing done and nothing changed', () => {
    expect(maintenance.status()).toEqual(FRESH);
    expect(DATA_METHODS['maintenance.status'].output.parse(maintenance.status())).toEqual(FRESH);
  });

  it('writes nothing to the database until something happens', () => {
    expect(storedState()).toBeUndefined();
  });

  it('hands out a copy of its state, which nobody can change it through', () => {
    Object.assign(maintenance.status(), { changedSinceBackup: true, lastBackupAt: 5 });
    expect(maintenance.status()).toEqual(FRESH);
  });

  it('notes a write as a change since the last backup, and keeps it in the database', () => {
    maintenance.noteWrite();
    expect(maintenance.status()).toEqual({ ...FRESH, changedSinceBackup: true });
    expect(storedState()).toEqual({ ...FRESH, changedSinceBackup: true });
  });

  it('keeps what it recorded across a new Maintenance on the same database', async () => {
    change();
    await runAt(T0);
    const before = maintenance.status();
    expect(before).toEqual({
      lastBackupAt: T0,
      changedSinceBackup: false,
      lastCheckAt: T0,
      lastCheckOk: true,
    });

    const next = new Maintenance(db, { file, backupDir });
    expect(next.status()).toEqual(before);
    expect(await runAt(T0 + HOUR, next)).toEqual({
      check: 'not_due',
      backup: 'not_due',
      backupFile: null,
      pruned: NOTHING_PRUNED,
    });
  });

  it('keeps it across the database being closed and opened again', async () => {
    change();
    await runAt(T0);
    const before = maintenance.status();
    await maintenance.stop();
    db.close();

    await openFresh();
    expect(maintenance.status()).toEqual(before);
  });

  it('reads a state it wrote earlier, whatever it holds', () => {
    const saved: MaintenanceState = {
      lastBackupAt: 1000,
      changedSinceBackup: true,
      lastCheckAt: 2000,
      lastCheckOk: false,
    };
    storeState(JSON.stringify(saved));
    expect(new Maintenance(db, { file, backupDir }).status()).toEqual(saved);
  });

  it.each([
    ['a document of some other shape', '{"x":1}'],
    ['an array', '[]'],
    ['a number', '7'],
    ['a string', '"changed"'],
    ['null', 'null'],
    [
      'a time before 1970',
      '{"lastBackupAt":-5,"changedSinceBackup":false,"lastCheckAt":null,"lastCheckOk":null}',
    ],
    [
      'a time that is not a whole number',
      '{"lastBackupAt":1.5,"changedSinceBackup":false,"lastCheckAt":null,"lastCheckOk":null}',
    ],
    [
      'a flag that is not a boolean',
      '{"lastBackupAt":null,"changedSinceBackup":"yes","lastCheckAt":null,"lastCheckOk":null}',
    ],
    ['a field missing', '{"lastBackupAt":null,"changedSinceBackup":false,"lastCheckAt":null}'],
    [
      'a field it does not know',
      '{"lastBackupAt":null,"changedSinceBackup":false,"lastCheckAt":null,"lastCheckOk":null,"extra":1}',
    ],
  ])('starts over, rather than fail, when the saved state is %s', async (_, json) => {
    storeState(json);
    const reading = new Maintenance(db, { file, backupDir });
    expect(reading.status()).toEqual(FRESH);

    // Starting over means at worst a backup too early: the first run checks, and has nothing new.
    expect(await runAt(T0, reading)).toEqual({
      check: 'ok',
      backup: 'unchanged',
      backupFile: null,
      pruned: NOTHING_PRUNED,
    });
    expect(storedState()).toEqual({ ...FRESH, lastCheckAt: T0, lastCheckOk: true });
  });

  it('replaces an unreadable saved state with a readable one the next time it saves', () => {
    storeState('{"x":1}');
    const reading = new Maintenance(db, { file, backupDir });
    reading.noteWrite();
    expect(storedState()).toEqual({ ...FRESH, changedSinceBackup: true });
    expect(new Maintenance(db, { file, backupDir }).status()).toEqual({
      ...FRESH,
      changedSinceBackup: true,
    });
  });
});

describe('Maintenance: the weekly full check', () => {
  it('is due the first time, and with no write the backup has nothing to take', async () => {
    expect(await runAt(T0)).toEqual({
      check: 'ok',
      backup: 'unchanged',
      backupFile: null,
      pruned: NOTHING_PRUNED,
    });
    expect(maintenance.status()).toEqual({
      lastBackupAt: null,
      changedSinceBackup: false,
      lastCheckAt: T0,
      lastCheckOk: true,
    });
    expect(backupFiles()).toEqual([]);
  });

  it('is not due again until a week has passed, to the millisecond', async () => {
    await runAt(T0);
    expect((await runAt(T0)).check).toBe('not_due');
    expect((await runAt(T0 + HOUR)).check).toBe('not_due');
    expect((await runAt(T0 + CHECK_EVERY_MS - 1)).check).toBe('not_due');
    expect(maintenance.status().lastCheckAt).toBe(T0);

    expect((await runAt(T0 + CHECK_EVERY_MS)).check).toBe('ok');
    expect(maintenance.status().lastCheckAt).toBe(T0 + CHECK_EVERY_MS);
    expect((await runAt(T0 + CHECK_EVERY_MS + DAY)).check).toBe('not_due');
  });

  it('is a week, and a backup a day', () => {
    expect(BACKUP_EVERY_MS).toBe(24 * HOUR);
    expect(CHECK_EVERY_MS).toBe(7 * 24 * HOUR);
  });

  it('is due again at once if the clock went back past the last check', async () => {
    await runAt(T0);
    expect((await runAt(T0 - 1)).check).toBe('ok');
    expect(maintenance.status().lastCheckAt).toBe(T0 - 1);
  });

  it('on a search index that disagrees with its table: skips the backup and marks the database', async () => {
    desyncSearchIndex();
    change();

    const result = await runAt(T0);
    expect(result).toEqual({
      check: 'failed',
      backup: 'skipped',
      backupFile: null,
      pruned: NOTHING_PRUNED,
    });
    expect(needsCheck(file)).toBe(true);
    expect(maintenance.status()).toEqual({
      lastBackupAt: null,
      changedSinceBackup: true,
      lastCheckAt: T0,
      lastCheckOk: false,
    });
    expect(backupFiles()).toEqual([]);
  });

  it('on finding damage: remembers it across a restart of the worker, which checks again at once', async () => {
    desyncSearchIndex();
    await runAt(T0);
    const restarted = new Maintenance(db, { file, backupDir });
    expect(restarted.status()).toMatchObject({ lastCheckAt: T0, lastCheckOk: false });
    expect((await runAt(T0 + HOUR, restarted)).check).toBe('failed');
  });

  it('on finding damage: leaves the good backups that are already there', async () => {
    change();
    expect((await runAt(T0)).backup).toBe('done');

    desyncSearchIndex();
    change('after');
    const result = await runAt(T0 + CHECK_EVERY_MS);
    expect(result).toEqual({
      check: 'failed',
      backup: 'skipped',
      backupFile: null,
      pruned: NOTHING_PRUNED,
    });
    expect(backupFiles()).toEqual([dailyBackupName(T0)]);
    expect(inspectBackup(dailyBackupName(T0), (copy) => userKeys(copy))).toEqual(['row']);
  });

  it('on a passing check: leaves no marker behind', async () => {
    change();
    await runAt(T0);
    expect(needsCheck(file)).toBe(false);
  });

  // A quick check does not see a search index that disagrees with its table, so it can not be
  // what stands between a damaged database and the good backups, which are pruned to the newest
  // three. After a failed check the full check runs on every run, and no backup is taken.
  it('does not back up, on any day after a failed full check, the database it found damaged', async () => {
    change();
    expect((await runAt(T0)).backup).toBe('done');
    desyncSearchIndex();
    change('after');
    expect((await runAt(T0 + CHECK_EVERY_MS)).check).toBe('failed');

    change('later');
    // More days than there are backups kept: were they taken, no good one would be left.
    for (let day = 1; day <= 4; day++) {
      const result = await runAt(T0 + CHECK_EVERY_MS + day * DAY);
      expect(result, `day ${String(day)}`).toEqual({
        check: 'failed',
        backup: 'skipped',
        backupFile: null,
        pruned: NOTHING_PRUNED,
      });
    }
    expect(backupFiles()).toEqual([dailyBackupName(T0)]);
    inspectBackup(dailyBackupName(T0), (copy) => {
      expect(copy.pragma('quick_check', { simple: true })).toBe('ok');
      expect(userKeys(copy)).toEqual(['row']);
    });
  });

  it('after a failed check: checks again on every run, whatever else is due, until it passes', async () => {
    desyncSearchIndex();
    expect((await runAt(T0)).check).toBe('failed');

    // No write, no backup due, a week not yet up: the check still comes first, every time.
    for (const later of [T0, T0 + HOUR, T0 + 2 * DAY, T0 + 3 * DAY]) {
      expect(await runAt(later), `at ${String(later - T0)} ms`).toEqual({
        check: 'failed',
        backup: 'skipped',
        backupFile: null,
        pruned: NOTHING_PRUNED,
      });
    }
    expect(maintenance.status()).toMatchObject({ lastCheckAt: T0 + 3 * DAY, lastCheckOk: false });
    expect(needsCheck(file)).toBe(true);
    expect(backupFiles()).toEqual([]);

    // The index is rebuilt, and data has changed meanwhile: the next run passes, and the
    // backup that was waiting is taken at once.
    db.exec("INSERT INTO pages_fts(pages_fts) VALUES ('rebuild')");
    change('repaired');
    const repairedAt = T0 + 4 * DAY;
    expect(await runAt(repairedAt)).toEqual({
      check: 'ok',
      backup: 'done',
      backupFile: dailyBackupName(repairedAt),
      pruned: NOTHING_PRUNED,
    });
    expect(maintenance.status()).toEqual({
      lastBackupAt: repairedAt,
      changedSinceBackup: false,
      lastCheckAt: repairedAt,
      lastCheckOk: true,
    });

    // From there the check is weekly again.
    expect(await runAt(repairedAt + HOUR)).toEqual({
      check: 'not_due',
      backup: 'not_due',
      backupFile: null,
      pruned: NOTHING_PRUNED,
    });
  });

  it('is also due before a backup, which then counts as the weekly check', async () => {
    change();
    expect(await runAt(T0)).toEqual({
      check: 'ok',
      backup: 'done',
      backupFile: dailyBackupName(T0),
      pruned: NOTHING_PRUNED,
    });
    change('again');
    expect((await runAt(T0 + DAY)).check).toBe('ok');
    expect(maintenance.status().lastCheckAt).toBe(T0 + DAY);

    // A week after the first check but only six days after the last: not due yet.
    expect((await runAt(T0 + CHECK_EVERY_MS)).check).toBe('not_due');
    expect((await runAt(T0 + DAY + CHECK_EVERY_MS - 1)).check).toBe('not_due');
    expect((await runAt(T0 + DAY + CHECK_EVERY_MS)).check).toBe('ok');
    expect(maintenance.status().lastCheckAt).toBe(T0 + DAY + CHECK_EVERY_MS);
  });
});

describe('Maintenance: the daily backup', () => {
  it('takes a complete copy of the database when the data changed', async () => {
    change('before');
    const result = await runAt(T0);
    expect(result).toEqual({
      check: 'ok',
      backup: 'done',
      backupFile: dailyBackupName(T0),
      pruned: NOTHING_PRUNED,
    });

    // Only the finished file is there: nothing half-written was left behind.
    expect(backupFiles()).toEqual([dailyBackupName(T0)]);
    expect(maintenance.status()).toEqual({
      lastBackupAt: T0,
      changedSinceBackup: false,
      lastCheckAt: T0,
      lastCheckOk: true,
    });

    inspectBackup(dailyBackupName(T0), (copy) => {
      expect(copy.pragma('user_version', { simple: true })).toBe(LATEST_VERSION);
      expect(copy.pragma('quick_check', { simple: true })).toBe('ok');
      expect(userKeys(copy)).toEqual(['before']);
    });
  });

  it('holds the pages and a search index that agrees with them', async () => {
    db.prepare(
      `INSERT INTO pages (url_key, url, host, site, title, first_visit_at, last_visit_at)
       VALUES ('example.com/', 'https://example.com/', 'example.com', 'example.com', 'Example', 1, 1)`,
    ).run();
    // With a recent visit, or retention would rightly take the page before the backup.
    db.prepare(
      "INSERT INTO visits (page_id, visited_at, transition) VALUES (last_insert_rowid(), ?, 'typed')",
    ).run([T0 - HOUR]);
    change('before');
    await runAt(T0);
    inspectBackup(dailyBackupName(T0), (copy) => {
      expect(copy.prepare('SELECT title FROM pages').pluck().all()).toEqual(['Example']);
      // The search index came with it, and agrees with the table.
      expect(
        copy.prepare("SELECT rowid FROM pages_fts WHERE pages_fts MATCH 'example'").pluck().all(),
      ).toHaveLength(1);
    });
  });

  it('does not hold what was written after it', async () => {
    change('before');
    await runAt(T0);
    change('after');
    inspectBackup(dailyBackupName(T0), (copy) => {
      expect(userKeys(copy)).toEqual(['before']);
    });
  });

  it('creates the backup folder when it is not there', async () => {
    expect(existsSync(backupDir)).toBe(false);
    change();
    await runAt(T0);
    expect(existsSync(backupDir)).toBe(true);
  });

  it('is not taken again in the same instant, or before a day is up, however much changed', async () => {
    change();
    await runAt(T0);

    const notDue = {
      check: 'not_due',
      backup: 'not_due',
      backupFile: null,
      pruned: NOTHING_PRUNED,
    };
    expect(await runAt(T0)).toEqual(notDue);
    change('again');
    expect(await runAt(T0)).toEqual(notDue);
    expect(await runAt(T0 + 23 * HOUR)).toEqual(notDue);
    expect(await runAt(T0 + DAY - 1)).toEqual(notDue);
    expect(backupFiles()).toEqual([dailyBackupName(T0)]);
    expect(maintenance.status()).toMatchObject({ lastBackupAt: T0, changedSinceBackup: true });
  });

  it('is taken a day later, to the millisecond, when there was a change', async () => {
    change();
    await runAt(T0);
    change('again');
    const result = await runAt(T0 + DAY);
    // The full check comes first, whenever a backup is due, so the week's check is not what
    // decides it: a day after the last one, it runs again.
    expect(result).toEqual({
      check: 'ok',
      backup: 'done',
      backupFile: dailyBackupName(T0 + DAY),
      pruned: NOTHING_PRUNED,
    });
    expect(maintenance.status().lastCheckAt).toBe(T0 + DAY);
    expect(backupFiles()).toEqual([dailyBackupName(T0), dailyBackupName(T0 + DAY)]);
    inspectBackup(dailyBackupName(T0 + DAY), (copy) => {
      expect(userKeys(copy)).toEqual(['again', 'row']);
    });
  });

  it('is not taken a day later when nothing changed', async () => {
    change();
    await runAt(T0);
    expect(await runAt(T0 + DAY)).toEqual({
      check: 'not_due',
      backup: 'unchanged',
      backupFile: null,
      pruned: NOTHING_PRUNED,
    });
    expect(backupFiles()).toEqual([dailyBackupName(T0)]);
  });

  it('is taken as soon as something changes after a quiet stretch, which does not reset the day', async () => {
    change();
    await runAt(T0);
    // Nothing changed, so there is no backup to check for: the week's check is not due either.
    expect(await runAt(T0 + 3 * DAY)).toEqual({
      check: 'not_due',
      backup: 'unchanged',
      backupFile: null,
      pruned: NOTHING_PRUNED,
    });
    expect(maintenance.status()).toMatchObject({ lastBackupAt: T0, lastCheckAt: T0 });

    change('again');
    expect(await runAt(T0 + 3 * DAY + 1000)).toEqual({
      check: 'ok',
      backup: 'done',
      backupFile: dailyBackupName(T0 + 3 * DAY + 1000),
      pruned: NOTHING_PRUNED,
    });
  });

  it('is due at once when the clock went back past the last backup', async () => {
    change();
    await runAt(T0);

    change('again');
    const earlier = T0 - HOUR;
    const result = await runAt(earlier);
    // The full check comes first, as before every backup (and the clock went back past it too).
    expect(result).toEqual({
      check: 'ok',
      backup: 'done',
      backupFile: dailyBackupName(earlier),
      pruned: NOTHING_PRUNED,
    });
    expect(maintenance.status().lastBackupAt).toBe(earlier);
    expect(backupFiles()).toEqual([dailyBackupName(earlier), dailyBackupName(T0)]);

    // From then on it keeps time by the new clock.
    change('third');
    expect((await runAt(earlier + HOUR)).backup).toBe('not_due');
  });

  it('keeps the newest three daily backups and deletes older ones, over five days', async () => {
    mkdirSync(backupDir);
    const upgrades = [
      upgradeBackupName(1, 2, T0 - 9 * DAY),
      upgradeBackupName(2, 3, T0 - 8 * DAY),
      upgradeBackupName(3, 4, T0 - 7 * DAY),
      upgradeBackupName(4, 5, T0 - 6 * DAY),
    ];
    const others = ['notes.txt', 'something-else.partial'];
    for (const name of [...upgrades, ...others]) {
      writeFileSync(join(backupDir, name), 'not touched');
    }

    for (let day = 0; day < 5; day++) {
      change(`day-${String(day)}`);
      const result = await runAt(T0 + day * DAY);
      expect(result.backup, `day ${String(day)}`).toBe('done');
    }

    const newestThree = [4, 3, 2].map((day) => dailyBackupName(T0 + day * DAY));
    expect(dailyBackups()).toEqual(newestThree);
    // Pre-upgrade backups and anything else in the folder are not Maintenance's to delete.
    expect(backupFiles()).toEqual([...newestThree, ...upgrades, ...others].sort());

    // Each backup is the database as it was that day.
    expect(inspectBackup(newestThree[0] ?? '', userKeys)).toEqual([
      'day-0',
      'day-1',
      'day-2',
      'day-3',
      'day-4',
    ]);
    expect(inspectBackup(newestThree[2] ?? '', userKeys)).toEqual(['day-0', 'day-1', 'day-2']);
  });

  it('is skipped, and the database marked, when the full check before it fails', async () => {
    change('before');
    expect((await runAt(T0)).backup).toBe('done');

    // Only a full check sees this: quick_check and integrity_check both pass on it.
    desyncSearchIndex();
    change('after');
    expect(needsCheck(file)).toBe(false);

    // A day on, the week's check is not due; the backup that is brings the full check with it.
    const result = await runAt(T0 + DAY);
    expect(result).toEqual({
      check: 'failed',
      backup: 'skipped',
      backupFile: null,
      pruned: NOTHING_PRUNED,
    });
    expect(needsCheck(file)).toBe(true);
    expect(backupFiles()).toEqual([dailyBackupName(T0)]);
    expect(maintenance.status()).toEqual({
      lastBackupAt: T0,
      changedSinceBackup: true,
      lastCheckAt: T0 + DAY,
      lastCheckOk: false,
    });
    inspectBackup(dailyBackupName(T0), (copy) => {
      expect(copy.pragma('quick_check', { simple: true })).toBe('ok');
    });
  });

  it('is skipped too when a page of the file is torn, which the full check finds', async () => {
    change('before');
    expect((await runAt(T0)).backup).toBe('done');

    // The table is damaged on disk; the worker is restarted and opens the file as it is.
    await maintenance.stop();
    db.close();
    damageTable(file);
    await openFresh();
    maintenance.noteWrite();
    expect(needsCheck(file)).toBe(false);

    const result = await runAt(T0 + DAY);
    expect(result).toEqual({
      check: 'failed',
      backup: 'skipped',
      backupFile: null,
      pruned: NOTHING_PRUNED,
    });
    expect(needsCheck(file)).toBe(true);
    expect(backupFiles()).toEqual([dailyBackupName(T0)]);
    expect(maintenance.status()).toMatchObject({ lastBackupAt: T0, changedSinceBackup: true });
    inspectBackup(dailyBackupName(T0), (copy) => {
      expect(copy.pragma('quick_check', { simple: true })).toBe('ok');
    });
  });

  it('reports a failure when the folder can not be made, and is tried again at once', async () => {
    writeFileSync(backupDir, 'a file where the folder should be');
    change();

    expect(await runAt(T0)).toEqual({
      check: 'ok',
      backup: 'failed',
      backupFile: null,
      pruned: NOTHING_PRUNED,
    });
    expect(maintenance.status()).toMatchObject({ lastBackupAt: null, changedSinceBackup: true });

    rmSync(backupDir);
    // The backup is due again, so the check before it is too, though it passed a moment ago.
    expect(await runAt(T0)).toEqual({
      check: 'ok',
      backup: 'done',
      backupFile: dailyBackupName(T0),
      pruned: NOTHING_PRUNED,
    });
    expect(maintenance.status()).toMatchObject({ lastBackupAt: T0, changedSinceBackup: false });
  });
});

describe('Maintenance: the leftovers of a backup cut short', () => {
  /** Files in the backup folder, as a crash or a kill mid-backup would have left them. */
  function leave(...names: string[]): void {
    mkdirSync(backupDir, { recursive: true });
    for (const name of names) {
      writeFileSync(join(backupDir, name), 'half a database');
    }
  }

  it('a new worker removes the stale .partial files of daily backups', () => {
    leave(
      `${dailyBackupName(T0 - 3 * DAY)}.partial`,
      `${dailyBackupName(T0 - DAY)}.partial`,
      `${dailyBackupName(T0)}.partial`,
    );
    new Maintenance(db, { file, backupDir });
    expect(backupFiles()).toEqual([]);
  });

  it('a new worker removes only those: backups of both kinds and other files stay', () => {
    const keep = [
      dailyBackupName(T0 - 2 * DAY),
      dailyBackupName(T0 - DAY),
      upgradeBackupName(1, 2, T0 - 5 * DAY),
      'notes.txt',
      'something-else.partial',
      `${dailyBackupName(T0)}.bak`,
      `${dailyBackupName(T0)}-wal`,
    ];
    leave(...keep, `${dailyBackupName(T0)}.partial`, `${dailyBackupName(T0 - 4 * DAY)}.partial`);
    new Maintenance(db, { file, backupDir });
    expect(backupFiles()).toEqual(keep.toSorted());
    // What was kept is as it was.
    expect(readFileSync(join(backupDir, keep[0] ?? ''), 'utf8')).toBe('half a database');
  });

  it('a new worker is not troubled by an empty backup folder, or a missing one', () => {
    expect(() => new Maintenance(db, { file, backupDir })).not.toThrow();
    expect(existsSync(backupDir)).toBe(false);

    leave();
    expect(() => new Maintenance(db, { file, backupDir })).not.toThrow();
    expect(backupFiles()).toEqual([]);
  });

  it('so a stale partial does not stand in the way of the next backup, even one of the same name', async () => {
    leave(`${dailyBackupName(T0)}.partial`);
    const restarted = new Maintenance(db, { file, backupDir });
    restarted.noteWrite();

    expect(await runAt(T0, restarted)).toEqual({
      check: 'ok',
      backup: 'done',
      backupFile: dailyBackupName(T0),
      pruned: NOTHING_PRUNED,
    });
    expect(backupFiles()).toEqual([dailyBackupName(T0)]);
    inspectBackup(dailyBackupName(T0), (copy) => {
      expect(copy.pragma('quick_check', { simple: true })).toBe('ok');
    });
  });
});

describe('Maintenance: a backup that is still running', () => {
  it('counts a write made while it runs as a change since the backup, so the next day takes another', async () => {
    makeLarge();
    maintenance.noteWrite();

    let finished = false;
    const running = runAt(T0).finally(() => {
      finished = true;
    });
    await untilBackupStarted(T0);
    expect(finished, 'the backup should still be running').toBe(false);
    // A backup in progress has already taken the flag: what it copies, it will have.
    expect(maintenance.status().changedSinceBackup).toBe(false);

    change('during');
    expect(maintenance.status().changedSinceBackup).toBe(true);
    expect(finished, 'the backup should still be running').toBe(false);

    const result = await running;
    expect(result).toEqual({
      check: 'ok',
      backup: 'done',
      backupFile: dailyBackupName(T0),
      pruned: NOTHING_PRUNED,
    });
    // Finishing records the backup without forgetting the write that came during it.
    expect(maintenance.status()).toEqual({
      lastBackupAt: T0,
      changedSinceBackup: true,
      lastCheckAt: T0,
      lastCheckOk: true,
    });
    expect(backupFiles()).toEqual([dailyBackupName(T0)]);

    expect(await runAt(T0 + DAY)).toEqual({
      check: 'ok',
      backup: 'done',
      backupFile: dailyBackupName(T0 + DAY),
      pruned: NOTHING_PRUNED,
    });
    expect(maintenance.status().changedSinceBackup).toBe(false);
    inspectBackup(dailyBackupName(T0 + DAY), (copy) => {
      expect(userKeys(copy)).toContain('during');
      expect(copy.pragma('quick_check', { simple: true })).toBe('ok');
    });
  }, 30_000);

  it('stopped half way: reports a failure, leaves no file at all, and is wanted again', async () => {
    makeLarge();
    maintenance.noteWrite();
    const running = runAt(T0);
    await untilBackupStarted(T0);

    const stopping = maintenance.stop();
    // Once stopping has begun, nothing new starts.
    const late = await rejectionOf(maintenance.run(T0 + DAY, 365));
    expect(late).toBeInstanceOf(DataError);
    expect(late).toMatchObject({ code: 'closed' });
    await stopping;

    expect(await running).toEqual({
      check: 'ok',
      backup: 'failed',
      backupFile: null,
      pruned: NOTHING_PRUNED,
    });
    expect(backupFiles()).toEqual([]);
    expect(maintenance.status()).toEqual({
      lastBackupAt: null,
      changedSinceBackup: true,
      lastCheckAt: T0,
      lastCheckOk: true,
    });
    // The connection is free: stopping is what lets the worker close it.
    expect(() => db.close()).not.toThrow();
  }, 30_000);

  it('turns a second run away as busy, and is not disturbed by it', async () => {
    makeLarge();
    maintenance.noteWrite();
    const running = runAt(T0);
    await untilBackupStarted(T0);

    const second = await rejectionOf(maintenance.run(T0, 365));
    expect(second).toBeInstanceOf(DataError);
    expect(second).toMatchObject({ code: 'busy' });
    const third = await rejectionOf(maintenance.run(T0 + 5 * DAY, 365));
    expect(third).toMatchObject({ code: 'busy' });

    expect(await running).toEqual({
      check: 'ok',
      backup: 'done',
      backupFile: dailyBackupName(T0),
      pruned: NOTHING_PRUNED,
    });
    expect(backupFiles()).toEqual([dailyBackupName(T0)]);

    // Once it is over, runs are accepted again.
    expect(await runAt(T0 + HOUR)).toEqual({
      check: 'not_due',
      backup: 'not_due',
      backupFile: null,
      pruned: NOTHING_PRUNED,
    });
  }, 30_000);
});

describe('Maintenance: stopping', () => {
  it('with nothing running returns at once, and refuses every run after it', async () => {
    await maintenance.stop();
    const error = await rejectionOf(maintenance.run(T0, 365));
    expect(error).toBeInstanceOf(DataError);
    expect(error).toMatchObject({ code: 'closed' });
    expect(await rejectionOf(maintenance.run(T0 + DAY, 365))).toMatchObject({ code: 'closed' });
  });

  it('can be asked twice', async () => {
    await maintenance.stop();
    await expect(maintenance.stop()).resolves.toBeUndefined();
  });

  it('does not change the state, or touch the files', async () => {
    change();
    await runAt(T0);
    const before = maintenance.status();
    const files = backupFiles();
    await maintenance.stop();
    expect(maintenance.status()).toEqual(before);
    expect(backupFiles()).toEqual(files);
  });

  it('after a refused run, leaves no check marker or backup behind', async () => {
    await maintenance.stop();
    await rejectionOf(maintenance.run(T0, 365));
    expect(needsCheck(file)).toBe(false);
    expect(backupFiles()).toEqual([]);
    expect(maintenance.status()).toEqual(FRESH);
  });
});

// ── Retention (§5.7): visits past the setting, then what nothing refers to, then old closed tabs ──

/** What one run can remove from one table: a cap, so a first run after a year away takes turns. */
const RUN_CAP = RETENTION_CHUNK * RETENTION_CHUNKS_PER_RUN;

const WORKSPACE = '0199f000-0000-7000-8000-000000000001';

/** The page `n`, with no visits yet; returns its id. */
function insertPage(n: number, extra: { title?: string; faviconId?: number | null } = {}): number {
  const info = db
    .prepare(
      `INSERT INTO pages (url_key, url, host, site, title, favicon_id, first_visit_at, last_visit_at)
       VALUES (?, ?, 'x.example', 'x.example', ?, ?, 1, 1)`,
    )
    .run([
      `https://x.example/${String(n)}`,
      `https://x.example/${String(n)}`,
      extra.title ?? '',
      extra.faviconId ?? null,
    ]);
  return Number(info.lastInsertRowid);
}

function insertVisit(pageId: number, at: number): void {
  db.prepare("INSERT INTO visits (page_id, visited_at, transition) VALUES (?, ?, 'link')").run([
    pageId,
    at,
  ]);
}

/**
 * A favicon row for a page or a tab to refer to; returns its id. The one place these tests use
 * the favicons table's columns.
 */
function insertFavicon(n: number): number {
  const info = db
    .prepare('INSERT INTO favicons (sha256, bytes, updated_at) VALUES (?, ?, ?)')
    .run([`sha-${String(n)}`, Buffer.from([n]), T0]);
  return Number(info.lastInsertRowid);
}

function insertTab(
  id: string,
  placement: 'strip' | 'shelf' | 'archive' | 'closed',
  extra: {
    readonly closedAt?: number | null;
    readonly archivedAt?: number | null;
    readonly faviconId?: number | null;
    readonly pageId?: number | null;
  } = {},
): void {
  db.prepare(
    `INSERT INTO tabs (id, workspace_id, placement, position, page_id, url, favicon_id,
       created_at, last_used_at, last_used_engaged, last_used_active_day, placement_changed_at,
       archived_at, closed_at)
     VALUES (?, ?, ?, 0, ?, 'https://x.example/', ?, 1, 1, 1, 1, 1, ?, ?)`,
  ).run([
    id,
    WORKSPACE,
    placement,
    extra.pageId ?? null,
    extra.faviconId ?? null,
    extra.archivedAt ?? (placement === 'archive' ? 1 : null),
    extra.closedAt ?? null,
  ]);
}

/** Many rows at once, as the chunking needs. `columns` and `values` are SQL, using `i`. */
function bulkInsert(table: string, columns: string, values: string, rows: number): void {
  db.exec(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${String(rows)})
     INSERT INTO ${table} (${columns}) SELECT ${values} FROM n`,
  );
}

/** `rows` visits of `pageId`, at the times 1 to `rows` (long ago). */
function bulkVisits(pageId: number, rows: number): void {
  bulkInsert('visits', 'page_id, visited_at, transition', `${String(pageId)}, i, 'link'`, rows);
}

/** `rows` pages that have no visit at all. */
function bulkOrphanPages(rows: number): void {
  bulkInsert(
    'pages',
    'url_key, url, host, site, first_visit_at, last_visit_at',
    "'k' || i, 'https://x.example/' || i, 'x.example', 'x.example', 1, 1",
    rows,
  );
}

function count(table: string): number {
  return db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number;
}

function tabIds(): string[] {
  return db.prepare('SELECT id FROM tabs ORDER BY id').pluck().all() as string[];
}

function visitTimes(): number[] {
  return db.prepare('SELECT visited_at FROM visits ORDER BY visited_at').pluck().all() as number[];
}

/** A run with the retention given, whatever else is due. */
async function retainAt(
  now: number,
  days = 365,
  target: Maintenance = maintenance,
): Promise<RunResult> {
  return DATA_METHODS['maintenance.run'].output.parse(await target.run(now, days));
}

/** A new Maintenance, as a restarted worker has: it has not looked for orphans yet. */
function restarted(): Maintenance {
  return new Maintenance(db, { file, backupDir });
}

/** The state of a worker that has just taken a backup and a check: nothing is due for a day. */
function quietState(overrides: Partial<MaintenanceState> = {}): void {
  storeState(
    JSON.stringify({
      lastBackupAt: T0,
      changedSinceBackup: false,
      lastCheckAt: T0,
      lastCheckOk: true,
      ...overrides,
    }),
  );
}

describe('Maintenance: retention of visits', () => {
  it('deletes visits older than the retention and keeps the rest, to the millisecond', async () => {
    const page = insertPage(1);
    const cutoff = T0 - 365 * DAY;
    insertVisit(page, cutoff - 1);
    insertVisit(page, cutoff);
    insertVisit(page, cutoff + 1);
    insertVisit(page, T0);

    const result = await retainAt(T0);

    expect(result.pruned).toEqual({ visits: 1, pages: 0, closedTabs: 0 });
    expect(visitTimes()).toEqual([cutoff, cutoff + 1, T0]);
  });

  it('uses the retention the run is given, in days of 24 hours', async () => {
    const page = insertPage(1);
    insertVisit(page, T0 - 31 * DAY);
    insertVisit(page, T0 - 30 * DAY - 1);
    insertVisit(page, T0 - 30 * DAY);
    insertVisit(page, T0 - 29 * DAY);

    const result = await retainAt(T0, 30);

    expect(result.pruned.visits).toBe(2);
    expect(visitTimes()).toEqual([T0 - 30 * DAY, T0 - 29 * DAY]);
  });

  it('keeps a single day of visits when the retention is one day', async () => {
    const page = insertPage(1);
    insertVisit(page, T0 - DAY - 1);
    insertVisit(page, T0 - DAY);
    insertVisit(page, T0 - HOUR);

    await retainAt(T0, 1);

    expect(visitTimes()).toEqual([T0 - DAY, T0 - HOUR]);
  });

  it('deletes nothing under the longest retention, which reaches back past 1970', async () => {
    const page = insertPage(1);
    insertVisit(page, 0);
    insertVisit(page, 1);

    const result = await retainAt(T0, 36_500);

    expect(result.pruned).toEqual(NOTHING_PRUNED);
    expect(visitTimes()).toEqual([0, 1]);
  });

  it('counts retention from the time of the run, not from when the visits were made', async () => {
    const page = insertPage(1);
    insertVisit(page, T0);

    expect((await retainAt(T0 + 364 * DAY)).pruned.visits).toBe(0);
    expect((await retainAt(T0 + 365 * DAY)).pruned.visits).toBe(0);
    expect((await retainAt(T0 + 365 * DAY + 1)).pruned.visits).toBe(1);
  });

  it('deletes nothing when nothing is old, and reports nothing', async () => {
    const page = insertPage(1);
    insertVisit(page, T0 - HOUR);

    const result = await retainAt(T0);

    expect(result.pruned).toEqual(NOTHING_PRUNED);
    expect(count('visits')).toBe(1);
    expect(count('pages')).toBe(1);
  });

  it('does nothing to an empty database', async () => {
    expect((await retainAt(T0)).pruned).toEqual(NOTHING_PRUNED);
  });

  it('keeps the recent visits of other pages whatever it deletes', async () => {
    const old = insertPage(1);
    const recent = insertPage(2);
    insertVisit(old, T0 - 400 * DAY);
    insertVisit(recent, T0 - DAY);

    await retainAt(T0);

    expect(db.prepare('SELECT page_id FROM visits').pluck().all()).toEqual([recent]);
  });
});

describe('Maintenance: retention of pages', () => {
  it('deletes a page left with no visits, and counts it', async () => {
    const gone = insertPage(1, { title: 'Obsolete' });
    insertVisit(gone, T0 - 400 * DAY);
    insertVisit(gone, T0 - 500 * DAY);

    const result = await retainAt(T0);

    expect(result.pruned).toEqual({ visits: 2, pages: 1, closedTabs: 0 });
    expect(count('pages')).toBe(0);
  });

  it('keeps a page that has a visit that is not old, and deletes only the old visits', async () => {
    const kept = insertPage(1);
    insertVisit(kept, T0 - 400 * DAY);
    insertVisit(kept, T0 - DAY);

    const result = await retainAt(T0);

    expect(result.pruned).toEqual({ visits: 1, pages: 0, closedTabs: 0 });
    expect(count('pages')).toBe(1);
    expect(visitTimes()).toEqual([T0 - DAY]);
  });

  it('takes a page that never had a visit as an orphan, in the first run of a worker', async () => {
    insertPage(1);

    const result = await retainAt(T0);

    expect(result.pruned).toEqual({ visits: 0, pages: 1, closedTabs: 0 });
    expect(count('pages')).toBe(0);
  });

  it('takes the page out of the search index as well, and the index still agrees', async () => {
    const gone = insertPage(1, { title: 'Peregrine' });
    insertVisit(gone, T0 - 400 * DAY);
    const kept = insertPage(2, { title: 'Merlin' });
    insertVisit(kept, T0 - HOUR);
    const search = (term: string) =>
      db.prepare('SELECT rowid FROM pages_fts WHERE pages_fts MATCH ?').pluck().all([term]);
    expect(search('peregrine')).toEqual([gone]);

    const result = await retainAt(T0);

    expect(search('peregrine')).toEqual([]);
    expect(search('merlin')).toEqual([kept]);
    // The check that runs right after retention reads the index against its table.
    expect(result.check).toBe('ok');
  });

  it('lets a tab outlive its page: the tab stays, with no page', async () => {
    addWorkspace(db, WORKSPACE);
    const gone = insertPage(1);
    insertVisit(gone, T0 - 400 * DAY);
    insertTab('tab-a', 'strip', { pageId: gone });

    await retainAt(T0);

    expect(count('pages')).toBe(0);
    expect(db.prepare('SELECT id, page_id AS pageId FROM tabs').all()).toEqual([
      { id: 'tab-a', pageId: null },
    ]);
  });

  it('counts only the pages that went, not the visits of pages that stay', async () => {
    const page = insertPage(1);
    insertVisit(page, T0 - 400 * DAY);
    insertVisit(page, T0 - 399 * DAY);
    insertVisit(page, T0 - 1);

    expect((await retainAt(T0)).pruned).toEqual({ visits: 2, pages: 0, closedTabs: 0 });
  });
});

describe('Maintenance: retention of favicons', () => {
  const hasFavicon = (id: number): boolean =>
    db.prepare('SELECT 1 FROM favicons WHERE id = ?').pluck().get([id]) !== undefined;

  it('deletes a favicon that no page and no tab refers to', async () => {
    const orphan = insertFavicon(1);

    await retainAt(T0);

    expect(hasFavicon(orphan)).toBe(false);
  });

  it('keeps a favicon a page refers to', async () => {
    const icon = insertFavicon(1);
    const page = insertPage(1, { faviconId: icon });
    insertVisit(page, T0 - HOUR);

    await retainAt(T0);

    expect(hasFavicon(icon)).toBe(true);
  });

  it('keeps a favicon that only a tab refers to', async () => {
    addWorkspace(db, WORKSPACE);
    const icon = insertFavicon(1);
    insertTab('tab-a', 'strip', { faviconId: icon });

    await retainAt(T0);

    expect(hasFavicon(icon)).toBe(true);
    expect(count('tabs')).toBe(1);
  });

  // Regression: orphans were looked for before the closed tabs went, so the icon of a tab that
  // expired in a run waited for a later scan. Closed tabs now go first, and their going is a
  // reason to scan, in the same run and the same worker.
  it('keeps the favicon of a closed tab while the tab is kept, and takes it in the run the tab goes', async () => {
    addWorkspace(db, WORKSPACE);
    const icon = insertFavicon(1);
    insertTab('tab-a', 'closed', { faviconId: icon, closedAt: T0 - DAY });
    await retainAt(T0);
    expect(hasFavicon(icon)).toBe(true);

    // The same worker, a week on: the tab goes, and its icon with it.
    await retainAt(T0 + 8 * DAY);
    expect(count('tabs')).toBe(0);
    expect(hasFavicon(icon)).toBe(false);
  });

  it('keeps a favicon that both a page and a tab refer to, when the page goes', async () => {
    addWorkspace(db, WORKSPACE);
    const icon = insertFavicon(1);
    const page = insertPage(1, { faviconId: icon });
    insertVisit(page, T0 - 400 * DAY);
    insertTab('tab-a', 'strip', { faviconId: icon });

    await retainAt(T0);

    expect(count('pages')).toBe(0);
    expect(hasFavicon(icon)).toBe(true);
  });

  it('deletes the favicon of a page that went in the same run', async () => {
    const icon = insertFavicon(1);
    const page = insertPage(1, { faviconId: icon });
    insertVisit(page, T0 - 400 * DAY);

    await retainAt(T0);

    expect(count('pages')).toBe(0);
    expect(hasFavicon(icon)).toBe(false);
  });

  it('deletes only the unreferenced favicons among several', async () => {
    const used = insertFavicon(1);
    const orphanA = insertFavicon(2);
    const orphanB = insertFavicon(3);
    const page = insertPage(1, { faviconId: used });
    insertVisit(page, T0 - HOUR);

    await retainAt(T0);

    expect([used, orphanA, orphanB].map(hasFavicon)).toEqual([true, false, false]);
  });

  it('does not count favicons in what it reports', async () => {
    insertFavicon(1);
    insertFavicon(2);

    expect((await retainAt(T0)).pruned).toEqual(NOTHING_PRUNED);
  });
});

describe('Maintenance: retention of closed tabs', () => {
  const WEEK = CLOSED_TAB_RETENTION_MS;

  it('is a week', () => {
    expect(CLOSED_TAB_RETENTION_MS).toBe(7 * DAY);
  });

  it('deletes closed tabs closed more than a week ago, to the millisecond, and counts them', async () => {
    addWorkspace(db, WORKSPACE);
    insertTab('older', 'closed', { closedAt: T0 - WEEK - 1 });
    insertTab('exactly', 'closed', { closedAt: T0 - WEEK });
    insertTab('newer', 'closed', { closedAt: T0 - WEEK + 1 });
    insertTab('recent', 'closed', { closedAt: T0 - HOUR });

    const result = await retainAt(T0);

    expect(result.pruned).toEqual({ visits: 0, pages: 0, closedTabs: 1 });
    expect(tabIds()).toEqual(['exactly', 'newer', 'recent']);
  });

  it('is a week whatever the retention of visits is', async () => {
    addWorkspace(db, WORKSPACE);
    insertTab('old', 'closed', { closedAt: T0 - 8 * DAY });

    await retainAt(T0, 36_500);

    expect(count('tabs')).toBe(0);
  });

  it('never deletes a tab that is open, however old it is', async () => {
    addWorkspace(db, WORKSPACE);
    insertTab('strip-tab', 'strip');
    insertTab('shelf-tab', 'shelf');
    insertTab('archived-tab', 'archive', { archivedAt: 1 });

    const result = await retainAt(T0);

    expect(result.pruned.closedTabs).toBe(0);
    expect(tabIds()).toEqual(['archived-tab', 'shelf-tab', 'strip-tab']);
  });

  it('never deletes a strip, shelf or archive tab that carries an old closing time', async () => {
    addWorkspace(db, WORKSPACE);
    insertTab('reopened', 'strip', { closedAt: T0 - 30 * DAY });
    insertTab('shelved', 'shelf', { closedAt: T0 - 30 * DAY });
    insertTab('archived', 'archive', { closedAt: T0 - 30 * DAY });

    await retainAt(T0);

    expect(tabIds()).toEqual(['archived', 'reopened', 'shelved']);
  });

  it('deletes the closed tabs and leaves the open ones in the same table', async () => {
    addWorkspace(db, WORKSPACE);
    insertTab('open-1', 'strip');
    insertTab('open-2', 'strip');
    insertTab('closed-old', 'closed', { closedAt: T0 - 9 * DAY });
    insertTab('closed-new', 'closed', { closedAt: T0 - DAY });

    await retainAt(T0);

    expect(tabIds()).toEqual(['closed-new', 'open-1', 'open-2']);
  });

  it('leaves the workspace alone', async () => {
    addWorkspace(db, WORKSPACE);
    insertTab('closed-old', 'closed', { closedAt: T0 - 9 * DAY });

    await retainAt(T0);

    expect(count('workspaces')).toBe(1);
  });
});

describe('Maintenance: retention in chunks', () => {
  it('has a cap of 50,000 rows per table per run, as the setting says', () => {
    expect(RETENTION_CHUNK).toBe(2000);
    expect(RETENTION_CHUNKS_PER_RUN).toBe(25);
    expect(RUN_CAP).toBe(50_000);
  });

  it('deletes a chunk at a time: only the first is done before the run first yields', async () => {
    const page = insertPage(1);
    const total = 2 * RETENTION_CHUNK + 500;
    bulkVisits(page, total);

    const running = retainAt(T0);

    // `run` has done its first statement synchronously and now waits for the next turn of the
    // event loop, where the worker answers its other requests.
    expect(count('visits')).toBe(total - RETENTION_CHUNK);
    const result = await running;
    expect(result.pruned.visits).toBe(total);
    expect(count('visits')).toBe(0);
  });

  it('is exact over several chunks, whatever the last one holds', async () => {
    const page = insertPage(1);
    const total = 2 * RETENTION_CHUNK + 37;
    bulkVisits(page, total);
    // A visit that is not old is not touched, wherever it sits among the old ones.
    insertVisit(page, T0 - HOUR);

    const result = await retainAt(T0);

    expect(result.pruned.visits).toBe(total);
    expect(visitTimes()).toEqual([T0 - HOUR]);
  });

  it('takes a table that is an exact multiple of the chunk', async () => {
    const page = insertPage(1);
    bulkVisits(page, 2 * RETENTION_CHUNK);

    const result = await retainAt(T0);

    expect(result.pruned.visits).toBe(2 * RETENTION_CHUNK);
    expect(count('visits')).toBe(0);
  });

  it('does the same for orphan pages and for closed tabs, over several chunks', async () => {
    addWorkspace(db, WORKSPACE);
    const total = 2 * RETENTION_CHUNK + 37;
    bulkOrphanPages(total);
    bulkInsert(
      'tabs',
      `id, workspace_id, placement, position, url, created_at, last_used_at, last_used_engaged,
       last_used_active_day, placement_changed_at, closed_at`,
      `'tab-' || i, '${WORKSPACE}', 'closed', 0, 'https://x.example/', 1, 1, 1, 1, 1, ${String(T0 - 30 * DAY)}`,
      total,
    );

    const result = await retainAt(T0);

    expect(result.pruned).toEqual({ visits: 0, pages: total, closedTabs: total });
    expect(count('pages')).toBe(0);
    expect(count('tabs')).toBe(0);
  });

  it('removes at most a chunk times chunks-per-run visits in a run, and the next run continues', async () => {
    const page = insertPage(1);
    const surplus = 1234;
    bulkVisits(page, RUN_CAP + surplus);

    const first = await retainAt(T0);
    expect(first.pruned.visits).toBe(RUN_CAP);
    expect(count('visits')).toBe(surplus);

    const second = await retainAt(T0 + HOUR);
    expect(second.pruned.visits).toBe(surplus);
    expect(count('visits')).toBe(0);

    expect((await retainAt(T0 + 2 * HOUR)).pruned.visits).toBe(0);
  }, 60_000);

  it('caps each table by itself: the pages and the tabs get their own turns', async () => {
    addWorkspace(db, WORKSPACE);
    const page = insertPage(1);
    bulkVisits(page, RUN_CAP + 1);
    insertTab('closed-old', 'closed', { closedAt: T0 - 30 * DAY });

    const result = await retainAt(T0);

    expect(result.pruned.visits).toBe(RUN_CAP);
    expect(result.pruned.closedTabs).toBe(1);
    // A visit remains, so the page is not an orphan yet.
    expect(count('visits')).toBe(1);
    expect(result.pruned.pages).toBe(0);
  }, 60_000);

  it('removes at most the cap of orphan pages in a run, and the rest wait for a new worker', async () => {
    const surplus = 10;
    bulkOrphanPages(RUN_CAP + surplus);

    const first = await retainAt(T0);
    expect(first.pruned.pages).toBe(RUN_CAP);
    expect(count('pages')).toBe(surplus);

    // No visits went, and this worker has looked: the rest waits for the next start.
    const second = await retainAt(T0 + HOUR);
    expect(second.pruned.pages).toBe(0);
    expect(count('pages')).toBe(surplus);

    const afterRestart = await retainAt(T0 + 2 * HOUR, 365, restarted());
    expect(afterRestart.pruned.pages).toBe(surplus);
    expect(count('pages')).toBe(0);
  }, 120_000);

  it('lets the next deletion of visits finish a run of orphans that was cut short', async () => {
    bulkOrphanPages(RUN_CAP + 5);
    await retainAt(T0);
    expect(count('pages')).toBe(5);
    const page = insertPage(999_999);
    insertVisit(page, T0 - 400 * DAY);

    const next = await retainAt(T0 + HOUR);

    expect(next.pruned).toEqual({ visits: 1, pages: 6, closedTabs: 0 });
    expect(count('pages')).toBe(0);
  }, 120_000);
});

describe('Maintenance: when orphans are looked for', () => {
  it('looks in the first run of a worker, even with no visit to delete', async () => {
    insertPage(1);
    insertFavicon(1);

    const result = await retainAt(T0);

    expect(result.pruned.pages).toBe(1);
    expect(count('pages')).toBe(0);
    expect(count('favicons')).toBe(0);
  });

  it('does not look again in a later run of the same worker that deletes no visits', async () => {
    await retainAt(T0);
    insertPage(1);
    insertFavicon(1);

    const result = await retainAt(T0 + HOUR);

    expect(result.pruned).toEqual(NOTHING_PRUNED);
    expect(count('pages')).toBe(1);
    expect(count('favicons')).toBe(1);
  });

  it('looks again once a run has deleted visits, and finds the orphans of the quiet run too', async () => {
    await retainAt(T0);
    insertPage(1);
    insertFavicon(1);
    const old = insertPage(2);
    insertVisit(old, T0 - 400 * DAY);

    const result = await retainAt(T0 + HOUR);

    expect(result.pruned).toEqual({ visits: 1, pages: 2, closedTabs: 0 });
    expect(count('pages')).toBe(0);
    expect(count('favicons')).toBe(0);
  });

  it('looks again after deleting closed tabs, as after deleting visits', async () => {
    addWorkspace(db, WORKSPACE);
    await retainAt(T0);
    insertPage(1);
    insertTab('closed-old', 'closed', { closedAt: T0 - 30 * DAY });

    const result = await retainAt(T0 + HOUR);

    expect(result.pruned).toEqual({ visits: 0, pages: 1, closedTabs: 1 });
    expect(count('pages')).toBe(0);
  });

  it('does not look in a later run that deleted nothing', async () => {
    await retainAt(T0);
    insertPage(1);

    const result = await retainAt(T0 + HOUR);

    expect(result.pruned).toEqual({ visits: 0, pages: 0, closedTabs: 0 });
    expect(count('pages')).toBe(1);
  });

  it('looks again in the first run of a new worker on the same database', async () => {
    await retainAt(T0);
    insertPage(1);

    const result = await retainAt(T0 + HOUR, 365, restarted());

    expect(result.pruned.pages).toBe(1);
    expect(count('pages')).toBe(0);
  });

  it('has looked once a worker has run, even if its run found nothing', async () => {
    expect((await retainAt(T0)).pruned).toEqual(NOTHING_PRUNED);
    insertPage(1);

    expect((await retainAt(T0 + HOUR)).pruned.pages).toBe(0);
    expect(count('pages')).toBe(1);
  });
});

describe('Maintenance: retention and the backup', () => {
  it('counts what it deleted as a change since the last backup, and keeps that', async () => {
    quietState();
    const quiet = restarted();
    expect(quiet.status().changedSinceBackup).toBe(false);
    const page = insertPage(1);
    insertVisit(page, T0 - 400 * DAY);

    await retainAt(T0 + HOUR, 365, quiet);

    expect(quiet.status().changedSinceBackup).toBe(true);
    expect(storedState()).toMatchObject({ changedSinceBackup: true });
  });

  it.each(['visits', 'orphan pages', 'closed tabs'])(
    'counts deleting %s as a change',
    async (what) => {
      addWorkspace(db, WORKSPACE);
      quietState();
      const quiet = restarted();
      if (what === 'visits') {
        insertVisit(insertPage(1), T0 - 400 * DAY);
      } else if (what === 'orphan pages') {
        insertPage(1);
      } else {
        insertTab('closed-old', 'closed', { closedAt: T0 - 30 * DAY });
      }

      await retainAt(T0 + HOUR, 365, quiet);

      expect(quiet.status().changedSinceBackup).toBe(true);
    },
  );

  it('does not count deleting nothing, nor deleting only favicons, as a change', async () => {
    quietState();
    const quiet = restarted();

    await retainAt(T0 + HOUR, 365, quiet);
    expect(quiet.status().changedSinceBackup).toBe(false);

    insertFavicon(1);
    await retainAt(T0 + 2 * HOUR, 365, restarted());
    expect(count('favicons')).toBe(0);
    expect(storedState()).toMatchObject({ changedSinceBackup: false });
  });

  it('makes the backup due: the same run takes it, with the deletions in it', async () => {
    const page = insertPage(1);
    insertVisit(page, T0 - 400 * DAY);
    const kept = insertPage(2);
    insertVisit(kept, T0 - HOUR);

    const result = await retainAt(T0);

    expect(result).toEqual({
      check: 'ok',
      backup: 'done',
      backupFile: dailyBackupName(T0),
      pruned: { visits: 1, pages: 1, closedTabs: 0 },
    });
    inspectBackup(dailyBackupName(T0), (copy) => {
      expect(copy.prepare('SELECT COUNT(*) FROM pages').pluck().get()).toBe(1);
      expect(copy.prepare('SELECT COUNT(*) FROM visits').pluck().get()).toBe(1);
    });
  });

  it('takes the next day backup after a day of deletions, though nothing else was written', async () => {
    change();
    expect((await retainAt(T0)).backup).toBe('done');
    const page = insertPage(1);
    insertVisit(page, T0 + DAY - 400 * DAY);

    const result = await retainAt(T0 + DAY);

    expect(result.pruned.visits).toBe(1);
    expect(result).toMatchObject({ backup: 'done', backupFile: dailyBackupName(T0 + DAY) });
  });

  it('takes no backup for a day on which nothing was deleted and nothing written', async () => {
    change();
    await retainAt(T0);

    const result = await retainAt(T0 + DAY);

    expect(result).toEqual({
      check: 'not_due',
      backup: 'unchanged',
      backupFile: null,
      pruned: NOTHING_PRUNED,
    });
  });

  it('comes before the backup, so a copy never holds what the run deleted', async () => {
    const page = insertPage(1);
    insertVisit(page, T0 - 400 * DAY);
    change();

    await retainAt(T0);

    inspectBackup(dailyBackupName(T0), (copy) => {
      expect(copy.prepare('SELECT COUNT(*) FROM visits').pluck().get()).toBe(0);
    });
  });
});

describe('Maintenance: retention after a failed check', () => {
  it('deletes nothing while the last check is failed, and reports nothing', async () => {
    addWorkspace(db, WORKSPACE);
    quietState({ lastBackupAt: null, lastCheckAt: T0 - DAY, lastCheckOk: false });
    const waiting = restarted();
    const page = insertPage(1);
    insertVisit(page, T0 - 400 * DAY);
    insertTab('closed-old', 'closed', { closedAt: T0 - 30 * DAY });
    insertPage(2);

    const result = await retainAt(T0, 365, waiting);

    expect(result.pruned).toEqual(NOTHING_PRUNED);
    expect(count('visits')).toBe(1);
    expect(count('pages')).toBe(2);
    expect(count('tabs')).toBe(1);
  });

  it('checks again in that run, and goes on deleting once the check passes', async () => {
    quietState({ lastBackupAt: null, lastCheckAt: T0 - DAY, lastCheckOk: false });
    const waiting = restarted();
    const page = insertPage(1);
    insertVisit(page, T0 - 400 * DAY);

    const first = await retainAt(T0, 365, waiting);
    expect(first.check).toBe('ok');
    expect(first.pruned).toEqual(NOTHING_PRUNED);
    expect(waiting.status()).toMatchObject({ lastCheckOk: true, lastCheckAt: T0 });

    const second = await retainAt(T0 + HOUR, 365, waiting);
    expect(second.pruned).toEqual({ visits: 1, pages: 1, closedTabs: 0 });
  });

  it('deletes nothing in the runs that follow a check that failed', async () => {
    desyncSearchIndex();
    const first = await retainAt(T0);
    expect(first.check).toBe('failed');
    expect(maintenance.status().lastCheckOk).toBe(false);
    insertVisit(insertPage(3), T0 - 400 * DAY);

    const second = await retainAt(T0 + HOUR);

    expect(second).toEqual({
      check: 'failed',
      backup: 'skipped',
      backupFile: null,
      pruned: NOTHING_PRUNED,
    });
    expect(visitTimes()).toHaveLength(1);
  });
});

describe('Maintenance: retention that runs into damage', () => {
  /**
   * Fills `visits` with enough rows to span several pages, then zeroes the second of its leaf
   * pages, which holds visits the first chunk deletes. The database must be closed.
   */
  function damageVisits(target: string): void {
    const raw = new Database(target);
    let leaf: number;
    try {
      raw.exec(
        `INSERT INTO pages (url_key, url, host, site, first_visit_at, last_visit_at)
         VALUES ('k', 'https://x.example/', 'x.example', 'x.example', 1, 1)`,
      );
      raw.exec(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1800)
         INSERT INTO visits (page_id, visited_at, transition) SELECT 1, 1000 + i, 'link' FROM n`,
      );
      raw.pragma('wal_checkpoint(TRUNCATE)');
      const leaves = raw
        .prepare(
          "SELECT pageno FROM dbstat WHERE name = 'visits' AND pagetype = 'leaf' ORDER BY pageno",
        )
        .pluck()
        .all() as number[];
      const second = leaves[1];
      if (second === undefined) {
        throw new Error('visits has fewer than two leaf pages');
      }
      leaf = second;
    } finally {
      raw.close();
    }
    const pageSize = 4096;
    const fd = openSync(target, 'r+');
    try {
      writeSync(fd, Buffer.alloc(pageSize, 0), 0, pageSize, (leaf - 1) * pageSize);
    } finally {
      closeSync(fd);
    }
  }

  async function reopenDamaged(): Promise<void> {
    await maintenance.stop();
    db.close();
    damageVisits(file);
    await openFresh();
  }

  it('reports a failed check and no backup, marks the database, and remembers it', async () => {
    await reopenDamaged();

    const result = await retainAt(T0);

    expect(result).toEqual({
      check: 'failed',
      backup: 'skipped',
      backupFile: null,
      pruned: NOTHING_PRUNED,
    });
    expect(needsCheck(file)).toBe(true);
    expect(maintenance.status()).toMatchObject({ lastCheckAt: T0, lastCheckOk: false });
    expect(storedState()).toMatchObject({ lastCheckAt: T0, lastCheckOk: false });
    expect(backupFiles()).toEqual([]);
  });

  it('leaves the good backups that are already there, and takes no new one', async () => {
    change('before');
    expect((await retainAt(T0)).backup).toBe('done');
    await reopenDamaged();
    maintenance.noteWrite();

    const result = await retainAt(T0 + DAY);

    expect(result).toMatchObject({ check: 'failed', backup: 'skipped', backupFile: null });
    expect(backupFiles()).toEqual([dailyBackupName(T0)]);
    inspectBackup(dailyBackupName(T0), (copy) => {
      expect(copy.pragma('quick_check', { simple: true })).toBe('ok');
    });
  });

  it('then deletes nothing while the check is failed, and checks every run', async () => {
    await reopenDamaged();
    await retainAt(T0);

    const next = await retainAt(T0 + HOUR);

    expect(next).toMatchObject({ check: 'failed', backup: 'skipped', pruned: NOTHING_PRUNED });
  });

  it('is not the same as a failure that is not damage, which the run reports by rejecting', async () => {
    const page = insertPage(1);
    insertVisit(page, T0 - 400 * DAY);
    db.exec(
      "CREATE TRIGGER refuse_delete BEFORE DELETE ON visits BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );

    await expect(retainAt(T0)).rejects.toThrow('refused');

    // Not marked as damage, and not recorded as a failed check.
    expect(needsCheck(file)).toBe(false);
    expect(maintenance.status()).toEqual(FRESH);
    // The run is over: the next one is accepted, and goes through once the cause is gone.
    db.exec('DROP TRIGGER refuse_delete');
    expect((await retainAt(T0 + HOUR)).pruned.visits).toBe(1);
  });
});

describe('Maintenance: stopping during retention', () => {
  it('stops before the next chunk, and the run still answers', async () => {
    const page = insertPage(1);
    const total = 3 * RETENTION_CHUNK + 100;
    bulkVisits(page, total);

    const running = retainAt(T0);
    // The first chunk went synchronously; stopping now keeps every later one from running.
    await maintenance.stop();
    const result = await running;

    expect(result.pruned.visits).toBe(RETENTION_CHUNK);
    expect(count('visits')).toBe(total - RETENTION_CHUNK);
    expect(result.pruned.pages).toBe(0);
    expect(() => db.close()).not.toThrow();
  });

  it('does not look for orphans or closed tabs after a stop', async () => {
    addWorkspace(db, WORKSPACE);
    insertPage(1);
    insertTab('closed-old', 'closed', { closedAt: T0 - 30 * DAY });
    const page = insertPage(2);
    bulkVisits(page, RETENTION_CHUNK * 2);

    const running = retainAt(T0);
    await maintenance.stop();
    const result = await running;

    expect(result.pruned).toEqual({ visits: RETENTION_CHUNK, pages: 0, closedTabs: 0 });
    expect(count('tabs')).toBe(1);
    expect(count('pages')).toBe(2);
  });

  it('refuses a run that comes after the stop, whatever is waiting to be deleted', async () => {
    const page = insertPage(1);
    insertVisit(page, T0 - 400 * DAY);

    await maintenance.stop();

    await expect(maintenance.run(T0, 365)).rejects.toMatchObject({ code: 'closed' });
    expect(count('visits')).toBe(1);
  });

  it('turns a second run away as busy while retention runs', async () => {
    const page = insertPage(1);
    bulkVisits(page, RETENTION_CHUNK * 2);

    const running = retainAt(T0);
    const second = await rejectionOf(maintenance.run(T0, 365));

    expect(second).toMatchObject({ code: 'busy' });
    expect((await running).pruned.visits).toBe(RETENTION_CHUNK * 2);
  });
});

describe('Maintenance: giving back space', () => {
  it('frees no more than its allowance of pages in one run', () => {
    expect(VACUUM_PAGES_PER_RUN).toBe(4096);
  });

  const freePages = (): number => db.pragma('freelist_count', { simple: true }) as number;

  /** A database with free pages in its list, as deleting many rows leaves it, and one page. */
  function withFreePages(): number {
    const page = insertPage(1);
    bulkVisits(page, 6000);
    db.exec('DELETE FROM visits');
    expect(freePages()).toBeGreaterThan(0);
    return page;
  }

  it('returns the free pages to the file system after a run that deleted something', async () => {
    const page = withFreePages();
    insertVisit(page, T0 - 400 * DAY);
    insertVisit(page, T0 - HOUR);

    const result = await retainAt(T0);

    expect(result.pruned.visits).toBe(1);
    expect(freePages()).toBe(0);
  });

  it('leaves the free list alone in a run that deleted nothing', async () => {
    const page = withFreePages();
    insertVisit(page, T0 - HOUR);
    const before = freePages();

    const result = await retainAt(T0);

    expect(result.pruned).toEqual(NOTHING_PRUNED);
    expect(freePages()).toBe(before);
  });
});
