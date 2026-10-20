// The data worker's startup on real files (assessment §5.6, §5.9): crash detection, the checks,
// and recovery from a damaged database by quarantine and restore.
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

import { backupStamp, dailyBackupName } from './backups';
import { DataError } from './errors';
import { NEEDS_CHECK_SUFFIX } from './integrity';
import { LATEST_VERSION } from './migrations';
import { startDatabase } from './startup';
import type { StartupResult } from './startup';
import { damageTable, destroyHeader } from './testing/damage';

const T0 = Date.UTC(2026, 9, 21, 8, 0, 0);

let dir: string;
let file: string;
let backupDir: string;
const started: StartupResult[] = [];

async function start(now = T0): Promise<StartupResult> {
  const result = await startDatabase({ file, backupDir, appVersion: '0.0.0', now: () => now });
  started.push(result);
  return result;
}

function close(result: StartupResult): void {
  if (result.opened.db.open) {
    result.opened.db.close();
  }
}

/** A launch that wrote a row, then quit cleanly or was killed. */
async function launch(options: { readonly crash: boolean; readonly key?: string }): Promise<void> {
  const result = await start();
  const { db } = result.opened;
  db.prepare("INSERT INTO app_state VALUES (?, '{}')").run([options.key ?? 'session']);
  db.prepare('UPDATE app_runs SET last_heartbeat_at = ? WHERE id = ?').run([
    T0 + 60_000,
    result.runId,
  ]);
  if (!options.crash) {
    db.prepare("UPDATE app_runs SET ended_at = ?, exit_kind = 'clean' WHERE id = ?").run([
      T0 + 61_000,
      result.runId,
    ]);
  }
  close(result);
}

/** A consistent copy of the current database in the backup folder, as the daily backup makes. */
async function backUp(at: number): Promise<string> {
  const result = await start();
  mkdirSync(backupDir, { recursive: true });
  const name = dailyBackupName(at);
  await result.opened.db.backup(join(backupDir, name));
  close(result);
  return name;
}

function keys(result: StartupResult): unknown[] {
  return result.opened.db.prepare('SELECT key FROM app_state ORDER BY key').pluck().all();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'veltriva-startup-'));
  file = join(dir, 'veltriva.db');
  backupDir = join(dir, 'backups');
});

afterEach(() => {
  started.splice(0).forEach(close);
  rmSync(dir, { recursive: true, force: true });
});

describe('startDatabase: runs and crashes', () => {
  it('records the first run, with nothing to check', async () => {
    const result = await start();
    expect(result).toMatchObject({ previousExit: 'none', checked: 'none', recovery: null });
    expect(result.opened.userVersion).toBe(LATEST_VERSION);
    expect(result.opened.db.prepare('SELECT * FROM app_runs').all()).toEqual([
      {
        id: result.runId,
        started_at: T0,
        last_heartbeat_at: T0,
        ended_at: null,
        exit_kind: null,
        app_version: '0.0.0',
      },
    ]);
  });

  it('after a clean exit, checks nothing', async () => {
    await launch({ crash: false });
    const result = await start();
    expect(result).toMatchObject({ previousExit: 'clean', checked: 'none', recovery: null });
  });

  it('after a crash, runs a quick check and closes the dead run at its last heartbeat', async () => {
    await launch({ crash: true });
    const result = await start(T0 + 120_000);
    expect(result).toMatchObject({ previousExit: 'crash', checked: 'quick', recovery: null });
    expect(
      result.opened.db
        .prepare('SELECT ended_at, exit_kind FROM app_runs WHERE id <> ? ORDER BY id')
        .all([result.runId]),
    ).toEqual([{ ended_at: T0 + 60_000, exit_kind: 'crash' }]);
    expect(keys(result)).toEqual(['session']);
  });

  it('runs the full check when the last run found damage, then clears the marker', async () => {
    await launch({ crash: false });
    writeFileSync(file + NEEDS_CHECK_SUFFIX, '');
    const result = await start();
    expect(result).toMatchObject({ checked: 'full', recovery: null });
    expect(existsSync(file + NEEDS_CHECK_SUFFIX)).toBe(false);
  });

  it('refuses a newer database rather than replacing it', async () => {
    await launch({ crash: false });
    const db = new Database(file);
    db.pragma(`user_version = ${String(LATEST_VERSION + 1)}`);
    db.close();
    const error: unknown = await start().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DataError);
    expect(error).toMatchObject({ code: 'db_newer' });
    expect(readdirSync(dir).filter((name) => name.includes('corrupt'))).toEqual([]);
  });
});

describe('startDatabase: a damaged database', () => {
  it('that is no longer a database: kept aside, and an empty one starts without backups', async () => {
    await launch({ crash: false });
    destroyHeader(file);
    const result = await start(T0 + 5000);
    const corruptFile = `veltriva.db.corrupt-${backupStamp(T0 + 5000)}`;
    expect(result.recovery).toEqual({ kind: 'reset', corruptFile });
    expect(existsSync(join(dir, corruptFile))).toBe(true);
    expect(keys(result)).toEqual([]);
    expect(result.opened.db.pragma('quick_check', { simple: true })).toBe('ok');
  });

  it('found by the quick check after a crash: restored from the newest good backup', async () => {
    await launch({ crash: false, key: 'kept' });
    const newest = T0 + 3_600_000;
    await backUp(T0);
    await backUp(newest);
    await launch({ crash: true, key: 'after-backup' });
    damageTable(file);

    const result = await start(T0 + 7_200_000);
    expect(result.checked).toBe('quick');
    expect(result.recovery).toEqual({
      kind: 'restored',
      backupAt: newest,
      corruptFile: `veltriva.db.corrupt-${backupStamp(T0 + 7_200_000)}`,
    });
    // The backup's rows, without what came after it.
    expect(keys(result)).toEqual(['kept']);
    expect(result.opened.db.pragma('quick_check', { simple: true })).toBe('ok');
    // The backups themselves are untouched.
    expect(readdirSync(backupDir)).toHaveLength(2);
  });

  it('skips a backup that is itself damaged, and takes the next newest', async () => {
    await launch({ crash: false, key: 'kept' });
    await backUp(T0);
    const bad = await backUp(T0 + 3_600_000);
    damageTable(join(backupDir, bad));
    destroyHeader(file);

    const result = await start(T0 + 7_200_000);
    expect(result.recovery).toMatchObject({ kind: 'restored', backupAt: T0 });
    expect(keys(result)).toEqual(['kept']);
    expect(readdirSync(dir).filter((name) => name.endsWith('.restoring'))).toEqual([]);
  });

  it('starts empty when no backup passes the check, keeping the damaged file', async () => {
    await launch({ crash: false });
    const bad = await backUp(T0);
    destroyHeader(join(backupDir, bad));
    destroyHeader(file);

    const result = await start(T0 + 1000);
    const corrupt = `veltriva.db.corrupt-${backupStamp(T0 + 1000)}`;
    expect(result.recovery).toEqual({ kind: 'reset', corruptFile: corrupt });
    expect(readdirSync(dir).filter((name) => name.startsWith(corrupt))).toEqual([corrupt]);
    expect(keys(result)).toEqual([]);
    // The damaged backup stays where it was: recovery never deletes a backup.
    expect(readdirSync(backupDir)).toEqual([bad]);
  });

  it('restores an older backup from an upgrade, which then migrates', async () => {
    await launch({ crash: false });
    mkdirSync(backupDir);
    copyFileSync(
      join(import.meta.dirname, 'migrations', 'fixtures', 'veltriva-v1.db'),
      join(backupDir, `veltriva-v1-before-v2-${backupStamp(T0)}.db`),
    );
    destroyHeader(file);
    const result = await start(T0 + 1000);
    expect(result.recovery).toMatchObject({ kind: 'restored', backupAt: T0 });
    expect(result.opened.db.prepare('SELECT count(*) FROM tabs').pluck().get()).toBe(3);
  });
});
