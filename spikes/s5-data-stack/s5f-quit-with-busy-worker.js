'use strict';
// S5.1 follow-up — what happens at shutdown if the data worker is busy inside a long SQLite statement?
// Parent mode (default) builds a 10k-page DB, then launches this same script as a child Electron process once per
// exit style and measures how long the child process lives after it asked to quit.
// Child mode (S5F_CHILD=<mode>): starts a long query in the worker, waits 300 ms, then quits in the given style.
// Run (from /spikes):  timeout 300 ./node_modules/.bin/electron s5-data-stack/s5f-quit-with-busy-worker.js

const { app } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../shared/harness');
const { DbClient } = require('./lib/db-client');
const { summarize } = require('./lib/stats');

const CHILD = process.env.S5F_CHILD;
const DB = path.join(__dirname, 's5f-quit.db');
const STAMP = path.join(__dirname, 's5f-quit-stamp.txt');
const K = Number(process.env.S5F_K ?? 700);

if (CHILD) h.prepareApp(path.join(__dirname, 's5f-child')); // separate profile dir so parent and child never share one
else h.prepareApp(__dirname);
h.failSafe(CHILD ? 60_000 : 280_000, 's5f');

async function child() {
  const c = new DbClient();
  await c.ready;
  await c.call('open', { file: DB });
  let started;
  const startedP = new Promise((r) => { started = r; });
  const args = CHILD === 'kill-self-mid-write' ? { kind: 'write', rows: 3_000_000 } : { kind: 'read', k: K };
  c.call('long', args, { onEvent: (e) => e.event === 'started' && started() }).catch(() => {});
  await startedP;
  await h.sleep(300);
  fs.writeFileSync(STAMP, String(Date.now()));
  if (CHILD === 'app.exit') app.exit(0);
  else if (CHILD === 'kill-self-mid-write') process.kill(process.pid); // hard kill while a 3M-row transaction is open
  else if (CHILD === 'app.quit') app.quit();
  else if (CHILD === 'terminate-then-app.quit') { c.terminate(); app.quit(); }
  else if (CHILD === 'terminate-then-app.exit') { c.terminate(); app.exit(0); }
  else if (CHILD === 'process.exit') process.exit(0);
  else if (CHILD === 'kill-self') process.kill(process.pid); // TerminateProcess on Windows
  else if (CHILD === 'app.quit+watchdog500ms') { setTimeout(() => process.kill(process.pid), 500); app.quit(); }
}

function runChild(mode) {
  return new Promise((resolve) => {
    fs.rmSync(STAMP, { force: true });
    const t0 = Date.now();
    const p = spawn(process.execPath, [__filename], { env: { ...process.env, S5F_CHILD: mode }, stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => p.kill(), 50_000);
    p.on('exit', (code) => {
      clearTimeout(timer);
      const t1 = Date.now();
      const quitAt = fs.existsSync(STAMP) ? Number(fs.readFileSync(STAMP, 'utf8')) : null;
      resolve({ mode, exitCode: code, exitAfterQuitCallMs: quitAt ? t1 - quitAt : null, totalMs: t1 - t0 });
    });
  });
}

app.whenReady().then(async () => {
  if (CHILD) return child();

  const rows = [];
  const results = { k: K };
  fs.rmSync(DB, { force: true });
  const c = new DbClient();
  await c.ready;
  await c.call('open', { file: DB });
  await c.call('load', { pages: 10_000, seed: 20261016 });
  const t = await c.timed('long', { kind: 'read', k: K });
  results.longQueryUninterruptedMs = Math.round(t.rttMs);
  await c.close();
  h.record(rows, 'uninterrupted duration of the long query used below', results.longQueryUninterruptedMs, null);

  results.runs = {};
  for (const mode of ['app.quit', 'app.exit', 'process.exit', 'terminate-then-app.quit', 'terminate-then-app.exit', 'kill-self', 'app.quit+watchdog500ms']) {
    const runs = [];
    for (let i = 0; i < 3; i += 1) runs.push(await runChild(mode));
    results.runs[mode] = { exitCodes: [...new Set(runs.map((r) => r.exitCode))], exitAfterQuitCallMs: runs.map((r) => r.exitAfterQuitCallMs), summary: summarize(runs.map((r) => r.exitAfterQuitCallMs ?? NaN)) };
    h.record(rows, `child quits via ${mode} while the worker is mid-query: ms from quit call to process exit (3 runs)`, results.runs[mode].exitAfterQuitCallMs, null);
  }
  // Hard kill (TerminateProcess) in the middle of a large write transaction: does WAL recovery leave a healthy DB?
  const w = new DbClient();
  await w.ready;
  await w.call('open', { file: DB });
  await w.call('exec', { sql: 'CREATE TABLE IF NOT EXISTS scratch (v INTEGER)' });
  await w.close();
  const killRuns = [];
  for (let i = 0; i < 5; i += 1) killRuns.push(await runChild('kill-self-mid-write'));
  const v = new DbClient();
  await v.ready;
  await v.call('open', { file: DB });
  const integrity = await v.call('integrity');
  const scratch = await v.call('get', { sql: 'SELECT count(*) AS n FROM scratch' });
  await v.close();
  results.hardKillMidWrite = { runs: killRuns.length, exitAfterKillMs: killRuns.map((r) => r.exitAfterQuitCallMs), integrity, scratchRows: scratch.n };
  h.record(rows, '5x hard kill (process.kill) during a 3M-row write transaction, then reopen', results.hardKillMidWrite,
    integrity.quick[0] === 'ok' && integrity.ftsOk === true && scratch.n === 0 && integrity.pages === 10_000);

  h.writeResults(__dirname, 's5f-quit-with-busy-worker', results);
  fs.rmSync(DB, { force: true });
  fs.rmSync(STAMP, { force: true });
  for (const s of ['-wal', '-shm']) fs.rmSync(DB + s, { force: true });
  app.exit(rows.every((r) => r.pass !== false) ? 0 : 1);
}).catch((e) => {
  console.error('s5f failed:', e);
  app.exit(2);
});
