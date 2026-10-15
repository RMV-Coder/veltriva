'use strict';
// S1: view lifecycle on Windows.
// - Do detached / setVisible(false) / occluded / minimized views report `hidden`?
// - Are hidden views throttled (interval ticks, animation frames)?
// - Does removeChildView + webContents.close() release renderers? Does dropping references alone leak?
// - Do media events fire as documented?
// - Is the back/forward cache active?
// Run from /spikes: ./node_modules/.bin/electron s1-view-lifecycle/main.js

const { app, session, webContents: allWebContents } = require('electron');
const v8 = require('node:v8');
const vm = require('node:vm');
const h = require('../shared/harness');
const { startFixtureServer } = require('../shared/fixture-server');

h.prepareApp(__dirname);
h.failSafe(240_000, 's1');

v8.setFlagsFromString('--expose-gc');
const forceGc = vm.runInNewContext('gc');

const rows = [];
const evalIn = (view, code) => view.webContents.executeJavaScript(code);
const visibility = (view) => evalIn(view, 'document.visibilityState');

/** Interval ticks and animation frames per second over `ms`. */
async function rates(view, ms) {
  const before = await evalIn(view, '({ i: __t.intervalTicks, r: __t.rafTicks, at: performance.now() })');
  await h.sleep(ms);
  const after = await evalIn(view, '({ i: __t.intervalTicks, r: __t.rafTicks, at: performance.now() })');
  const seconds = (after.at - before.at) / 1000;
  return {
    intervalPerSec: Math.round(((after.i - before.i) / seconds) * 10) / 10,
    rafPerSec: Math.round(((after.r - before.r) / seconds) * 10) / 10,
  };
}

function tabProcesses() {
  const summary = h.appMetricsSummary();
  return { tabCount: summary.byType.Tab?.count ?? 0, tabPrivateMB: Math.round((summary.byType.Tab?.privateKB ?? 0) / 1024), totalPrivateMB: Math.round(summary.totalPrivateKB / 1024) };
}

async function visibilityChecks(win, fixture) {
  const view = h.createTabView(win);
  await view.webContents.loadURL(fixture.url('/timers.html', 'vis.test'));
  await h.sleep(1000);
  h.record(rows, 'attached view in a shown window is visible', await visibility(view), (await visibility(view)) === 'visible');
  const visibleRates = await rates(view, 4000);
  h.record(rows, 'visible: 100 ms interval and rAF rates', visibleRates, visibleRates.intervalPerSec > 8 && visibleRates.rafPerSec > 20);

  win.contentView.removeChildView(view);
  await h.sleep(800);
  const detached = await visibility(view);
  h.record(rows, 'removeChildView → page reports hidden', detached, detached === 'hidden');
  const detachedRates = await rates(view, 6000);
  h.record(rows, 'detached: timers throttled to ~1/s and rAF stopped', detachedRates, detachedRates.intervalPerSec <= 1.5 && detachedRates.rafPerSec < 1);

  view.webContents.setBackgroundThrottling(false);
  await h.sleep(300);
  const unthrottled = await rates(view, 4000);
  h.record(rows, 'detached + setBackgroundThrottling(false): timer rate', unthrottled, null, 'informational');
  view.webContents.setBackgroundThrottling(true);

  win.contentView.addChildView(view);
  await h.sleep(800);
  const reattached = await visibility(view);
  h.record(rows, 're-added view reports visible again (Linux had a 44.x regression here)', reattached, reattached === 'visible');
  const reattachedRates = await rates(view, 3000);
  h.record(rows, 're-added view resumes painting (rAF)', reattachedRates, reattachedRates.rafPerSec > 20);

  view.setVisible(false);
  await h.sleep(800);
  const setInvisible = await visibility(view);
  h.record(rows, 'setVisible(false) on an attached view → page visibility', setInvisible, null, 'informational: detaching is the hiding method we rely on');
  view.setVisible(true);
  await h.sleep(500);

  // Occlusion by another view (what snapshot takeover in ADR-0006 option A does).
  const cover = h.createTabView(win);
  await cover.webContents.loadURL('data:text/html,<body style="background:#334">cover</body>');
  await h.sleep(800);
  const occluded = await visibility(view);
  const occludedRates = await rates(view, 3000);
  h.record(rows, 'fully covered by another view in the same window → page visibility and rAF', { occluded, ...occludedRates }, null, 'informational for ADR-0006 option A');
  h.destroyView(win, cover);
  await h.sleep(800);

  // Native window occlusion: another top-level window covering ours entirely.
  const [x, y] = win.getPosition();
  const [width, height] = win.getSize();
  const coverWindow = h.createWindow({ width: width + 40, height: height + 40, title: 'S1 cover window' });
  coverWindow.setAlwaysOnTop(true, 'screen-saver');
  coverWindow.setPosition(x - 20, y - 20);
  const coverContent = h.createTabView(coverWindow);
  await coverContent.webContents.loadURL('data:text/html,<body style="background:#433">cover window</body>');
  await h.sleep(3000);
  const windowOccluded = await visibility(view);
  const windowOccludedRates = await rates(view, 3000);
  h.record(rows, 'whole window covered by another window → page visibility (native occlusion)', { windowOccluded, ...windowOccludedRates }, null, 'informational');
  h.destroyView(coverWindow, coverContent);
  coverWindow.destroy();
  await h.sleep(2000);
  h.record(rows, 'cover window removed → page visible again', await visibility(view), (await visibility(view)) === 'visible');

  win.minimize();
  await h.sleep(1500);
  const minimized = await visibility(view);
  h.record(rows, 'window minimized → attached page reports hidden', minimized, minimized === 'hidden');
  win.restore();
  await h.sleep(1500);

  const log = await evalIn(view, '__t.visibility.map(v => v.state).join(" → ")');
  h.record(rows, 'visibilitychange sequence seen by the page', log, null);
  h.destroyView(win, view);
}

async function releaseChecks(win, fixture) {
  // Let renderers from earlier checks exit before taking the baseline.
  const baseline = (await h.pollUntil(() => {
    const now = tabProcesses();
    return now.tabCount === 0 ? now : null;
  }, { timeoutMs: 8000, intervalMs: 250 })) ?? tabProcesses();
  const views = [];
  for (let i = 0; i < 8; i++) {
    const view = h.createTabView(win, { attach: false });
    await view.webContents.loadURL(fixture.url(`/page?heapMB=20&domKB=50&title=T${i}`, `t${i}.test`));
    views.push(view);
  }
  await h.sleep(2000);
  const loaded = tabProcesses();
  h.record(rows, '8 live cross-site tabs (20 MB heap each)', { baseline, loaded }, loaded.tabCount >= baseline.tabCount + 8);

  for (const view of views.slice(0, 4)) win.contentView.removeChildView(view);
  await h.sleep(1500);
  const detachedOnly = tabProcesses();
  h.record(rows, 'removeChildView alone releases nothing', detachedOnly, detachedOnly.tabCount === loaded.tabCount);

  for (const view of views.slice(0, 4)) h.destroyView(win, view);
  const closed = await h.pollUntil(() => {
    const now = tabProcesses();
    return now.tabCount <= loaded.tabCount - 4 ? now : null;
  }, { timeoutMs: 8000, intervalMs: 250 }) ?? tabProcesses();
  h.record(rows, 'removeChildView + close() releases 4 renderers', { closed, privateMBFreed: loaded.totalPrivateMB - closed.totalPrivateMB }, closed.tabCount <= loaded.tabCount - 4);

  // Drop references to the other 4 without closing them, force GC, and see whether they survive.
  const leakedIds = views.slice(4).map((v) => v.webContents.id);
  views.length = 0;
  forceGc();
  await h.sleep(3000);
  forceGc();
  await h.sleep(2000);
  const alive = leakedIds.filter((id) => {
    const wc = allWebContents.fromId(id);
    return wc && !wc.isDestroyed();
  });
  h.record(rows, 'dropping references without close(): renderers still alive after 2 forced GCs over 5 s', { alive: alive.length, of: leakedIds.length, ...tabProcesses() }, null,
    'release by GC is non-deterministic; explicit close() is the only predictable release (ADR-0002)');
  for (const id of alive) allWebContents.fromId(id)?.close();
  await h.sleep(2000);
  h.record(rows, 'after closing the leaked contents', tabProcesses(), null);
}

async function mediaChecks(win, fixture) {
  const view = h.createTabView(win);
  const events = [];
  const wc = view.webContents;
  wc.on('media-started-playing', () => events.push('media-started-playing'));
  wc.on('media-paused', () => events.push('media-paused'));
  wc.on('audio-state-changed', (event) => events.push(`audio-state-changed:${event.audible}`));
  await wc.loadURL(fixture.url('/audio.html', 'media.test'));
  wc.setAudioMuted(true); // keep the user's speakers quiet

  const started = await wc.executeJavaScript('play()', true);
  await h.sleep(2500);
  const audibleWhilePlayingMuted = wc.isCurrentlyAudible();
  await wc.executeJavaScript('pause()', true);
  await h.sleep(2500);
  const audibleAfterPause = wc.isCurrentlyAudible();
  h.record(rows, 'media events while muted', { started, events: [...events], audibleWhilePlayingMuted, audibleAfterPause }, events.includes('media-started-playing') && events.includes('media-paused'));
  h.destroyView(win, view);
}

async function bfcacheCheck(win, fixture) {
  const view = h.createTabView(win);
  await view.webContents.loadURL(fixture.url('/article?n=5&title=A', 'bf.test'));
  await evalIn(view, 'window.__marker = "same-js-heap"; true');
  await view.webContents.loadURL(fixture.url('/article?n=5&title=B', 'bf.test'));
  const back = h.waitFor(view.webContents, 'did-navigate', 10000).catch(() => null);
  view.webContents.navigationHistory.goBack();
  await back;
  await h.sleep(500);
  const marker = await evalIn(view, 'window.__marker ?? null');
  h.record(rows, 'back/forward cache: page restored from memory on Back?', { restoredFromBfcache: marker === 'same-js-heap' }, null, 'informational');
  h.destroyView(win, view);
}

app.whenReady().then(async () => {
  session.fromPartition(h.TAB_PREFS.partition).setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  const fixture = await startFixtureServer();
  const win = h.createWindow({ width: 900, height: 600, title: 'Veltriva S1' });
  // Keep the window un-occluded so "visible" really means visible (Windows native occlusion tracking).
  win.setAlwaysOnTop(true);
  await h.sleep(1000);
  try {
    await visibilityChecks(win, fixture);
    await releaseChecks(win, fixture);
    await mediaChecks(win, fixture);
    await bfcacheCheck(win, fixture);
  } catch (error) {
    h.record(rows, 'unexpected error', String(error?.stack ?? error), false);
  }
  h.writeResults(__dirname, process.env.S1_RESULTS_NAME ?? 's1-view-lifecycle', { rows });
  await fixture.close();
  app.exit(rows.some((r) => r.pass === false) ? 1 : 0);
});
