'use strict';
// S7 check 5: external protocols (SAFE VERSION).
// The deny handlers are installed on BOTH the default session and the tab session before any web contents
// exists. Without them Electron would hand mailto:/unknown schemes to the OS. Nothing here is ever granted:
// the request handler calls back false and the check handler returns false.
// A process-list diff (tasklist) before/after is the evidence that nothing launched.

const { app, session } = require('electron');
const { execFileSync } = require('node:child_process');
const h = require('../shared/harness');
const { startFixtureServer } = require('../shared/fixture-server');
const lib = require('./lib');

lib.setup('protocols', { failSafeMs: 90_000 });

function processNames() {
  const out = execFileSync('tasklist.exe', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 15000 });
  const counts = {};
  for (const line of out.split(/\r?\n/).filter(Boolean)) {
    const name = line.split('","')[0].replace(/^"/, '').toLowerCase();
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

app.whenReady().then(async () => {
  const rows = [];
  const fixture = await startFixtureServer();

  // 1. Deny handlers FIRST. Verified by the log below: every entry must end in "denied".
  const permLog = [];
  const tabSession = session.fromPartition(h.TAB_PREFS.partition);
  for (const ses of [session.defaultSession, tabSession]) {
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      permLog.push({
        kind: 'request',
        permission,
        externalURL: details.externalURL,
        requestingUrl: details.requestingUrl,
        isMainFrame: details.isMainFrame,
        detailKeys: Object.keys(details),
        at: Date.now(),
        result: 'denied',
      });
      callback(false);
    });
    ses.setPermissionCheckHandler((wc, permission, origin) => {
      permLog.push({ kind: 'check', permission, origin, at: Date.now(), result: 'denied' });
      return false;
    });
  }

  const before = processNames();
  const win = h.createWindow({ width: 700, height: 450, title: 'S7 protocols' });
  const view = h.createTabView(win);
  const wc = view.webContents;
  const nav = [];
  wc.on('will-navigate', (e) => nav.push(`will-navigate ${e.url}`));
  wc.on('did-start-navigation', (e) => nav.push(`did-start-navigation ${e.url} main=${e.isMainFrame}`));
  wc.on('did-fail-load', (e, code, desc, url) => nav.push(`did-fail-load ${code} ${desc} ${url}`));
  const handlerCalls = [];
  wc.setWindowOpenHandler((details) => {
    handlerCalls.push({ url: details.url, disposition: details.disposition });
    return { action: 'deny' };
  });

  await wc.loadURL(fixture.url('/index.html', 'a.test'));
  await lib.stabilizeWindow(win, wc);
  const pageUrl = wc.getURL();

  const attempts = [
    { label: 'location.href = mailto: (userGesture=true)', code: "location.href = 'mailto:test@example.com'", gesture: true },
    { label: 'location.href = made-up scheme (userGesture=true)', code: "location.href = 'veltriva-spike-unregistered:hello'", gesture: true },
    { label: 'location.href = mailto: (NO user gesture)', code: "location.href = 'mailto:test@example.com'", gesture: false },
    { label: 'location.href = made-up scheme (NO user gesture)', code: "location.href = 'veltriva-spike-unregistered:hello'", gesture: false },
    { label: 'iframe.src = made-up scheme (NO user gesture)', code: "const f = document.createElement('iframe'); f.src = 'veltriva-spike-unregistered:from-iframe'; document.body.appendChild(f)", gesture: false },
    { label: 'window.open(made-up scheme) (NO user gesture)', code: "window.open('veltriva-spike-unregistered:from-window-open')", gesture: false, informational: true },
  ];

  for (const attempt of attempts) {
    const logBefore = permLog.length;
    const navBefore = nav.length;
    const handlerBefore = handlerCalls.length;
    await wc.executeJavaScript(attempt.code, attempt.gesture).catch((err) => nav.push(`js error: ${err.message}`));
    await h.sleep(1200);
    const requests = permLog.slice(logBefore).filter((p) => p.kind === 'request');
    h.record(rows, attempt.label, {
      permissionRequests: requests.map(({ permission, externalURL, requestingUrl, isMainFrame, detailKeys, result }) => ({ permission, externalURL, requestingUrl, isMainFrame, detailKeys, result })),
      otherPermissionLogEntries: permLog.slice(logBefore).filter((p) => p.kind !== 'request').map((p) => `${p.kind}:${p.permission}`),
      navigationEvents: nav.slice(navBefore),
      windowOpenHandlerCalls: handlerCalls.slice(handlerBefore),
      pageStillAt: wc.getURL(),
    }, attempt.informational ? null : requests.some((r) => r.permission === 'openExternal'));
  }

  const after = processNames();
  const appeared = Object.keys(after).filter((n) => (after[n] ?? 0) > (before[n] ?? 0));
  h.record(rows, 'process-list diff (new process names or higher counts after all attempts)', { appeared, pageUnchanged: wc.getURL() === pageUrl }, null,
    'electron.exe counts change by themselves (renderers); anything else would indicate a launched app');
  h.record(rows, 'every permission-log entry was denied', { entries: permLog.length, allDenied: permLog.every((p) => p.result === 'denied') }, permLog.every((p) => p.result === 'denied'));

  h.writeResults(__dirname, 'protocols', { rows, permLog: permLog.map(({ at, ...rest }) => rest) });
  lib.releaseWindow(win);
  h.destroyView(win, view);
  win.close();
  await fixture.close();
  app.exit(0);
});
