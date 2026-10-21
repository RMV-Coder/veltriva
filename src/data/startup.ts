// What the data worker does before it serves anything (assessment §5.6 and §5.9):
//   1. open and migrate the database (./database.ts);
//   2. after a crash, or when the last run found damage, check it: quick or full;
//   3. if it is damaged, quarantine it and restore the newest backup that passes a check, or
//      start fresh;
//   4. close out the runs that never ended (crashes), and record this one.
// A damaged file is renamed, never deleted, so it stays available for manual recovery.
import { copyFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

import Database from 'better-sqlite3/win32-x64';

import type { DataRecovery } from '../shared/contracts/data-rpc';
import { backupStamp, listBackups } from './backups';
import { openDatabase } from './database';
import { DataError } from './errors';
import type { OpenedDatabase, OpenOptions } from './database';
import { clearNeedsCheck, fullCheck, isCorruption, needsCheck, quickCheck } from './integrity';
import { LATEST_VERSION } from './migrations';

export interface StartupOptions extends OpenOptions {
  readonly appVersion: string;
}

export interface StartupResult {
  readonly opened: OpenedDatabase;
  readonly runId: number;
  readonly previousExit: 'none' | 'clean' | 'crash';
  readonly checked: 'none' | 'quick' | 'full';
  readonly recovery: DataRecovery | null;
}

export async function startDatabase(options: StartupOptions): Promise<StartupResult> {
  const now = options.now ?? Date.now;
  const wantsFullCheck = needsCheck(options.file);
  let recovery: DataRecovery | null = null;
  let opened: OpenedDatabase;
  try {
    opened = await openRetrying(options);
  } catch (error) {
    if (!isCorruption(error)) {
      throw error; // A newer or foreign database is refused, never replaced.
    }
    ({ opened, recovery } = await recover(options, now()));
  }

  const runs = opened.db
    .prepare('SELECT count(*) AS total, count(*) - count(ended_at) AS open FROM app_runs')
    .get() as { total: number; open: number };
  const previousExit = runs.total === 0 ? 'none' : runs.open > 0 ? 'crash' : 'clean';

  let checked: StartupResult['checked'] = 'none';
  if (recovery === null && (wantsFullCheck || previousExit === 'crash')) {
    checked = wantsFullCheck ? 'full' : 'quick';
    const ok = wantsFullCheck ? fullCheck(opened.db) : quickCheck(opened.db);
    if (!ok) {
      opened.db.close();
      ({ opened, recovery } = await recover(options, now()));
    }
  }
  clearNeedsCheck(options.file);

  const { db } = opened;
  if (previousExit === 'crash' && recovery === null) {
    // A killed run leaves its WAL behind, never folded into the file. Fold it now, where nothing
    // is waiting: otherwise closing at the next quit has to, inside the 3 s cap, and on a loaded
    // machine it didn't always make it (found by the 20-kill test).
    db.pragma('wal_checkpoint(TRUNCATE)');
  }
  // A run that never ended was a crash (or a hard kill); it ended at its last heartbeat.
  db.prepare(
    "UPDATE app_runs SET ended_at = last_heartbeat_at, exit_kind = 'crash' WHERE ended_at IS NULL",
  ).run();
  const startedAt = now();
  const runId = Number(
    db
      .prepare('INSERT INTO app_runs (started_at, last_heartbeat_at, app_version) VALUES (?, ?, ?)')
      .run([startedAt, startedAt, options.appVersion]).lastInsertRowid,
  );
  return { opened, runId, previousExit, checked, recovery };
}

/** Attempts at opening while the files are briefly unavailable, and the waits between them. */
export const OPEN_RETRY_DELAYS_MS: readonly number[] = [150, 300, 600, 900, 1200];

/**
 * Opens the database, waiting out errors that pass: right after a hard kill, Windows (or a file
 * scanner) can still hold the killed process's files for a few seconds, and SQLite then fails
 * to truncate or lock them (SQLITE_IOERR_TRUNCATE was measured, even 4 s after the kill). A
 * corrupt, newer or foreign database fails at once.
 */
async function openRetrying(options: StartupOptions): Promise<OpenedDatabase> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await openDatabase(options);
    } catch (error) {
      const delay = OPEN_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isTransient(error)) {
        throw error;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, delay);
      });
    }
  }
}

function isTransient(error: unknown): boolean {
  const detail = error instanceof DataError ? error.detail : undefined;
  return (
    detail !== undefined &&
    /^SQLITE_(IOERR|BUSY|LOCKED|CANTOPEN)/.test(detail) &&
    !isCorruption(error)
  );
}

/**
 * Moves the damaged file (and its -wal and -shm) aside as `veltriva.db.corrupt-<time>`, then
 * restores the newest backup that opens and passes a quick check, or starts an empty database.
 */
async function recover(
  options: StartupOptions,
  at: number,
): Promise<{ opened: OpenedDatabase; recovery: DataRecovery }> {
  const { file } = options;
  const corrupt = `${file}.corrupt-${backupStamp(at)}`;
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(file + suffix)) {
      renameSync(file + suffix, corrupt + suffix);
    }
  }
  const corruptFile = basename(corrupt);

  for (const backup of listBackups(options.backupDir)) {
    const restoring = `${file}.restoring`;
    try {
      copyFileSync(join(options.backupDir, backup.name), restoring);
      if (!usable(restoring)) {
        continue;
      }
      renameSync(restoring, file);
      const opened = await openDatabase(options);
      return { opened, recovery: { kind: 'restored', backupAt: backup.takenAt, corruptFile } };
    } catch {
      removeWithSideFiles(file); // This backup doesn't open either: try the next one.
    } finally {
      // A WAL-mode copy opened even read-only gets -wal and -shm files beside it.
      removeWithSideFiles(restoring);
    }
  }
  const opened = await openDatabase(options);
  return { opened, recovery: { kind: 'reset', corruptFile } };
}

function removeWithSideFiles(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(path + suffix, { force: true });
  }
}

/** A backup worth restoring: a SQLite file this build can open, that passes a quick check. */
function usable(path: string): boolean {
  let db;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    const version = db.pragma('user_version', { simple: true });
    return (
      typeof version === 'number' && version >= 1 && version <= LATEST_VERSION && quickCheck(db)
    );
  } catch {
    return false;
  } finally {
    db?.close();
  }
}
