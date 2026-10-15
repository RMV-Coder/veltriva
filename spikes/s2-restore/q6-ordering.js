'use strict';
// Q6: does restore() behave differently before any loadURL (the recommended order) vs after loadURL('about:blank')?
// The same full snapshot (A -> form -> C, settled) is restored under each precondition.

const h = require('../shared/harness');
const L = require('./lib');
const S = require('./scenario');

const VARIANTS = {
  'V0 restore() on a brand-new view (recommended)': { prepare: undefined },
  "V1 restore() after await loadURL('about:blank')": { prepare: (wc) => wc.loadURL('about:blank') },
  "V1b restore() right after loadURL('about:blank') without awaiting it": { prepare: async (wc) => void wc.loadURL('about:blank').catch(() => {}) },
  'V2 restore() after loading a real page (A)': { prepare: (wc, urls) => wc.loadURL(urls.A) },
};

async function oneRun(ctx, snapshot, expected, variant) {
  const urls = S.pageUrls(ctx.fx);
  const r = await L.restoreInto(ctx, snapshot, { attach: 'before', prepare: variant.prepare && ((wc) => variant.prepare(wc, urls)) });
  const run = { outcome: r.outcome, events: r.events.map((e) => `${e.t}ms ${e.name}`) };
  if (r.outcome.status === 'resolved') {
    // Give a not-awaited about:blank load time to interfere, then read the state.
    run.history = L.summarizeHistory(r.wc);
    run.activeUrl = L.stripOrigin(r.wc.getURL());
    run.active = await S.checkPage(r.wc, 'C', expected, 400);
    const len = run.history.length;
    // Walk back through whatever history exists and record the URLs seen.
    run.walk = [run.activeUrl];
    for (let i = 0; i < len - 1 && r.wc.navigationHistory.canGoBack(); i++) {
      run.walk.push(await L.navigateHistory(r.wc, 'back'));
      if (L.stripOrigin(r.wc.getURL()) === S.pagePaths.form) run.formAtBack = await S.checkForm(r.wc, 400);
      if (L.stripOrigin(r.wc.getURL()) === S.pagePaths.A) run.scrollAtA = await S.checkScroll(r.wc, expected.scroll.A, 400);
    }
  } else {
    await h.sleep(600); // a not-awaited load may still be in flight; look at what the tab ends up as
    run.state = { url: L.stripOrigin(r.wc.getURL()), history: L.summarizeHistory(r.wc) };
  }
  await L.discard(ctx.win, r.view);
  return run;
}

async function run(ctx, rows, { reps = 3 } = {}) {
  const src = await S.buildSourceTab(ctx, 'formMiddle', 'full-settled');
  const snapshot = src.snapshot;
  const expected = src.expected;
  await L.discard(ctx.win, src.view);
  const out = { expected, variants: {} };

  for (const [name, variant] of Object.entries(VARIANTS)) {
    const runs = [];
    for (let i = 0; i < reps; i++) runs.push(await oneRun(ctx, snapshot, expected, variant));
    const summary = {
      outcomes: runs.map((r) => r.outcome.status),
      errors: [...new Set(runs.map((r) => r.outcome.error).filter(Boolean))],
      historyLengths: runs.map((r) => r.history?.length ?? null),
      activeIndexes: runs.map((r) => r.history?.activeIndex ?? null),
      entryUrls: runs[0].history?.entries.map((e) => e.url),
      activeScrollRestored: runs.map((r) => r.active?.scroll?.ok ?? null),
      formRestoredAtBack1: runs.map((r) => (r.formAtBack ? r.formAtBack.final : null)).map((f) => f && `${Object.values(f).filter((v) => v === 'restored').length}/6 fields`),
      scrollRestoredAtA: runs.map((r) => r.scrollAtA?.ok ?? null),
      settledAtMs: runs.map((r) => r.outcome.settledAtMs ?? null),
      walk: runs[0].walk,
      stateAfterRejection: runs[0].state ? { url: runs[0].state.url, length: runs[0].state.history.length, activeIndex: runs[0].state.history.activeIndex, entries: runs[0].state.history.entries.map((e) => e.url) } : undefined,
    };
    out.variants[name] = { summary, runs };
    h.record(rows, `Q6 ${name}`, summary, null);
  }

  // Calling restore() a second time on a view that already restored.
  {
    const urls = S.pageUrls(ctx.fx);
    const r = await L.restoreInto(ctx, snapshot, { attach: 'before' });
    const second = {};
    let p;
    try {
      p = r.wc.navigationHistory.restore({ index: 0, entries: [{ url: urls.A, title: 'A' }] });
    } catch (error) {
      second.status = 'threw';
      second.error = String(error.message);
    }
    if (p) {
      const settled = await Promise.race([p.then(() => ({ status: 'resolved' }), (e) => ({ status: 'rejected', error: String(e.message) })), h.sleep(8000).then(() => ({ status: 'hung (8 s)' }))]);
      Object.assign(second, settled);
    }
    second.historyAfter = L.summarizeHistory(r.wc);
    out.secondRestoreOnRestoredView = { first: r.outcome, second };
    h.record(rows, 'Q6 second restore() on a view that already restored', { first: r.outcome.status, second: second.status, error: second.error, length: second.historyAfter.length, activeIndex: second.historyAfter.activeIndex }, null);
    await L.discard(ctx.win, r.view);
  }
  return out;
}

module.exports = { run };
