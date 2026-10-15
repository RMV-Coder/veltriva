'use strict';
// Helpers private to spike S3 (unsaved-work detection). Main-process only.

const { app, session } = require('electron');
const path = require('node:path');
const h = require('../shared/harness');

const { sleep } = h;

// ---------------------------------------------------------------------------------------
// Lock-down: deny every permission (including openExternal), block popups and navigation
// away from the local fixture server.
// ---------------------------------------------------------------------------------------

/** Returns a log of everything that was denied, so the run can prove nothing slipped through. */
function lockDown() {
  const denied = [];
  const ses = session.fromPartition(h.TAB_PREFS.partition);
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    denied.push({ kind: 'request', permission, requestingUrl: details?.requestingUrl });
    callback(false);
  });
  ses.setPermissionCheckHandler((_wc, permission) => {
    denied.push({ kind: 'check', permission });
    return false;
  });
  ses.setDevicePermissionHandler(() => false);
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => {
      if (!/^http:\/\/(127\.0\.0\.1|[ab]\.test)(:\d+)?\//.test(url)) {
        denied.push({ kind: 'navigation', url });
        event.preventDefault();
      }
    });
  });
  return denied;
}

// ---------------------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------------------

const round = (n, digits = 1) => (n == null ? n : Math.round(n * 10 ** digits) / 10 ** digits);

/** median / min / max / n, rounded to 0.1 ms. Ignores null entries (and reports how many were null). */
function stats(values) {
  const nums = values.filter((v) => typeof v === 'number').sort((a, b) => a - b);
  if (!nums.length) return { n: 0, missing: values.length };
  const mid = Math.floor(nums.length / 2);
  const median = nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
  return {
    n: nums.length,
    missing: values.length - nums.length,
    median: round(median),
    min: round(nums[0]),
    max: round(nums[nums.length - 1]),
  };
}

// ---------------------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------------------

const windowOf = new WeakMap();

/**
 * sendInputEvent is silently dropped unless the window is focused (Electron docs), and other
 * processes (for example another spike's window) can take OS focus mid-run. Call before input.
 */
async function ensureFocus(wc, tries = 15) {
  const win = windowOf.get(wc);
  for (let i = 0; i < tries; i += 1) {
    if (win.isFocused() && wc.isFocused()) return true;
    win.show();
    win.focus();
    win.moveTop();
    wc.focus();
    await sleep(100);
  }
  return win.isFocused() && wc.isFocused();
}

/** Loads `url` into a fresh attached tab view and waits until it has finished loading. */
async function openTab(win, url, { attach = true, focus = true } = {}) {
  const view = h.createTabView(win, { attach });
  const wc = view.webContents;
  windowOf.set(wc, win);
  await wc.loadURL(url);
  if (attach && focus) await ensureFocus(wc);
  return { view, wc };
}

function detach(win, view) {
  win.contentView.removeChildView(view);
}

function attach(win, view) {
  win.contentView.addChildView(view);
}

/**
 * Removes the view from the window and destroys its web contents without waiting for beforeunload.
 * Takes the { view, wc } pair from openTab(): view.webContents is undefined once destroyed.
 */
function dispose(win, { view, wc }) {
  try {
    win.contentView.removeChildView(view);
  } catch {
    /* already detached */
  }
  if (!wc.isDestroyed()) wc.close();
}

/** Evaluates in the page's main world, no user gesture. */
const evalMain = (wc, code) => wc.executeJavaScript(code, false);

/** Bounding box of a DOM element in CSS pixels (== DIPs at zoom 1), plus its centre. */
function rectOf(wc, selector) {
  return evalMain(
    wc,
    `(() => {
      const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    })()`,
  );
}

/** Reads navigator.userActivation without causing activation. */
const userActivation = (wc) =>
  evalMain(wc, `({ hasBeenActive: navigator.userActivation.hasBeenActive, isActive: navigator.userActivation.isActive })`);

// ---------------------------------------------------------------------------------------
// Scripted input via webContents.sendInputEvent
// ---------------------------------------------------------------------------------------

async function click(wc, x, y, { move = false, holdMs = 20 } = {}) {
  await ensureFocus(wc);
  if (move) wc.sendInputEvent({ type: 'mouseMove', x, y });
  wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  await sleep(holdMs);
  wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  await sleep(30);
}

/** keyDown + char + keyUp for each character. */
async function typeText(wc, text, { gapMs = 15 } = {}) {
  await ensureFocus(wc);
  for (const ch of text) {
    wc.sendInputEvent({ type: 'keyDown', keyCode: ch });
    wc.sendInputEvent({ type: 'char', keyCode: ch });
    wc.sendInputEvent({ type: 'keyUp', keyCode: ch });
    await sleep(gapMs);
  }
}

/** keyDown + keyUp for a named key such as 'Down' or 'Tab' (no char event). */
async function pressKey(wc, keyCode) {
  await ensureFocus(wc);
  wc.sendInputEvent({ type: 'keyDown', keyCode });
  wc.sendInputEvent({ type: 'keyUp', keyCode });
  await sleep(30);
}

// ---------------------------------------------------------------------------------------
// Routed input through the Chrome DevTools Protocol. sendInputEvent only reaches the root widget,
// so this is how the spike drives input inside a cross-process iframe (see part B).
// ---------------------------------------------------------------------------------------

/** Attaches the debugger for the duration of `fn`. */
async function withDebugger(wc, fn) {
  wc.debugger.attach('1.3');
  try {
    return await fn();
  } finally {
    try {
      wc.debugger.detach();
    } catch {
      /* already detached */
    }
  }
}

/** mouseMoved + mousePressed + mouseReleased at (x, y) in main-frame CSS pixels (needs the debugger attached). */
async function cdpClick(wc, x, y) {
  const send = (params) => wc.debugger.sendCommand('Input.dispatchMouseEvent', params);
  await send({ type: 'mouseMoved', x, y });
  await send({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await send({ type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

/**
 * CDP-clicks (x, y) until `selector` is the active element inside `childFrame`. A click sent right after the
 * iframe loads can be routed to the parent because the browser has no hit-test data for the child yet,
 * so wait first and retry. Returns the number of clicks it took, or false.
 */
async function cdpFocusChildInput(wc, childFrame, selector, x, y, { tries = 6 } = {}) {
  await sleep(400);
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    await cdpClick(wc, x, y);
    await sleep(100);
    const focused = await childFrame.executeJavaScript(`Boolean(document.activeElement && document.activeElement.matches(${JSON.stringify(selector)}))`);
    if (focused) return attempt;
    await sleep(300);
  }
  return false;
}

/** keyDown (with text) + keyUp for each character, to whichever widget has focus (needs the debugger attached). */
async function cdpType(wc, text) {
  for (const ch of text) {
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, unmodifiedText: ch });
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
  }
}

/**
 * Clicks the centre of `selector` and types `text`, verifying that the text reached the element
 * (input/textarea value or contenteditable text) and retrying if it did not (lost window focus).
 * Returns { rect, attempts, focusOk, typed, failed }.
 */
async function clickAndType(wc, selector, text, { maxAttempts = 5 } = {}) {
  const read = () =>
    evalMain(wc, `(() => { const e = document.querySelector(${JSON.stringify(selector)}); return e.value !== undefined ? e.value : e.textContent; })()`);
  let rect;
  let focusOk;
  let typed;
  const diag = [];
  for (let attempts = 1; attempts <= maxAttempts; attempts += 1) {
    focusOk = await ensureFocus(wc);
    rect = await rectOf(wc, selector);
    await click(wc, rect.cx, rect.cy);
    await typeText(wc, text);
    typed = await read();
    diag.push({
      attempt: attempts,
      ensureFocusOk: focusOk,
      windowFocused: windowOf.get(wc).isFocused(),
      webContentsFocused: wc.isFocused(),
      documentHasFocus: await evalMain(wc, 'document.hasFocus()'),
      visibilityState: await evalMain(wc, 'document.visibilityState'),
      windowMinimized: windowOf.get(wc).isMinimized(),
      typed,
    });
    if (typeof typed === 'string' && typed.includes(text)) return { rect, attempts, focusOk, typed, failed: false, diag };
    await sleep(attempts * 500); // input was dropped; the environment may be busy (other spikes share this desktop), back off
  }
  return { rect, attempts: maxAttempts, focusOk, typed, failed: true, diag, electronProcesses: await countElectronProcesses() };
}

/** Number of electron.exe processes on the machine (other spikes running concurrently show up here). */
function countElectronProcesses() {
  return new Promise((resolve) => {
    require('node:child_process').execFile('tasklist', ['/FI', 'IMAGENAME eq electron.exe', '/FO', 'CSV', '/NH'], { windowsHide: true }, (error, stdout) => {
      resolve(error ? null : stdout.split('\n').filter((line) => line.includes('electron.exe')).length);
    });
  });
}

// ---------------------------------------------------------------------------------------
// Closing and observing
// ---------------------------------------------------------------------------------------

/**
 * Calls webContents.close() and records what Electron does afterwards.
 * @param {Electron.WebContents} wc
 * @param {{waitForBeforeUnload?:boolean, preventDefault?:boolean, observeMs?:number}} opts
 *   preventDefault: call event.preventDefault() inside the will-prevent-unload handler.
 *   observeMs: how long to keep watching (the call returns early once destroyed).
 */
async function closeAndObserve(wc, { waitForBeforeUnload = false, preventDefault = false, observeMs = 3000, midpoint } = {}) {
  const rec = {
    option: waitForBeforeUnload ? { waitForBeforeUnload: true } : 'none',
    preventDefaultInHandler: preventDefault,
    willPreventUnloadCount: 0,
    willPreventUnloadAtMs: null,
    destroyedEventAtMs: null,
    isDestroyedRightAfterCall: null,
    isDestroyedAtEnd: null,
    midpointResult: null,
  };
  const t0 = performance.now();
  const onPrevent = (event) => {
    rec.willPreventUnloadCount += 1;
    rec.willPreventUnloadAtMs ??= round(performance.now() - t0, 2);
    if (preventDefault) event.preventDefault();
  };
  wc.on('will-prevent-unload', onPrevent);
  const onDestroyed = () => {
    rec.destroyedEventAtMs = round(performance.now() - t0, 2);
  };
  wc.once('destroyed', onDestroyed);

  wc.close(waitForBeforeUnload ? { waitForBeforeUnload: true } : undefined);
  rec.isDestroyedRightAfterCall = wc.isDestroyed();

  const deadline = t0 + observeMs;
  let midpointDone = false;
  while (performance.now() < deadline && rec.destroyedEventAtMs == null) {
    await sleep(10);
    if (midpoint && !midpointDone && performance.now() - t0 > observeMs / 2) {
      midpointDone = true;
      rec.midpointResult = await midpoint();
    }
  }
  rec.isDestroyedAtEnd = wc.isDestroyed();
  rec.observedForMs = round(performance.now() - t0, 0);
  try {
    wc.removeListener('will-prevent-unload', onPrevent);
    wc.removeListener('destroyed', onDestroyed); // do not let a later close() rewrite this record
  } catch {
    /* destroyed wrapper */
  }
  return rec;
}

/** Beacons added to fixture.beacons since `startIndex`, reduced to what matters. */
function beaconsSince(fixture, startIndex) {
  return fixture.beacons.slice(startIndex).map((b) => ({
    event: b.query.event,
    mode: b.query.mode,
    dirty: b.query.dirty,
    objected: b.query.objected,
    host: b.host,
  }));
}

// ---------------------------------------------------------------------------------------
// Native window enumeration (evidence for "did a modal dialog appear?")
// ---------------------------------------------------------------------------------------

/**
 * Wraps list-windows.ps1, a long-running PowerShell helper that lists the top-level native windows
 * owned by this process via user32 EnumWindows. Compiling the helper takes ~10 s, so start() early
 * and await ready() only when the first listing is needed. The helper exits when stdin closes.
 */
class WindowWatcher {
  constructor() {
    this.child = null;
    this.buffer = '';
    this.waiters = [];
  }

  start() {
    const { spawn } = require('node:child_process');
    this.child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'list-windows.ps1')],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] },
    );
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        this.waiters.shift()?.(line);
      }
    });
    this.child.on('exit', () => {
      while (this.waiters.length) this.waiters.shift()(null);
    });
    this.readyPromise = new Promise((resolve) => this.waiters.push(resolve));
    return this;
  }

  /** Resolves true when the helper printed READY, false on timeout or failure. */
  async ready(timeoutMs = 60_000) {
    const line = await Promise.race([this.readyPromise, sleep(timeoutMs).then(() => 'timeout')]);
    return line === 'READY';
  }

  /** Visible top-level windows of this process as "class|title|owned=bool" strings (hidden helper windows omitted). */
  async list() {
    if (!this.child || this.child.killed) return { error: 'watcher not running' };
    const answer = new Promise((resolve) => this.waiters.push(resolve));
    this.child.stdin.write(`${process.pid}\n`);
    const line = await Promise.race([answer, sleep(10_000).then(() => 'timeout')]);
    try {
      return JSON.parse(line).filter((w) => w.visible).map((w) => `${w.class}|${w.title}|owned=${w.owned}`);
    } catch {
      return { error: `bad answer: ${String(line).slice(0, 100)}` };
    }
  }

  stop() {
    try {
      this.child?.stdin.end();
      this.child?.kill();
    } catch {
      /* already gone */
    }
  }
}

module.exports = {
  lockDown,
  stats,
  round,
  openTab,
  ensureFocus,
  detach,
  attach,
  dispose,
  evalMain,
  rectOf,
  userActivation,
  click,
  typeText,
  pressKey,
  clickAndType,
  withDebugger,
  cdpClick,
  cdpFocusChildInput,
  cdpType,
  closeAndObserve,
  beaconsSince,
  WindowWatcher,
};
