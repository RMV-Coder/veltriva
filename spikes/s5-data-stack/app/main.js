'use strict';
// Minimal packaged-app probe. Starts a Worker whose script lives inside the app (so inside app.asar once packaged),
// lets it open better-sqlite3 and run an FTS5 query, writes a JSON report to os.tmpdir(), and exits.
// Env: S5_WORKER_MODE = asar (default: path.join(__dirname, 'worker.js')) | appPath (app.getAppPath()) | unpacked (app.asar.unpacked)
const { app } = require('electron');
const { Worker } = require('node:worker_threads');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const OUT = path.join(os.tmpdir(), 's5-packaged-probe-result.json');
const DB = path.join(os.tmpdir(), 's5-packaged-probe.db');
// Keep Electron's profile out of %APPDATA% for this throwaway probe.
app.setPath('userData', path.join(os.tmpdir(), 's5-packaged-probe-user-data'));

const report = {
  startedAt: new Date().toISOString(),
  isPackaged: app.isPackaged,
  execPath: process.execPath,
  resourcesPath: process.resourcesPath,
  appPath: app.getAppPath(),
  mainDirname: __dirname,
  electron: process.versions.electron,
  node: process.versions.node,
};

function finish(code, extra) {
  Object.assign(report, extra, { finishedAt: new Date().toISOString() });
  // Which better-sqlite3 .node file did the process actually load? (works for main + all worker threads)
  try {
    report.loadedNativeModules = process.report.getReport().sharedObjects.filter((p) => /better_sqlite3|better-sqlite3|\.node$/i.test(p));
  } catch (e) {
    report.loadedNativeModulesError = e.message;
  }
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  app.exit(code);
}

const killTimer = setTimeout(() => finish(3, { error: 'fail-safe timeout (20 s)' }), 20_000);
killTimer.unref?.();

app.whenReady().then(() => {
  const mode = process.env.S5_WORKER_MODE ?? 'asar';
  const workerPath = mode === 'appPath' ? path.join(app.getAppPath(), 'worker.js')
    : mode === 'unpacked' ? path.join(process.resourcesPath, 'app.asar.unpacked', 'worker.js')
      : path.join(__dirname, 'worker.js');
  report.workerMode = mode;
  report.workerPath = workerPath;
  let worker;
  try {
    worker = new Worker(workerPath, { workerData: { dbFile: DB } });
  } catch (e) {
    finish(2, { ok: false, stage: 'new Worker', error: e.stack });
    return;
  }
  worker.once('message', (msg) => {
    report.worker = msg;
    for (const s of ['', '-wal', '-shm']) fs.rmSync(DB + s, { force: true });
    finish(msg.ok ? 0 : 1, { ok: msg.ok });
  });
  worker.once('error', (e) => finish(2, { ok: false, stage: 'worker error event', error: e.stack }));
  worker.once('exit', (code) => { if (code !== 0) report.workerExitCode = code; });
}).catch((e) => finish(2, { ok: false, stage: 'whenReady', error: e.stack }));
