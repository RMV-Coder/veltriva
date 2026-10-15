'use strict';
// S4: overlay strategy (ADR-0006).
// Option A, snapshot takeover: capturePage() → shell paints snapshot + palette → raise shell above the tab.
// Option B, overlay view: a transparent WebContentsView above the tab.
// Measures latency (median/range), visibility side effects, transparency, focus and memory cost.
// Run from /spikes: ./node_modules/.bin/electron s4-overlay/main.js

const { app, session, desktopCapturer, WebContentsView } = require('electron');
const path = require('node:path');
const h = require('../shared/harness');
const { startFixtureServer } = require('../shared/fixture-server');

h.prepareApp(__dirname);
h.failSafe(180_000, 's4');

const RUNS = Number(process.env.S4_RUNS ?? 10);
const TOOLBAR = 56;
const rows = [];

const now = () => performance.now();
const ms = (t) => Math.round(t * 10) / 10;
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  return { median: ms(median), min: ms(sorted[0]), max: ms(sorted[sorted.length - 1]), n: sorted.length };
}

async function pageRates(view, durationMs) {
  const read = () => view.webContents.executeJavaScript('({ i: __t.intervalTicks, r: __t.rafTicks, at: performance.now(), v: document.visibilityState })');
  const a = await read();
  await h.sleep(durationMs);
  const b = await read();
  const s = (b.at - a.at) / 1000;
  return { visibility: b.v, intervalPerSec: Math.round(((b.i - a.i) / s) * 10) / 10, rafPerSec: Math.round(((b.r - a.r) / s) * 10) / 10 };
}

/** Counts near-red and near-blue pixels in a capture of our window. */
async function sampleWindowColors(title) {
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 900, height: 640 } });
  const source = sources.find((s) => s.name === title);
  if (!source) return { found: false, names: sources.map((s) => s.name).slice(0, 10) };
  const { width, height } = source.thumbnail.getSize();
  const bitmap = source.thumbnail.toBitmap(); // BGRA
  let red = 0;
  let blue = 0;
  let white = 0;
  for (let i = 0; i < bitmap.length; i += 4) {
    const b = bitmap[i];
    const g = bitmap[i + 1];
    const r = bitmap[i + 2];
    if (r > 200 && g < 60 && b < 60) red += 1;
    else if (b > 200 && r < 60 && g < 60) blue += 1;
    else if (r > 235 && g > 235 && b > 235) white += 1;
  }
  const total = width * height;
  const pct = (n) => Math.round((n / total) * 1000) / 10;
  return { found: true, size: `${width}x${height}`, redPct: pct(red), bluePct: pct(blue), whitePct: pct(white) };
}

function tabProcessSummary() {
  const summary = h.appMetricsSummary();
  return { tabCount: summary.byType.Tab?.count ?? 0, tabPrivateMB: Math.round((summary.byType.Tab?.privateKB ?? 0) / 1024) };
}

async function optionA(win, shell, tab) {
  const capture = [];
  const encode = [];
  const paint = [];
  const total = [];
  let jpegBytes = 0;
  for (let i = 0; i < RUNS; i++) {
    const t0 = now();
    const image = await tab.webContents.capturePage();
    const t1 = now();
    const jpeg = image.toJPEG(85);
    jpegBytes = jpeg.length;
    const dataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
    const t2 = now();
    await shell.webContents.executeJavaScript(`showSnapshot(${JSON.stringify(dataUrl)})`);
    win.contentView.addChildView(shell); // re-adding moves the shell to the top
    const t3 = now();
    capture.push(t1 - t0);
    encode.push(t2 - t1);
    paint.push(t3 - t2);
    total.push(t3 - t0);
    if (i === 0) {
      const underShell = await pageRates(tab, 2500);
      h.record(rows, 'A: tab page while the shell is raised above it', underShell, null, 'does the page see a visibility change?');
      shell.webContents.focus();
      h.record(rows, 'A: shell has keyboard focus while overlay is open', await shell.webContents.executeJavaScript('document.hasFocus()'), null);
    }
    await shell.webContents.executeJavaScript('hideOverlay()');
    win.contentView.addChildView(tab); // tab back on top
    await h.sleep(150);
  }
  h.record(rows, 'A: capturePage latency (ms)', stats(capture), null);
  h.record(rows, 'A: JPEG encode + base64 (ms)', { ...stats(encode), jpegKB: Math.round(jpegBytes / 1024) }, null);
  h.record(rows, 'A: shell decode + paint (ms)', stats(paint), null);
  h.record(rows, 'A: total time to overlay on screen (ms)', stats(total), null);
  h.record(rows, 'A: tab page after overlay closed', await pageRates(tab, 2000), null);
}

// Option A′: raise the shell itself, with a transparent view background, as the overlay.
async function optionAPrime(win, shell, tab, fixture) {
  shell.setBackgroundColor('#00000000');
  const shows = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = now();
    await shell.webContents.executeJavaScript('showOverlayLive()');
    win.contentView.addChildView(shell);
    shell.webContents.focus();
    shows.push(now() - t0);
    if (i === 0) {
      h.record(rows, 'A′: tab page while the transparent shell is raised above it', await pageRates(tab, 2500), null);
      h.record(rows, 'A′: focus after shell.webContents.focus()', {
        shellIsFocused: shell.webContents.isFocused(),
        shell: await shell.webContents.executeJavaScript('focusState()'),
      }, null);
    }
    await shell.webContents.executeJavaScript('hideOverlay()');
    win.contentView.addChildView(tab);
    await h.sleep(150);
  }
  h.record(rows, 'A′: time to overlay on screen (ms)', stats(shows), null);

  await tab.webContents.loadURL('data:text/html,<body style="margin:0;background:rgb(255,0,0)"></body>');
  await shell.webContents.executeJavaScript('showOverlayLive()');
  win.contentView.addChildView(shell);
  await h.sleep(800);
  const colors = await sampleWindowColors(win.getTitle());
  h.record(rows, 'A′: window capture through the transparent shell (expect red page around a white palette)', colors,
    colors.found ? colors.redPct > 30 : null);
  await shell.webContents.executeJavaScript('hideOverlay()');
  win.contentView.addChildView(tab);
  await tab.webContents.loadURL(fixture.url('/timers.html', 'overlay.test'));
  await h.sleep(800);
}

async function optionB(win, tab, overlayFile) {
  const before = tabProcessSummary();
  const t0 = now();
  const overlay = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  overlay.setBackgroundColor('#00000000');
  const [width, height] = win.getContentSize();
  overlay.setBounds({ x: 0, y: TOOLBAR, width, height: height - TOOLBAR });
  await overlay.webContents.loadFile(overlayFile);
  win.contentView.addChildView(overlay);
  await overlay.webContents.executeJavaScript('paintAck()');
  const coldMs = now() - t0;
  await h.sleep(1000);
  const after = tabProcessSummary();
  h.record(rows, 'B: cold create + load + first paint of overlay view (ms)', ms(coldMs), null);
  h.record(rows, 'B: extra renderer cost of the overlay view', { before, after }, null);

  const shows = [];
  for (let i = 0; i < RUNS; i++) {
    overlay.setVisible(false);
    await h.sleep(150);
    const t = now();
    overlay.setVisible(true);
    await overlay.webContents.executeJavaScript('paintAck()');
    shows.push(now() - t);
  }
  h.record(rows, 'B: warm show (setVisible(true) → painted) (ms)', stats(shows), null);
  h.record(rows, 'B: tab page while the overlay view is shown', await pageRates(tab, 2500), null);

  overlay.webContents.focus();
  await overlay.webContents.executeJavaScript('document.getElementById("q").focus(); true');
  await h.sleep(200);
  h.record(rows, 'B: focus after overlay.webContents.focus()', {
    overlayIsFocused: overlay.webContents.isFocused(),
    overlay: await overlay.webContents.executeJavaScript('focusState()'),
    tabIsFocused: tab.webContents.isFocused(),
  }, null);

  // Transparency: put a solid red page under the overlay and capture the whole window.
  await tab.webContents.loadURL('data:text/html,<body style="margin:0;background:rgb(255,0,0)"></body>');
  await h.sleep(800);
  const colors = await sampleWindowColors(win.getTitle());
  h.record(rows, 'B: window capture through the transparent overlay (expect red around a blue palette)', colors,
    colors.found ? colors.redPct > 30 && colors.bluePct > 3 : null);
  win.contentView.removeChildView(overlay);
  overlay.webContents.close();
}

app.whenReady().then(async () => {
  for (const s of [session.defaultSession, session.fromPartition(h.TAB_PREFS.partition)]) {
    s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  }
  const fixture = await startFixtureServer();
  const win = h.createWindow({ width: 900, height: 600, title: 'Veltriva S4' });
  win.setAlwaysOnTop(true); // avoid native occlusion skewing visibility (see S1)
  const [width, height] = win.getContentSize();

  const shell = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  shell.setBounds({ x: 0, y: 0, width, height });
  win.contentView.addChildView(shell);
  await shell.webContents.loadFile(path.join(__dirname, 'shell.html'));

  const tab = h.createTabView(win, { bounds: { x: 0, y: TOOLBAR, width, height: height - TOOLBAR } });
  await tab.webContents.loadURL(fixture.url('/timers.html', 'overlay.test'));
  await h.sleep(1000);
  h.record(rows, 'baseline: tab page before any overlay', await pageRates(tab, 2000), null);

  try {
    await optionA(win, shell, tab);
    await optionAPrime(win, shell, tab, fixture);
    await optionB(win, tab, path.join(__dirname, 'overlay.html'));
  } catch (error) {
    h.record(rows, 'unexpected error', String(error?.stack ?? error), false);
  }

  h.writeResults(__dirname, process.env.S4_RESULTS_NAME ?? 's4-overlay', { runs: RUNS, rows });
  h.destroyView(win, tab);
  shell.webContents.close();
  await fixture.close();
  app.exit(rows.some((r) => r.pass === false) ? 1 : 0);
});
