'use strict';
// S5.3 — node:sqlite in Electron's main process (and in a worker): availability, FTS5, math functions, API gaps.
// The latency benchmark itself is s5b-bench.js with S5_DRIVER=node:sqlite (it runs in the same worker file).
// Run (from /spikes):  timeout 300 ./node_modules/.bin/electron s5-data-stack/s5c-node-sqlite-probe.js

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../shared/harness');
const { DbClient } = require('./lib/db-client');
const { mulberry32 } = require('./lib/datagen');
const { summarize, round } = require('./lib/stats');

h.prepareApp(__dirname);
h.failSafe(240_000, 's5c');

const rmDb = (file) => ['', '-wal', '-shm'].forEach((s) => fs.rmSync(file + s, { force: true }));

app.whenReady().then(async () => {
  const rows = [];
  const results = { rows };
  const warnings = [];
  process.on('warning', (w) => warnings.push(`${w.name}: ${w.message}`));

  // ---- 1. availability in main, no flags --------------------------------------------------------------------------
  let sqlite = null;
  let loadError = null;
  try {
    sqlite = require('node:sqlite');
  } catch (e) {
    loadError = e.message;
  }
  h.record(rows, "require('node:sqlite') in Electron main without flags", { ok: Boolean(sqlite), error: loadError, exports: sqlite && Object.keys(sqlite), electronNode: process.versions.node, bundledSqliteVersionString: process.versions.sqlite ?? null, execArgv: process.execArgv }, Boolean(sqlite));
  if (!sqlite) {
    h.writeResults(__dirname, 's5c-node-sqlite-probe', results);
    app.exit(1);
    return;
  }

  // ---- 2. feature probes on a :memory: DB in main ----------------------------------------------------------------
  const db = new sqlite.DatabaseSync(':memory:');
  const one = (sql) => db.prepare(sql).get();
  const version = one('SELECT sqlite_version() AS v').v;
  const compile = db.prepare('SELECT compile_options AS o FROM pragma_compile_options').all().map((r) => r.o);
  const pick = (re) => compile.filter((o) => re.test(o));
  results.sqlite = { version, compileOptionCount: compile.length, interesting: pick(/FTS|MATH|DBSTAT|THREADSAFE|DEFAULT_CACHE|FOREIGN|DQS|STAT4|SESSION|COMPILER/) };

  let fts = {};
  try {
    db.exec(`CREATE VIRTUAL TABLE t USING fts5(title, url, site, tokenize='unicode61 remove_diacritics 2', prefix='2 3');
             INSERT INTO t(title,url,site) VALUES ('PostgreSQL index performance','https://postgresql.org/docs','postgresql.org'), ('React hooks','https://react.dev/hooks','react.dev');
             INSERT INTO t(t, rank) VALUES ('secure-delete', 1);`);
    fts = db.prepare(`SELECT bm25(t, 10.0, 3.0, 5.0) AS r, highlight(t, 0, char(1), char(2)) AS h FROM t WHERE t MATCH '"postgre"* "index"*' ORDER BY r`).all();
    fts = { hit: fts.length === 1, rank: fts[0]?.r, highlight: fts[0]?.h, secureDeleteConfigAccepted: true };
  } catch (e) {
    fts = { error: e.message };
  }
  h.record(rows, 'FTS5 in node:sqlite (unicode61, prefix index, bm25, highlight, secure-delete option)', fts, fts.hit === true);

  let math = {};
  try {
    math = one('SELECT exp(1) AS e, pow(2, 3) AS p, ln(2) AS l, log2(8) AS l2, power(2, 0.5) AS sq');
  } catch (e) {
    math = { error: e.message };
  }
  h.record(rows, 'math functions exp/pow/ln/log2 in node:sqlite', math, math.p === 8);

  const misc = {};
  for (const [k, sql] of Object.entries({
    strict: 'CREATE TABLE s(a INTEGER) STRICT',
    jsonValid: "SELECT json_valid('{\"a\":1}') AS v",
    dbstat: 'SELECT count(*) AS n FROM dbstat',
    withoutRowid: 'CREATE TABLE w(a PRIMARY KEY) WITHOUT ROWID',
  })) {
    try {
      if (/^SELECT/.test(sql)) misc[k] = db.prepare(sql).get();
      else {
        db.exec(sql);
        misc[k] = 'ok';
      }
    } catch (e) {
      misc[k] = `ERR ${e.message}`;
    }
  }
  misc.foreignKeysDefault = one('PRAGMA foreign_keys');
  misc.cacheSizeDefault = one('PRAGMA cache_size');
  misc.journalModeMemory = one('PRAGMA journal_mode');
  h.record(rows, 'other schema features used by §5.3 (STRICT, json_valid, WITHOUT ROWID, dbstat) + defaults', misc, !String(misc.strict).startsWith('ERR'));

  const proto = Object.getOwnPropertyNames(sqlite.DatabaseSync.prototype).filter((n) => n !== 'constructor');
  const stmtProto = Object.getOwnPropertyNames(sqlite.StatementSync.prototype).filter((n) => n !== 'constructor');
  results.api = {
    databaseSync: proto,
    statementSync: stmtProto,
    hasInterrupt: proto.includes('interrupt'),
    hasPragmaHelper: proto.includes('pragma'),
    hasTransactionHelper: proto.includes('transaction'),
    hasBackup: typeof sqlite.backup === 'function',
  };
  h.record(rows, 'API differences that matter for a drop-in fallback', results.api, null, 'no pragma()/transaction() helpers; no interrupt(); backup is a top-level function');
  db.close();

  // ---- 3. experimental warning behaviour ------------------------------------------------------------------------
  await h.sleep(200);
  h.record(rows, 'process warnings seen after loading node:sqlite in main', warnings, null, 'ExperimentalWarning means "release candidate" stability, not stable');
  results.warningsMain = warnings;

  // ---- 4. in a worker: same worker file as better-sqlite3, ADR-0004 pragmas + §5.3 schema ----------------------------
  const file = path.join(__dirname, 's5c-nodesqlite.db');
  rmDb(file);
  const c = new DbClient({ driver: 'node:sqlite' });
  await c.ready;
  const open = await c.call('open', { file });
  h.record(rows, 'node:sqlite worker: ADR-0004 pragmas + §5.3 schema applied', { sqlite: open.sqliteVersion, pragmas: open.pragmas }, open.pragmas.journal_mode === 'wal' && open.pragmas.auto_vacuum === 2 && open.pragmas.secure_delete === 1);
  const load = await c.call('load', { pages: 10_000, seed: 20261016 });
  const s = await c.timed('search', { q: 'postgres index' });
  const integ = await c.call('integrity');
  h.record(rows, 'node:sqlite worker: load 10k pages, §5.4 query over postMessage, integrity', { insertMs: round(load.insertMs), rows: s.result.rows.length, rttMs: round(s.rttMs), integrity: [integ.quick[0], integ.ftsOk] }, s.result.rows.length > 0 && integ.quick[0] === 'ok');
  results.nodeSqliteWorker = { open, load };

  // ---- 5. terminate() robustness for the fallback driver ---------------------------------------------------------
  const rng = mulberry32(55);
  await c.call('exec', { sql: 'CREATE TABLE IF NOT EXISTS scratch (v INTEGER)' });
  // calibrate a ~0.8 s read
  let k = 100;
  let ms = 0;
  for (let i = 0; i < 4; i += 1) {
    ms = (await c.timed('long', { kind: 'read', k })).rttMs;
    if (ms > 600 && ms < 1200) break;
    k = Math.max(20, Math.round(k * (800 / Math.max(ms, 20))));
  }
  await c.close();
  const runs = [];
  for (let i = 0; i < 30; i += 1) {
    const w = new DbClient({ driver: 'node:sqlite' });
    await w.ready;
    await w.call('open', { file });
    let started;
    const startedP = new Promise((r) => { started = r; });
    const opP = w.call('long', { kind: 'read', k }, { onEvent: (e) => e.event === 'started' && started() }).catch(() => {});
    await startedP;
    await h.sleep(30 + Math.floor(rng() * 300));
    const t = performance.now();
    const code = await w.terminate();
    runs.push({ code, ms: performance.now() - t });
    await opP;
  }
  const term = { k, queryMs: round(ms), iterations: runs.length, exitCodes: [...new Set(runs.map((r) => r.code))], terminateToExitMs: summarize(runs.map((r) => r.ms)) };
  const v = new DbClient({ driver: 'node:sqlite' });
  await v.ready;
  await v.call('open', { file });
  term.integrityAfter = (await v.call('integrity')).quick[0];
  await v.close();
  h.record(rows, '30x worker.terminate() mid long read with node:sqlite: process survived', term, runs.length === 30 && term.integrityAfter === 'ok');
  results.nodeSqliteTerminate = term;

  results.warningsAll = warnings;
  h.writeResults(__dirname, 's5c-node-sqlite-probe', results);
  app.exit(rows.every((r) => r.pass !== false) ? 0 : 1);
}).catch((e) => {
  console.error('s5c failed:', e);
  app.exit(2);
});
