'use strict';
// Q4: how stale can the active entry's pageState be?
//   part 'freshness': time from an edit until getAllEntries() shows a changed pageState, polled every 100 ms
//                     (<= 10 s), for a scroll and for a form edit, with the view attached and detached.
//   part 'triggers' : does removeChildView / setVisible(false) / blur / history.replaceState / navigating away
//                     force an immediate update?
// Every timing is recorded with document.visibilityState (the window is always-on-top so occlusion
// tracking does not hide the page behind the user's other windows; see L.setup).

const h = require('../shared/harness');
const L = require('./lib');
const S = require('./scenario');

const POLL_MS = 100;
const MAX_MS = 10_000;

/** Loads the page for `kind`, waits until its pageState is quiet, and returns the baseline. */
async function prepare(ctx, kind, { detach }) {
  const urls = S.pageUrls(ctx.fx);
  const view = h.createTabView(ctx.win);
  const wc = view.webContents;
  await wc.loadURL(kind === 'scroll' ? urls.C : urls.form);
  const quiet = await L.waitPageStateQuiet(wc);
  if (detach) ctx.win.contentView.removeChildView(view);
  return { view, wc, baseline: quiet.pageState, quietAfterMs: quiet.quietAfterMs };
}

/** Applies the edit and returns the performance.now() at which executeJavaScript resolved. */
async function edit(wc, kind) {
  if (kind === 'scroll') await L.scrollToParagraph(wc, 120);
  else await L.fillForm(wc);
  return performance.now();
}

async function freshnessTrial(ctx, kind, detached) {
  const { view, wc, baseline, quietAfterMs } = await prepare(ctx, kind, { detach: detached });
  const visibilityState = await L.visibility(wc);
  const t0 = await edit(wc, kind);
  let changedMs = null;
  let textMarkerMs = null;
  while (performance.now() - t0 <= MAX_MS) {
    const ps = L.activePageState(wc);
    const elapsed = Math.round(performance.now() - t0);
    if (changedMs === null && ps !== baseline) changedMs = elapsed;
    if (kind === 'form' && textMarkerMs === null && L.psHas(ps, L.FORM_VALUES.text)) textMarkerMs = elapsed;
    if (kind === 'scroll' ? changedMs !== null : textMarkerMs !== null) break;
    await h.sleep(POLL_MS);
  }
  // Which form fields end up in the blob? Give the page 3 s from the edit in total.
  let captured;
  if (kind === 'form') {
    const remaining = 3000 - (performance.now() - t0);
    if (remaining > 0) await h.sleep(remaining);
    const ps = L.activePageState(wc);
    captured = {
      text: L.psHas(ps, L.FORM_VALUES.text),
      area: L.psHas(ps, 'S2 area line one'),
      reactish: L.psHas(ps, L.FORM_VALUES.reactish),
      ce: L.psHas(ps, L.FORM_VALUES.ce),
    };
  }
  const result = { kind, detached, visibilityState, quietAfterMs, changedMs, ...(kind === 'form' ? { textMarkerMs, captured } : {}) };
  ctx.win.contentView.addChildView(view); // so destroyView's removeChildView is a clean no-op
  await L.discard(ctx.win, view);
  return result;
}

const stats = (xs) => ({ values: xs, median: L.median(xs), range: L.range(xs), neverWithin10s: xs.filter((x) => x === null).length });

async function runFreshness(ctx, rows, { attachedTrials = 5, detachedTrials = 3 } = {}) {
  const out = { pollMs: POLL_MS, maxMs: MAX_MS, trials: [] };
  const plan = [
    ['scroll', false, attachedTrials],
    ['form', false, attachedTrials],
    ['scroll', true, detachedTrials],
    ['form', true, detachedTrials],
  ];
  for (const [kind, detached, n] of plan) {
    const trials = [];
    for (let i = 0; i < n; i++) trials.push(await freshnessTrial(ctx, kind, detached));
    out.trials.push(...trials);
    const key = kind === 'scroll' ? 'changedMs' : 'textMarkerMs';
    const s = stats(trials.map((t) => t[key]));
    const label = `Q4 pageState freshness: ${kind} edit, view ${detached ? 'DETACHED (hidden)' : 'attached (visible)'}`;
    out[`${kind}-${detached ? 'detached' : 'attached'}`] = { ...s, metric: key, visibility: [...new Set(trials.map((t) => t.visibilityState))] };
    h.record(rows, label, { ms_to_change: s.values, median: s.median, range: s.range, visibility: out[`${kind}-${detached ? 'detached' : 'attached'}`].visibility }, null);
    if (kind === 'form') {
      const cap = trials.map((t) => t.captured);
      const all = (f) => cap.every((c) => c?.[f]);
      out[`${kind}-${detached ? 'detached' : 'attached'}`].capturedFields = { text: all('text'), area: all('area'), reactish: all('reactish'), ce: all('ce') };
      h.record(rows, `Q4 form fields present in pageState after 3 s (${detached ? 'detached' : 'attached'}), all trials`, out[`${kind}-${detached ? 'detached' : 'attached'}`].capturedFields, null);
    }
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// Triggers
// -------------------------------------------------------------------------------------------------

const TRIGGERS = {
  control: { note: 'no trigger (natural latency)', apply: async () => {} },
  removeChildView: { note: 'win.contentView.removeChildView(view)', apply: async ({ ctx, view }) => ctx.win.contentView.removeChildView(view) },
  setVisible: { note: 'view.setVisible(false)', apply: async ({ view }) => view.setVisible(false) },
  blur: { note: 'document.activeElement.blur() after focusing #text', apply: async ({ wc }) => wc.executeJavaScript('document.activeElement && document.activeElement.blur(); true') },
  replaceState: { note: 'history.replaceState(history.state, "") in the page (main world)', apply: async ({ wc }) => wc.executeJavaScript('history.replaceState(history.state, ""); true') },
  // Same call from an isolated world, which is where the lifecycle probe would run (ADR-0003 step 5.1; assessment 4.10).
  replaceStateIsolated: {
    note: 'history.replaceState(history.state, "") from an isolated world',
    apply: async ({ wc }) => wc.executeJavaScriptInIsolatedWorld(1001, [{ code: 'history.replaceState(history.state, ""); true' }]),
  },
};

/** Time-sampled check after a trigger; resolves with ms to first sign of the edit in pageState (null if none within `windowMs`). */
async function sampleAfter(wc, isFresh, t0, windowMs, intervalMs = 25) {
  while (performance.now() - t0 <= windowMs) {
    if (isFresh(L.activePageState(wc))) return Math.round(performance.now() - t0);
    await h.sleep(intervalMs);
  }
  return null;
}

async function triggerTrial(ctx, name, kind, { detach = false } = {}) {
  const { view, wc, baseline } = await prepare(ctx, kind, { detach });
  const isFresh = kind === 'scroll' ? (ps) => ps !== baseline : (ps) => L.psHas(ps, L.FORM_VALUES.text);
  if (name === 'blur') await wc.executeJavaScript("document.getElementById('text').focus(); true");
  const t0 = await edit(wc, kind);
  const result = { trigger: name, kind, editedWhileDetached: detach };
  if (name === 'navigateAway') {
    // The edited page becomes entry 0; read its pageState at the earliest moments we can observe.
    const at = {};
    const read = (label) => () => (at[label] = { ms: Math.round(performance.now() - t0), fresh: isFresh(wc.navigationHistory.getEntryAtIndex(0)?.pageState) });
    wc.once('did-start-navigation', read('didStartNavigation'));
    wc.once('did-navigate', read('didNavigate'));
    await wc.loadURL(ctx.fx.url('/article?n=20&title=elsewhere'));
    read('afterLoadResolved')();
    Object.assign(result, { reads: at, flushedAtNavigationCommit: at.didNavigate?.fresh ?? null });
  } else {
    // Side effects of the trigger that the page or our code could observe.
    let inPageNavigations = 0;
    wc.on('did-navigate-in-page', () => (inPageNavigations += 1));
    const before = { length: wc.navigationHistory.length(), url: wc.getURL(), pageHistoryLength: await wc.executeJavaScript('history.length') };
    const tApply = performance.now();
    await TRIGGERS[name].apply({ ctx, view, wc });
    result.applyTookMs = Math.round(performance.now() - tApply);
    result.visibilityState = await L.visibility(wc);
    result.freshAtMs = await sampleAfter(wc, isFresh, t0, 1500);
    const after = { length: wc.navigationHistory.length(), url: wc.getURL(), pageHistoryLength: await wc.executeJavaScript('history.length') };
    result.sideEffects = { didNavigateInPageEvents: inPageNavigations, historyUnchanged: before.length === after.length && before.url === after.url && before.pageHistoryLength === after.pageHistoryLength };
  }
  if (!wc.isDestroyed()) {
    ctx.win.contentView.addChildView(view); // so destroyView's removeChildView is a clean no-op
    await L.discard(ctx.win, view);
  }
  return result;
}

async function runTriggers(ctx, rows) {
  const out = { windowMs: 1500, trials: [] };
  const plan = [
    ['control', 'form', 2],
    ['removeChildView', 'form', 3],
    ['removeChildView', 'scroll', 3],
    ['setVisible', 'form', 2],
    ['blur', 'form', 2],
    ['replaceState', 'form', 3],
    ['replaceState', 'scroll', 3],
    ['replaceStateIsolated', 'form', 3],
    ['replaceStateIsolated', 'scroll', 3],
    ['replaceStateIsolated', 'form', 3, { detach: true }],
    ['replaceStateIsolated', 'scroll', 3, { detach: true }],
    ['control', 'form', 1, { detach: true }],
    ['navigateAway', 'form', 3],
    ['navigateAway', 'scroll', 3],
  ];
  for (const [name, kind, n, opts] of plan) {
    const trials = [];
    for (let i = 0; i < n; i++) trials.push(await triggerTrial(ctx, name, kind, opts));
    out.trials.push(...trials);
    const summary =
      name === 'navigateAway'
        ? { fresh_at_did_start_navigation: trials.map((t) => t.reads?.didStartNavigation?.fresh), fresh_at_did_navigate: trials.map((t) => t.flushedAtNavigationCommit), fresh_after_loadURL_resolved: trials.map((t) => t.reads?.afterLoadResolved?.fresh) }
        : {
            ms_until_fresh_within_1500: trials.map((t) => t.freshAtMs),
            visibility: [...new Set(trials.map((t) => t.visibilityState))],
            sideEffects: [...new Set(trials.map((t) => JSON.stringify(t.sideEffects)))],
          };
    h.record(rows, `Q4b ${name} (${kind} edit${opts?.detach ? ', view DETACHED/hidden while edited' : ''})`, summary, null, TRIGGERS[name]?.note ?? 'loadURL to another page; reads entry 0 (the edited page)');
  }
  return out;
}

async function run(ctx, rows, { part = 'freshness', reps = 3 } = {}) {
  return part === 'triggers' ? runTriggers(ctx, rows) : runFreshness(ctx, rows, { attachedTrials: Math.max(reps, 5), detachedTrials: reps });
}

module.exports = { run };
