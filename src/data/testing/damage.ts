// Test support: ways to damage a database file on disk, as a failing disk or a torn write would.
// Used by the startup and maintenance tests; the worker never imports it.
import { closeSync, openSync, writeSync } from 'node:fs';

import Database from 'better-sqlite3/win32-x64';

/** Overwrites the file's first 100 bytes (SQLite's header): it is no longer a database. */
export function destroyHeader(file: string): void {
  const fd = openSync(file, 'r+');
  try {
    writeSync(fd, Buffer.alloc(100, 0x5a), 0, 100, 0);
  } finally {
    closeSync(fd);
  }
}

/**
 * Fills `table` with enough rows to span many pages, then zeroes one of its leaf pages. The file
 * still opens (the schema is on page 1), but quick_check fails. The database must be closed.
 */
export function damageTable(file: string, table = 'app_state'): void {
  const db = new Database(file);
  let page: number;
  try {
    db.exec(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
       INSERT INTO ${table} (key, json) SELECT 'filler' || i, json_object('pad', hex(randomblob(200))) FROM n`,
    );
    db.pragma('wal_checkpoint(TRUNCATE)');
    const pages = db
      .prepare("SELECT pageno FROM dbstat WHERE name = ? AND pagetype = 'leaf' ORDER BY pageno")
      .pluck()
      .all([table]) as number[];
    const middle = pages[Math.floor(pages.length / 2)];
    if (middle === undefined) {
      throw new Error(`${table} has no leaf pages`);
    }
    page = middle;
  } finally {
    db.close();
  }
  const pageSize = 4096;
  const fd = openSync(file, 'r+');
  try {
    writeSync(fd, Buffer.alloc(pageSize, 0), 0, pageSize, (page - 1) * pageSize);
  } finally {
    closeSync(fd);
  }
}
