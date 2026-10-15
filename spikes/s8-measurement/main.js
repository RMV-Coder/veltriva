'use strict';
// S8: memory measurement method (one run). Compares Electron's app.getAppMetrics() with Windows'
// own per-process counters for the same PIDs, checks whether getAppMetrics() misses any process in
// our process tree, and measures "all live" vs "discarded" totals.
// Driven 5× by run.js; can also run alone: ./node_modules/.bin/electron s8-measurement/main.js

const { app, session } = require('electron');
const { execFile } = require('node:child_process');
const h = require('../shared/harness');
const { startFixtureServer } = require('../shared/fixture-server');

h.prepareApp(__dirname);
h.failSafe(240_000, 's8');

const TABS = Number(process.env.S8_TABS ?? 20);
const SETTLE_MS = Number(process.env.S8_SETTLE_MS ?? 10_000);
const RUN_ID = process.env.S8_RUN_ID ?? 'single';

/** Windows counters for our whole process tree (Win32_Process), in KB. */
function windowsProcessTree(rootPid) {
  // Excludes this PowerShell process and its children (e.g. conhost): they are measurement artifacts.
  const script = `
    $all = Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.ParentProcessId -ne $PID } |
      Select-Object ProcessId, ParentProcessId, Name, PrivatePageCount, WorkingSetSize
    $tree = @(${rootPid}); $added = $true
    while ($added) { $added = $false; foreach ($p in $all) { if ($tree -contains $p.ParentProcessId -and -not ($tree -contains $p.ProcessId)) { $tree += $p.ProcessId; $added = $true } } }
    $all | Where-Object { $tree -contains $_.ProcessId } | ForEach-Object {
      [pscustomobject]@{ pid = $_.ProcessId; name = $_.Name; privateKB = [math]::Round($_.PrivatePageCount / 1KB); workingSetKB = [math]::Round($_.WorkingSetSize / 1KB) }
    } | ConvertTo-Json -Compress`;
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, maxBuffer: 4 * 2 ** 20 }, (error, stdout) => {
      if (error) return reject(error);
      const parsed = JSON.parse(stdout || '[]');
      resolve(Array.isArray(parsed) ? parsed : [parsed]);
    });
  });
}

async function snapshot(label) {
  const electron = h.appMetricsSummary();
  const windows = await windowsProcessTree(process.pid);
  const electronPids = new Set(electron.processes.map((p) => p.pid));
  const winByPid = new Map(windows.map((p) => [p.pid, p]));
  const matched = electron.processes.filter((p) => winByPid.has(p.pid));
  const sum = (list, key) => list.reduce((acc, p) => acc + (p[key] ?? 0), 0);
  return {
    label,
    electron: {
      processes: electron.processCount,
      privateMB: Math.round(electron.totalPrivateKB / 1024),
      workingSetMB: Math.round(electron.totalWorkingSetKB / 1024),
      byType: Object.fromEntries(Object.entries(electron.byType).map(([t, v]) => [t, { count: v.count, privateMB: Math.round(v.privateKB / 1024) }])),
    },
    windows: {
      processes: windows.length,
      privateMB: Math.round(sum(windows, 'privateKB') / 1024),
      workingSetMB: Math.round(sum(windows, 'workingSetKB') / 1024),
    },
    samePids: {
      count: matched.length,
      electronPrivateMB: Math.round(sum(matched, 'privateKB') / 1024),
      windowsPrivateMB: Math.round(matched.reduce((acc, p) => acc + winByPid.get(p.pid).privateKB, 0) / 1024),
      electronWorkingSetMB: Math.round(sum(matched, 'workingSetKB') / 1024),
      windowsWorkingSetMB: Math.round(matched.reduce((acc, p) => acc + winByPid.get(p.pid).workingSetKB, 0) / 1024),
    },
    missingFromAppMetrics: windows.filter((p) => !electronPids.has(p.pid)).map((p) => ({ pid: p.pid, name: p.name, privateMB: Math.round(p.privateKB / 1024) })),
  };
}

app.whenReady().then(async () => {
  session.fromPartition(h.TAB_PREFS.partition).setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  const fixture = await startFixtureServer();
  const win = h.createWindow({ width: 900, height: 600, title: 'Veltriva S8' });
  win.setAlwaysOnTop(true);
  const result = { runId: RUN_ID, tabs: TABS, settleMs: SETTLE_MS, page: '/page?heapMB=10&domKB=100' };
  try {
    await h.sleep(2000);
    result.empty = await snapshot('empty window, no tabs');

    const views = [];
    for (let i = 0; i < TABS; i++) {
      const view = h.createTabView(win, { attach: i === 0 });
      await view.webContents.loadURL(fixture.url(`/page?heapMB=10&domKB=100&title=M${i}`, `m${i}.test`));
      views.push(view);
    }
    await h.sleep(SETTLE_MS);
    result.allLive = await snapshot(`${TABS} live tabs (1 attached)`);

    for (const view of views.slice(1)) h.destroyView(win, view);
    await h.sleep(SETTLE_MS);
    result.discarded = await snapshot(`1 live tab, ${TABS - 1} discarded`);
    h.destroyView(win, views[0]);
  } catch (error) {
    result.error = String(error?.stack ?? error);
  }
  h.writeResults(__dirname, `s8-run-${RUN_ID}`, result);
  console.log(JSON.stringify({ empty: result.empty?.electron.privateMB, allLive: result.allLive?.electron.privateMB, discarded: result.discarded?.electron.privateMB }));
  await fixture.close();
  app.exit(result.error ? 1 : 0);
});
