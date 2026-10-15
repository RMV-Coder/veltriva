'use strict';
// S7 check 2: does Electron's built-in PDF viewer render in a tab view (TAB_PREFS)?
// Compares capturePage() of about:blank, a plain HTML page and /fixture.pdf.

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../shared/harness');
const { startFixtureServer } = require('../shared/fixture-server');
const lib = require('./lib');

lib.setup('pdf', { failSafeMs: 90_000 });

/**
 * Cheap image statistics from a NativeImage: share of pixels differing from the top-left pixel, distinct colours,
 * and the share of pure-white pixels. The viewer's toolbar and dark background alone make a capture "non-blank";
 * the white PDF page (whiteShare) is what shows the document itself rendered.
 */
function imageStats(image) {
  const { width, height } = image.getSize();
  const bmp = image.toBitmap(); // BGRA
  const first = bmp.readUInt32LE(0);
  const colours = new Set();
  let different = 0;
  let white = 0;
  const pixels = width * height;
  for (let i = 0; i < pixels; i++) {
    const px = bmp.readUInt32LE(i * 4);
    if (px !== first) different++;
    if (px === 0xffffffff) white++;
    if (colours.size < 256) colours.add(px);
  }
  return { width, height, differentFromCorner: Math.round((different / Math.max(pixels, 1)) * 10000) / 100, distinctColours: colours.size >= 256 ? '256+' : colours.size, whiteShare: Math.round((white / Math.max(pixels, 1)) * 10000) / 100 };
}

app.whenReady().then(async () => {
  const rows = [];
  const fixture = await startFixtureServer();
  const win = h.createWindow({ width: 800, height: 520, title: 'S7 pdf' });
  const view = h.createTabView(win);
  const wc = view.webContents;

  await wc.loadURL('about:blank');
  const visibilityState = await lib.stabilizeWindow(win, wc);
  const blank = imageStats(await wc.capturePage());
  h.record(rows, 'about:blank capture (baseline)', { visibilityState, ...blank }, blank.differentFromCorner === 0);

  await wc.loadURL(fixture.url('/article?n=5&title=Plain%20page'));
  await h.sleep(500);
  const html = imageStats(await wc.capturePage());
  h.record(rows, 'plain HTML page capture (sanity: capture works)', html, html.differentFromCorner > 0);

  // PDF: load and observe events.
  const events = [];
  wc.on('did-finish-load', () => events.push('did-finish-load'));
  wc.on('did-start-navigation', (e) => events.push(`did-start-navigation ${e.url} main=${e.isMainFrame}`));
  wc.on('did-fail-load', (e, code, desc) => events.push(`did-fail-load ${code} ${desc}`));
  wc.on('page-title-updated', (e, title) => events.push(`title ${title}`));
  const finished = h.waitFor(wc, 'did-finish-load', 20000).then(() => true, () => false);
  const loadResult = await wc.loadURL(fixture.url('/fixture.pdf')).then(() => 'resolved', (err) => `rejected: ${err.message}`);
  const didFinish = await finished;
  h.record(rows, 'did-finish-load for /fixture.pdf', { loadResult, didFinish, events: events.slice(0, 8) }, didFinish);

  // Wait for the viewer to paint (poll until the capture is no longer blank).
  let pdfStats = null;
  const rendered = await h.pollUntil(async () => {
    pdfStats = imageStats(await wc.capturePage());
    return pdfStats.differentFromCorner > 1 && pdfStats.whiteShare > 10;
  }, { timeoutMs: 15000, intervalMs: 500 });
  // Optional: S7_DUMP_DIR=<dir> saves the captures as PNG so a human can look at them.
  const dump = async (view_, name) => { if (process.env.S7_DUMP_DIR) fs.writeFileSync(path.join(process.env.S7_DUMP_DIR, `${name}.png`), (await view_.capturePage()).toPNG()); };
  await dump(wc, 'pdf-normal');
  const frames = wc.mainFrame.framesInSubtree.map((f) => ({ url: f.url, processId: f.processId, origin: f.origin }));
  const pdfVisibility = await wc.executeJavaScript('document.visibilityState', true).catch((e) => `error ${e.message}`);
  h.record(rows, 'PDF capture shows the viewer AND the white document page', { visibilityState: pdfVisibility, title: wc.getTitle(), url: wc.getURL(), ...pdfStats }, Boolean(rendered));
  h.record(rows, 'PDF frame tree', frames, frames.length > 1 ? true : null, 'extension/embedded frames indicate the viewer UI');

  const pluginInfo = await wc.executeJavaScript(
    'JSON.stringify({ plugins: Array.from(navigator.plugins).map(p => p.name), pdfViewerEnabled: navigator.pdfViewerEnabled, mime: Array.from(navigator.mimeTypes).map(m => m.type) })',
    true,
  ).catch(() => null);
  h.record(rows, 'navigator.pdfViewerEnabled / plugins on the PDF page', pluginInfo && JSON.parse(pluginInfo), null);

  // Back to a normal page: the tab must work after the PDF.
  await wc.loadURL(fixture.url('/article?n=5&title=After%20PDF'));
  h.record(rows, 'tab navigates normally after the PDF', wc.getTitle(), wc.getTitle() === 'After PDF');

  // Guarded passes: ADR-0002 / assessment 6.4 allow only http(s) and about:blank for tabs. The PDF viewer navigates
  // chrome-extension:// frames, so test a guard of exactly that shape, then the same guard plus the PDF extension.
  const PDF_EXTENSION = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/';
  async function guardedPass(label, dumpName, isAllowed) {
    const guarded = h.createTabView(win);
    const gwc = guarded.webContents;
    const navs = [];
    gwc.on('will-frame-navigate', (event) => {
      const allowed = isAllowed(event.url);
      navs.push({ url: event.url.slice(0, 90), isMainFrame: event.isMainFrame, allowed });
      if (!allowed) event.preventDefault();
    });
    await gwc.loadURL(fixture.url('/fixture.pdf')).catch(() => {});
    let stats = null;
    const documentRendered = await h.pollUntil(async () => {
      stats = imageStats(await gwc.capturePage());
      return stats.differentFromCorner > 1 && stats.whiteShare > 10;
    }, { timeoutMs: 8000, intervalMs: 500 });
    h.record(rows, label, { guardSawNavigations: navs, blockedByGuard: navs.filter((n) => !n.allowed).length, ...stats }, null,
      documentRendered ? 'document page rendered' : 'viewer chrome renders but the DOCUMENT PAGE does not');
    await dump(gwc, dumpName);
    h.destroyView(win, guarded);
    return documentRendered;
  }
  const isWeb = (url) => /^https?:/.test(url) || url === 'about:blank';
  await guardedPass('PDF with a strict will-frame-navigate guard (http/https/about:blank only)', 'pdf-strict-guard', isWeb);
  const allowedWithExtension = await guardedPass('PDF with the guard plus the PDF viewer extension origin allowed', 'pdf-guard-allow-extension', (url) => isWeb(url) || url.startsWith(PDF_EXTENSION));
  h.record(rows, 'allowing only the PDF extension origin restores the document page', allowedWithExtension, allowedWithExtension);

  h.writeResults(__dirname, 'pdf', { visibilityState, rows });
  lib.releaseWindow(win);
  h.destroyView(win, view);
  win.close();
  await fixture.close();
  app.exit(rows.every((r) => r.pass !== false) ? 0 : 1);
});
