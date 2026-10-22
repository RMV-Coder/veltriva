// Discarding a background tab, M3.1 (assessment §4.9 and §4.10, ADR-0003, spikes S2 and S3): the
// scheduler (M3.2) will free a hidden tab's renderer, and selecting the tab restores it with its
// back/forward stack, and, in this run only, its scroll position and plain form values. These specs
// ask TabManager for the same discard through the `discardTab` hook and check the answer, the
// tab's state, what the probe learned, and what comes back.
//
// Rules from ADR-0008 item 4 that matter here:
//  - Every case discards a tab that is NOT selected: another tab (the new-tab page the app starts
//    with) is selected first. Nothing asserts what a hidden page does through Playwright (its focus
//    emulation masks it); that belongs to the lifecycle harness (tests/lifecycle/discard.test.ts).
//  - Edits made "as a script" go through `evaluateInTab`, i.e. `webContents.executeJavaScript` in
//    the page's own world with no user gesture: Playwright's `evaluate` runs with a gesture and
//    would give the page user activation, which the probe reads as "the user was here" (S3).
//  - Real typing and clicks are `sendInputEvent` from main (`sendKey`, `clickElement`), never
//    Playwright's keyboard, and a spec checks that the text arrived before it goes on (S3 saw
//    input dropped now and then).
//  - Pages come from the local fixture server (tests/fixtures/pages/lifecycle-*.html). A discard
//    takes a few seconds on this machine (the first script call into a just-hidden tab is
//    scheduled after 1 to 2.5 s), so no timeout here is tight.
import { setTimeout as delay } from 'node:timers/promises';

import type { ElectronApplication, Page } from '@playwright/test';

import type { DiscardOutcome, DiscardRequest } from '../../src/core/lifecycle/discard';
import type { LifecycleFacts, RuntimeTransition } from '../../src/main/tabs/tab-manager';
import type { FixtureServer } from '../fixtures/server';
import { expect } from './expect';
import { allWindows, clickElement, evaluateInTab, selectedTabId, sendKey, tabState } from './hooks';
import type { TabId } from './hooks';
import { expectVisits, visitList } from './memory-ui';
import { profileDbBytes, readProfileDb } from './profile-db';
import { expectSaved, startWithPages, test } from './session-ui';
import type { Launcher, RunningApp } from './session-ui';
import { expectConsistent, loadInNewTab, sidebarIds, tabElement, waitForLoaded } from './shell-ui';

// Each test starts the app once or twice, and a discard takes seconds on a loaded machine.
test.describe.configure({ timeout: 180_000 });

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────

/** The app and its shell, plus the new-tab page the app starts with, the "other" tab. */
interface Rig extends RunningApp {
  readonly blank: TabId;
}

async function launchWithBlank(launcher: Launcher): Promise<Rig> {
  const run = await launcher.launch();
  const ids = await sidebarIds(run.shell);
  const [blank] = ids;
  if (ids.length !== 1 || blank === undefined) {
    throw new Error(`The app starts with one tab, not ${String(ids.length)}.`);
  }
  return { ...run, blank };
}

/** Clicks the tab in the sidebar and waits until main has it selected. */
async function selectTab(app: ElectronApplication, shell: Page, tabId: TabId): Promise<void> {
  await tabElement(shell, tabId).click();
  await expect
    .poll(() => selectedTabId(app), { message: `tab ${tabId} should become the selected tab` })
    .toBe(tabId);
}

/** The id of a tab's web contents; throws if it has none (it is unloaded). */
async function contentsOf(app: ElectronApplication, tabId: TabId): Promise<number> {
  const state = await tabState(app, tabId);
  if (state?.webContentsId === null || state?.webContentsId === undefined) {
    throw new Error(`Tab ${tabId} has no web contents.`);
  }
  return state.webContentsId;
}

/** One discard request: an explicit one unless `request` says otherwise. */
function discardOnce(
  app: ElectronApplication,
  tabId: TabId,
  request?: Partial<DiscardRequest>,
): Promise<DiscardOutcome> {
  return app.evaluate(
    (_electron, args) => {
      const hooks = globalThis.__veltrivaTest;
      if (hooks === undefined) {
        throw new Error('The test hooks are missing: this is not a test build.');
      }
      return hooks.discardTab(args.tabId, args.request);
    },
    { tabId, request },
  );
}

interface Discarded {
  readonly outcome: DiscardOutcome;
  /** How many requests it took: more than one when the page did not answer in time. */
  readonly attempts: number;
}

/**
 * Discards a tab as the scheduler will, but gives a page that did not answer in time (`blocked`
 * with `probe-unanswered`) up to three more tries, as the next evaluation would. On a loaded
 * laptop the probe's 100 ms budget is sometimes missed even after the wake-up (M3.1 measured
 * 4 to 60 ms on a quiet one), and that says nothing about what a spec checks. Any other answer is
 * final. A retry is recorded as an annotation of the test, so an intermittent stays visible.
 */
async function discardWithAttempts(
  app: ElectronApplication,
  tabId: TabId,
  request?: Partial<DiscardRequest>,
): Promise<Discarded> {
  for (let attempts = 1; ; attempts += 1) {
    const outcome = await discardOnce(app, tabId, request);
    const unanswered = outcome.outcome === 'blocked' && outcome.reason === 'probe-unanswered';
    if (!unanswered || attempts === 4) {
      if (attempts > 1) {
        test.info().annotations.push({
          type: 'discard-retried',
          description: `Tab ${tabId}: ${String(attempts)} requests were needed; the last answered ${JSON.stringify(outcome)}.`,
        });
      }
      return { outcome, attempts };
    }
    await delay(1_000);
  }
}

async function discard(
  app: ElectronApplication,
  tabId: TabId,
  request?: Partial<DiscardRequest>,
): Promise<DiscardOutcome> {
  return (await discardWithAttempts(app, tabId, request)).outcome;
}

/**
 * The runtime events of `attempts` requests for one tab: each that kept the page is a `discard`
 * and a `discardBlocked`, and the last ends as `last`.
 */
function discardEvents(attempts: number, last: 'discardBlocked' | 'discarded'): string[] {
  return [
    ...Array.from({ length: attempts - 1 }, () => ['discard', 'discardBlocked']).flat(),
    'discard',
    last,
  ];
}

function lifecycleFacts(app: ElectronApplication, tabId: TabId): Promise<LifecycleFacts> {
  return app.evaluate((_electron, id) => {
    const hooks = globalThis.__veltrivaTest;
    if (hooks === undefined) {
      throw new Error('The test hooks are missing: this is not a test build.');
    }
    return hooks.lifecycleFacts(id);
  }, tabId);
}

function transitionsOf(app: ElectronApplication, tabId: TabId): Promise<RuntimeTransition[]> {
  return app.evaluate((_electron, id) => {
    const hooks = globalThis.__veltrivaTest;
    if (hooks === undefined) {
      throw new Error('The test hooks are missing: this is not a test build.');
    }
    return hooks.runtimeTransitions(id);
  }, tabId);
}

/** The runtime events a tab went through after the first `already` transitions. */
async function eventsSince(
  app: ElectronApplication,
  tabId: TabId,
  already: number,
): Promise<string[]> {
  return (await transitionsOf(app, tabId)).slice(already).map((transition) => transition.event);
}

/** The OS process id of a web contents' renderer. */
function rendererPid(app: ElectronApplication, contentsId: number): Promise<number> {
  return app.evaluate(({ webContents }, id) => {
    const pid = webContents.fromId(id)?.getOSProcessId();
    if (pid === undefined) {
      throw new Error(`No web contents ${String(id)}.`);
    }
    return pid;
  }, contentsId);
}

/** Every process the app has right now (`app.getAppMetrics()`). */
function runningProcessIds(app: ElectronApplication): Promise<number[]> {
  return app.evaluate(({ app: electronApp }) =>
    electronApp.getAppMetrics().map((metric) => metric.pid),
  );
}

/** The renderer exits shortly after its web contents closes. */
async function expectProcessGone(app: ElectronApplication, pid: number): Promise<void> {
  await expect
    .poll(() => runningProcessIds(app), {
      message: `renderer ${String(pid)} should be gone from app.getAppMetrics()`,
      timeout: 30_000,
    })
    .not.toContain(pid);
}

/** The tab is unloaded: no web contents, no view, still a web tab with its address and title. */
async function expectUnloaded(
  app: ElectronApplication,
  tabId: TabId,
  expected: { readonly url: string; readonly title: string },
): Promise<void> {
  expect(await tabState(app, tabId)).toMatchObject({
    runtime: 'unloaded',
    webContentsId: null,
    attached: false,
    loading: false,
    page: { kind: 'web' },
    ...expected,
  });
}

/** The tab is live and kept its web contents, hidden. */
async function expectKept(app: ElectronApplication, tabId: TabId, contentsId: number) {
  expect(await tabState(app, tabId)).toMatchObject({
    runtime: 'live',
    webContentsId: contentsId,
    attached: false,
  });
}

const pageValue = (app: ElectronApplication, contentsId: number, code: string): Promise<unknown> =>
  evaluateInTab(app, contentsId, code);

/** Whether the page has had user activation since it loaded (what the probe reads, S3). */
async function hasBeenActive(app: ElectronApplication, contentsId: number): Promise<boolean> {
  return (await pageValue(app, contentsId, 'navigator.userActivation.hasBeenActive')) === true;
}

/** A field's text: `value` for a form control, `textContent` for a contenteditable region. */
async function fieldText(
  app: ElectronApplication,
  contentsId: number,
  selector: string,
): Promise<string> {
  return (await pageValue(
    app,
    contentsId,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      return element === null ? null : 'value' in element ? element.value : element.textContent;
    })()`,
  )) as string;
}

/** The id of the element that has focus in the page, or '' for none. */
async function focusedId(app: ElectronApplication, contentsId: number): Promise<string> {
  return (await pageValue(app, contentsId, 'document.activeElement?.id ?? ""')) as string;
}

/**
 * Types `text` into the element for real: a click on it (a mouse move, down and up from main) and
 * then one key press per character (`sendInputEvent`), as the S3 spike did. The tab must be
 * attached and selected. It checks that the element got the focus and that the text arrived, and
 * tries again if not (S3: input is dropped now and then).
 */
async function typeInto(
  app: ElectronApplication,
  contentsId: number,
  selector: string,
  text: string,
): Promise<void> {
  const wanted = selector.slice(1);
  let problem = '';
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      // Into view first: a click lands only on what the viewport shows.
      await pageValue(
        app,
        contentsId,
        `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'nearest' })`,
      );
      await clickElement(app, contentsId, selector);
      const focused = await focusedId(app, contentsId);
      if (focused === wanted) {
        for (const character of text) {
          await sendKey(app, contentsId, character);
        }
        const held = await fieldText(app, contentsId, selector);
        if (held.includes(text)) {
          return;
        }
        problem = `the field holds "${held}"`;
      } else {
        problem = `the click left the focus on "${focused}"`;
      }
    } catch (error) {
      // The geometry says why a click could not be aimed (S3: be ready for input that fails).
      problem = `${error instanceof Error ? error.message : String(error)}: ${await describeElement(app, contentsId, selector)}`;
    }
    await delay(500);
  }
  throw new Error(`Typing "${text}" into ${selector} did not arrive in 5 attempts: ${problem}`);
}

/** Where an element is in the viewport and what is at its center, for a failure message. */
async function describeElement(
  app: ElectronApplication,
  contentsId: number,
  selector: string,
): Promise<string> {
  return JSON.stringify(
    await pageValue(
      app,
      contentsId,
      `(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (element === null) {
          return 'no such element';
        }
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return {
          viewport: [innerWidth, innerHeight],
          scrollY,
          rect: [rect.left, rect.top, rect.width, rect.height],
          hit: hit === null ? null : hit.tagName + '#' + hit.id,
          readyState: document.readyState,
        };
      })()`,
    ),
  );
}

/** Edits the form page as a script would: no gesture, so no user activation (S2). */
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

interface FormReading {
  readonly text: string;
  readonly area: string;
  readonly sel: string;
  readonly chk: boolean;
  readonly scrollY: number;
  readonly activated: boolean;
}

/** The beforeunload reports the unload fixture sent for a tag (`?tag=` in its address). */
function beaconsFor(server: FixtureServer, tag: string): { event: string; objected: string }[] {
  return server
    .requestsTo('/lifecycle-beacon')
    .map((request) => new URL(request.url, 'http://fixture.invalid').searchParams)
    .filter((query) => query.get('tag') === tag)
    .map((query) => ({ event: query.get('event') ?? '', objected: query.get('objected') ?? '' }));
}

const KEPT_UNSAVED_INPUT: DiscardOutcome = { outcome: 'blocked', reason: 'unsaved-input' };
const DISCARDED: DiscardOutcome = { outcome: 'discarded' };

// ── 1. A discard frees the renderer; selecting the tab brings the page state back ───────────────

test.describe('discard and restore, in this run', () => {
  test('frees the renderer of a hidden tab, and selecting it brings back scroll and plain form values', async ({
    launcher,
    fixtureServer,
  }) => {
    const articleUrl = fixtureServer.url('/lifecycle-article.html?case=lifecycle-restore');
    const formUrl = fixtureServer.url('/lifecycle-form.html?case=lifecycle-restore');
    const { app, shell, blank } = await launchWithBlank(launcher);

    // The article is scrolled far while it is shown, as a reader would.
    const articleTab = await loadInNewTab(app, shell, articleUrl);
    const articleContents = await contentsOf(app, articleTab);
    const articleScrolled = (await pageValue(
      app,
      articleContents,
      'window.scrollTo(0, 6000); window.scrollY',
    )) as number;
    expect(articleScrolled).toBeGreaterThan(3000);

    // The form is edited after its tab is hidden, right before the discard: a hidden page's state
    // trails by about 5 s (S2), so only the probe's flush can have caught these edits.
    const formTab = await loadInNewTab(app, shell, formUrl);
    const formContents = await contentsOf(app, formTab);
    await selectTab(app, shell, blank);
    const formScrolled = (await pageValue(app, formContents, EDIT_FORM)) as number;
    expect(formScrolled).toBeGreaterThan(1000);
    expect(await hasBeenActive(app, formContents)).toBe(false);

    const pids = {
      form: await rendererPid(app, formContents),
      article: await rendererPid(app, articleContents),
    };

    expect(await discard(app, formTab)).toEqual(DISCARDED);
    expect(await discard(app, articleTab)).toEqual(DISCARDED);

    await expectUnloaded(app, formTab, { url: formUrl, title: 'Lifecycle form' });
    await expectUnloaded(app, articleTab, { url: articleUrl, title: 'Lifecycle article' });
    expect((await lifecycleFacts(app, formTab)).pageStateInMemory).toBe(true);
    await expectProcessGone(app, pids.form);
    await expectProcessGone(app, pids.article);
    await expectConsistent(app, shell);

    // Selecting the form tab restores it into a brand-new web contents.
    await selectTab(app, shell, formTab);
    await waitForLoaded(app, formTab);
    const restoredForm = await contentsOf(app, formTab);
    expect(restoredForm).not.toBe(formContents);
    await expect
      .poll(
        async () => {
          const reading = (await pageValue(app, restoredForm, READ_FORM)) as FormReading;
          return {
            ...reading,
            // The scroll comes back within a pixel (S2).
            scrollY: Math.abs(reading.scrollY - formScrolled) <= 1 ? 'restored' : reading.scrollY,
          };
        },
        { message: 'the form tab should get its values and scroll position back' },
      )
      .toEqual({
        text: 'edited text',
        area: 'edited area',
        sel: 'b',
        chk: true,
        scrollY: 'restored',
        // Restoring does not count as the user having been there.
        activated: false,
      });
    expect(await pageValue(app, restoredForm, 'document.title')).toBe('Lifecycle form');

    // The article too.
    await selectTab(app, shell, articleTab);
    await waitForLoaded(app, articleTab);
    const restoredArticle = await contentsOf(app, articleTab);
    expect(restoredArticle).not.toBe(articleContents);
    await expect
      .poll(
        async () => {
          const scrollY = (await pageValue(app, restoredArticle, 'window.scrollY')) as number;
          return Math.abs(scrollY - articleScrolled) <= 1 ? 'restored' : scrollY;
        },
        { message: 'the article should be scrolled where it was' },
      )
      .toBe('restored');
    expect(await hasBeenActive(app, restoredArticle)).toBe(false);
    await expectConsistent(app, shell);
  });
});

// ── 2 and 3. Unsaved input the probe finds ──────────────────────────────────────────────────────

test.describe('the probe: unsaved input', () => {
  test('real typing into a plain field keeps the tab (unsaved-input); automation is then blocked from what was learned', async ({
    launcher,
    fixtureServer,
  }) => {
    const formUrl = fixtureServer.url('/lifecycle-form.html?case=lifecycle-dirty');
    const { app, shell, blank } = await launchWithBlank(launcher);
    const tab = await loadInNewTab(app, shell, formUrl);
    const contents = await contentsOf(app, tab);

    await typeInto(app, contents, '#text', 'hi');
    expect(await hasBeenActive(app, contents)).toBe(true);
    await selectTab(app, shell, blank);

    expect(await discard(app, tab)).toEqual(KEPT_UNSAVED_INPUT);
    await expectKept(app, tab, contents);
    expect(await fieldText(app, contents, '#text')).toContain('hi');
    expect((await lifecycleFacts(app, tab)).learned).toEqual(['unsaved-input']);

    // The scheduler's request, with the epoch it saw, is turned away from what the earlier
    // attempt learned: it never asks the page, so the tab goes through no transition at all.
    const { epoch } = await lifecycleFacts(app, tab);
    const seen = (await transitionsOf(app, tab)).length;
    expect(await discard(app, tab, { origin: 'automation', epoch })).toEqual(KEPT_UNSAVED_INPUT);
    expect(await eventsSince(app, tab, seen)).toEqual([]);
    expect((await lifecycleFacts(app, tab)).epoch).toBe(epoch);

    // An explicit request asks the page again, and the page is still dirty.
    const asked = await discardWithAttempts(app, tab);
    expect(asked.outcome).toEqual(KEPT_UNSAVED_INPUT);
    expect(await eventsSince(app, tab, seen)).toEqual(
      discardEvents(asked.attempts, 'discardBlocked'),
    );
    await expectKept(app, tab, contents);

    // The text is still there when the user comes back.
    await selectTab(app, shell, tab);
    expect(await fieldText(app, contents, '#text')).toContain('hi');
    expect(await tabState(app, tab)).toMatchObject({ runtime: 'live', attached: true });
  });

  test('real typing into a React-style input, whose value attribute follows its value, keeps the tab', async ({
    launcher,
    fixtureServer,
  }) => {
    const formUrl = fixtureServer.url('/lifecycle-form.html?case=lifecycle-reactish');
    const { app, shell, blank } = await launchWithBlank(launcher);
    const tab = await loadInNewTab(app, shell, formUrl);
    const contents = await contentsOf(app, tab);

    await typeInto(app, contents, '#reactish', 'hello');
    // Its default value tracks its value, so a value-against-default check sees no change (S2, S3):
    // only the trusted-input tracker can have caught this.
    expect(
      await pageValue(
        app,
        contents,
        `(() => {
          const input = document.getElementById('reactish');
          return input.value === input.defaultValue && input.getAttribute('value') === input.value;
        })()`,
      ),
    ).toBe(true);
    await selectTab(app, shell, blank);

    expect(await discard(app, tab)).toEqual(KEPT_UNSAVED_INPUT);
    await expectKept(app, tab, contents);
    expect((await lifecycleFacts(app, tab)).learned).toEqual(['unsaved-input']);
    expect(await fieldText(app, contents, '#reactish')).toBe('hello');
  });
});

// ── 4. contenteditable ──────────────────────────────────────────────────────────────────────────

test.describe('the probe: contenteditable', () => {
  test('text typed into a contenteditable region keeps the tab after the region lost focus', async ({
    launcher,
    fixtureServer,
  }) => {
    const formUrl = fixtureServer.url('/lifecycle-form.html?case=lifecycle-ce-typed');
    const { app, shell, blank } = await launchWithBlank(launcher);
    const tab = await loadInNewTab(app, shell, formUrl);
    const contents = await contentsOf(app, tab);

    await typeInto(app, contents, '#ce', 'hello');
    // Blur it with a real click on the heading: focus alone would no longer say anything (S3).
    await clickElement(app, contents, '#heading');
    expect(await focusedId(app, contents)).not.toBe('ce');
    expect(await fieldText(app, contents, '#ce')).toContain('hello');
    await selectTab(app, shell, blank);

    expect(await discard(app, tab)).toEqual(KEPT_UNSAVED_INPUT);
    await expectKept(app, tab, contents);
    expect((await lifecycleFacts(app, tab)).learned).toEqual(['unsaved-input']);
  });

  test('a contenteditable region that only has the focus keeps the tab softly (editing); overrideSoft discards it', async ({
    launcher,
    fixtureServer,
  }) => {
    const formUrl = fixtureServer.url('/lifecycle-form.html?case=lifecycle-ce-focused');
    const { app, shell, blank } = await launchWithBlank(launcher);
    const tab = await loadInNewTab(app, shell, formUrl);
    const contents = await contentsOf(app, tab);

    // A click puts the caret in; nothing is typed, and the region stays focused.
    await clickElement(app, contents, '#ce');
    expect(await focusedId(app, contents)).toBe('ce');
    expect(await fieldText(app, contents, '#ce')).toBe('editable region');
    await selectTab(app, shell, blank);

    expect(await discard(app, tab)).toEqual({ outcome: 'blocked', reason: 'editing' });
    await expectKept(app, tab, contents);
    expect((await lifecycleFacts(app, tab)).learned).toEqual(['editing']);

    // Critical memory pressure lets a soft protection go, and the explicit request asks again.
    expect(await discard(app, tab, { overrideSoft: true })).toEqual(DISCARDED);
    await expectUnloaded(app, tab, { url: formUrl, title: 'Lifecycle form' });
  });
});

// ── 5. beforeunload ─────────────────────────────────────────────────────────────────────────────

test.describe("the page's own beforeunload", () => {
  test('a page the user never touched cannot object: it is closed plainly and discarded', async ({
    launcher,
    fixtureServer,
  }) => {
    const tag = 'untouched';
    const url = fixtureServer.url(`/lifecycle-unload.html?mode=always&tag=${tag}`);
    const { app, shell, blank } = await launchWithBlank(launcher);
    const tab = await loadInNewTab(app, shell, url);
    const contents = await contentsOf(app, tab);
    expect(await hasBeenActive(app, contents)).toBe(false);
    expect(await pageValue(app, contents, 'window.__veltrivaUnload.objected')).toBe(0);
    const pid = await rendererPid(app, contents);
    await selectTab(app, shell, blank);

    // It registers a handler that objects to everything, but Electron's close with
    // waitForBeforeUnload would first give it the user activation it needs to object (S3).
    expect(await discard(app, tab)).toEqual(DISCARDED);
    await expectUnloaded(app, tab, { url, title: 'Lifecycle unload' });
    await expectProcessGone(app, pid);
    // A plain close runs no beforeunload (S3 A2): the page reported nothing as it went.
    await delay(2_000);
    expect(beaconsFor(fixtureServer, tag)).toEqual([]);
  });

  test('a page the user activated that objects keeps the tab, silently, and is still alive', async ({
    launcher,
    fixtureServer,
  }) => {
    const tag = 'objects';
    const url = fixtureServer.url(`/lifecycle-unload.html?mode=always&tag=${tag}`);
    const { app, shell, blank } = await launchWithBlank(launcher);
    const tab = await loadInNewTab(app, shell, url);
    const contents = await contentsOf(app, tab);
    await clickElement(app, contents, '#button');
    expect(await hasBeenActive(app, contents)).toBe(true);
    await selectTab(app, shell, blank);

    const windowsBefore = (await allWindows(app)).length;
    const pagesBefore = app.windows().length;
    expect(await discard(app, tab)).toEqual({ outcome: 'blocked', reason: 'page-unsaved-changes' });

    // The page is alive and answers, the same web contents, and it did object.
    await expectKept(app, tab, contents);
    expect(await pageValue(app, contents, '1 + 1')).toBe(2);
    const unload = (await pageValue(app, contents, 'window.__veltrivaUnload')) as {
      beforeunload: number;
      objected: number;
    };
    expect(unload.beforeunload).toBeGreaterThanOrEqual(1);
    expect(unload.objected).toBeGreaterThanOrEqual(1);
    await expect
      .poll(() => beaconsFor(fixtureServer, tag).map((beacon) => beacon.objected), {
        message: 'the page should have reported that its beforeunload handler objected',
        timeout: 30_000,
      })
      .toContain('true');
    // No dialog and no other window came up.
    expect((await allWindows(app)).length).toBe(windowsBefore);
    expect(app.windows().length).toBe(pagesBefore);
    expect((await lifecycleFacts(app, tab)).learned).toEqual(['page-unsaved-changes']);

    // The user comes back to a page that was never touched.
    await selectTab(app, shell, tab);
    expect(await tabState(app, tab)).toMatchObject({
      runtime: 'live',
      webContentsId: contents,
      attached: true,
    });
    expect(await pageValue(app, contents, '1 + 1')).toBe(2);
  });

  test('an activated page whose handler never objects is discarded, after its handler ran', async ({
    launcher,
    fixtureServer,
  }) => {
    const tag = 'never';
    const url = fixtureServer.url(`/lifecycle-unload.html?mode=never&tag=${tag}`);
    const { app, shell, blank } = await launchWithBlank(launcher);
    const tab = await loadInNewTab(app, shell, url);
    const contents = await contentsOf(app, tab);
    await clickElement(app, contents, '#button');
    expect(await hasBeenActive(app, contents)).toBe(true);
    const pid = await rendererPid(app, contents);
    await selectTab(app, shell, blank);

    expect(await discard(app, tab)).toEqual(DISCARDED);
    await expectUnloaded(app, tab, { url, title: 'Lifecycle unload' });
    await expectProcessGone(app, pid);
    // The close for an activated page runs beforeunload, so the page reported once, and said it
    // did not object.
    await expect
      .poll(() => beaconsFor(fixtureServer, tag), {
        message: 'the page should have run its beforeunload handler once',
        timeout: 30_000,
      })
      .toEqual([{ event: 'beforeunload', objected: 'false' }]);
  });
});

// ── 6 and 7. Sensitive pages, and requests that no longer apply ─────────────────────────────────

test.describe('other reasons to keep a tab, or to skip it', () => {
  test('a page with a password or payment field keeps the tab softly (sensitive-page); overrideSoft discards it', async ({
    launcher,
    fixtureServer,
  }) => {
    const url = fixtureServer.url('/lifecycle-sensitive.html?case=lifecycle-sensitive');
    const { app, shell, blank } = await launchWithBlank(launcher);
    const tab = await loadInNewTab(app, shell, url);
    const contents = await contentsOf(app, tab);
    await selectTab(app, shell, blank);

    expect(await discard(app, tab)).toEqual({ outcome: 'blocked', reason: 'sensitive-page' });
    await expectKept(app, tab, contents);
    expect((await lifecycleFacts(app, tab)).learned).toEqual(['sensitive-page']);

    expect(await discard(app, tab, { overrideSoft: true })).toEqual(DISCARDED);
    await expectUnloaded(app, tab, { url, title: 'Lifecycle sign-in' });
  });

  test('the selected tab is skipped, and so is a request whose epoch is stale', async ({
    launcher,
    fixtureServer,
  }) => {
    const url = fixtureServer.url('/lifecycle-sensitive.html?case=lifecycle-skipped');
    const { app, shell, blank } = await launchWithBlank(launcher);
    const tab = await loadInNewTab(app, shell, url);
    const contents = await contentsOf(app, tab);
    expect(await selectedTabId(app)).toBe(tab);

    // The selected tab is never discarded, not even by an explicit request.
    const first = await lifecycleFacts(app, tab);
    const seen = (await transitionsOf(app, tab)).length;
    expect(await discard(app, tab)).toEqual({ outcome: 'skipped', why: 'selected' });
    expect(await discard(app, tab, { origin: 'automation', epoch: first.epoch })).toEqual({
      outcome: 'skipped',
      why: 'selected',
    });
    expect(await eventsSince(app, tab, seen)).toEqual([]);
    expect(await tabState(app, tab)).toMatchObject({ runtime: 'live', attached: true });

    // A decision made at an epoch the tab has left behind: a blocked attempt is a pair of
    // transitions, so the epoch the scheduler saw first is stale afterwards.
    await selectTab(app, shell, blank);
    expect(await discard(app, tab)).toEqual({ outcome: 'blocked', reason: 'sensitive-page' });
    const { epoch } = await lifecycleFacts(app, tab);
    expect(epoch).toBeGreaterThan(first.epoch);
    const afterBlocked = (await transitionsOf(app, tab)).length;
    expect(await discard(app, tab, { origin: 'automation', epoch: first.epoch })).toEqual({
      outcome: 'skipped',
      why: 'stale',
    });
    expect(await eventsSince(app, tab, afterBlocked)).toEqual([]);
    await expectKept(app, tab, contents);

    // With the epoch it holds now, the request goes through to what the tab learned.
    expect(await discard(app, tab, { origin: 'automation', epoch })).toEqual({
      outcome: 'blocked',
      reason: 'sensitive-page',
    });
    expect(await eventsSince(app, tab, afterBlocked)).toEqual([]);
  });
});

// ── 8. The flush is not a navigation ────────────────────────────────────────────────────────────

test.describe('the page-state flush', () => {
  test('is not a navigation: a discard adds no visit, keeps the address and goes through two transitions', async ({
    launcher,
    fixtureServer,
  }) => {
    const url = fixtureServer.url('/lifecycle-form.html?case=lifecycle-flush');
    const { app, shell, blank } = await launchWithBlank(launcher);
    const tab = await loadInNewTab(app, shell, url);
    await expectVisits(app, [[url, 'typed']]);
    await selectTab(app, shell, blank);

    const visitsBefore = await visitList(app);
    const seen = (await transitionsOf(app, tab)).length;
    const discarded = await discardWithAttempts(app, tab);
    expect(discarded.outcome).toEqual(DISCARDED);

    // The probe's `history.replaceState` commits once in the page. Watch long enough for a visit
    // to be written behind it (visits are written a moment after the commit).
    for (let sample = 0; sample < 6; sample += 1) {
      expect(await visitList(app)).toEqual(visitsBefore);
      await delay(500);
    }
    expect(visitsBefore).toEqual([[url, 'typed']]);
    await expectUnloaded(app, tab, { url, title: 'Lifecycle form' });
    // Only the discard's own pair of transitions: the flush added none (and each earlier request
    // that kept the page for a missed probe is one more `discard` and `discardBlocked`).
    expect(await eventsSince(app, tab, seen)).toEqual(
      discardEvents(discarded.attempts, 'discarded'),
    );
  });
});

// ── 9. What is saved ────────────────────────────────────────────────────────────────────────────

test.describe('persistence of a discarded tab', () => {
  test('the tab comes back unloaded with its address and title; the file holds no page state', async ({
    launcher,
    fixtureServer,
    userDataDir,
  }) => {
    const formUrl = fixtureServer.url('/lifecycle-form.html?case=lifecycle-saved');
    const otherUrl = fixtureServer.url('/page-b.html?case=lifecycle-saved');

    const first = await launcher.launch();
    const [formTab, otherTab] = await startWithPages(first.app, first.shell, [formUrl, otherUrl]);
    const formContents = await contentsOf(first.app, formTab);
    // Values and a scroll position that the page state holds, and that must stay in memory.
    await pageValue(first.app, formContents, EDIT_FORM);
    expect(await discard(first.app, formTab)).toEqual(DISCARDED);
    await expectUnloaded(first.app, formTab, { url: formUrl, title: 'Lifecycle form' });
    expect((await lifecycleFacts(first.app, formTab)).pageStateInMemory).toBe(true);
    await expectSaved(first.app, {
      ids: [formTab, otherTab],
      selectedTabId: otherTab,
      stacks: { [formTab]: { index: 0, urls: [formUrl] } },
    });
    await launcher.quit(first);

    // The file: the tab's row holds the stack as addresses and titles, nothing else.
    const rows = readProfileDb(
      userDataDir,
      'SELECT id, url, title, placement, restore_state FROM tabs ORDER BY position',
    );
    const row = rows.find((candidate) => candidate.id === formTab);
    expect(row).toMatchObject({ url: formUrl, title: 'Lifecycle form', placement: 'strip' });
    const saved = row?.restore_state;
    if (typeof saved !== 'string') {
      throw new Error('The discarded tab has no saved stack.');
    }
    const stack = JSON.parse(saved) as Record<string, unknown>;
    expect(Object.keys(stack).sort()).toEqual(['entries', 'index', 'v']);
    expect(stack.index).toBe(0);
    expect(stack.entries).toEqual([{ url: formUrl, title: 'Lifecycle form' }]);
    expect(JSON.stringify(rows)).not.toContain('pageState');
    // And nowhere in the file or its log.
    expect(profileDbBytes(userDataDir).includes('pageState')).toBe(false);

    // The next start: the tab is there, unloaded, and loads when selected. The page state was for
    // this run only, so the form comes back as the page itself defines it.
    const second = await launcher.launch();
    await expect.poll(() => sidebarIds(second.shell)).toEqual([formTab, otherTab]);
    await waitForLoaded(second.app, otherTab);
    await expectUnloaded(second.app, formTab, { url: formUrl, title: 'Lifecycle form' });
    await selectTab(second.app, second.shell, formTab);
    await waitForLoaded(second.app, formTab);
    const reloaded = await contentsOf(second.app, formTab);
    await expect
      .poll(async () => (await pageValue(second.app, reloaded, READ_FORM)) as FormReading, {
        message: 'the form should show the values the page defines, none of the earlier edits',
      })
      .toEqual({
        text: 'initial',
        area: 'initial area',
        sel: 'a',
        chk: false,
        scrollY: 0,
        activated: false,
      });
  });
});
