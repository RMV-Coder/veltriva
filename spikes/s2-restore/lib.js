'use strict';
// Helpers shared by the S2 experiments (restore fidelity of navigationHistory.restore()).
// Main-process only. Everything here talks to our own fixture pages on the local fixture server.

const { app, session } = require('electron');
const net = require('node:net');
const h = require('../shared/harness');
const { startFixtureServer } = require('../shared/fixture-server');

/** Values we write into form.html. All differ from the fixture's initial values. */
const FORM_VALUES = Object.freeze({
  text: 'S2 text value',
  area: 'S2 area line one\nS2 area line two',
  sel: 'b',
  chk: true,
  reactish: 'S2 react value',
  ce: 'S2 contenteditable content',
});
/** Initial values of form.html, to tell "reset to initial" apart from "something else". */
const FORM_INITIAL = Object.freeze({ text: 'initial', area: 'initial area', sel: 'a', chk: false, reactish: '', ce: 'editable region' });

// ---------------------------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------------------------

/**
 * Denies every permission (including 'openExternal'), blocks window.open, and cancels any HTTP(S)/WS
 * request that is not to loopback / *.test. Installed before any page is loaded.
 */
function lockDownSessions() {
  const blocked = [];
  const permissionRequests = [];
  const isLocalHost = (host) => host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host.endsWith('.test');
  for (const ses of [session.defaultSession, session.fromPartition(h.TAB_PREFS.partition)]) {
    ses.setPermissionRequestHandler((_wc, permission, callback) => {
      permissionRequests.push(permission);
      callback(false);
    });
    ses.setPermissionCheckHandler(() => false);
    ses.setDevicePermissionHandler(() => false);
    ses.webRequest.onBeforeRequest((details, callback) => {
      let allow = true;
      try {
        const u = new URL(details.url);
        if (/^(https?|wss?|ftp):$/.test(u.protocol)) allow = isLocalHost(u.hostname);
      } catch {
        allow = false;
      }
      if (!allow) blocked.push(details.url);
      callback({ cancel: !allow });
    });
  }
  app.on('web-contents-created', (_event, wc) => wc.setWindowOpenHandler(() => ({ action: 'deny' })));
  return { blocked, permissionRequests };
}

/**
 * Fixture server + one small always-on-top window (so Windows occlusion tracking does not mark the
 * page hidden and distort page-state timings; see the coordinator note in the S2 brief).
 */
async function setup() {
  const guard = lockDownSessions();
  const fx = await startFixtureServer();
  const win = h.createWindow({ width: 800, height: 600, show: false, title: 'S2 restore spike' });
  win.setAlwaysOnTop(true);
  win.showInactive();
  await h.sleep(1000); // let occlusion tracking settle
  return { fx, win, guard };
}

/** A TCP port that was just free: a connection to it is refused. */
function closedPort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const median = (xs) => {
  const s = xs.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const range = (xs) => {
  const s = xs.filter((x) => x !== null && x !== undefined);
  return s.length ? [Math.min(...s), Math.max(...s)] : null;
};
const now = () => Math.round(performance.now());

// ---------------------------------------------------------------------------------------------
// pageState utilities (pageState is a base64 string of Chromium's serialized PageState)
// ---------------------------------------------------------------------------------------------

const psBuffer = (ps) => Buffer.from(ps ?? '', 'base64');
/** Decoded size in bytes, or null when the entry has no pageState. */
const psBytes = (ps) => (typeof ps === 'string' && ps.length ? psBuffer(ps).length : null);
/**
 * True when the decoded blob contains `text` as UTF-16LE or Latin-1. Form values are serialized as
 * UTF-16 strings inside the blob, so a distinctive value works as a marker that the value was captured.
 */
function psHas(ps, text) {
  if (typeof ps !== 'string' || !ps.length) return false;
  const buf = psBuffer(ps);
  return buf.includes(Buffer.from(text, 'utf16le')) || buf.includes(Buffer.from(text, 'latin1'));
}

const origin = (fx) => new URL(fx.url('/')).origin;
const stripOrigin = (url) => url.replace(/^http:\/\/[^/]+/, '');

/** Plain copy of the current history: what ADR-0003 step 5.2 snapshots. */
function snapshotHistory(wc) {
  const nh = wc.navigationHistory;
  return {
    index: nh.getActiveIndex(),
    entries: nh.getAllEntries().map((e) => ({ url: e.url, title: e.title, pageState: e.pageState })),
  };
}
/** "Persisted-style" snapshot: only what ADR-0003 persists (no pageState). */
const persistedStyle = (snap) => ({ index: snap.index, entries: snap.entries.map(({ url, title }) => ({ url, title })) });

/** Readable summary of a web contents' navigation history. */
function summarizeHistory(wc) {
  const nh = wc.navigationHistory;
  return {
    length: nh.length(),
    activeIndex: nh.getActiveIndex(),
    canGoBack: nh.canGoBack(),
    canGoForward: nh.canGoForward(),
    entries: nh.getAllEntries().map((e) => ({
      url: stripOrigin(e.url),
      title: e.title,
      pageStateType: e.pageState === undefined ? 'undefined' : typeof e.pageState,
      pageStateBase64Chars: typeof e.pageState === 'string' ? e.pageState.length : null,
      pageStateBytes: psBytes(e.pageState),
    })),
  };
}

const activePageState = (wc) => wc.navigationHistory.getEntryAtIndex(wc.navigationHistory.getActiveIndex())?.pageState;

// ---------------------------------------------------------------------------------------------
// Page state: set and read through the page's main world (our own fixture pages)
// ---------------------------------------------------------------------------------------------

const visibility = (wc) => wc.executeJavaScript('document.visibilityState');

/** Scrolls an article to paragraph `n`; returns the offsetTop and the scrollY actually reached. */
function scrollToElement(wc, id) {
  return wc.executeJavaScript(`(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    window.scrollTo(0, el.offsetTop);
    return { target: el.offsetTop, scrollY: window.scrollY };
  })()`);
}
const scrollToParagraph = (wc, n) => scrollToElement(wc, `p${n}`);
/** Scrolls to an absolute Y. Pick a value well inside the page: a position at the bottom is clamped and proves little. */
function scrollToY(wc, y) {
  return wc.executeJavaScript(`(() => { window.scrollTo(0, ${Number(y)}); return { target: ${Number(y)}, scrollY: window.scrollY }; })()`);
}
const readScrollY = (wc) => wc.executeJavaScript('window.scrollY');

/** Programmatic edit of every control on form.html, with input/change events (our own page). */
function fillForm(wc, v = FORM_VALUES) {
  return wc.executeJavaScript(`(() => {
    const v = ${JSON.stringify(v)};
    const $ = (id) => document.getElementById(id);
    const fire = (el, types) => types.forEach((t) => el.dispatchEvent(new Event(t, { bubbles: true })));
    $('text').value = v.text; fire($('text'), ['input', 'change']);
    $('area').value = v.area; fire($('area'), ['input', 'change']);
    $('sel').value = v.sel; fire($('sel'), ['input', 'change']);
    $('chk').checked = v.chk; fire($('chk'), ['input', 'change']);
    $('reactish').value = v.reactish; fire($('reactish'), ['input', 'change']); // listener syncs the value attribute
    $('ce').textContent = v.ce; fire($('ce'), ['input']);
    return true;
  })()`);
}
/** Edits only #text (programmatic), for the freshness measurements. */
function fillTextOnly(wc, value) {
  return wc.executeJavaScript(`(() => {
    const t = document.getElementById('text');
    t.value = ${JSON.stringify(value)};
    t.dispatchEvent(new Event('input', { bubbles: true }));
    t.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
}
function readForm(wc) {
  return wc.executeJavaScript(`(() => {
    const $ = (id) => document.getElementById(id);
    return { text: $('text').value, area: $('area').value, sel: $('sel').value, chk: $('chk').checked,
             reactish: $('reactish').value, ce: $('ce').textContent };
  })()`);
}
/** Per-field verdict: 'restored' (equals what we typed), 'initial' (reset to fixture default) or 'other'. */
function classifyForm(actual) {
  const out = {};
  for (const k of Object.keys(FORM_VALUES)) {
    out[k] = actual[k] === FORM_VALUES[k] ? 'restored' : actual[k] === FORM_INITIAL[k] ? 'initial' : 'other';
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------------------------

/** goBack/goForward/goToIndex and wait for loading to stop. Resolves with the resulting URL (origin stripped). */
async function navigateHistory(wc, action, arg) {
  const loaded = h.waitFor(wc, 'did-stop-loading', 10000); // fires for failed loads too
  const nh = wc.navigationHistory;
  if (action === 'back') nh.goBack();
  else if (action === 'forward') nh.goForward();
  else nh.goToIndex(arg);
  await loaded;
  return stripOrigin(wc.getURL());
}

/**
 * Waits until `predicate(activePageState)` holds, polling every `intervalMs`.
 * Returns the elapsed ms since `t0` (or null on timeout).
 */
async function waitPageState(wc, predicate, { t0 = performance.now(), timeoutMs = 10000, intervalMs = 100 } = {}) {
  const deadline = t0 + timeoutMs;
  for (;;) {
    if (predicate(activePageState(wc))) return Math.round(performance.now() - t0);
    if (performance.now() >= deadline) return null;
    await h.sleep(intervalMs);
  }
}

/**
 * After a load, the active entry's pageState settles about 1 s later (a first periodic commit).
 * Wait until it has not changed for `quietMs` so a later change can be attributed to our edit.
 */
async function waitPageStateQuiet(wc, { quietMs = 1300, timeoutMs = 8000, intervalMs = 50 } = {}) {
  const t0 = performance.now();
  let last = activePageState(wc);
  let lastChange = t0;
  while (performance.now() - t0 < timeoutMs) {
    await h.sleep(intervalMs);
    const cur = activePageState(wc);
    if (cur !== last) {
      last = cur;
      lastChange = performance.now();
    }
    if (performance.now() - lastChange >= quietMs) return { quietAfterMs: Math.round(lastChange - t0), pageState: last };
  }
  return { quietAfterMs: null, pageState: last };
}

// ---------------------------------------------------------------------------------------------
// Discard / restore
// ---------------------------------------------------------------------------------------------

/** The shared destroyView rule from ADR-0002, plus a wait for the `destroyed` event. Returns ms taken. */
async function discard(win, view) {
  const wc = view.webContents;
  const t0 = performance.now();
  const destroyed = h.waitFor(wc, 'destroyed', 10000);
  h.destroyView(win, view);
  await destroyed;
  return Math.round(performance.now() - t0);
}

const WATCHED_EVENTS = ['did-start-loading', 'dom-ready', 'did-finish-load', 'did-stop-loading', 'did-frame-finish-load', 'page-title-updated'];

/** Records loading events with timestamps relative to `clock.t0`, so we can compare them with restore()'s settle time. */
function instrument(wc) {
  const clock = { t0: performance.now() };
  const events = [];
  const push = (name, detail) => events.push({ t: Math.round((performance.now() - clock.t0) * 10) / 10, name, ...(detail ? { detail } : {}) });
  for (const name of WATCHED_EVENTS) {
    wc.on(name, (...args) => {
      if (name === 'did-frame-finish-load') return push(name, { isMainFrame: args[1] });
      if (name === 'page-title-updated') return push(name, { title: args[1] });
      push(name);
    });
  }
  wc.on('did-start-navigation', (details) => push('did-start-navigation', { url: stripOrigin(details.url), isMainFrame: details.isMainFrame }));
  wc.on('did-navigate', (_e, url, httpResponseCode, httpStatusText) => push('did-navigate', { url: stripOrigin(url), httpResponseCode, httpStatusText }));
  wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) =>
    push('did-fail-load', { errorCode, errorDescription, validatedURL: stripOrigin(validatedURL), isMainFrame }),
  );
  return { events, clock, mark: push };
}

/**
 * Creates a view and restores `snap` into it.
 *  - attach: 'after' (default; ADR-0003 step order: create, restore, then attach),
 *            'before' (attach to the window, visible, then restore),
 *            'before-hidden' (attach, then view.setVisible(false), then restore: a background restore)
 *  - prepare(wc): runs before restore (e.g. loadURL('about:blank'))
 * Never throws: a synchronous throw, a rejection or a resolution is reported as `outcome`.
 */
async function restoreInto(ctx, snap, { attach = 'after', prepare } = {}) {
  const view = h.createTabView(ctx.win, { attach: attach !== 'after' });
  if (attach === 'before-hidden') view.setVisible(false);
  const wc = view.webContents;
  const { events, clock, mark } = instrument(wc);
  if (prepare) await prepare(wc);
  clock.t0 = performance.now();
  events.length = 0;
  const outcome = {};
  let promise;
  try {
    promise = wc.navigationHistory.restore({ index: snap.index, entries: snap.entries });
    outcome.returnedPromise = typeof promise?.then === 'function';
  } catch (error) {
    outcome.status = 'threw';
    outcome.error = String(error?.message ?? error);
  }
  if (promise) {
    try {
      await promise;
      outcome.status = 'resolved';
    } catch (error) {
      outcome.status = 'rejected';
      outcome.error = String(error?.message ?? error);
    }
    outcome.settledAtMs = Math.round(performance.now() - clock.t0);
    mark(`>>> restore() promise ${outcome.status}`); // ordered among the load events, to see which event settles it
  }
  if (attach === 'after' && !wc.isDestroyed()) ctx.win.contentView.addChildView(view);
  return { view, wc, outcome, events };
}

module.exports = {
  FORM_VALUES,
  FORM_INITIAL,
  setup,
  closedPort,
  median,
  range,
  now,
  psBuffer,
  psBytes,
  psHas,
  origin,
  stripOrigin,
  snapshotHistory,
  persistedStyle,
  summarizeHistory,
  activePageState,
  visibility,
  scrollToElement,
  scrollToParagraph,
  scrollToY,
  readScrollY,
  fillForm,
  fillTextOnly,
  readForm,
  classifyForm,
  navigateHistory,
  waitPageState,
  waitPageStateQuiet,
  discard,
  instrument,
  restoreInto,
};
