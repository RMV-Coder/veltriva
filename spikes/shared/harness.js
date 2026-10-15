'use strict';
// Small helpers shared by the Electron spikes. Main-process only.

const { app, BaseWindow, WebContentsView } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Hardened tab preferences, mirroring assessment §6.2 (in-memory partition for spikes). */
const TAB_PREFS = Object.freeze({
  partition: 'spike-browsing',
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  navigateOnDragDrop: false,
  safeDialogs: true,
  backgroundThrottling: true,
});

/**
 * Call before `app` is ready. Maps *.test hostnames to loopback so a.test and b.test are
 * different sites served by the same fixture server, and keeps Electron's profile inside
 * the spike folder instead of %APPDATA%.
 */
function prepareApp(spikeDir) {
  app.commandLine.appendSwitch('host-resolver-rules', 'MAP *.test 127.0.0.1');
  app.setPath('userData', path.join(spikeDir, 'user-data'));
}

/** Exits with code 3 if the spike hangs. */
function failSafe(ms, label) {
  const timer = setTimeout(() => {
    console.error(`[${label}] fail-safe timeout after ${ms} ms`);
    app.exit(3);
  }, ms);
  timer.unref?.();
  return timer;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves with the event's arguments, or rejects after `timeoutMs`. */
function waitFor(emitter, event, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const handler = (...args) => {
      clearTimeout(timer);
      resolve(args);
    };
    const timer = setTimeout(() => {
      emitter.removeListener(event, handler);
      reject(new Error(`timeout waiting for "${event}"`));
    }, timeoutMs);
    emitter.once(event, handler);
  });
}

/** Polls `fn` until it returns a truthy value or the timeout elapses; returns the last value. */
async function pollUntil(fn, { timeoutMs = 10000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await fn();
    if (value) return value;
    await sleep(intervalMs);
  }
  return value;
}

function createWindow({ width = 1200, height = 800, show = true, title = 'Veltriva spike' } = {}) {
  return new BaseWindow({ width, height, show, title });
}

function contentBounds(win) {
  const [width, height] = win.getContentSize();
  return { x: 0, y: 0, width, height };
}

/** Creates a tab view with hardened preferences. Does not load anything unless `url` is given. */
function createTabView(win, { url, attach = true, prefs = {}, bounds } = {}) {
  const view = new WebContentsView({ webPreferences: { ...TAB_PREFS, ...prefs } });
  view.setBounds(bounds ?? contentBounds(win));
  if (attach) win.contentView.addChildView(view);
  if (url) view.webContents.loadURL(url).catch(() => {});
  return view;
}

/** The explicit destruction rule from ADR-0002: detach, close, drop references. */
function destroyView(win, view) {
  win.contentView.removeChildView(view);
  if (!view.webContents.isDestroyed()) view.webContents.close();
}

/** Snapshot of app.getAppMetrics(). Memory values are KB. Note: CPU % is "since the previous call by any caller". */
function appMetricsSummary() {
  const metrics = app.getAppMetrics();
  const byType = {};
  let totalPrivateKB = 0;
  let totalWorkingSetKB = 0;
  for (const m of metrics) {
    const bucket = (byType[m.type] ??= { count: 0, privateKB: 0, workingSetKB: 0 });
    bucket.count += 1;
    bucket.privateKB += m.memory.privateBytes ?? 0;
    bucket.workingSetKB += m.memory.workingSetSize;
    totalPrivateKB += m.memory.privateBytes ?? 0;
    totalWorkingSetKB += m.memory.workingSetSize;
  }
  return {
    processCount: metrics.length,
    totalPrivateKB,
    totalWorkingSetKB,
    byType,
    processes: metrics.map((m) => ({
      pid: m.pid,
      type: m.type,
      name: m.name,
      serviceName: m.serviceName,
      privateKB: m.memory.privateBytes,
      workingSetKB: m.memory.workingSetSize,
      cpuPercent: m.cpu.percentCPUUsage,
    })),
  };
}

/** Records one observation and prints a PASS/FAIL/INFO line. `pass` may be null for informational rows. */
function record(list, name, observed, pass, note) {
  const row = { name, observed, pass, ...(note ? { note } : {}) };
  list.push(row);
  const tag = pass === null ? 'INFO' : pass ? 'PASS' : 'FAIL';
  console.log(`${tag}  ${name}  ${JSON.stringify(observed)}${note ? `  (${note})` : ''}`);
  return pass;
}

/** Writes spikes/<spike>/results/<name>.json with environment metadata. */
function writeResults(spikeDir, name, data) {
  const dir = path.join(spikeDir, 'results');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  const payload = {
    generatedAt: new Date().toISOString(),
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node: process.versions.node,
    os: `${process.platform} ${os.release()}`,
    cpu: os.cpus()[0]?.model,
    totalMemGB: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
    ...data,
  };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`results written: ${file}`);
  return file;
}

module.exports = {
  TAB_PREFS,
  prepareApp,
  failSafe,
  sleep,
  waitFor,
  pollUntil,
  createWindow,
  contentBounds,
  createTabView,
  destroyView,
  appMetricsSummary,
  record,
  writeResults,
};
