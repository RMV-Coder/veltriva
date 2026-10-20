// Integrity checks and the "needs a check" marker (assessment §5.6, §5.9). A quick check runs on
// opening after a crash; a full check (SQLite's integrity_check plus FTS5's own) runs weekly when
// the user is idle. Measured at 50,000 pages: quick_check about 0.25 s, integrity_check about
// 0.35 s, FTS5 integrity-check about 0.15 s. Each is one statement that can't be interrupted (S5),
// which is why they only run at startup or while idle.
import { existsSync, rmSync, writeFileSync } from 'node:fs';

import type { DatabaseConnection } from 'better-sqlite3/win32-x64';

import { DataError, sqliteCode } from './errors';

/**
 * Written beside the database when SQLite reported damage, or a check failed, while the app ran.
 * The next start runs the full check, and recovers if it fails (./startup.ts).
 */
export const NEEDS_CHECK_SUFFIX = '.needs-check';

export function markNeedsCheck(file: string): void {
  try {
    writeFileSync(file + NEEDS_CHECK_SUFFIX, '');
  } catch {
    // Best effort: the next crash's quick check is the fallback.
  }
}

export function needsCheck(file: string): boolean {
  return existsSync(file + NEEDS_CHECK_SUFFIX);
}

export function clearNeedsCheck(file: string): void {
  rmSync(file + NEEDS_CHECK_SUFFIX, { force: true });
}

/** SQLite's answer that the file is damaged, or isn't a database at all. */
export function isCorruption(error: unknown): boolean {
  const code = error instanceof DataError ? error.detail : sqliteCode(error);
  return code !== undefined && /SQLITE_(CORRUPT|NOTADB)/.test(code);
}

/** `PRAGMA quick_check`: the b-trees and their pages, without cross-checking indexes. */
export function quickCheck(db: DatabaseConnection): boolean {
  return guarded(() => db.pragma('quick_check', { simple: true }) === 'ok');
}

/** `PRAGMA integrity_check`, then FTS5's check of the search index against `pages`. */
export function fullCheck(db: DatabaseConnection): boolean {
  return guarded(() => {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') {
      return false;
    }
    // Throws SQLITE_CORRUPT_VTAB when the index and its content table disagree.
    db.exec("INSERT INTO pages_fts(pages_fts, rank) VALUES ('integrity-check', 1)");
    return true;
  });
}

/** A check that SQLite aborts with a corruption error has failed; any other error is a bug. */
function guarded(check: () => boolean): boolean {
  try {
    return check();
  } catch (error) {
    if (isCorruption(error)) {
      return false;
    }
    throw error;
  }
}
