// Opens Veltriva's database: connection pragmas, downgrade protection, the pre-upgrade backup and
// the migration runner (ADR-0004 item 2 and 5, assessment §5.6, spike S5). Runs only in the data
// worker, never on main's thread.
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3/win32-x64';
import type { DatabaseConnection } from 'better-sqlite3/win32-x64';

import { pruneBackups, upgradeBackupName } from './backups';
import { DataError, sqliteCode } from './errors';
import type { Migration } from './migrations';
import { MIGRATIONS } from './migrations';

/** busy_timeout, in ms (ADR-0004). */
export const BUSY_TIMEOUT_MS = 5000;
/** cache_size in KiB, negative as SQLite wants it: 16 MB (S5). */
export const CACHE_SIZE = -16_000;

export interface OpenOptions {
  readonly file: string;
  readonly backupDir: string;
  /** Tests pass a shorter or broken history; the app uses MIGRATIONS. */
  readonly migrations?: readonly Migration[];
  readonly now?: () => number;
}

export interface OpenedDatabase {
  readonly db: DatabaseConnection;
  /** The version before this open: 0 for a new file. */
  readonly fromVersion: number;
  readonly userVersion: number;
  /** The backup taken before upgrading an existing database, if one was. */
  readonly backupFile: string | null;
}

export async function openDatabase(options: OpenOptions): Promise<OpenedDatabase> {
  const migrations = options.migrations ?? MIGRATIONS;
  checkHistory(migrations);
  const latest = migrations.length;
  const now = options.now ?? Date.now;

  let db: DatabaseConnection;
  try {
    db = new Database(options.file, { timeout: BUSY_TIMEOUT_MS });
  } catch (error) {
    throw new DataError('open_failed', sqliteCode(error));
  }
  try {
    const fromVersion = readVersion(db);
    if (fromVersion > latest) {
      // Downgrade protection: a newer Veltriva wrote this file, and this build can't know what
      // its schema means. Nothing is changed.
      throw new DataError('db_newer', `${String(fromVersion)} > ${String(latest)}`);
    }
    const objects = db.prepare('SELECT count(*) FROM sqlite_master').pluck().get();
    if (fromVersion === 0 && objects !== 0) {
      throw new DataError('db_foreign');
    }
    const isNew = fromVersion === 0;

    applyPragmas(db, isNew);

    let backupFile: string | null = null;
    if (!isNew && fromVersion < latest) {
      backupFile = await backupBeforeUpgrade(db, options.backupDir, fromVersion, latest, now());
    }
    for (const migration of migrations) {
      if (migration.version > fromVersion) {
        runMigration(db, migration);
      }
    }
    if (fromVersion < latest) {
      const broken = db.pragma('foreign_key_check');
      if (broken.length > 0) {
        throw new DataError('migration_failed', 'foreign_key_check');
      }
    }
    if (isNew && db.pragma('auto_vacuum', { simple: true }) !== 2) {
      throw new DataError('open_failed', 'auto_vacuum');
    }
    return { db, fromVersion, userVersion: readVersion(db), backupFile };
  } catch (error) {
    db.close();
    if (error instanceof DataError) {
      throw error;
    }
    throw new DataError('open_failed', sqliteCode(error));
  }
}

function checkHistory(migrations: readonly Migration[]): void {
  if (migrations.length === 0 || migrations.some((m, index) => m.version !== index + 1)) {
    throw new DataError('internal', 'migration history');
  }
}

function readVersion(db: DatabaseConnection): number {
  const version = db.pragma('user_version', { simple: true });
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    throw new DataError('open_failed', 'user_version');
  }
  return version;
}

/**
 * The ADR-0004 connection pragmas, each read back. On a brand-new file auto_vacuum must come
 * before journal_mode=WAL: in the other order it silently stays off (S5).
 */
function applyPragmas(db: DatabaseConnection, isNew: boolean): void {
  if (isNew) {
    db.pragma('auto_vacuum = INCREMENTAL');
  }
  expect(db, 'journal_mode = WAL', 'wal');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma(`busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);
  db.pragma('secure_delete = ON');
  db.pragma('temp_store = MEMORY');
  db.pragma(`cache_size = ${String(CACHE_SIZE)}`);
  expect(db, 'synchronous', 1);
  expect(db, 'foreign_keys', 1);
  expect(db, 'busy_timeout', BUSY_TIMEOUT_MS);
  expect(db, 'secure_delete', 1);
  expect(db, 'temp_store', 2);
  expect(db, 'cache_size', CACHE_SIZE);
}

function expect(db: DatabaseConnection, pragma: string, value: string | number): void {
  if (db.pragma(pragma, { simple: true }) !== value) {
    throw new DataError('open_failed', pragma.split(' ')[0]);
  }
}

function runMigration(db: DatabaseConnection, migration: Migration): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(migration.sql);
    db.pragma(`user_version = ${String(migration.version)}`);
    db.exec('COMMIT');
  } catch (error) {
    if (db.inTransaction) {
      db.exec('ROLLBACK');
    }
    const code = sqliteCode(error);
    throw new DataError(
      'migration_failed',
      code === undefined ? String(migration.version) : `${String(migration.version)} ${code}`,
    );
  }
}

/**
 * SQLite's online backup of the database as it is, before any migration touches it. The upgrade
 * is refused if the backup fails, so an upgrade never runs without one.
 */
async function backupBeforeUpgrade(
  db: DatabaseConnection,
  backupDir: string,
  fromVersion: number,
  toVersion: number,
  at: number,
): Promise<string> {
  const file = join(backupDir, upgradeBackupName(fromVersion, toVersion, at));
  try {
    mkdirSync(backupDir, { recursive: true });
    await db.backup(file);
  } catch (error) {
    rmSync(file, { force: true });
    throw new DataError('migration_failed', `backup ${sqliteCode(error) ?? ''}`.trim());
  }
  pruneBackups(backupDir, 'upgrade');
  return file;
}
