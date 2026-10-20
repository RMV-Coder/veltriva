// The integrity checks and the "needs a check" marker (assessment §5.6, §5.9), on real database
// files: a healthy one, one with a torn page, one that is no longer a database, and one whose
// search index disagrees with its table.
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3/win32-x64';
import type { DatabaseConnection } from 'better-sqlite3/win32-x64';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from './database';
import { DataError } from './errors';
import {
  clearNeedsCheck,
  fullCheck,
  isCorruption,
  markNeedsCheck,
  NEEDS_CHECK_SUFFIX,
  needsCheck,
  quickCheck,
} from './integrity';
import { damageTable, destroyHeader } from './testing/damage';

let dir: string;
let file: string;
const open: DatabaseConnection[] = [];

/** A new, migrated database, with a few pages in it so the search index has something to hold. */
async function createDatabase(): Promise<DatabaseConnection> {
  const { db } = await openDatabase({ file, backupDir: join(dir, 'backups') });
  for (let n = 1; n <= 3; n++) {
    db.prepare(
      `INSERT INTO pages (url_key, url, host, site, title, first_visit_at, last_visit_at)
       VALUES (?, ?, 'example.com', 'example.com', ?, 1, 1)`,
    ).run([`example.com/${String(n)}`, `https://example.com/${String(n)}`, `Page ${String(n)}`]);
  }
  open.push(db);
  return db;
}

/** Opens the file as it is on disk now: call it after the damage, not before. */
function reopen(): DatabaseConnection {
  const db = new Database(file);
  open.push(db);
  return db;
}

function closeAll(): void {
  for (const db of open.splice(0)) {
    if (db.open) {
      db.close();
    }
  }
}

/** Makes `pages_fts` forget a page's index entries, though `pages` still holds the page. */
function desyncSearchIndex(db: DatabaseConnection): void {
  const id = db.prepare('SELECT id FROM pages ORDER BY id').pluck().get();
  db.prepare(
    "INSERT INTO pages_fts(pages_fts, rowid, title, url, site) VALUES ('delete', ?, 'wrong', 'wrong', 'wrong')",
  ).run([id]);
}

/** What SQLite throws when it meets damage, as better-sqlite3 reports it. */
function sqliteError(code: string): Error {
  return new Database.SqliteError(`SQLite says ${code}`, code);
}

function thrownBy(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'veltriva-integrity-'));
  file = join(dir, 'veltriva.db');
});

afterEach(() => {
  closeAll();
  rmSync(dir, { recursive: true, force: true });
});

describe('the checks on a healthy database', () => {
  it('pass the quick check', async () => {
    expect(quickCheck(await createDatabase())).toBe(true);
  });

  it('pass the full check, including the search index', async () => {
    expect(fullCheck(await createDatabase())).toBe(true);
  });

  it('pass on an empty one, just as it is after the first start', async () => {
    const { db } = await openDatabase({ file, backupDir: join(dir, 'backups') });
    open.push(db);
    expect(quickCheck(db)).toBe(true);
    expect(fullCheck(db)).toBe(true);
  });

  it('change nothing in it', async () => {
    const db = await createDatabase();
    const before = db.prepare('SELECT count(*) FROM pages').pluck().get();
    quickCheck(db);
    fullCheck(db);
    expect(db.prepare('SELECT count(*) FROM pages').pluck().get()).toBe(before);
    expect(db.inTransaction).toBe(false);
  });
});

describe('the checks on a database with a torn page', () => {
  async function damaged(): Promise<DatabaseConnection> {
    (await createDatabase()).close();
    damageTable(file);
    return reopen();
  }

  it('fail the quick check', async () => {
    expect(quickCheck(await damaged())).toBe(false);
  });

  it('fail the full check', async () => {
    expect(fullCheck(await damaged())).toBe(false);
  });

  it('make the next read of the table throw what isCorruption recognises', async () => {
    const db = await damaged();
    const error = thrownBy(() =>
      db.prepare('SELECT count(*), sum(length(json)) FROM app_state').get(),
    );
    expect(error).toBeInstanceOf(Database.SqliteError);
    expect(isCorruption(error)).toBe(true);
  });
});

describe('the checks on a file that is no longer a database', () => {
  async function destroyed(): Promise<DatabaseConnection> {
    (await createDatabase()).close();
    destroyHeader(file);
    return reopen();
  }

  it('fail the quick check, rather than throw', async () => {
    expect(quickCheck(await destroyed())).toBe(false);
  });

  it('fail the full check, rather than throw', async () => {
    expect(fullCheck(await destroyed())).toBe(false);
  });

  it('are what isCorruption calls corruption when the file is opened for use', async () => {
    const db = await destroyed();
    const error = thrownBy(() => db.pragma('user_version', { simple: true }));
    expect(error).toMatchObject({ code: 'SQLITE_NOTADB' });
    expect(isCorruption(error)).toBe(true);
  });
});

describe('the checks on a search index that disagrees with its table', () => {
  it('fail the full check', async () => {
    const db = await createDatabase();
    desyncSearchIndex(db);
    expect(fullCheck(db)).toBe(false);
  });

  it('do not fail the quick check, which never reads the search index against its table', async () => {
    const db = await createDatabase();
    desyncSearchIndex(db);
    expect(quickCheck(db)).toBe(true);
  });

  it('do not fail SQLite integrity_check either: only the FTS5 check sees this', async () => {
    const db = await createDatabase();
    desyncSearchIndex(db);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(fullCheck(db)).toBe(false);
  });

  it('are found by the full check after the database is closed and opened again', async () => {
    const db = await createDatabase();
    desyncSearchIndex(db);
    db.close();
    expect(fullCheck(reopen())).toBe(false);
  });
});

describe('the checks on a database that is not what they expect', () => {
  it('do not call a closed connection damaged: that would be a bug, so it throws', async () => {
    const db = await createDatabase();
    db.close();
    expect(() => quickCheck(db)).toThrow(/not open/);
    expect(() => fullCheck(db)).toThrow(/not open/);
  });

  it('do not call a database with no search index damaged either: the full check throws', () => {
    const db = reopen();
    expect(() => fullCheck(db)).toThrow(/no such table/);
    expect(quickCheck(db)).toBe(true);
  });
});

describe('isCorruption', () => {
  it.each(['SQLITE_CORRUPT', 'SQLITE_CORRUPT_VTAB', 'SQLITE_CORRUPT_INDEX', 'SQLITE_NOTADB'])(
    'is true for SQLite saying %s',
    (code) => {
      expect(isCorruption(sqliteError(code))).toBe(true);
    },
  );

  it.each(['SQLITE_CORRUPT', 'SQLITE_CORRUPT_VTAB', 'SQLITE_NOTADB'])(
    'is true for a DataError whose detail is %s',
    (code) => {
      expect(isCorruption(new DataError('open_failed', code))).toBe(true);
      expect(isCorruption(new DataError('sqlite', code))).toBe(true);
    },
  );

  it('is true for a corruption code inside a longer detail, as a failed migration reports one', () => {
    expect(isCorruption(new DataError('migration_failed', '2 SQLITE_CORRUPT'))).toBe(true);
  });

  it.each([
    'SQLITE_FULL',
    'SQLITE_BUSY',
    'SQLITE_IOERR',
    'SQLITE_CONSTRAINT_CHECK',
    'SQLITE_ERROR',
  ])('is false for SQLite saying %s', (code) => {
    expect(isCorruption(sqliteError(code))).toBe(false);
    expect(isCorruption(new DataError('sqlite', code))).toBe(false);
  });

  it('is false for an error that is not SQLite at all', () => {
    expect(isCorruption(new Error('boom'))).toBe(false);
    expect(isCorruption(new TypeError('The database connection is not open'))).toBe(false);
    expect(isCorruption(new Error('SQLITE_CORRUPT'))).toBe(false); // the words, not a code
  });

  it('is false for a DataError that carries no SQLite code', () => {
    expect(isCorruption(new DataError('db_newer', '3 > 2'))).toBe(false);
    expect(isCorruption(new DataError('open_failed'))).toBe(false);
    expect(isCorruption(new DataError('closed'))).toBe(false);
  });

  it('is false for anything that is not an error', () => {
    for (const value of [undefined, null, 'SQLITE_CORRUPT', 0, {}, { code: 7 }]) {
      expect(isCorruption(value)).toBe(false);
    }
  });
});

describe('the needs-check marker', () => {
  it('is not there until it is written', () => {
    expect(needsCheck(file)).toBe(false);
  });

  it('is written beside the database, as an empty file with its own name', () => {
    markNeedsCheck(file);
    expect(needsCheck(file)).toBe(true);
    expect(NEEDS_CHECK_SUFFIX).toBe('.needs-check');
    expect(readdirSync(dir)).toEqual(['veltriva.db.needs-check']);
  });

  it('goes away when it is cleared', () => {
    markNeedsCheck(file);
    clearNeedsCheck(file);
    expect(needsCheck(file)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('can be written twice and cleared twice', () => {
    markNeedsCheck(file);
    markNeedsCheck(file);
    expect(needsCheck(file)).toBe(true);
    clearNeedsCheck(file);
    expect(() => {
      clearNeedsCheck(file);
    }).not.toThrow();
    expect(needsCheck(file)).toBe(false);
  });

  it('belongs to one database file, not to the folder', () => {
    const other = join(dir, 'other.db');
    markNeedsCheck(file);
    expect(needsCheck(other)).toBe(false);
    clearNeedsCheck(other);
    expect(needsCheck(file)).toBe(true);
  });

  it('is only a marker: it neither creates nor touches the database file', () => {
    markNeedsCheck(file);
    expect(existsSync(file)).toBe(false);
  });

  it('is best effort: where it cannot be written, marking says nothing and finds nothing', () => {
    const unwritable = join(dir, 'no-such-folder', 'veltriva.db');
    expect(() => {
      markNeedsCheck(unwritable);
    }).not.toThrow();
    expect(needsCheck(unwritable)).toBe(false);
  });
});
