'use strict';
// Builds a 3-entry tab with scroll/form state, discards it, restores it, and verifies what survived.
// Used by Q2 (full entries), Q3 (url+title only) and Q6 (ordering of restore vs loadURL).

const h = require('../shared/harness');
const L = require('./lib');

/**
 * Page order in the 3-entry history.
 *  - formMiddle: A -> form.html -> C   (the layout from the brief; form values live on a non-active entry)
 *  - formActive: A -> C -> form.html   (form values and scroll live on the active entry)
 */
const LAYOUTS = Object.freeze({
  formMiddle: ['A', 'form', 'C'],
  formActive: ['A', 'C', 'form'],
});

const pageUrls = (fx) => ({
  A: fx.url('/article?n=200&title=A'),
  C: fx.url('/article?n=200&title=C'),
  form: fx.url('/form.html'),
});
const pagePaths = Object.freeze({ A: '/article?n=200&title=A', C: '/article?n=200&title=C', form: '/form.html' });
const pageTitles = Object.freeze({ A: 'A', C: 'C', form: 'form' });

/** Applies the scroll / form edits for one page. Returns what we expect to see after a restore. */
async function interact(wc, key, expected, { isActive }) {
  if (key === 'A') expected.scroll.A = (await L.scrollToParagraph(wc, 60)).scrollY;
  if (key === 'C') expected.scroll.C = (await L.scrollToParagraph(wc, 120)).scrollY;
  if (key === 'form') {
    // Scroll first, then fill: when the form marker shows up in pageState, the scroll is in it too.
    if (isActive) expected.scroll.form = (await L.scrollToY(wc, 1500)).scrollY;
    await L.fillForm(wc);
  }
}

/**
 * Creates the source tab and snapshots it.
 * mode: 'full-settled' waits until the active entry's pageState reflects the last edit before snapshotting;
 *       'full-flushed' forces an update with history.replaceState(history.state, '') from an isolated world
 *       (found in Q4b) and snapshots about 50 ms later, instead of waiting ~1 s;
 *       'full-immediate' and 'persisted' snapshot right after the edit (persisted then drops pageState).
 */
async function buildSourceTab(ctx, layout, mode, { hideSource = false } = {}) {
  const order = LAYOUTS[layout];
  const urls = pageUrls(ctx.fx);
  const expected = { scroll: {} };
  const view = h.createTabView(ctx.win);
  const wc = view.webContents;
  const build = {};
  for (let i = 0; i < order.length; i++) {
    const key = order[i];
    const isActive = i === order.length - 1;
    await wc.loadURL(urls[key]);
    let baseline;
    if (isActive && mode === 'full-settled') {
      const quiet = await L.waitPageStateQuiet(wc);
      baseline = quiet.pageState;
      build.quietAfterLoadMs = quiet.quietAfterMs;
    }
    // hideSource: edit the active page while its view is detached (document.visibilityState === 'hidden').
    if (isActive && hideSource) ctx.win.contentView.removeChildView(view);
    if (isActive) build.visibilityBeforeEdit = await L.visibility(wc);
    await interact(wc, key, expected, { isActive });
    if (isActive && mode === 'full-flushed') {
      const beforeFlush = L.activePageState(wc);
      const t0 = performance.now();
      await wc.executeJavaScriptInIsolatedWorld(1001, [{ code: "history.replaceState(history.state, ''); true" }]);
      build.flushedAfterMs = await L.waitPageState(wc, (ps) => ps !== beforeFlush, { t0, timeoutMs: 1000, intervalMs: 10 });
    }
    if (isActive && mode === 'full-settled') {
      const t0 = performance.now();
      const needsMarker = key === 'form';
      build.settledAfterEditMs = await L.waitPageState(
        wc,
        (ps) => ps !== baseline && (!needsMarker || L.psHas(ps, L.FORM_VALUES.text)),
        { t0, timeoutMs: 10000, intervalMs: 50 },
      );
    }
  }
  build.visibilityState = await L.visibility(wc);
  const snapshot = L.snapshotHistory(wc);
  build.snapshotBytes = snapshot.entries.map((e) => L.psBytes(e.pageState));
  return { view, wc, expected, snapshot, build };
}

/** Polls scrollY until it matches `expected` (±1 px) or `pollMs` elapses. */
async function checkScroll(wc, expected, pollMs) {
  const atLoad = await L.readScrollY(wc);
  const t0 = performance.now();
  let last = atLoad;
  let settleMs = Math.abs(atLoad - expected) <= 1 ? 0 : null;
  while (settleMs === null && performance.now() - t0 < pollMs) {
    await h.sleep(50);
    last = await L.readScrollY(wc);
    if (Math.abs(last - expected) <= 1) settleMs = Math.round(performance.now() - t0);
  }
  return { expected, atLoad, final: last, ok: settleMs !== null, settleMs };
}

/** Reads form.html, then polls until every field is restored or `pollMs` elapses. */
async function checkForm(wc, pollMs) {
  const first = await L.readForm(wc);
  let last = first;
  const allRestored = (f) => Object.values(L.classifyForm(f)).every((c) => c === 'restored');
  const t0 = performance.now();
  while (!allRestored(last) && performance.now() - t0 < pollMs) {
    await h.sleep(50);
    last = await L.readForm(wc);
  }
  return { first: L.classifyForm(first), final: L.classifyForm(last), finalValues: last, settleMs: allRestored(last) ? Math.round(performance.now() - t0) : null };
}

/** Checks one page (by key) in the restored tab. */
async function checkPage(wc, key, expected, pollMs) {
  const r = { key, url: L.stripOrigin(wc.getURL()), title: wc.getTitle() };
  r.urlOk = r.url === pagePaths[key];
  r.visibilityState = await L.visibility(wc);
  if (expected.scroll[key] !== undefined) r.scroll = await checkScroll(wc, expected.scroll[key], pollMs);
  if (key === 'form') r.form = await checkForm(wc, pollMs);
  return r;
}

/** Flattens the checks into name -> boolean so repeated runs can be summarised as k/n. */
function flatten(run) {
  const flat = {};
  const s = run.stack;
  flat['stack: length 3'] = s.length === 3;
  flat['stack: active index 2'] = s.activeIndex === 2;
  flat['stack: canGoBack true'] = s.canGoBack === true;
  flat['stack: canGoForward false'] = s.canGoForward === false;
  flat['stack: titles preserved'] = s.titlesOk;
  const addPage = (label, p) => {
    flat[`${label}: URL correct`] = p.urlOk;
    if (p.scroll) flat[`${label}: scroll restored`] = p.scroll.ok;
    if (p.form) for (const [field, verdict] of Object.entries(p.form.final)) flat[`${label}: form #${field}`] = verdict === 'restored';
  };
  addPage('active', run.active);
  addPage('back 1', run.back1);
  addPage('back 2', run.back2);
  addPage('forward x2', run.forward2);
  return flat;
}

/**
 * One full cycle: build, snapshot, discard, restore, verify.
 * @param {{layout:string, mode:'full-settled'|'full-flushed'|'full-immediate'|'persisted', attach?:'after'|'before'|'before-hidden', pollMs?:number, hideSource?:boolean}} opts
 */
async function runFidelity(ctx, { layout, mode, attach = 'after', pollMs = 400, hideSource = false }) {
  const order = LAYOUTS[layout];
  const src = await buildSourceTab(ctx, layout, mode, { hideSource });
  const snap = mode === 'persisted' ? L.persistedStyle(src.snapshot) : src.snapshot;
  const discardMs = await L.discard(ctx.win, src.view);

  const restored = await L.restoreInto(ctx, snap, { attach });
  const wc = restored.wc;
  const run = { layout, mode, attach, expected: src.expected, build: src.build, discardMs, outcome: restored.outcome };

  const hist = L.summarizeHistory(wc);
  run.stack = {
    length: hist.length,
    activeIndex: hist.activeIndex,
    canGoBack: hist.canGoBack,
    canGoForward: hist.canGoForward,
    titles: hist.entries.map((e) => e.title),
    titlesOk: hist.entries.map((e) => e.title).join('|') === order.map((k) => pageTitles[k]).join('|'),
    urlsOk: hist.entries.map((e) => e.url).join('|') === order.map((k) => pagePaths[k]).join('|'),
  };
  run.historyAfterRestore = hist;
  // Does restore() hand the same pageState bytes back (non-active entries)?
  run.pageStateRoundTrip = wc.navigationHistory.getAllEntries().map((e, i) => (src.snapshot.entries[i].pageState === undefined ? null : e.pageState === src.snapshot.entries[i].pageState));

  if (run.outcome.status === 'resolved') {
    run.active = await checkPage(wc, order[2], src.expected, pollMs);
    run.backUrl1 = await L.navigateHistory(wc, 'back');
    run.back1 = await checkPage(wc, order[1], src.expected, pollMs);
    run.backUrl2 = await L.navigateHistory(wc, 'back');
    run.back2 = await checkPage(wc, order[0], src.expected, pollMs);
    await L.navigateHistory(wc, 'forward');
    await L.navigateHistory(wc, 'forward');
    run.forward2 = await checkPage(wc, order[2], src.expected, pollMs);
    run.finalHistory = L.summarizeHistory(wc);
    run.flat = flatten(run);
  } else {
    run.flat = {};
  }
  await L.discard(ctx.win, restored.view);
  return run;
}

/** Summarises many runs of the same configuration as { check: "k/n" } plus raw timing arrays. */
function summarizeRuns(runs) {
  const counts = {};
  for (const run of runs) {
    for (const [name, ok] of Object.entries(run.flat)) {
      counts[name] ??= { ok: 0, n: 0 };
      counts[name].n += 1;
      if (ok) counts[name].ok += 1;
    }
  }
  const checks = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, `${v.ok}/${v.n}`]));
  const settle = (pick) => runs.map(pick).filter((x) => typeof x === 'number');
  return {
    runs: runs.length,
    outcomes: runs.map((r) => r.outcome.status),
    checks,
    timings: {
      settledAfterEditMs: runs.map((r) => r.build.settledAfterEditMs ?? null),
      flushedAfterMs: runs.map((r) => r.build.flushedAfterMs ?? null),
      visibilityBeforeEdit: runs.map((r) => r.build.visibilityBeforeEdit ?? null),
      restoreSettledAtMs: runs.map((r) => r.outcome.settledAtMs ?? null),
      activeScrollSettleMs: runs.map((r) => r.active?.scroll?.settleMs ?? null),
      activeScrollAtLoad: runs.map((r) => r.active?.scroll?.atLoad ?? null),
      activeScrollExpected: runs.map((r) => r.active?.scroll?.expected ?? null),
      restoreSettledMedian: L.median(settle((r) => r.outcome.settledAtMs)),
    },
  };
}

module.exports = { LAYOUTS, pageUrls, pagePaths, pageTitles, buildSourceTab, runFidelity, summarizeRuns, checkPage, checkScroll, checkForm };
