// Generates veltriva-v1.db, the frozen schema-v1 fixture for the migration tests
// (src/data/database.test.ts). It was run once, with migration 0001 as released, and its output is
// committed: never regenerate it after a later migration exists, because the point is a real v1
// file. It applies 0001 the way the runner does (auto_vacuum before WAL, one BEGIN IMMEDIATE),
// then writes a few rows in every table the app uses. Usage, from the repository root:
//   node src/data/migrations/fixtures/generate-v1.mjs
import console from 'node:console';
import { readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, URL } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3/win32-x64');

const file = fileURLToPath(new URL('./veltriva-v1.db', import.meta.url));
for (const suffix of ['', '-wal', '-shm']) {
  rmSync(file + suffix, { force: true });
}
const sql = readFileSync(new URL('../0001_init.sql', import.meta.url), 'utf8');
const db = new Database(file);
db.pragma('auto_vacuum = INCREMENTAL');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec('BEGIN IMMEDIATE');
db.exec(sql);
db.pragma('user_version = 1');
db.exec('COMMIT');

const T = 1_792_000_000_000; // 2026-10-15, fixed so the file is the same on every run
const WS = '0199f000-0000-7000-8000-000000000001';
db.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?)').run(WS, 'Default', T, T);
db.prepare("INSERT INTO favicons VALUES (1, 'aa', x'89504e47', ?)").run(T);
const page = db.prepare(
  `INSERT INTO pages (id, url_key, url, host, site, title, favicon_id, first_visit_at,
     last_visit_at, visit_count, typed_count, frecency, frecency_at)
   VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 0, ?, ?)`,
);
page.run(
  1,
  'https://example.com/',
  'https://example.com/',
  'example.com',
  'example.com',
  'Example Domain',
  T,
  T + 1000,
  2,
  1.5,
  T + 1000,
);
page.run(
  2,
  'https://docs.example.org/postgres',
  'https://docs.example.org/postgres',
  'docs.example.org',
  'example.org',
  'PostgreSQL index types',
  T,
  T + 2000,
  1,
  1,
  T + 2000,
);
const visit = db.prepare(
  'INSERT INTO visits (page_id, tab_id, visited_at, transition) VALUES (?, ?, ?, ?)',
);
visit.run(1, null, T, 'typed');
visit.run(1, null, T + 1000, 'link');
visit.run(2, null, T + 2000, 'link');
const tab = db.prepare(
  `INSERT INTO tabs (id, workspace_id, placement, position, pinned, user_protected, page_id, url,
     title, favicon_id, restore_state, opener_tab_id, created_at, last_used_at, last_used_engaged,
     last_used_active_day, placement_changed_at, archived_at, archive_reason, closed_at)
   VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const restore = (url, title) => JSON.stringify({ v: 1, index: 0, entries: [{ url, title }] });
tab.run(
  '0199f000-0000-7000-8000-000000000011',
  WS,
  'strip',
  0,
  1,
  1,
  'https://example.com/',
  'Example Domain',
  restore('https://example.com/', 'Example Domain'),
  T,
  T,
  10,
  1,
  T,
  null,
  null,
  null,
);
tab.run(
  '0199f000-0000-7000-8000-000000000012',
  WS,
  'archive',
  0,
  0,
  2,
  'https://docs.example.org/postgres',
  'PostgreSQL index types',
  null,
  T,
  T,
  5,
  1,
  T,
  T + 5000,
  'auto',
  null,
);
tab.run(
  '0199f000-0000-7000-8000-000000000013',
  WS,
  'closed',
  0,
  0,
  null,
  'https://example.net/',
  'Closed one',
  null,
  T,
  T,
  5,
  1,
  T,
  null,
  null,
  T + 6000,
);
db.prepare('INSERT INTO site_rules VALUES (?, 1, 0, ?)').run('example.org', T);
db.prepare('INSERT INTO permission_decisions VALUES (?, ?, ?, ?)').run(
  'https://example.com',
  'notifications',
  'allow',
  T,
);
db.prepare('INSERT INTO permission_decisions VALUES (?, ?, ?, ?)').run(
  'https://example.com',
  'protocol:mailto',
  'allow',
  T,
);
db.prepare('INSERT INTO permission_decisions VALUES (?, ?, ?, ?)').run(
  'https://example.org',
  'camera',
  'block',
  T,
);
db.prepare(`INSERT INTO downloads VALUES (?, ?, ?, ?, ?, 'completed', 0, 1, 1024, 1024, ?, ?)`).run(
  '0199f000-0000-7000-8000-000000000021',
  'report.pdf',
  String.raw`C:\Users\Example\Downloads\report.pdf`,
  'https://example.com/report.pdf',
  'example.com',
  T,
  T + 100,
);
db.prepare("INSERT INTO settings VALUES (1, '{}')").run();
db.prepare('INSERT INTO app_state VALUES (?, ?)').run(
  'session',
  JSON.stringify({ selectedTabId: null }),
);
db.prepare('INSERT INTO app_state VALUES (?, ?)').run('client_hints', JSON.stringify({}));
db.prepare(
  'INSERT INTO app_runs (started_at, last_heartbeat_at, ended_at, exit_kind, app_version) VALUES (?, ?, ?, ?, ?)',
).run(T, T + 60_000, T + 61_000, 'clean', '0.0.0');

// One self-contained file: fold the WAL in and leave journal_mode as the app will find it (WAL).
db.pragma('wal_checkpoint(TRUNCATE)');
db.close();
for (const suffix of ['-wal', '-shm']) {
  rmSync(file + suffix, { force: true });
}
console.log(`wrote ${file}`);
