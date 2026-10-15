'use strict';
// Q5: does restore() resolve on load and reject on failure, and what state does it leave behind?

const h = require('../shared/harness');
const L = require('./lib');
const S = require('./scenario');

const withTimeout = (promise, ms, label = 'timeout') => Promise.race([promise, h.sleep(ms).then(() => ({ __timeout: label }))]);

/** What the web contents looks like after a restore attempt. Page-world reads are time-boxed: a view without a document never answers. */
async function describeState(wc) {
  if (wc.isDestroyed()) return { destroyed: true };
  const state = {
    url: L.stripOrigin(wc.getURL()),
    title: wc.getTitle(),
    isLoading: wc.isLoading(),
    isCrashed: wc.isCrashed(),
    history: (({ length, activeIndex, canGoBack, canGoForward, entries }) => ({ length, activeIndex, canGoBack, canGoForward, entries: entries.map((e) => `${e.url} [${e.title}]`) }))(L.summarizeHistory(wc)),
  };
  const page = await withTimeout(
    wc.executeJavaScript('({ href: location.href, title: document.title, text: document.body ? document.body.innerText.slice(0, 120) : null })'),
    2000,
  );
  state.page = page.__timeout ? 'executeJavaScript did not answer within 2 s' : page;
  return state;
}

/** Runs one restore attempt in a fresh attached view and reports the outcome, events and final state. */
async function attempt(ctx, label, snap, { after } = {}) {
  const r = await L.restoreInto(ctx, snap, { attach: 'before' });
  const hung = r.outcome.status === undefined;
  const result = { label, outcome: r.outcome, events: r.events.map((e) => `${e.t}ms ${e.name}${e.detail ? ` ${JSON.stringify(e.detail)}` : ''}`) };
  if (!hung) result.state = await describeState(r.wc);
  if (after && !r.wc.isDestroyed()) result.after = await after(r.wc);
  if (!r.wc.isDestroyed()) await L.discard(ctx.win, r.view);
  return result;
}

async function run(ctx, rows) {
  const out = { cases: {} };
  const urls = S.pageUrls(ctx.fx);
  const dead = ctx.fx.url('/never-served').replace(/:\d+/, `:${await L.closedPort()}`); // closed port on loopback
  const entry = (url, title) => ({ url, title });
  const A = entry(urls.A, 'A');
  const C = entry(urls.C, 'C');
  const missing = entry(ctx.fx.url('/missing-404'), 'missing');
  const deadEntry = entry(dead, 'dead');
  const goodSingle = { index: 0, entries: [A] };
  const reg = async (key, p) => (out.cases[key] = await p);

  // --- Success reference ---------------------------------------------------------------------
  await reg('success', attempt(ctx, 'single good entry', goodSingle));

  // --- Closed port -----------------------------------------------------------------------------
  await reg('closedPortSingle', attempt(ctx, 'single entry, closed port', { index: 0, entries: [deadEntry] }));
  await reg(
    'closedPortMiddle',
    attempt(ctx, 'A, dead (active), C', { index: 1, entries: [A, deadEntry, C] }, {
      after: async (wc) => {
        // Can the tab recover through its own history, and what does retrying on the same web contents do?
        const back = await withTimeout(L.navigateHistory(wc, 'back'), 5000);
        const afterBack = { loaded: back.__timeout ? 'timeout' : back, history: L.summarizeHistory(wc) };
        const fwd = await withTimeout(L.navigateHistory(wc, 'forward').catch((e) => `error: ${e.message}`), 5000);
        const afterForward = { loaded: fwd.__timeout ? 'timeout (did-finish-load never fired: error page?)' : fwd, url: L.stripOrigin(wc.getURL()) };
        return { afterBack: { loaded: afterBack.loaded, activeIndex: afterBack.history.activeIndex }, afterForwardToDead: afterForward };
      },
    }),
  );
  await reg(
    'retryOnSameWebContentsAfterFailure',
    attempt(ctx, 'restore dead, then restore good entries into the SAME web contents', { index: 0, entries: [deadEntry] }, {
      after: async (wc) => {
        const second = {};
        let p;
        try {
          p = wc.navigationHistory.restore({ index: 0, entries: [A] });
        } catch (error) {
          second.status = 'threw';
          second.error = String(error.message);
        }
        if (p) {
          const settled = await withTimeout(p.then(() => 'resolved', (e) => `rejected: ${e.message}`), 8000);
          second.status = settled.__timeout ? 'hung (8 s)' : settled;
        }
        second.stateAfterSecondRestore = await describeState(wc);
        // And the plain alternative: loadURL on the same web contents.
        const loaded = await withTimeout(wc.loadURL(urls.C).then(() => 'resolved', (e) => `rejected: ${e.message}`), 8000);
        return { secondRestore: second, loadURLAfterwards: loaded.__timeout ? 'hung' : loaded, urlAfterLoadURL: L.stripOrigin(wc.getURL()) };
      },
    }),
  );

  // --- HTTP 404 --------------------------------------------------------------------------------
  await reg('http404Single', attempt(ctx, 'single entry, HTTP 404', { index: 0, entries: [missing] }));
  await reg('http404Middle', attempt(ctx, 'A, 404 (active), C', { index: 1, entries: [A, missing, C] }));

  // --- Slow entry: when exactly does restore() settle relative to the load events? --------------
  await reg('slow1500ms', attempt(ctx, 'single entry, /slow?ms=1500', { index: 0, entries: [entry(ctx.fx.url('/slow?ms=1500'), 'slow')] }));

  // --- Invalid input (what if persisted data is damaged?) ----------------------------------------
  const invalid = {
    indexTooLarge: { index: 3, entries: [A] },
    indexNegative: { index: -1, entries: [A] },
    emptyEntries: { index: 0, entries: [] },
    unparsableUrl: { index: 0, entries: [entry('not a url', 'junk')] },
    garbagePageStateBase64: { index: 0, entries: [{ ...A, pageState: 'AAAAAAAA' }] },
    garbagePageStateNotBase64: { index: 0, entries: [{ ...A, pageState: '!!! not base64 !!!' }] },
    emptyPageState: { index: 0, entries: [{ ...A, pageState: '' }] },
    missingTitle: { index: 0, entries: [{ url: A.url }] },
    emptyTitle: { index: 0, entries: [{ url: A.url, title: '' }] },
    pageStateNull: { index: 0, entries: [{ ...A, pageState: null }] },
    pageStateExplicitUndefined: { index: 0, entries: [{ ...A, pageState: undefined }] },
    emptyUrl: { index: 0, entries: [{ url: '', title: 'empty url' }] },
    missingUrl: { index: 0, entries: [{ title: 'no url' }] },
  };
  out.invalid = {};
  for (const [key, snap] of Object.entries(invalid)) {
    out.invalid[key] = await withTimeout(attempt(ctx, key, snap), 20000, `attempt ${key} hung`);
  }

  // --- Records ---------------------------------------------------------------------------------
  const c = out.cases;
  const short = (r) => `${r.outcome.status}${r.outcome.error ? ` (${r.outcome.error})` : ''} after ${r.outcome.settledAtMs} ms`;
  h.record(rows, 'Q5 restore() on a good entry', short(c.success), c.success.outcome.status === 'resolved');
  h.record(rows, 'Q5 restore() when the active entry points at a closed port', short(c.closedPortSingle), c.closedPortSingle.outcome.status === 'rejected', JSON.stringify(c.closedPortSingle.events));
  h.record(rows, 'Q5 state after the closed-port rejection', c.closedPortSingle.state, null);
  h.record(rows, 'Q5 closed port in the middle of three entries', { outcome: short(c.closedPortMiddle), state: c.closedPortMiddle.state, after: c.closedPortMiddle.after }, null);
  h.record(rows, 'Q5 retry on the same web contents after a failure', c.retryOnSameWebContentsAfterFailure.after, null);
  h.record(rows, 'Q5 restore() when the active entry is an HTTP 404 page', short(c.http404Single), null, 'HTTP errors are still successful loads');
  h.record(rows, 'Q5 404 events', c.http404Single.events, null);
  h.record(rows, 'Q5 404 state', c.http404Middle.state, null);
  h.record(rows, 'Q5 slow entry: settle time vs load events', { outcome: short(c.slow1500ms), events: c.slow1500ms.events }, null);
  for (const [key, r] of Object.entries(out.invalid)) {
    h.record(rows, `Q5 invalid input: ${key}`, r.__timeout ? r : { outcome: short(r), state: r.state && { url: r.state.url, history: r.state.history } }, null);
  }
  return out;
}

module.exports = { run };
