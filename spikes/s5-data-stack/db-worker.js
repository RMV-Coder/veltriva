'use strict';
// Data worker for spike S5. Runs inside worker_threads (started from Electron's main process or plain Node).
// One connection, WAL, everything serialized here (assessment §5.5). Talks to its parent over postMessage:
//   parent -> worker : { id, op, args }
//   worker -> parent : { id, ok: true, result } | { id, ok: false, error: { message, code } }
// plus unsolicited { event: 'started', id } just before a deliberately long operation.
//
// The same worker file serves two drivers (workerData.driver): 'better-sqlite3' (default) and 'node:sqlite',
// so the benchmark compares like with like. Only constructor/close differ; both expose prepare().all/get/run
// and exec().

const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const { generateDataset } = require('./lib/datagen');
const Q = require('./lib/queries');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
const driverName = workerData?.driver ?? 'better-sqlite3';

let conn = null; // { exec, prepare, close }
let dbFile = null;
const stmtCache = new Map();
let exprIndexBuilt = false;

function openDriver(file) {
  if (driverName === 'node:sqlite') {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file);
    return { exec: (s) => db.exec(s), prepare: (s) => db.prepare(s), close: () => db.close() };
  }
  const Database = require('better-sqlite3');
  const db = new Database(file);
  return { exec: (s) => db.exec(s), prepare: (s) => db.prepare(s), close: () => db.close() };
}

const stmt = (sql) => {
  let s = stmtCache.get(sql);
  if (!s) stmtCache.set(sql, (s = conn.prepare(sql)));
  return s;
};
const setPragma = (name, value) => conn.exec(`PRAGMA ${name} = ${value}`);
const getPragma = (name) => Object.values(conn.prepare(`PRAGMA ${name}`).all()[0] ?? {})[0];
const ms = () => performance.now();

// ---------------------------------------------------------------- ops

const ops = {
  ping: () => 'pong',

  /** Opens (creating if needed) the database with the ADR-0004 pragmas and applies the §5.3 schema. */
  open({ file, cacheKB = 0, walBeforeAutoVacuum = false }) {
    dbFile = file;
    const t0 = ms();
    conn = openDriver(file);
    const isNew = getPragma('user_version') === 0 && conn.prepare("SELECT count(*) AS n FROM sqlite_master").get().n === 0;
    if (walBeforeAutoVacuum) {
      // Experiment only: the wrong order, to see whether auto_vacuum still sticks.
      setPragma('journal_mode', 'WAL');
      if (isNew) setPragma('auto_vacuum', 'INCREMENTAL');
    } else {
      if (isNew) setPragma('auto_vacuum', 'INCREMENTAL'); // must precede table creation
      setPragma('journal_mode', 'WAL');
    }
    setPragma('synchronous', 'NORMAL');
    setPragma('foreign_keys', 'ON');
    setPragma('busy_timeout', 5000);
    setPragma('secure_delete', 'ON');
    setPragma('temp_store', 'MEMORY');
    if (cacheKB) setPragma('cache_size', -cacheKB);
    let migrationMs = 0;
    if (isNew) {
      const m0 = ms();
      conn.exec('BEGIN IMMEDIATE');
      conn.exec(SCHEMA_SQL);
      conn.exec('PRAGMA user_version = 1');
      conn.exec('COMMIT');
      migrationMs = ms() - m0;
    }
    const opts = conn.prepare('SELECT compile_options AS o FROM pragma_compile_options').all().map((r) => r.o);
    return {
      driver: driverName,
      isNew,
      openMs: ms() - t0,
      migrationMs,
      sqliteVersion: conn.prepare('SELECT sqlite_version() AS v').get().v,
      pragmas: {
        journal_mode: getPragma('journal_mode'),
        synchronous: getPragma('synchronous'),
        foreign_keys: getPragma('foreign_keys'),
        busy_timeout: getPragma('busy_timeout'),
        secure_delete: getPragma('secure_delete'),
        auto_vacuum: getPragma('auto_vacuum'),
        temp_store: getPragma('temp_store'),
        user_version: getPragma('user_version'),
        cache_size: getPragma('cache_size'),
        page_size: getPragma('page_size'),
      },
      compile: ['ENABLE_FTS5', 'ENABLE_MATH_FUNCTIONS', 'ENABLE_DBSTAT_VTAB', 'THREADSAFE', 'DEFAULT_CACHE_SIZE', 'DEFAULT_FOREIGN_KEYS'].map((k) => opts.find((o) => o.startsWith(k)) ?? `(no ${k})`),
    };
  },

  /** Generates a synthetic dataset (untimed vs inserting) and inserts it in batched transactions. */
  load({ pages, seed, tabs = 300, batchSize = 1000 }) {
    const g0 = ms();
    const ds = generateDataset({ pages, seed, tabs });
    const generateMs = ms() - g0;

    const insWs = stmt('INSERT INTO workspaces(id,name,created_at,updated_at) VALUES (?,?,?,?)');
    const insPage = stmt(`INSERT INTO pages(id,url_key,url,host,site,title,first_visit_at,last_visit_at,visit_count,typed_count,frecency,frecency_at)
                          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insVisit = stmt('INSERT INTO visits(page_id,tab_id,visited_at,transition) VALUES (?,?,?,?)');
    const insTab = stmt(`INSERT INTO tabs(id,workspace_id,placement,position,pinned,user_protected,page_id,url,title,restore_state,opener_tab_id,
                                          created_at,last_used_at,last_used_engaged,last_used_active_day,placement_changed_at,archived_at,archive_reason,closed_at)
                         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

    const t0 = ms();
    conn.exec('BEGIN');
    insWs.run(...ds.workspace);
    conn.exec('COMMIT');
    let v = 0;
    const batches = [];
    for (let i = 0; i < ds.pages.length; i += batchSize) {
      const b0 = ms();
      conn.exec('BEGIN');
      const end = Math.min(i + batchSize, ds.pages.length);
      for (let k = i; k < end; k += 1) insPage.run(...ds.pages[k]);
      const lastPageId = ds.pages[end - 1][0];
      while (v < ds.visits.length && ds.visits[v][0] <= lastPageId) insVisit.run(...ds.visits[v++]);
      conn.exec('COMMIT');
      batches.push(ms() - b0);
    }
    const pagesVisitsMs = ms() - t0;
    const tt0 = ms();
    conn.exec('BEGIN');
    for (const row of ds.tabs) insTab.run(...row);
    conn.exec('COMMIT');
    const tabsMs = ms() - tt0;
    const insertMs = ms() - t0;
    const totalRows = ds.pages.length + ds.visits.length + ds.tabs.length;
    return {
      generateMs, insertMs, pagesVisitsMs, tabsMs, batchSize,
      batchMsMedian: batches.sort((a, b) => a - b)[batches.length >> 1],
      pages: ds.pages.length, visits: ds.visits.length, tabs: ds.tabs.length,
      visitsPerPage: ds.stats.visitsPerPage, distinctSites: ds.sitesDistinct,
      pagesPerSec: ds.pages.length / (pagesVisitsMs / 1000),
      totalRowsPerSec: totalRows / (insertMs / 1000),
    };
  },

  /** WAL checkpoint (TRUNCATE) then on-disk sizes, plus a per-object breakdown via dbstat when available. */
  sizes({ breakdown = true } = {}) {
    const c0 = ms();
    conn.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const checkpointMs = ms() - c0;
    const size = (f) => (fs.existsSync(f) ? fs.statSync(f).size : 0);
    const out = {
      checkpointMs, dbBytes: size(dbFile), walBytes: size(`${dbFile}-wal`),
      pageCount: getPragma('page_count'), freelist: getPragma('freelist_count'),
    };
    if (breakdown) {
      try {
        const rows = conn.prepare('SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name').all();
        // Group each table with its own indexes; keep the FTS5 shadow tables separate.
        const groupOf = (name) => {
          if (name.startsWith('pages_fts')) return name;
          for (const t of ['pages', 'visits', 'tabs']) {
            if (name === t || name.startsWith(`${t}_`) || name.startsWith(`sqlite_autoindex_${t}_`)) return `${t} (table + indexes)`;
          }
          return name;
        };
        const byGroup = {};
        for (const r of rows) {
          const g = groupOf(r.name);
          byGroup[g] = (byGroup[g] ?? 0) + r.bytes;
        }
        out.byObject = Object.fromEntries(rows.map((r) => [r.name, r.bytes]));
        out.byGroup = byGroup;
      } catch (e) {
        out.breakdownError = e.message;
      }
    }
    return out;
  },

  /** One search exactly as the palette would issue it. Returns the rows (structured-cloned to the parent). */
  search({ q }) {
    const s = stmt(Q.SEARCH_SQL);
    const t0 = ms();
    const rows = s.all({ q: Q.buildMatch(q) });
    return { rows, innerMs: ms() - t0 };
  },

  /** In-worker timing loops: `passes` interleaved passes over all queries; returns raw samples per query. */
  bench({ queries, passes = 20, warmupPasses = 2 }) {
    const s = stmt(Q.SEARCH_SQL);
    const counter = stmt(Q.COUNT_SQL);
    const matches = queries.map((q) => buildArgs(q));
    const samples = queries.map(() => new Float64Array(passes));
    let rowCounts = new Array(queries.length).fill(0);
    for (let pass = -warmupPasses; pass < passes; pass += 1) {
      for (let i = 0; i < matches.length; i += 1) {
        const t0 = ms();
        const rows = s.all(matches[i]);
        const dt = ms() - t0;
        if (pass >= 0) samples[i][pass] = dt;
        rowCounts[i] = rows.length;
      }
    }
    const totals = queries.map((_, i) => counter.get(matches[i]).n);
    return queries.map((q, i) => ({ q, rows: rowCounts[i], matches: totals[i], samples: Array.from(samples[i]) }));
  },

  /** Same loop as bench(), but for several SQL variants of the search; `jsHighlight` post-processes titles in JS. */
  benchSql({ variants, queries, passes = 15, warmupPasses = 2 }) {
    const out = {};
    for (const [name, spec] of Object.entries(variants)) {
      const sql = typeof spec === 'string' ? spec : spec.sql;
      const post = typeof spec === 'string' ? null : spec.post;
      const s = stmt(sql);
      const samples = queries.map(() => new Float64Array(passes));
      for (let pass = -warmupPasses; pass < passes; pass += 1) {
        for (let i = 0; i < queries.length; i += 1) {
          const t0 = ms();
          const rows = s.all({ q: Q.buildMatch(queries[i]) });
          if (post === 'jsHighlight') Q.markTitles(rows, queries[i]);
          if (pass >= 0) samples[i][pass] = ms() - t0;
        }
      }
      out[name] = queries.map((q, i) => ({ q, samples: Array.from(samples[i]) }));
    }
    return out;
  },

  /** Empty-query listing variants. Returns raw in-worker samples. */
  recent({ variant, now, reps = 30, warmup = 3, returnRows = false }) {
    let indexBuildMs = null;
    if (variant === 'exprIndex' && !exprIndexBuilt) {
      const b0 = ms();
      conn.exec(Q.RECENT_EXPR_INDEX_SQL);
      indexBuildMs = ms() - b0;
      exprIndexBuilt = true;
    }
    const s = stmt(Q.RECENT_VARIANTS[variant]);
    let rows = 0;
    for (let i = 0; i < warmup; i += 1) rows = s.all({ now }).length;
    const samples = [];
    let top = null;
    let last = null;
    for (let i = 0; i < reps; i += 1) {
      const t0 = ms();
      const r = s.all({ now });
      samples.push(ms() - t0);
      rows = r.length;
      top = r[0]?.id;
      last = r;
    }
    const plan = conn.prepare(`EXPLAIN QUERY PLAN ${Q.RECENT_VARIANTS[variant]}`).all({ now }).map((r) => r.detail);
    return { variant, rows, top, samples, indexBuildMs, plan, ...(returnRows ? { data: last } : {}) };
  },

  /** Do the full-scan pow() variant and the expression-index variant return the same 200 ids in the same order? */
  recentCompare({ now }) {
    const a = stmt(Q.RECENT_VARIANTS.pow).all({ now }).map((r) => r.id);
    const b = stmt(Q.RECENT_VARIANTS.exprIndex).all({ now }).map((r) => r.id);
    return { identicalOrder: a.length === b.length && a.every((id, i) => id === b[i]), n: a.length };
  },

  /** Emulates the §5.5 flush: one small transaction of typical navigation bookkeeping. */
  flushBench({ n = 200, now }) {
    const maxPage = stmt('SELECT max(id) AS m FROM pages').get().m;
    const tabIds = stmt("SELECT id FROM tabs WHERE placement IN ('strip','shelf') LIMIT 10").all().map((r) => r.id);
    const insPage = stmt('INSERT INTO pages(url_key,url,host,site,title,first_visit_at,last_visit_at,visit_count,typed_count,frecency,frecency_at) VALUES (?,?,?,?,?,?,?,1,0,1,?)');
    const insVisit = stmt("INSERT INTO visits(page_id,tab_id,visited_at,transition) VALUES (?,?,?,'link')");
    const updPage = stmt('UPDATE pages SET visit_count = visit_count + 1, last_visit_at = ?, frecency = frecency * 0.99 + 1, frecency_at = ? WHERE id = ?');
    const updTitle = stmt('UPDATE pages SET title = ? WHERE id = ?');
    const updTab = stmt('UPDATE tabs SET last_used_at = ?, title = ? WHERE id = ?');
    const samples = [];
    for (let i = 0; i < n; i += 1) {
      const t0 = ms();
      conn.exec('BEGIN');
      const key = `https://flush.example/${maxPage}/${i}`;
      const newId = Number(insPage.run(key, key, 'flush.example', 'example', `flush page ${i} postgres index`, now + i, now + i, now + i).lastInsertRowid);
      insVisit.run(newId, tabIds[0] ?? null, now + i);
      insVisit.run(1 + ((i * 7919) % maxPage), null, now + i);
      insVisit.run(1 + ((i * 104729) % maxPage), null, now + i);
      updPage.run(now + i, now + i, 1 + ((i * 31) % maxPage));
      updPage.run(now + i, now + i, 1 + ((i * 37) % maxPage));
      updTitle.run(`flush page ${i} retitled react hooks`, newId);
      for (const id of tabIds.slice(0, 6)) updTab.run(now + i, `tab ${i}`, id);
      conn.exec('COMMIT');
      samples.push(ms() - t0);
    }
    return { n, samples };
  },

  /** Deliberately long operations for the terminate() tests. */
  long({ id, kind, k = 1000, rows = 4_000_000 }) {
    parentPort.postMessage({ event: 'started', id });
    if (kind === 'read') {
      // O(k * pages) substring scan: pure native work inside a single sqlite3_step loop.
      return stmt("SELECT count(*) AS n FROM pages a JOIN pages b ON b.title LIKE '%' || substr(a.title, 1, 3) || '%' WHERE a.id <= :k").get({ k });
    }
    if (kind === 'write') {
      // One huge write transaction in a single native statement.
      conn.exec('CREATE TABLE IF NOT EXISTS scratch (v INTEGER)');
      conn.exec('BEGIN');
      conn.exec(`WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < ${rows}) INSERT INTO scratch(v) SELECT x FROM c`);
      conn.exec('COMMIT');
      return { inserted: rows };
    }
    if (kind === 'write-js') {
      // A write transaction driven from JavaScript: many small statements, so V8 can interrupt between them.
      conn.exec('CREATE TABLE IF NOT EXISTS scratch (v INTEGER)');
      const ins = stmt('INSERT INTO scratch(v) VALUES (?)');
      conn.exec('BEGIN');
      for (let i = 0; i < rows; i += 1) ins.run(i);
      conn.exec('COMMIT');
      return { inserted: rows };
    }
    throw new Error(`unknown long kind ${kind}`);
  },

  /** Busy loop of short statements (JS regains control between calls, so V8 can interrupt it). */
  spin({ id, kind, ms: durationMs = 5000 }) {
    parentPort.postMessage({ event: 'started', id });
    const end = performance.now() + durationMs;
    let n = 0;
    if (kind === 'iterate') {
      const it = stmt('SELECT id, title, url FROM pages');
      while (performance.now() < end) {
        for (const row of it.iterate()) { n += row.id & 1; if (performance.now() >= end) break; }
      }
    } else {
      const s = stmt(Q.SEARCH_SQL);
      while (performance.now() < end) n += s.all({ q: Q.buildMatch('react hooks') }).length;
    }
    return { n };
  },

  /** Integrity: quick_check, FTS5 integrity-check (throws on mismatch) and basic row counts. */
  integrity({ fts = true } = {}) {
    const quick = conn.prepare('PRAGMA quick_check').all().map((r) => Object.values(r)[0]);
    let ftsOk = null;
    if (fts) {
      try {
        conn.exec("INSERT INTO pages_fts(pages_fts, rank) VALUES ('integrity-check', 1)");
        ftsOk = true;
      } catch (e) {
        ftsOk = `FAILED: ${e.message}`;
      }
    }
    const count = (t) => conn.prepare(`SELECT count(*) AS n FROM ${t}`).get().n;
    return { quick, ftsOk, pages: count('pages'), visits: count('visits'), tabs: count('tabs'), ftsDocsize: count('pages_fts_docsize') };
  },

  /** Drops the three FTS sync triggers (bulk-load experiment). */
  dropFtsTriggers() {
    for (const t of ['pages_fts_ai', 'pages_fts_ad', 'pages_fts_au']) conn.exec(`DROP TRIGGER ${t}`);
    return true;
  },

  /** Rebuilds the external-content FTS index from `pages`; returns elapsed ms. */
  ftsRebuild() {
    const t0 = ms();
    conn.exec("INSERT INTO pages_fts(pages_fts) VALUES ('rebuild')");
    return { ms: ms() - t0 };
  },

  /** Raw single-statement helper for probes. */
  get: ({ sql, params = {} }) => conn.prepare(sql).get(params),
  all: ({ sql, params = {} }) => conn.prepare(sql).all(params),
  exec: ({ sql }) => {
    conn.exec(sql);
    return true;
  },

  close() {
    stmtCache.clear();
    conn?.close();
    conn = null;
    return true;
  },
};

function buildArgs(q) {
  return { q: Q.buildMatch(q) };
}

parentPort.on('message', ({ id, op, args }) => {
  try {
    const result = ops[op]({ id, ...(args ?? {}) });
    parentPort.postMessage({ id, ok: true, result });
    if (op === 'close') setImmediate(() => process.exit(0));
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: { message: error.message, code: error.code } });
  }
});
parentPort.postMessage({ event: 'ready', driver: driverName, node: process.versions.node, electron: process.versions.electron ?? null });
