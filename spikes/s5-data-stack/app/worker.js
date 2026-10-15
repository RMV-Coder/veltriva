'use strict';
// Runs inside app.asar once packaged. Loads better-sqlite3 (native .node), applies a mini version of the
// ADR-0004 pragmas and the pages_fts table from assessment §5.3, and runs the §5.4 match/rank/highlight query.
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');

const info = { filename: __filename, dirname: __dirname, electron: process.versions.electron, node: process.versions.node };
try {
  const Database = require('better-sqlite3');
  info.betterSqlite3Resolved = require.resolve('better-sqlite3');
  for (const s of ['', '-wal', '-shm']) fs.rmSync(workerData.dbFile + s, { force: true });
  const db = new Database(workerData.dbFile);
  db.pragma('auto_vacuum = INCREMENTAL');
  info.journalMode = db.pragma('journal_mode = WAL', { simple: true });
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('secure_delete = ON');
  info.sqlite = db.prepare('SELECT sqlite_version() AS v').get().v;
  db.exec(`
    CREATE TABLE pages (id INTEGER PRIMARY KEY, url TEXT NOT NULL, title TEXT NOT NULL, site TEXT NOT NULL) STRICT;
    CREATE VIRTUAL TABLE pages_fts USING fts5(title, url, site, content='pages', content_rowid='id',
      tokenize='unicode61 remove_diacritics 2', prefix='2 3');
    INSERT INTO pages_fts(pages_fts, rank) VALUES ('secure-delete', 1);
    CREATE TRIGGER pages_fts_ai AFTER INSERT ON pages BEGIN
      INSERT INTO pages_fts(rowid, title, url, site) VALUES (new.id, new.title, new.url, new.site);
    END;`);
  const ins = db.prepare('INSERT INTO pages(url, title, site) VALUES (?, ?, ?)');
  db.transaction(() => {
    for (let i = 0; i < 2000; i += 1) ins.run(`https://example.test/${i}`, i % 7 === 0 ? `PostgreSQL index tuning ${i}` : `Other page ${i}`, 'example.test');
  })();
  const rows = db.prepare(`SELECT p.id, p.title, bm25(pages_fts, 10.0, 3.0, 5.0) AS text_rank,
         highlight(pages_fts, 0, char(1), char(2)) AS title_marked
       FROM pages_fts JOIN pages p ON p.id = pages_fts.rowid
       WHERE pages_fts MATCH ? ORDER BY text_rank LIMIT 200`).all('"postgre"* "index"*');
  info.autoVacuum = db.pragma('auto_vacuum', { simple: true });
  // The addon is unloaded when the worker exits, so record which files this thread has mapped right now.
  info.loadedNative = process.report.getReport().sharedObjects.filter((p) => /better_sqlite3|better-sqlite3|\.node$/i.test(p));
  info.ftsRows = rows.length;
  info.firstRow = rows[0];
  db.close();
  parentPort.postMessage({ ok: rows.length > 0, info });
} catch (e) {
  parentPort.postMessage({ ok: false, info, error: e.stack });
}
