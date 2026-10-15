'use strict';
// S5.1 — worker_threads data worker inside Electron's main process, plus the terminate()-mid-query robustness test.
// Run (from /spikes):  timeout 300 ./node_modules/.bin/electron s5-data-stack/s5a-worker-terminate.js
//
//   1. start a Worker from Electron main; open a file DB with the ADR-0004 pragmas; apply the §5.3 schema; query it
//   2. is the loop-lag of main affected by a long query: in the worker vs the same query directly on main (control)
//   3. terminate() the worker mid-query, 50x with a fresh worker each time (long READ), then long WRITE variants;
//      watch for process aborts, time-to-exit, and DB integrity afterwards (quick_check + FTS5 integrity-check)

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../shared/harness');
const { DbClient } = require('./lib/db-client');
const { mulberry32 } = require('./lib/datagen');
const { summarize, lagMonitor, round } = require('./lib/stats');

h.prepareApp(__dirname);
h.failSafe(290_000, 's5a');

const DB = path.join(__dirname, 's5a-terminate.db');
const PROGRESS = path.join(__dirname, 's5a-progress.log');
const log = (line) => fs.appendFileSync(PROGRESS, `${new Date().toISOString()} ${line}\n`);
const rmDb = (file) => ['', '-wal', '-shm'].forEach((s) => fs.rmSync(file + s, { force: true }));

async function freshWorker(opts) {
  const c = new DbClient(opts);
  await c.ready;
  return c;
}

/** Starts `op`, waits for the worker's 'started' event, waits `delayMs`, terminates. Returns timings. */
async function terminateMidOp(op, args, delayMs) {
  const c = await freshWorker();
  await c.call('open', { file: DB });
  let started;
  const startedP = new Promise((r) => { started = r; });
  let outcome = 'pending';
  const t0 = performance.now();
  const opP = c.call(op, args, { onEvent: (e) => e.event === 'started' && started(performance.now()) }).then(() => { outcome = 'completed'; }, () => { outcome = 'rejected'; });
  const tStarted = await startedP;
  await new Promise((r) => setTimeout(r, delayMs));
  const tTerm = performance.now();
  const termResult = await c.terminate(); // resolves with the exit code once the thread is really gone
  const tExit = performance.now();
  await opP;
  return {
    outcome, exitCode: termResult, terminateToExitMs: tExit - tTerm, startToExitMs: tExit - tStarted, setupMs: tStarted - t0,
  };
}

app.whenReady().then(async () => {
  const rows = [];
  const results = { rows };
  rmDb(DB);
  fs.rmSync(PROGRESS, { force: true });

  // ---- 1. the worker works in Electron main --------------------------------------------------------------------
  const c = await freshWorker();
  const readyMsg = await c.ready;
  const open = await c.call('open', { file: DB });
  h.record(rows, 'Worker starts inside Electron main and sees Electron\'s Node', { electron: readyMsg.electron, node: readyMsg.node, isMainThreadElectron: Boolean(process.versions.electron) }, Boolean(readyMsg.electron));
  h.record(rows, 'ADR-0004 pragmas applied on a brand-new file DB', open.pragmas,
    open.pragmas.journal_mode === 'wal' && open.pragmas.synchronous === 1 && open.pragmas.foreign_keys === 1 && open.pragmas.secure_delete === 1
    && open.pragmas.auto_vacuum === 2 && open.pragmas.busy_timeout === 5000 && open.pragmas.temp_store === 2 && open.pragmas.user_version === 1);
  h.record(rows, 'schema.sql (§5.3) applied in one BEGIN IMMEDIATE transaction', { migrationMs: round(open.migrationMs), sqlite: open.sqliteVersion, compile: open.compile }, open.migrationMs > 0);
  const load = await c.call('load', { pages: 10_000, seed: 20261016 });
  const search = await c.timed('search', { q: 'postgres index' });
  h.record(rows, 'load 10k pages then query over postMessage', { insertMs: round(load.insertMs), rows: search.result.rows.length, innerMs: round(search.result.innerMs), rttMs: round(search.rttMs) }, search.result.rows.length > 0);
  results.setup = { open, load };
  await c.call('exec', { sql: 'CREATE TABLE IF NOT EXISTS scratch (v INTEGER)' });

  // auto_vacuum ordering experiment (is INCREMENTAL kept when journal_mode=WAL is set first?)
  const orderCheck = {};
  for (const [label, walFirst] of [['autovacuum-first', false], ['wal-first', true]]) {
    const file = path.join(__dirname, `s5a-order-${label}.db`);
    rmDb(file);
    const w = await freshWorker();
    const o = await w.call('open', { file, walBeforeAutoVacuum: walFirst });
    orderCheck[label] = o.pragmas.auto_vacuum;
    await w.close();
    rmDb(file);
  }
  h.record(rows, 'auto_vacuum=INCREMENTAL(2) sticks only if set before tables exist; ordering vs journal_mode', orderCheck, orderCheck['autovacuum-first'] === 2, 'wal-first result is informational');

  // ---- 2. calibrate a long read (~1.2 s) -----------------------------------------------------------------------
  let k = 100;
  let readMs = 0;
  for (let i = 0; i < 4; i += 1) {
    const t = await c.timed('long', { kind: 'read', k });
    readMs = t.rttMs;
    if (readMs > 900 && readMs < 1600) break;
    k = Math.max(20, Math.round(k * (1200 / Math.max(readMs, 20))));
  }
  h.record(rows, 'calibrated long read query', { k, ms: round(readMs) }, null);
  results.longReadCalibration = { k, ms: readMs };

  // ---- 3. main-thread responsiveness: worker vs control on main -------------------------------------------------
  const lag = {};
  let m = lagMonitor();
  await h.sleep(600);
  lag.idleBaseline = m.stop();
  m = lagMonitor();
  const tW = performance.now();
  await c.call('long', { kind: 'read', k });
  lag.longQueryInWorker = { ...m.stop(), queryMs: round(performance.now() - tW) };
  // Control: same SQL on the main thread (what ADR-0004 forbids), blocking the event loop.
  const Database = require('better-sqlite3');
  const direct = new Database(DB, { readonly: true });
  m = lagMonitor();
  await h.sleep(30); // let the timer establish a baseline tick
  const tM = performance.now();
  direct.prepare("SELECT count(*) AS n FROM pages a JOIN pages b ON b.title LIKE '%' || substr(a.title, 1, 3) || '%' WHERE a.id <= ?").get(k);
  const blockedMs = performance.now() - tM;
  await h.sleep(30);
  lag.longQueryOnMainControl = { ...m.stop(), queryMs: round(blockedMs) };
  direct.close();
  h.record(rows, 'main-thread event-loop lag while a ~1 s query runs: in worker vs directly on main', lag,
    lag.longQueryInWorker.max < 50 && lag.longQueryOnMainControl.max > 500);
  results.mainThreadLag = lag;
  await c.close();

  // ---- 4. terminate() probe: does it preempt a native call? ------------------------------------------------------
  const probe = await terminateMidOp('long', { kind: 'read', k }, 150);
  h.record(rows, 'single probe: terminate() 150 ms into a long read', probe, null, 'startToExit ~ query length => terminate cannot preempt native SQLite');
  results.terminateProbe = probe;

  // ---- 5. 50x terminate mid long READ, fresh worker each time ----------------------------------------------------
  const rng = mulberry32(5);
  const readRuns = [];
  for (let i = 0; i < 50; i += 1) {
    const delay = 30 + Math.floor(rng() * 400);
    log(`read #${i} delay=${delay}ms begin`);
    const r = await terminateMidOp('long', { kind: 'read', k }, delay);
    r.delay = delay;
    readRuns.push(r);
    log(`read #${i} done ${JSON.stringify(r)}`);
  }
  const readSummary = {
    iterations: readRuns.length,
    outcomes: Object.fromEntries([...new Set(readRuns.map((r) => r.outcome))].map((o) => [o, readRuns.filter((r) => r.outcome === o).length])),
    exitCodes: Object.fromEntries([...new Set(readRuns.map((r) => r.exitCode))].map((o) => [o, readRuns.filter((r) => r.exitCode === o).length])),
    terminateToExitMs: summarize(readRuns.map((r) => r.terminateToExitMs)),
    startToExitMs: summarize(readRuns.map((r) => r.startToExitMs)),
    delayMs: { min: Math.min(...readRuns.map((r) => r.delay)), max: Math.max(...readRuns.map((r) => r.delay)) },
  };
  h.record(rows, '50x worker.terminate() mid long READ (fresh worker each): process survived', readSummary, readRuns.length === 50);
  results.terminateRead = readSummary;

  // ---- 6. terminate mid long WRITE (native single statement, and JS-driven loop) ---------------------------------
  const writeSummary = {};
  for (const [label, kind, args, iterations] of [['nativeWrite', 'write', { rows: 3_000_000 }, 15], ['jsLoopWrite', 'write-js', { rows: 400_000 }, 15]]) {
    const runs = [];
    for (let i = 0; i < iterations; i += 1) {
      const delay = 40 + Math.floor(rng() * 350);
      log(`${label} #${i} delay=${delay}ms begin`);
      const r = await terminateMidOp('long', { kind, ...args }, delay);
      // reopen and look at what survived
      const v = await freshWorker();
      await v.call('open', { file: DB });
      const scratch = await v.call('get', { sql: 'SELECT count(*) AS n FROM scratch' });
      await v.close();
      runs.push({ ...r, delay, scratchRows: scratch.n });
      log(`${label} #${i} done ${JSON.stringify(runs[runs.length - 1])}`);
    }
    writeSummary[label] = {
      iterations,
      outcomes: Object.fromEntries([...new Set(runs.map((r) => r.outcome))].map((o) => [o, runs.filter((r) => r.outcome === o).length])),
      exitCodes: Object.fromEntries([...new Set(runs.map((r) => r.exitCode))].map((o) => [o, runs.filter((r) => r.exitCode === o).length])),
      startToExitMs: summarize(runs.map((r) => r.startToExitMs)),
      terminateToExitMs: summarize(runs.map((r) => r.terminateToExitMs)),
      scratchRowCountsSeen: [...new Set(runs.map((r) => r.scratchRows))],
    };
  }
  h.record(rows, 'worker.terminate() mid long WRITE transaction: process survived, uncommitted data rolled back', writeSummary,
    Object.values(writeSummary).every((s) => s.scratchRowCountsSeen.every((n) => n === 0 || n >= 400_000)));
  results.terminateWrite = writeSummary;

  // ---- 6b. terminate while JS regains control between statements, with an open iterator, and while idle ----------
  const otherSummary = {};
  for (const [label, run] of [
    ['spinAll', () => terminateMidOp('spin', { kind: 'all' }, 20 + Math.floor(rng() * 200))],
    ['spinIterate', () => terminateMidOp('spin', { kind: 'iterate' }, 20 + Math.floor(rng() * 200))],
    ['idleWithOpenDb', async () => {
      const w = await freshWorker();
      await w.call('open', { file: DB });
      await w.call('search', { q: 'docker' }); // leaves a prepared statement cached
      const t = performance.now();
      const code = await w.terminate();
      return { outcome: 'idle', exitCode: code, terminateToExitMs: performance.now() - t, startToExitMs: 0 };
    }],
  ]) {
    const runs = [];
    for (let i = 0; i < 50; i += 1) {
      log(`${label} #${i} begin`);
      runs.push(await run());
    }
    otherSummary[label] = {
      iterations: runs.length,
      outcomes: Object.fromEntries([...new Set(runs.map((r) => r.outcome))].map((o) => [o, runs.filter((r) => r.outcome === o).length])),
      exitCodes: Object.fromEntries([...new Set(runs.map((r) => r.exitCode))].map((o) => [o, runs.filter((r) => r.exitCode === o).length])),
      terminateToExitMs: summarize(runs.map((r) => r.terminateToExitMs)),
    };
  }
  h.record(rows, '50x terminate() each: busy loop of short queries, open iterate() cursor, idle worker with open DB', otherSummary,
    Object.values(otherSummary).every((s) => s.iterations === 50));
  results.terminateOther = otherSummary;

  // ---- 7. database still healthy after ~80 terminations ----------------------------------------------------------
  const v = await freshWorker();
  await v.call('open', { file: DB });
  const integrity = await v.call('integrity');
  const search2 = await v.call('search', { q: 'react hooks' });
  await v.close();
  h.record(rows, 'DB integrity after all terminations (quick_check + FTS5 integrity-check)', { ...integrity, searchRows: search2.rows.length },
    integrity.quick[0] === 'ok' && integrity.ftsOk === true && integrity.pages === 10_000);
  results.integrityAfter = integrity;

  results.processSurvived = true;
  results.betterSqlite3 = require('better-sqlite3/package.json').version;
  h.writeResults(__dirname, 's5a-worker-terminate', results);
  app.exit(rows.every((r) => r.pass !== false) ? 0 : 1);
}).catch((e) => {
  console.error('s5a failed:', e);
  app.exit(2);
});
