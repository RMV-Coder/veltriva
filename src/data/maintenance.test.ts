// Idle-time upkeep (assessment §5.6): the weekly full check and the daily backup, on a real
// database in a temp folder, with a real Maintenance. Time is the `now` each run is given, so a
// "day later" costs nothing.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
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
import { BACKUP_EVERY_MS, CHECK_EVERY_MS, Maintenance } from './maintenance';
import type { MaintenanceState } from './maintenance';
import { LATEST_VERSION } from './migrations';
import { damageTable } from './testing/damage';

type RunResult = DataOutput<'maintenance.run'>;

const T0 = Date.UTC(2026, 9, 21, 8, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = BACKUP_EVERY_MS;
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
  const result = await target.run(now);
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
    expect(await runAt(T0)).toEqual({ check: 'ok', backup: 'unchanged', backupFile: null });
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
    expect(result).toEqual({ check: 'failed', backup: 'skipped', backupFile: null });
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
    expect(result).toEqual({ check: 'failed', backup: 'skipped', backupFile: null });
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
    });
  });

  it('is also due before a backup, which then counts as the weekly check', async () => {
    change();
    expect(await runAt(T0)).toEqual({
      check: 'ok',
      backup: 'done',
      backupFile: dailyBackupName(T0),
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
    expect(result).toEqual({ check: 'ok', backup: 'done', backupFile: dailyBackupName(T0) });

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

    const notDue = { check: 'not_due', backup: 'not_due', backupFile: null };
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
    });
    expect(maintenance.status()).toMatchObject({ lastBackupAt: T0, lastCheckAt: T0 });

    change('again');
    expect(await runAt(T0 + 3 * DAY + 1000)).toEqual({
      check: 'ok',
      backup: 'done',
      backupFile: dailyBackupName(T0 + 3 * DAY + 1000),
    });
  });

  it('is due at once when the clock went back past the last backup', async () => {
    change();
    await runAt(T0);

    change('again');
    const earlier = T0 - HOUR;
    const result = await runAt(earlier);
    // The full check comes first, as before every backup (and the clock went back past it too).
    expect(result).toEqual({ check: 'ok', backup: 'done', backupFile: dailyBackupName(earlier) });
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
    expect(result).toEqual({ check: 'failed', backup: 'skipped', backupFile: null });
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
    expect(result).toEqual({ check: 'failed', backup: 'skipped', backupFile: null });
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

    expect(await runAt(T0)).toEqual({ check: 'ok', backup: 'failed', backupFile: null });
    expect(maintenance.status()).toMatchObject({ lastBackupAt: null, changedSinceBackup: true });

    rmSync(backupDir);
    // The backup is due again, so the check before it is too, though it passed a moment ago.
    expect(await runAt(T0)).toEqual({
      check: 'ok',
      backup: 'done',
      backupFile: dailyBackupName(T0),
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
    expect(result).toEqual({ check: 'ok', backup: 'done', backupFile: dailyBackupName(T0) });
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
    const late = await rejectionOf(maintenance.run(T0 + DAY));
    expect(late).toBeInstanceOf(DataError);
    expect(late).toMatchObject({ code: 'closed' });
    await stopping;

    expect(await running).toEqual({ check: 'ok', backup: 'failed', backupFile: null });
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

    const second = await rejectionOf(maintenance.run(T0));
    expect(second).toBeInstanceOf(DataError);
    expect(second).toMatchObject({ code: 'busy' });
    const third = await rejectionOf(maintenance.run(T0 + 5 * DAY));
    expect(third).toMatchObject({ code: 'busy' });

    expect(await running).toEqual({ check: 'ok', backup: 'done', backupFile: dailyBackupName(T0) });
    expect(backupFiles()).toEqual([dailyBackupName(T0)]);

    // Once it is over, runs are accepted again.
    expect(await runAt(T0 + HOUR)).toEqual({
      check: 'not_due',
      backup: 'not_due',
      backupFile: null,
    });
  }, 30_000);
});

describe('Maintenance: stopping', () => {
  it('with nothing running returns at once, and refuses every run after it', async () => {
    await maintenance.stop();
    const error = await rejectionOf(maintenance.run(T0));
    expect(error).toBeInstanceOf(DataError);
    expect(error).toMatchObject({ code: 'closed' });
    expect(await rejectionOf(maintenance.run(T0 + DAY))).toMatchObject({ code: 'closed' });
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
    await rejectionOf(maintenance.run(T0));
    expect(needsCheck(file)).toBe(false);
    expect(backupFiles()).toEqual([]);
    expect(maintenance.status()).toEqual(FRESH);
  });
});
