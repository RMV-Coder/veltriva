'use strict';
// Q1: what does navigationHistory report for a 3-entry tab (A -> form.html -> C)?

const h = require('../shared/harness');
const L = require('./lib');
const S = require('./scenario');

async function run(ctx, rows) {
  const out = {};
  const urls = S.pageUrls(ctx.fx);

  // (a) Bare history: three plain loads, no scrolling or typing.
  {
    const view = h.createTabView(ctx.win);
    const wc = view.webContents;
    for (const key of S.LAYOUTS.formMiddle) await wc.loadURL(urls[key]);
    out.bareImmediate = L.summarizeHistory(wc);
    await h.sleep(1500); // the active entry's pageState changes ~1 s after load (see Q4)
    out.bareAfter1500ms = L.summarizeHistory(wc);
    await L.discard(ctx.win, view);
  }

  // (b) The same history after real interaction: A scrolled to p60, form filled, C scrolled to p120 (settled).
  const src = await S.buildSourceTab(ctx, 'formMiddle', 'full-settled');
  const wc = src.wc;
  const nh = wc.navigationHistory;
  out.interacted = L.summarizeHistory(wc);
  out.interactedBuild = src.build;
  out.visibilityState = await L.visibility(wc);

  const e = out.interacted;
  h.record(rows, 'Q1 getAllEntries() urls (A, form, C)', e.entries.map((x) => x.url), e.entries.map((x) => x.url).join('|') === S.LAYOUTS.formMiddle.map((k) => S.pagePaths[k]).join('|'));
  h.record(rows, 'Q1 getAllEntries() titles', e.entries.map((x) => x.title), e.entries.map((x) => x.title).join('|') === 'A|form|C');
  h.record(rows, 'Q1 pageState present on every entry (type, decoded bytes)', e.entries.map((x) => [x.pageStateType, x.pageStateBytes]), e.entries.every((x) => x.pageStateType === 'string' && x.pageStateBytes > 0));
  h.record(rows, 'Q1 pageState size, bare tab, immediately after loads (bytes)', out.bareImmediate.entries.map((x) => x.pageStateBytes), null);
  h.record(rows, 'Q1 pageState size, bare tab, 1.5 s later (bytes)', out.bareAfter1500ms.entries.map((x) => x.pageStateBytes), null);
  h.record(rows, 'Q1 pageState size, after scroll/typing, settled (bytes)', e.entries.map((x) => x.pageStateBytes), null);
  h.record(rows, 'Q1 length / activeIndex / canGoBack / canGoForward', [e.length, e.activeIndex, e.canGoBack, e.canGoForward], e.length === 3 && e.activeIndex === 2 && e.canGoBack && !e.canGoForward);

  // (c) Navigation through the live history, to see the counters move.
  out.walk = [];
  const step = async (label, fn) => {
    const url = await fn();
    out.walk.push({ label, url, ...L.summarizeHistory(wc), entries: undefined });
    return url;
  };
  await step('goBack', () => L.navigateHistory(wc, 'back'));
  await step('goBack', () => L.navigateHistory(wc, 'back'));
  await step('goForward', () => L.navigateHistory(wc, 'forward'));
  await step('goToIndex(2)', () => L.navigateHistory(wc, 'index', 2));
  h.record(
    rows,
    'Q1 counters while walking back/forward (len, idx, back, fwd)',
    out.walk.map((w) => `${w.label}: ${w.url} -> [${w.length}, ${w.activeIndex}, ${w.canGoBack}, ${w.canGoForward}]`),
    out.walk[0].activeIndex === 1 && out.walk[0].canGoForward && out.walk[1].activeIndex === 0 && !out.walk[1].canGoBack && out.walk[3].activeIndex === 2,
  );
  out.outOfBounds = { atLength: nh.getEntryAtIndex(3), atMinusOne: nh.getEntryAtIndex(-1) };
  h.record(rows, 'Q1 getEntryAtIndex out of bounds', out.outOfBounds, out.outOfBounds.atLength === null && out.outOfBounds.atMinusOne === null);

  // (d) Is the entry JSON-serialisable (this is what we would persist)? How big is it?
  const entries = nh.getAllEntries();
  out.json = {
    fullBytes: Buffer.byteLength(JSON.stringify(entries)),
    withoutPageStateBytes: Buffer.byteLength(JSON.stringify(entries.map(({ url, title }) => ({ url, title })))),
    keys: entries.map((x) => Object.keys(x)),
  };
  h.record(rows, 'Q1 JSON size of entries with / without pageState (bytes)', out.json, null);

  await L.discard(ctx.win, src.view);

  // (e) pageState grows with form content: 50 KB of text in the textarea (flushed with replaceState, see Q4b).
  {
    const view = h.createTabView(ctx.win);
    await view.webContents.loadURL(urls.form);
    const small = L.psBytes(L.activePageState(view.webContents));
    await view.webContents.executeJavaScript(`(() => { const a = document.getElementById('area'); a.value = 'x'.repeat(50000); a.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await view.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: "history.replaceState(history.state, ''); true" }]);
    await h.sleep(100);
    out.largeTextarea = { bytesBefore: small, bytesWith50KBTextarea: L.psBytes(L.activePageState(view.webContents)) };
    h.record(rows, 'Q1 pageState size with 50 KB typed into the textarea (bytes)', out.largeTextarea, null);
    await L.discard(ctx.win, view);
  }
  return out;
}

module.exports = { run };
