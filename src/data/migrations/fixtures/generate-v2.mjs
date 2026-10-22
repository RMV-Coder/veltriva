// Generates veltriva-v2.db, the frozen schema-v2 fixture for the migration tests
// (src/data/database.test.ts). It was run once, with migrations 0001 and 0002 as released, and its
// output is committed: never regenerate it after a later migration exists, because the point is a
// real v2 file. It applies each migration the way the runner does (auto_vacuum before WAL, one
// BEGIN IMMEDIATE per file, user_version inside it), then writes a few rows in every table the
// app uses. The settings document lists protected sites as M3.4 wrote them, plus entries its
// schema drops, for migration 3 (site rules). Usage, from the repository root:
//   node src/data/migrations/fixtures/generate-v2.mjs
import console from 'node:console';
import { readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, URL } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3/win32-x64');

const file = fileURLToPath(new URL('./veltriva-v2.db', import.meta.url));
for (const suffix of ['', '-wal', '-shm']) {
  rmSync(file + suffix, { force: true });
}
const db = new Database(file);
db.pragma('auto_vacuum = INCREMENTAL');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
for (const [version, name] of [
  [1, '0001_init.sql'],
  [2, '0002_favicon_bytes.sql'],
]) {
  db.exec('BEGIN IMMEDIATE');
  db.exec(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
  db.pragma(`user_version = ${String(version)}`);
  db.exec('COMMIT');
}

const T = 1_792_600_000_000; // 2026-10-22, fixed so the file is the same on every run
const WS = '0199f100-0000-7000-8000-000000000001';
db.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?)').run(WS, 'Default', T, T);
db.prepare("INSERT INTO favicons VALUES (1, 'bb', x'89504e47', ?, 'image/png')").run(T);
const page = db.prepare(
  `INSERT INTO pages (id, url_key, url, host, site, title, favicon_id, first_visit_at,
     last_visit_at, visit_count, typed_count, frecency, frecency_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
);
page.run(
  1,
  'https://example.com/',
  'https://example.com/',
  'example.com',
  'example.com',
  'Example Domain',
  1,
  T,
  T + 1000,
  2,
  1.5,
  T + 1000,
);
page.run(
  2,
  'https://github.com/veltriva',
  'https://github.com/veltriva',
  'github.com',
  'github.com',
  'Veltriva on GitHub',
  null,
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
   VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL)`,
);
const restore = (url, title) => JSON.stringify({ v: 1, index: 0, entries: [{ url, title }] });
tab.run(
  '0199f100-0000-7000-8000-000000000011',
  WS,
  'strip',
  0,
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
);
tab.run(
  '0199f100-0000-7000-8000-000000000012',
  WS,
  'archive',
  0,
  2,
  'https://github.com/veltriva',
  'Veltriva on GitHub',
  null,
  T,
  T,
  5,
  1,
  T,
  T + 5000,
  'auto',
);
// A site already excluded from the memory, which the user also protected (M3.4's list below).
db.prepare('INSERT INTO site_rules VALUES (?, 0, 1, ?)').run('github.com', T);
db.prepare('INSERT INTO permission_decisions VALUES (?, ?, ?, ?)').run(
  'https://example.com',
  'notifications',
  'allow',
  T,
);
db.prepare('INSERT INTO settings VALUES (1, ?)').run(
  JSON.stringify({
    search: { template: 'https://duckduckgo.com/?q={searchTerms}' },
    history: { retentionDays: 365 },
    lifecycle: {
      preset: 'gentle',
      autoArchive: true,
      freeze: false,
      paused: false,
      preview: 'off',
      // As siteOf wrote them, then what the schema drops: a duplicate, upper case, an empty
      // entry, a number and a name too long to be a host.
      protectedSites: ['example.com', 'github.com', 'Example.com', '', 5, 'x'.repeat(254)],
      overrides: { stripCap: 12 },
    },
  }),
);
db.prepare('INSERT INTO app_state VALUES (?, ?)').run(
  'session',
  JSON.stringify({ selectedTabId: null }),
);
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
