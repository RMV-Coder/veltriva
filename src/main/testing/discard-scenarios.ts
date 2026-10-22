// Lifecycle scenarios for the discard and restore of M3.1 (ADR-0008 4a, assessment §4.9, spikes
// S2 and S3), run without Playwright: its focus emulation keeps hidden tabs "visible", and the
// discard's flush, its close and the renderer's release are what these measure. Test builds only;
// ./lifecycle-scenarios.ts runs them. The fixture server's origin comes from the harness in
// VELTRIVA_FIXTURE_ORIGIN.
import { BaseWindow, app, screen } from 'electron';
import type { WebContents, WebContentsView } from 'electron';

import type { DiscardOutcome } from '../../core/lifecycle/discard';
import type { TabId } from '../tabs/tab-manager';
import type { ScenarioContext } from './lifecycle-scenarios';
import { recordedRuntimeTransitions } from './runtime-transitions';

export const FIXTURE_ORIGIN_ENV = 'VELTRIVA_FIXTURE_ORIGIN';

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** A fresh renderer on a loaded laptop can take seconds. */
const LOAD_TIMEOUT_MS = 30_000;

function fixtureUrl(path: string): string {
  const origin = process.env[FIXTURE_ORIGIN_ENV];
  if (origin === undefined || origin === '') {
    throw new Error(`${FIXTURE_ORIGIN_ENV} is not set: the harness starts the fixture server.`);
  }
  return `${origin}${path}`;
}

async function waitFor(
  what: string,
  done: () => boolean,
  timeoutMs = LOAD_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await wait(50);
  }
}

/** Waits until a tab shows `url` live and has stopped loading; returns its view. */
async function loaded(
  { tabs, views }: ScenarioContext,
  tabId: TabId,
  url: string,
): Promise<WebContentsView> {
  await waitFor(`${url} to load in ${tabId}`, () => {
    const tab = tabs.get(tabId);
    return tab.runtime === 'live' && !tab.loading && tab.url === url && views.has(tabId);
  });
  const view = views.get(tabId);
  if (view === undefined) {
    throw new Error(`Tab ${tabId} has no view`);
  }
  return view;
}

/** Opens a page in a new tab and waits for it to load. */
async function open(
  context: ScenarioContext,
  path: string,
  options: { readonly select: boolean },
): Promise<{ readonly tabId: TabId; readonly view: WebContentsView; readonly url: string }> {
  const url = fixtureUrl(path);
  const tabId = context.tabs.create({ select: options.select });
  context.tabs.navigate(tabId, url, { focus: false });
  return { tabId, view: await loaded(context, tabId, url), url };
}

/** The process ids of every renderer that is still running. */
function rendererPids(): Set<number> {
  return new Set(
    app
      .getAppMetrics()
      .filter((metric) => metric.type === 'Tab')
      .map((metric) => metric.pid),
  );
}

/** Edits a form by script in the page's own world: no user activation (S2's method). */
const EDIT_FORM = `(() => {
  const set = (id, value) => {
    const element = document.getElementById(id);
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  };
  set('text', 'edited text');
  set('area', 'edited area');
  set('sel', 'b');
  const check = document.getElementById('chk');
  check.checked = true;
  check.dispatchEvent(new Event('change', { bubbles: true }));
  window.scrollTo(0, 1500);
  return window.scrollY;
})()`;

const READ_FORM = `({
  text: document.getElementById('text').value,
  area: document.getElementById('area').value,
  sel: document.getElementById('sel').value,
  chk: document.getElementById('chk').checked,
  scrollY: window.scrollY,
  activated: navigator.userActivation.hasBeenActive,
})`;

/**
 * Two background tabs, edited (scrolled, a form filled by script) just before they are discarded
 * while hidden, then restored by selecting them. The discard's flush must have caught the edits
 * (a hidden tab's page state otherwise trails by about 5 s, S2), each renderer must be gone, and
 * the restore must bring back the scroll position and the form values (in this run only).
 */
export async function discardRestoresPageState(context: ScenarioContext): Promise<unknown> {
  const { main, tabs, views } = context;
  main.window.setAlwaysOnTop(true);
  const article = await open(context, '/lifecycle-article.html', { select: true });
  const scrolledTo = (await article.view.webContents.executeJavaScript(
    'window.scrollTo(0, 3000); window.scrollY',
  )) as number;
  const form = await open(context, '/lifecycle-form.html', { select: true });
  const formScrolledTo = (await form.view.webContents.executeJavaScript(EDIT_FORM)) as number;
  const pids = {
    article: article.view.webContents.getOSProcessId(),
    form: form.view.webContents.getOSProcessId(),
  };
  // A third tab takes the selection: the two are hidden now, and discarded at once.
  const other = tabs.create({ select: true });
  tabs.navigate(other, 'about:blank', { focus: false });
  const started = Date.now();
  // Retried like the scheduler would if a loaded machine keeps the probe from answering in time.
  const [articleDiscard, formDiscard] = await Promise.all([
    discardPatiently(context, article.tabId),
    discardPatiently(context, form.tabId),
  ]);
  const articleOutcome = articleDiscard.outcome;
  const formOutcome = formDiscard.outcome;
  const attempts = { article: articleDiscard.attemptMs, form: formDiscard.attemptMs };
  const discardMs = Date.now() - started;
  const afterDiscard = {
    article: { runtime: tabs.get(article.tabId).runtime, hasView: views.has(article.tabId) },
    form: { runtime: tabs.get(form.tabId).runtime, hasView: views.has(form.tabId) },
  };
  // The renderers exit shortly after their web contents closes.
  let running = rendererPids();
  const deadline = Date.now() + 10_000;
  while ((running.has(pids.article) || running.has(pids.form)) && Date.now() < deadline) {
    await wait(100);
    running = rendererPids();
  }
  const renderersGone = { article: !running.has(pids.article), form: !running.has(pids.form) };

  tabs.select(article.tabId);
  const restoredArticle = await loaded(context, article.tabId, article.url);
  // Scroll is applied once the page has laid out; give it a moment to settle.
  let articleScroll = 0;
  const scrollDeadline = Date.now() + 3000;
  while (Date.now() < scrollDeadline) {
    articleScroll = (await restoredArticle.webContents.executeJavaScript(
      'window.scrollY',
    )) as number;
    if (Math.abs(articleScroll - scrolledTo) <= 1) {
      break;
    }
    await wait(100);
  }
  tabs.select(form.tabId);
  const restoredForm = await loaded(context, form.tabId, form.url);
  let formState: { scrollY: number } & Record<string, unknown> = { scrollY: 0 };
  const formDeadline = Date.now() + 3000;
  while (Date.now() < formDeadline) {
    formState = (await restoredForm.webContents.executeJavaScript(READ_FORM)) as typeof formState;
    if (Math.abs(formState.scrollY - formScrolledTo) <= 1) {
      break;
    }
    await wait(100);
  }
  return {
    outcomes: { article: articleOutcome, form: formOutcome },
    attempts,
    discardMs,
    afterDiscard,
    renderersGone,
    article: { scrolledTo, restoredScroll: articleScroll },
    form: { scrolledTo: formScrolledTo, restored: formState },
  };
}

// ── Real input, as the S3 spike drove it ────────────────────────────────────────────────────────

/** Runs `code` in the page's own world with no user gesture (never `userGesture: true`: S3). */
function readPage(view: WebContentsView, code: string): Promise<unknown> {
  return view.webContents.executeJavaScript(code, false) as Promise<unknown>;
}

/** The center of the first element matching `selector`, scrolled into view, in the page's CSS pixels. */
async function elementCenter(
  view: WebContentsView,
  selector: string,
): Promise<{ readonly x: number; readonly y: number }> {
  const found = (await readPage(
    view,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (element === null) {
        return null;
      }
      element.scrollIntoView({ block: 'nearest' });
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`,
  )) as { x: number; y: number } | null;
  if (found === null) {
    throw new Error(`No element matches ${selector}`);
  }
  return { x: Math.round(found.x), y: Math.round(found.y) };
}

/** A real click: a mouse move, down and up sent with `sendInputEvent`, after giving the page the keyboard. */
async function realClick(view: WebContentsView, selector: string): Promise<void> {
  const { x, y } = await elementCenter(view, selector);
  const contents = view.webContents;
  contents.focus();
  contents.sendInputEvent({ type: 'mouseMove', x, y });
  contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
}

function pressKey(contents: WebContents, character: string): void {
  contents.sendInputEvent({ type: 'keyDown', keyCode: character });
  contents.sendInputEvent({ type: 'char', keyCode: character });
  contents.sendInputEvent({ type: 'keyUp', keyCode: character });
}

/** A form control's `value`, or a contenteditable region's text. */
async function fieldText(view: WebContentsView, selector: string): Promise<string> {
  return (await readPage(
    view,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      return element === null ? '' : 'value' in element ? element.value : element.textContent;
    })()`,
  )) as string;
}

const focusedId = async (view: WebContentsView): Promise<string> =>
  (await readPage(view, 'document.activeElement?.id ?? ""')) as string;

/**
 * Clicks the element and types `text` with real input events, then checks that the element had the
 * focus and the text arrived, and tries again if not: S3 saw `sendInputEvent` input dropped now and
 * then. Returns the attempt that worked (1 when the first did).
 */
async function typeInto(view: WebContentsView, selector: string, text: string): Promise<number> {
  const wanted = selector.slice(1);
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    if (attempt > 1) {
      // S3 saw input dropped now and then, with a window that said it was focused: ask again.
      for (const window of BaseWindow.getAllWindows()) {
        window.focus();
      }
    }
    await realClick(view, selector);
    if ((await focusedId(view)) === wanted) {
      for (const character of text) {
        pressKey(view.webContents, character);
      }
      await wait(100);
      if ((await fieldText(view, selector)).includes(text)) {
        return attempt;
      }
    }
    await wait(300);
  }
  const windowFocused = BaseWindow.getAllWindows().map((window) => window.isFocused());
  throw new Error(
    `Typing "${text}" into ${selector} did not arrive in 8 attempts: it holds ` +
      `"${await fieldText(view, selector)}", focus is on "${await focusedId(view)}", ` +
      `document.hasFocus() is ${String(await readPage(view, 'document.hasFocus()'))}, ` +
      `windows focused: ${windowFocused.join(', ')}`,
  );
}

/** An about:blank tab that stays in the background: somewhere else for the selection to go. */
async function openBlank(context: ScenarioContext): Promise<TabId> {
  const tabId = context.tabs.create({ select: false });
  context.tabs.navigate(tabId, 'about:blank', { focus: false });
  await loaded(context, tabId, 'about:blank');
  return tabId;
}

/** A discard that may have needed more than one try; see `discardPatiently`. */
interface PatientDiscard {
  readonly outcome: DiscardOutcome;
  readonly attempts: number;
  /** How long each attempt took: a missed 5 s wake-up shows as 5000 and more, a missed 100 ms probe as less. */
  readonly attemptMs: readonly number[];
}

/**
 * Discards as the scheduler will (an explicit request here), but gives a page that did not answer
 * in time (`blocked` with `probe-unanswered`) up to three more tries, as the next evaluation would:
 * on a loaded laptop the probe's 100 ms budget is sometimes missed even after the wake-up (M3.1
 * measured 4 to 60 ms on a quiet one). Anything else is final. Every attempt is reported.
 */
async function discardPatiently(context: ScenarioContext, tabId: TabId): Promise<PatientDiscard> {
  const attemptMs: number[] = [];
  for (let attempt = 1; ; attempt += 1) {
    const started = Date.now();
    const outcome = await context.tabs.discard(tabId, { origin: 'user' });
    attemptMs.push(Date.now() - started);
    const unanswered = outcome.outcome === 'blocked' && outcome.reason === 'probe-unanswered';
    if (!unanswered || attempt === 4) {
      return { outcome, attempts: attempt, attemptMs };
    }
    await wait(1000);
  }
}

/** What a tab looks like after a discard attempt. */
function stateOf(context: ScenarioContext, tabId: TabId) {
  return {
    runtime: context.tabs.get(tabId).runtime,
    hasView: context.views.has(tabId),
    learned: context.tabs.lifecycleFacts(tabId).learned,
  };
}

// ── a. beforeunload on a hidden tab, with real input (S3 part A) ─────────────────────────────────

/**
 * Presses a key with nothing focused (so no field changes), until the page has seen a trusted
 * keydown: returns the attempt that worked.
 */
async function pressKeyOnPage(view: WebContentsView): Promise<number> {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    view.webContents.focus();
    pressKey(view.webContents, 'x');
    await wait(150);
    if (((await readPage(view, 'window.__veltrivaUnload.keys')) as number) >= 1) {
      return attempt;
    }
    await wait(300);
  }
  throw new Error('The key press did not reach the page in 5 attempts');
}

/**
 * `beforeunload` on a hidden tab, with real input (S3 part A), in three kinds of page:
 *  - `mode=dirty`, typed into: the probe finds the field changed, so the tab is kept for its
 *    unsaved input before the page is asked (its handler is never run);
 *  - `mode=keys`, a key pressed with no field focused: no field changed, so only the page's own
 *    `beforeunload` can keep the tab. It does, with no dialog and no window added, and the page
 *    lives on;
 *  - `mode=always`, never touched: it gets no say and is discarded.
 */
export async function discardBeforeUnloadHidden(context: ScenarioContext): Promise<unknown> {
  const { main, tabs } = context;
  main.window.setAlwaysOnTop(true);
  const otherTab = await openBlank(context);
  const windowsBefore = BaseWindow.getAllWindows().length;
  const unload = (view: WebContentsView): Promise<unknown> =>
    readPage(view, 'window.__veltrivaUnload');

  const dirty = await open(context, '/lifecycle-unload.html?mode=dirty', { select: true });
  const dirtyAttempts = await typeInto(dirty.view, '#text', 'hi');
  const dirtyActivated = await readPage(dirty.view, 'navigator.userActivation.hasBeenActive');
  tabs.select(otherTab);
  const dirtyDiscard = await discardPatiently(context, dirty.tabId);
  const dirtyAfter = {
    ...dirtyDiscard,
    ...stateOf(context, dirty.tabId),
    activated: dirtyActivated,
    inputAttempts: dirtyAttempts,
    answers: await readPage(dirty.view, '1 + 1'),
    text: await fieldText(dirty.view, '#text'),
    unload: await unload(dirty.view),
    windows: BaseWindow.getAllWindows().length,
  };

  const keys = await open(context, '/lifecycle-unload.html?mode=keys', { select: true });
  const keysAttempts = await pressKeyOnPage(keys.view);
  const keysActivated = await readPage(keys.view, 'navigator.userActivation.hasBeenActive');
  tabs.select(otherTab);
  const keysDiscard = await discardPatiently(context, keys.tabId);
  const keysAfter = {
    ...keysDiscard,
    ...stateOf(context, keys.tabId),
    activated: keysActivated,
    inputAttempts: keysAttempts,
    answers: await readPage(keys.view, '1 + 1'),
    unload: await unload(keys.view),
    windows: BaseWindow.getAllWindows().length,
  };

  const always = await open(context, '/lifecycle-unload.html?mode=always', { select: true });
  const alwaysActivated = await readPage(always.view, 'navigator.userActivation.hasBeenActive');
  tabs.select(otherTab);
  const alwaysDiscard = await discardPatiently(context, always.tabId);
  const alwaysAfter = {
    ...alwaysDiscard,
    ...stateOf(context, always.tabId),
    activated: alwaysActivated,
    windows: BaseWindow.getAllWindows().length,
  };
  return { windowsBefore, dirty: dirtyAfter, keys: keysAfter, always: alwaysAfter };
}

// ── b. Real typing the probe must catch ─────────────────────────────────────────────────────────

/**
 * Real typing into a plain field, into a React-style input and into a contenteditable region that
 * was blurred afterwards, each on a tab of its own, then hidden and discarded: every one is kept
 * for its unsaved input (S3 part C and its trusted-input tracker).
 */
export async function discardRealInputKept(context: ScenarioContext): Promise<unknown> {
  const { main, tabs } = context;
  main.window.setAlwaysOnTop(true);
  const otherTab = await openBlank(context);
  const cases = [
    { name: 'text', selector: '#text', text: 'hi', blur: false },
    { name: 'reactish', selector: '#reactish', text: 'hello', blur: false },
    { name: 'contenteditable', selector: '#ce', text: 'hello', blur: true },
  ] as const;

  const prepared: {
    readonly name: string;
    readonly tabId: TabId;
    readonly view: WebContentsView;
    readonly selector: string;
    readonly typed: string;
    readonly focusedAfter: string;
    readonly activated: unknown;
    readonly typingAttempts: number;
  }[] = [];
  for (const { name, selector, text, blur } of cases) {
    const page = await open(context, '/lifecycle-form.html', { select: true });
    const typingAttempts = await typeInto(page.view, selector, text);
    if (blur) {
      // A real click on the heading takes the focus away: the region is no longer focused (S3).
      await realClick(page.view, '#heading');
    }
    prepared.push({
      name,
      tabId: page.tabId,
      view: page.view,
      selector,
      typed: await fieldText(page.view, selector),
      focusedAfter: await focusedId(page.view),
      activated: await readPage(page.view, 'navigator.userActivation.hasBeenActive'),
      typingAttempts,
    });
  }
  tabs.select(otherTab);
  const results = [];
  for (const tab of prepared) {
    // One at a time: three wake-ups at once are what a loaded laptop cannot answer in time.
    const discard = await discardPatiently(context, tab.tabId);
    results.push({
      name: tab.name,
      typed: tab.typed,
      focusedAfter: tab.focusedAfter,
      activated: tab.activated,
      typingAttempts: tab.typingAttempts,
      ...discard,
      ...stateOf(context, tab.tabId),
    });
  }
  return results;
}

// ── c. Restoring in the background (S2's scale-factor trap) ─────────────────────────────────────

/** `window.scrollY` until it is within a pixel of `expected`, or the last reading after `timeoutMs`. */
async function settledScroll(
  view: WebContentsView,
  expected: number,
  timeoutMs = 4000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let scroll = -1;
  while (Date.now() < deadline) {
    scroll = (await readPage(view, 'window.scrollY')) as number;
    if (Math.abs(scroll - expected) <= 1) {
      break;
    }
    await wait(100);
  }
  return scroll;
}

/**
 * The article is scrolled far and discarded; then a reload, with another tab selected, restores it
 * in the background (TabManager attaches the view invisibly first, S2). Once it has loaded, its
 * scroll is read while still hidden and again after the tab is selected. A restore into a view
 * that is not attached puts the scroll off by the display's scale factor (6416 became 8020 at
 * 125 %), and never corrects it.
 */
export async function backgroundRestoreScroll(context: ScenarioContext): Promise<unknown> {
  const { main, tabs, views } = context;
  main.window.setAlwaysOnTop(true);
  const otherTab = await openBlank(context);
  const article = await open(context, '/lifecycle-article.html', { select: true });
  const scrolledTo = (await readPage(
    article.view,
    'window.scrollTo(0, 4000); window.scrollY',
  )) as number;
  tabs.select(otherTab);
  const discard = await discardPatiently(context, article.tabId);
  const afterDiscard = stateOf(context, article.tabId);

  // The restore starts with another tab selected.
  const selectedDuringRestore = tabs.selectedTabId();
  tabs.reload(article.tabId);
  const restoringView = views.get(article.tabId);
  const attachedWhileRestoring =
    restoringView !== undefined && main.window.contentView.children.includes(restoringView);
  const restored = await loaded(context, article.tabId, article.url);
  const hiddenScroll = await settledScroll(restored, scrolledTo);
  const stillHidden = tabs.selectedTabId() === otherTab;

  tabs.select(article.tabId);
  const shownScroll = await settledScroll(restored, scrolledTo);
  return {
    ...discard,
    afterDiscard,
    scrolledTo,
    selectedDuringRestore: selectedDuringRestore === otherTab,
    attachedWhileRestoring,
    stillHidden,
    hiddenScroll,
    shownScroll,
    scaleFactor: screen.getPrimaryDisplay().scaleFactor,
    devicePixelRatio: await readPage(restored, 'window.devicePixelRatio'),
    activated: await readPage(restored, 'navigator.userActivation.hasBeenActive'),
  };
}

// ── d. The freeze experiment (off by default in the app) ────────────────────────────────────────

/** What the counting page logs every 100 ms; main counts the console messages, not the page. */
const TICK_MESSAGE = 'veltriva-tick';

/**
 * Freezing a hidden tab (`tabs.freeze`, CDP `Page.setWebLifecycleState`): a page logs a line every
 * 100 ms and main counts them, since a frozen page can't be asked anything. Visible it logs about
 * 20 a second; hidden and live it is throttled; frozen it should log none; selecting it thaws it
 * and it runs again. A frozen tab can still be discarded: the discard thaws it first (unload
 * handlers need a running page). Facts are reported as measured.
 */
export async function freezeExperiment(context: ScenarioContext): Promise<unknown> {
  const { main, tabs } = context;
  main.window.setAlwaysOnTop(true);
  const otherTab = await openBlank(context);
  const page = await open(context, '/lifecycle-form.html', { select: true });
  const contents = page.view.webContents;
  let ticks = 0;
  contents.on('console-message', (event) => {
    if (event.message === TICK_MESSAGE) {
      ticks += 1;
    }
  });
  await readPage(
    page.view,
    `setInterval(() => console.log(${JSON.stringify(TICK_MESSAGE)}), 100); true`,
  );
  const ticksOver = async (ms: number): Promise<number> => {
    const before = ticks;
    await wait(ms);
    return ticks - before;
  };
  const windowMs = 3000;

  const visibleTicks = await ticksOver(windowMs);
  tabs.select(otherTab);
  await wait(1500); // Let Chromium notice that the page is hidden.
  const hiddenLiveTicks = await ticksOver(windowMs);

  // The control: a live tab that is shown again runs at full speed, with no freeze involved.
  tabs.select(page.tabId);
  const reshownTicks = await ticksOver(2000);
  const visibilityReshown = await readPage(page.view, 'document.visibilityState');
  tabs.select(otherTab);
  await wait(1500);

  const freezeStarted = Date.now();
  const freezeOutcome = await tabs.freeze(page.tabId);
  const freezeMs = Date.now() - freezeStarted;
  const runtimeAfterFreeze = tabs.get(page.tabId).runtime;
  await wait(500); // A tick that was already queued may still arrive.
  const frozenTicks = await ticksOver(windowMs);

  // Selecting the tab thaws it, in the same call.
  tabs.select(page.tabId);
  const runtimeAfterSelect = tabs.get(page.tabId).runtime;
  const visibilityAfterThaw = await readPage(page.view, 'document.visibilityState');
  const resumedTicks = await ticksOver(2000);
  const resumedTicksLater = await ticksOver(2000);
  const answersAfterThaw = await readPage(page.view, '1 + 1');

  // A frozen tab is discarded: thawed first, then probed and closed. On a loaded machine the page
  // can take longer than the wake-up deadline to run again, and the discard then keeps the tab
  // (`probe-unanswered`, live and thawed); the attempts are all reported, up to three.
  tabs.select(otherTab);
  await wait(500);
  const frozenDiscards: {
    readonly freeze: unknown;
    readonly runtimeBefore: string;
    readonly outcome: unknown;
    readonly ms: number;
  }[] = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const freeze = await tabs.freeze(page.tabId);
    const runtimeBefore = tabs.get(page.tabId).runtime;
    const started = Date.now();
    const outcome = await tabs.discard(page.tabId, { origin: 'user' });
    frozenDiscards.push({ freeze, runtimeBefore, outcome, ms: Date.now() - started });
    if ((outcome as { outcome: string }).outcome === 'discarded') {
      break;
    }
    await wait(1000);
  }
  return {
    windowMs,
    visibleTicks,
    hiddenLiveTicks,
    reshownTicks,
    visibilityReshown,
    freezeOutcome,
    freezeMs,
    runtimeAfterFreeze,
    frozenTicks,
    runtimeAfterSelect,
    visibilityAfterThaw,
    resumedTicks,
    resumedTicksLater,
    answersAfterThaw,
    frozenDiscards,
    afterDiscard: stateOf(context, page.tabId),
    events: recordedRuntimeTransitions()
      .filter((transition) => transition.tabId === page.tabId)
      .map((transition) => transition.event),
  };
}
