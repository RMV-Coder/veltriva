// Lifecycle automation, M3.2 and M3.3 (assessment §4.4, §4.6–§4.8 and §4.10, ADR-0003 items 13
// and 14): the engagement clock and the policy, the scheduler that carries the policy out (from
// M3.3 also moving tabs to Sleeping and the Archive, with Undo and an activity log), memory
// pressure, and the protections automation must respect. Discarding a tab is M3.1's job
// (lifecycle.spec.ts); these specs check WHICH tabs the scheduler acts on, WHEN, and that it logs
// why.
//
// How time passes. Nothing here waits an hour. `advanceLifecycleClock` fast-forwards the clock the
// policy, TabManager's activity and the protections see, and `lifecycleEvaluate` evaluates now,
// whatever the 60 s timer and the 2-minute quiet start say, and resolves once every discard it
// started has settled. `lifecyclePlanWith` reads the policy's plan in ONE synchronous step in main
// (see hooks.ts), so the app's own timer can never evaluate between a fast-forward and the read.
//
// What the values are. The thresholds below (60 min, 15 min, 10 tabs, 2 engaged hours, the guard,
// the pressure budgets) are written out from assessment §4.7, not imported from the policy, so a
// wrong constant in the policy fails here instead of agreeing with itself.
//
// Rules from ADR-0008 item 4 that matter here:
//  - Nothing asserts what a hidden page does through Playwright. Tabs are acted on only while
//    they are selected (attached); the specs read hidden ones from main (`evaluateInTab`).
//  - Real clicks and typing are `sendInputEvent` from main (`clickElement`, `sendKey`), never
//    Playwright's keyboard: the trusted-input tracker, `hasBeenActive` and the recent-interaction
//    guard all read real input. Page scripts run with no user gesture, except the audio fixture,
//    which needs one to start (`executeJavaScript(code, true)`).
//  - Pages come from the local fixture server. The audio fixture is muted from main
//    (`setAudioMuted`), so the tone never reaches the speakers; a muted tab still counts as audible.
//
// The memory pressure is pinned to 'none' unless a spec sets another level. The real monitor
// reads this laptop (7.9 GB, often under 10% free) as moderate, which would add pressure
// discards to every plan.
//
// Timers of the app itself. The scheduler's timer starts 2 minutes after launch and then ticks
// every minute, and a tab switch or a settings change asks it to evaluate a second later. Specs
// therefore read what the log holds in total (`lifecycleLog`), grouped by evaluation (`at`), and
// never assume that the records `lifecycleEvaluate` returned are the only ones.
import { freemem, totalmem } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

import type { ElectronApplication } from '@playwright/test';

import { startFixtureServer } from '../fixtures/server';
import type { FixtureServer } from '../fixtures/server';
import { expect } from './expect';
import {
  activityEntries,
  advanceLifecycleClock,
  archivedTabs,
  clickElement,
  closeWindowShowing,
  evaluateInTab,
  isDevToolsOpened,
  lifecycleClock,
  lifecycleEvaluate,
  lifecycleLog,
  lifecyclePlan,
  lifecyclePlanWith,
  popupWindows,
  recordInputEvents,
  selectedTabId,
  sendKey,
  setLifecycleSettings,
  setMemoryPressure,
  sleepingTabStates,
  tabState,
  tabStates,
  undoOffer,
} from './hooks';
import type { ActionRecord, LifecycleAction, LifecycleSettingsChange, TabId } from './hooks';
import type { PageGlobal } from './page-globals';
import { workspaceSnapshot } from './prompt-ui';
import { dataValue, expectSaved, readSavedSession, test } from './session-ui';
import type { Launcher, RunningApp } from './session-ui';
import {
  expectConsistent,
  internalPage,
  loadInNewTab,
  openTabAt,
  sidebarIds,
  tabElement,
  togglePinWithButton,
  typeAddress,
  waitForLoaded,
} from './shell-ui';

// Each test launches the app once or twice and a discard takes seconds on a loaded laptop.
test.describe.configure({ timeout: 300_000 });

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// ── The rig ─────────────────────────────────────────────────────────────────────────────────────

/** The app, its shell, and the new-tab page the app starts with (the tab nobody can discard). */
interface Rig extends RunningApp {
  readonly blank: TabId;
  /** `Date.now()` when the app was ready. Its quiet start began a moment before this. */
  readonly readyAt: number;
}

async function launchRig(launcher: Launcher): Promise<Rig> {
  const run = await launcher.launch();
  const ids = await sidebarIds(run.shell);
  const [blank] = ids;
  if (ids.length !== 1 || blank === undefined) {
    throw new Error(`The app starts with one tab, not ${String(ids.length)}.`);
  }
  await prepareApp(run.app);
  return { ...run, blank, readyAt: Date.now() };
}

/**
 * What every spec does right after a launch: pins the memory pressure to 'none' (the real monitor
 * reads this laptop as moderate).
 */
async function prepareApp(app: ElectronApplication): Promise<void> {
  await setMemoryPressure(app, 'none');
  // A fresh profile is on its first active day, when automation only previews its moves (M3.4,
  // §4.13). These specs check moves carried out; preview has its own spec (protection.spec.ts).
  await setLifecycleSettings(app, { preview: 'off' });
}

/**
 * Marks a web contents as captured (camera, microphone or screen share), or not. Playwright turns
 * on focus emulation for every page it attaches to (`Emulation.setFocusEmulationEnabled`), and
 * Chromium counts that as a capturer, so under Playwright every page reports `isBeingCaptured()`.
 * Test builds therefore read capture from these marks (src/main/testing/test-clock.ts), which is
 * also how the capture protection is exercised without a real device (ADR-0008).
 */
async function markCaptured(
  app: ElectronApplication,
  contentsId: number,
  captured: boolean,
): Promise<void> {
  await app.evaluate(
    (_electron, { id, on }) => {
      const hooks = globalThis.__veltrivaTest;
      if (hooks === undefined) {
        throw new Error('The test hooks are missing: this is not a test build.');
      }
      hooks.setCaptured(id, on);
    },
    { id: contentsId, on: captured },
  );
}

/** Clicks the tab in the sidebar and waits until main has it selected. */
async function selectTab(rig: Pick<Rig, 'app' | 'shell'>, tabId: TabId): Promise<void> {
  await tabElement(rig.shell, tabId).click();
  await expect
    .poll(() => selectedTabId(rig.app), { message: `tab ${tabId} should become the selected tab` })
    .toBe(tabId);
}

/** Hides whatever is shown: the new-tab page comes to the front. */
function showBlank(rig: Rig): Promise<void> {
  return selectTab(rig, rig.blank);
}

/** The id of a tab's web contents; throws if it has none (it is unloaded). */
async function contentsOf(app: ElectronApplication, tabId: TabId): Promise<number> {
  const state = await tabState(app, tabId);
  if (state?.webContentsId === null || state?.webContentsId === undefined) {
    throw new Error(`Tab ${tabId} has no web contents.`);
  }
  return state.webContentsId;
}

interface OpenedPage {
  readonly tabId: TabId;
  /** Its web contents id, for the main-side helpers. */
  readonly contents: number;
}

/** Opens a page in a new tab, which is selected and loaded when this returns. */
async function openPage(rig: Pick<Rig, 'app' | 'shell'>, url: string): Promise<OpenedPage> {
  const tabId = await loadInNewTab(rig.app, rig.shell, url);
  return { tabId, contents: await contentsOf(rig.app, tabId) };
}

/** A tiny page nothing can be unsaved on; `name` makes the address (and the tab) its own. */
function plain(server: FixtureServer, name: string): string {
  return server.url(`/lifecycle-plain.html?case=automation&tab=${name}`);
}

// ── Real input and what a page holds (copied from lifecycle.spec.ts, which owns the originals) ──

const pageValue = (app: ElectronApplication, contentsId: number, code: string): Promise<unknown> =>
  evaluateInTab(app, contentsId, code);

/** Whether the page has had user activation since it loaded (what the probe reads, S3). */
async function hasBeenActive(app: ElectronApplication, contentsId: number): Promise<boolean> {
  return (await pageValue(app, contentsId, 'navigator.userActivation.hasBeenActive')) === true;
}

/** The id of the element that has focus in the page, or '' for none. */
async function focusedId(app: ElectronApplication, contentsId: number): Promise<string> {
  return (await pageValue(app, contentsId, 'document.activeElement?.id ?? ""')) as string;
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

/**
 * Types `text` into the element for real: a click on it and then one key press per character, from
 * main. The tab must be attached and selected. It checks that the element got the focus and that
 * the text arrived, and tries again if not (S3: input is dropped now and then).
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
      problem = error instanceof Error ? error.message : String(error);
    }
    await delay(500);
  }
  throw new Error(`Typing "${text}" into ${selector} did not arrive in 5 attempts: ${problem}`);
}

function setAudioMuted(app: ElectronApplication, contentsId: number, muted: boolean) {
  return app.evaluate(
    ({ webContents }, { id, value }) => {
      webContents.fromId(id)?.setAudioMuted(value);
    },
    { id: contentsId, value: muted },
  );
}

function isAudible(app: ElectronApplication, contentsId: number): Promise<boolean> {
  return app.evaluate(
    ({ webContents }, id) => webContents.fromId(id)?.isCurrentlyAudible() ?? false,
    contentsId,
  );
}

async function closeDevTools(app: ElectronApplication, contentsId: number): Promise<void> {
  await app.evaluate(({ webContents }, id) => {
    webContents.fromId(id)?.closeDevTools();
  }, contentsId);
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

/** Opens the audio fixture, mutes it, plays its tone, and waits until the tab is audible. */
async function openPlayingTab(rig: Rig, url: string): Promise<OpenedPage> {
  const page = await openPage(rig, url);
  await setAudioMuted(rig.app, page.contents, true);
  expect(
    await evaluateInTab(rig.app, page.contents, 'lifecycleAudio.play()', { userGesture: true }),
    'the page should be able to start its tone',
  ).toBe('running');
  await expect
    .poll(() => isAudible(rig.app, page.contents), {
      message: 'the generated tone should make the (muted) tab audible',
      timeout: 30_000,
    })
    .toBe(true);
  return page;
}

// ── Reading the log ─────────────────────────────────────────────────────────────────────────────

type Result = ActionRecord['result'];

/** A result as a short word: `discarded`, `blocked:unsaved-input`, `rate-limited`, `planned`. */
function word(result: Result): string {
  switch (result.outcome) {
    case 'blocked':
      return `blocked:${result.reason}`;
    case 'skipped':
      return `skipped:${result.why}`;
    default:
      return result.outcome;
  }
}

const isDiscardAction = (action: LifecycleAction): boolean => action.kind === 'discard';
const isDiscardRecord = (record: ActionRecord): boolean => record.kind === 'discard';
/** A discard the scheduler really started (it was not turned away by the per-evaluation limit). */
const wasStarted = (record: ActionRecord): boolean =>
  isDiscardRecord(record) &&
  record.result.outcome !== 'rate-limited' &&
  record.result.outcome !== 'paused';

/** The discards the plan calls for, as tab ids in the order to carry them out. */
const discardIds = (plan: readonly LifecycleAction[]): TabId[] =>
  plan.filter(isDiscardAction).map((action) => action.tabId);

/**
 * The records of one evaluation each. An evaluation logs under one `at` (the wall-clock time it
 * began), and discards take seconds, so two evaluations do not share one.
 */
function byEvaluation(log: readonly ActionRecord[]): ActionRecord[][] {
  const groups = new Map<number, ActionRecord[]>();
  for (const record of log) {
    groups.set(record.at, [...(groups.get(record.at) ?? []), record]);
  }
  return [...groups.values()];
}

interface Attempts {
  /** What each attempt at the tab came to, in order, without the unanswered probes. */
  readonly results: string[];
  /** The rules that planned them, in the same order. */
  readonly rules: string[];
  /**
   * Attempts that ended `probe-unanswered`: on a loaded laptop a just-hidden page sometimes misses
   * the probe's 100 ms budget, which keeps the tab for that attempt only, and the next
   * evaluation plans it again (ADR-0003 item 12).
   */
  readonly unanswered: number;
}

/** The scheduler's discard attempts at one tab. A retry is noted on the test, so it stays visible. */
function attemptsAt(log: readonly ActionRecord[], tabId: TabId): Attempts {
  const records = log.filter((record) => record.tabId === tabId && wasStarted(record));
  const unanswered = records.filter((record) => word(record.result) === 'blocked:probe-unanswered');
  const noted = test
    .info()
    .annotations.some(
      (annotation) =>
        annotation.type === 'discard-retried' &&
        annotation.description?.startsWith(`Tab ${tabId}:`),
    );
  if (unanswered.length > 0 && !noted) {
    test.info().annotations.push({
      type: 'discard-retried',
      description: `Tab ${tabId}: ${String(unanswered.length)} attempt(s) ended probe-unanswered and were planned again.`,
    });
  }
  const answered = records.filter((record) => !unanswered.includes(record));
  return {
    results: answered.map((record) => word(record.result)),
    rules: answered.map((record) => record.rule),
    unanswered: unanswered.length,
  };
}

/** The tab ids with a started discard in the log, in the order of their first attempt. */
function tabsAttempted(log: readonly ActionRecord[]): TabId[] {
  const seen: TabId[] = [];
  for (const record of log.filter(wasStarted)) {
    if (!seen.includes(record.tabId)) {
      seen.push(record.tabId);
    }
  }
  return seen;
}

/** Most discards one evaluation of the log started (the scheduler's limit is 3). */
function mostStartedPerEvaluation(log: readonly ActionRecord[]): number {
  return Math.max(0, ...byEvaluation(log).map((group) => group.filter(wasStarted).length));
}

// ── Letting the scheduler finish ────────────────────────────────────────────────────────────────

/**
 * Waits until no discard is under way and the log has been still for a second. The scheduler's
 * own timer may be evaluating too: `lifecycleEvaluate` then returns before the evaluation that
 * runs right after it has started anything.
 */
async function settled(app: ElectronApplication): Promise<void> {
  const deadline = Date.now() + 120_000;
  let last = '';
  let stillSince = Date.now();
  for (;;) {
    const [states, log] = await Promise.all([tabStates(app), lifecycleLog(app)]);
    const underway = states.some(
      (tab) => tab.runtime === 'discarding' || tab.runtime === 'creating',
    );
    const now = `${String(log.length)}:${JSON.stringify(log.at(-1) ?? null)}`;
    if (underway || now !== last) {
      last = now;
      stillSince = Date.now();
    } else if (Date.now() - stillSince >= 1_000) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error('The scheduler did not settle within 120 s.');
    }
    await delay(250);
  }
}

/**
 * Evaluates until the plan holds nothing at all: every discard, shelve and archive carried out.
 * Returns how many evaluations that took.
 */
async function drainAll(app: ElectronApplication, limit = 15): Promise<number> {
  let evaluations = 0;
  for (;;) {
    await settled(app);
    const plan = await lifecyclePlan(app);
    if (plan.length === 0) {
      return evaluations;
    }
    if (evaluations >= limit) {
      throw new Error(
        `The plan still holds actions after ${String(limit)} evaluations: ${JSON.stringify(plan)}`,
      );
    }
    evaluations += 1;
    await lifecycleEvaluate(app);
  }
}

/**
 * Evaluates until the plan holds no discard (a tab whose probe went unanswered is planned again),
 * and returns how many evaluations that took.
 */
async function drain(app: ElectronApplication, limit = 15): Promise<number> {
  let evaluations = 0;
  for (;;) {
    await settled(app);
    const plan = await lifecyclePlan(app);
    if (!plan.some(isDiscardAction)) {
      return evaluations;
    }
    if (evaluations >= limit) {
      throw new Error(
        `The plan still holds discards after ${String(limit)} evaluations: ${JSON.stringify(plan)}`,
      );
    }
    evaluations += 1;
    await lifecycleEvaluate(app);
  }
}

/** The runtime of every tab, by id. */
async function runtimes(app: ElectronApplication): Promise<Map<TabId, string>> {
  return new Map((await tabStates(app)).map((tab) => [tab.id, tab.runtime]));
}

/** The tab is live, with the web contents it had, hidden or not. */
async function expectLive(app: ElectronApplication, page: OpenedPage): Promise<void> {
  expect(await tabState(app, page.tabId), `tab ${page.tabId} should still be live`).toMatchObject({
    runtime: 'live',
    webContentsId: page.contents,
  });
}

/** The tab is unloaded: no web contents. */
async function expectUnloaded(app: ElectronApplication, tabId: TabId): Promise<void> {
  expect(await tabState(app, tabId), `tab ${tabId} should be unloaded`).toMatchObject({
    runtime: 'unloaded',
    webContentsId: null,
  });
}

/** The renderer exits shortly after its web contents closes. */
async function expectProcessGone(app: ElectronApplication, pid: number): Promise<void> {
  await expect
    .poll(
      () =>
        app.evaluate(({ app: electronApp }) =>
          electronApp.getAppMetrics().map((metric) => metric.pid),
        ),
      {
        message: `renderer ${String(pid)} should be gone from app.getAppMetrics()`,
        timeout: 30_000,
      },
    )
    .not.toContain(pid);
}

/** What the app's renderers hold, for the report. */
interface MemoryReading {
  readonly renderers: number;
  readonly rendererWorkingSetMb: number;
  readonly appWorkingSetMb: number;
  readonly systemFreeMb: number;
}

async function readMemory(app: ElectronApplication): Promise<MemoryReading> {
  const metrics = await app.evaluate(({ app: electronApp }) =>
    electronApp.getAppMetrics().map((metric) => ({
      type: metric.type,
      workingSetKb: metric.memory.workingSetSize,
    })),
  );
  const mb = (kb: number): number => Math.round(kb / 1024);
  const renderers = metrics.filter((metric) => metric.type === 'Tab');
  return {
    renderers: renderers.length,
    rendererWorkingSetMb: mb(renderers.reduce((sum, metric) => sum + metric.workingSetKb, 0)),
    appWorkingSetMb: mb(metrics.reduce((sum, metric) => sum + metric.workingSetKb, 0)),
    systemFreeMb: Math.round(freemem() / (1024 * 1024)),
  };
}

function note(type: string, description: string): void {
  test.info().annotations.push({ type, description });
}

// ── 1. Fifty tabs: the actions match the policy exactly ─────────────────────────────────────────

/**
 * Fifty tabs, as a realistic session on a laptop that cannot hold fifty live renderers (7.9 GB,
 * often under 500 MB free): the profile is seeded with 50 strip tabs and the app is relaunched, so
 * 37 of them come back unloaded (never shown this run), as a restored session does. 13 are then
 * shown one after the other, which loads them, and left again. So:
 *   2 pinned tabs, both visited:                      live, hidden        (never discarded: Balanced)
 *   11 unpinned tabs visited in order V1..V11:        live, hidden, except the last one, selected
 *   37 unpinned tabs never shown:                     unloaded
 * The 10 most recently used unpinned tabs are V11 (selected) and V10..V2; V1 and the 37 are beyond
 * the strip cap of 10. Policy, after a fast-forward of 61 min and over 2 engaged hours:
 *   discard V1..V10 (hidden an hour, live), longest hidden first;
 *   shelve the 37 unloaded, and V1 once it is discarded (it is no longer planned as a discard).
 * A tab gets one action at a time, which is why V1 is a discard first and a shelve later. Three
 * active days later, every Sleeping tab is archived (Balanced), and V2, now beyond the cap,
 * goes to Sleeping and then to the Archive too.
 */
interface FiftyLayout {
  /** The strip in order. */
  readonly ids: readonly TabId[];
  readonly pinned: readonly TabId[];
  /** Unpinned tabs shown during the run, V1 first; the last stays selected. */
  readonly shown: readonly TabId[];
  /** The order the tabs are shown in, the first being the one the restored session selects. */
  readonly visits: readonly TabId[];
  readonly neverShown: readonly TabId[];
}

const FIFTY = 50;
const PINNED = 2;
const SHOWN = 11;

/** A valid UUIDv7 for the nth seeded tab. */
const seededId = (index: number): TabId =>
  `0199f100-0000-7000-8000-${index.toString(16).padStart(12, '0')}`;

function fiftyLayout(): FiftyLayout {
  const ids = Array.from({ length: FIFTY }, (_, index) => seededId(index));
  const pinned = ids.slice(0, PINNED);
  // Spread through the strip, so the sidebar has to scroll to them.
  const shown = Array.from({ length: SHOWN }, (_, order) => seededId(PINNED + 4 * order));
  const [v1, v2, v3, v4, v5, v6, v7, v8, v9, v10, v11] = shown;
  const [p1, p2] = pinned;
  const visits = [v1, p1, v2, v3, v4, p2, v5, v6, v7, v8, v9, v10, v11].filter(
    (id): id is TabId => id !== undefined,
  );
  const neverShown = ids.filter((id) => !visits.includes(id));
  return { ids, pinned, shown, visits, neverShown };
}

/** Starts the app on an empty profile, writes the 50 tabs into it, and quits. */
async function seedFiftyTabs(
  launcher: Launcher,
  fixtureServer: FixtureServer,
  layout: FiftyLayout,
): Promise<void> {
  const first = await launcher.launch();
  const [blank] = await sidebarIds(first.shell);
  if (blank === undefined) {
    throw new Error('The app starts with one tab.');
  }
  await expectSaved(first.app, { ids: [blank] });
  const [saved] = (await readSavedSession(first.app)).strip;
  if (saved === undefined) {
    throw new Error('The first flush wrote no tab.');
  }
  // Three hours ago, oldest first: unused tabs the earlier session left behind. The ones that get
  // shown are stamped with the real time when they are left, so they are all more recent.
  const base = Date.now() - 3 * HOUR;
  const rows = layout.ids.map((id, index) => ({
    id,
    workspaceId: saved.workspaceId,
    placement: 'strip' as const,
    position: index,
    pinned: index < PINNED,
    userProtected: false,
    pageId: null,
    url: fixtureServer.url(`/lifecycle-plain.html?case=fifty&tab=${String(index)}`),
    title: 'Lifecycle plain',
    faviconId: null,
    restoreState: null,
    openerTabId: null,
    createdAt: base + index * 1000,
    lastUsedAt: base + index * 1000,
    lastUsedEngaged: 1,
    lastUsedActiveDay: 0,
    placementChangedAt: base + index * 1000,
    archivedAt: null,
    archiveReason: null,
    closedAt: null,
  }));
  const [selected] = layout.visits;
  await dataValue(first.app, 'session.save', {
    tabs: rows,
    deleteIds: [blank],
    documents: [{ key: 'session', value: { selectedTabId: selected } }],
  });
  await expectSaved(first.app, { ids: layout.ids, selectedTabId: selected ?? null });
  await launcher.quit(first);
}

test.describe('fifty tabs', () => {
  test('exactly the actions the policy plans are carried out: discards 3 at a time, then the shelves, then the archives', async ({
    launcher,
    fixtureServer,
  }) => {
    test.setTimeout(600_000);
    const layout = fiftyLayout();
    const [firstShown, lastShown] = [layout.shown[0], layout.shown.at(-1)];
    if (firstShown === undefined || lastShown === undefined) {
      throw new Error('unreachable: the layout shows tabs');
    }
    await seedFiftyTabs(launcher, fixtureServer, layout);

    // ── The session comes back: 50 tabs, only the selected one loaded.
    const { app, shell } = await launcher.launch();
    await prepareApp(app);
    await expect
      .poll(() => sidebarIds(shell), { message: 'the 50 saved tabs should be restored in order' })
      .toEqual(layout.ids);
    await waitForLoaded(app, firstShown);
    const restored = await tabStates(app);
    expect(restored).toHaveLength(FIFTY);
    expect(restored.filter((tab) => tab.runtime === 'live').map((tab) => tab.id)).toEqual([
      firstShown,
    ]);
    expect(restored.filter((tab) => tab.pinned).map((tab) => tab.id)).toEqual(layout.pinned);

    // ── Show 13 of them one after the other, and leave each: live and hidden.
    const contents = new Map<TabId, number>([[firstShown, await contentsOf(app, firstShown)]]);
    for (const tabId of layout.visits.slice(1)) {
      await selectTab({ app, shell }, tabId);
      await waitForLoaded(app, tabId);
      contents.set(tabId, await contentsOf(app, tabId));
    }
    expect(await selectedTabId(app)).toBe(lastShown);
    const live = await runtimes(app);
    expect(
      layout.ids.filter((id) => live.get(id) === 'live'),
      'exactly the 13 tabs that were shown hold a renderer',
    ).toEqual(layout.ids.filter((id) => layout.visits.includes(id)));
    const pids = new Map<TabId, number>();
    for (const tabId of layout.shown.slice(0, -1)) {
      pids.set(tabId, await rendererPid(app, contents.get(tabId) ?? -1));
    }
    const memoryLive = await readMemory(app);
    note(
      'memory',
      `13 live tabs + 37 unloaded: ${JSON.stringify(memoryLive)} (renderer working sets in MB, whole app in MB, system free in MB)`,
    );
    expect(await lifecycleLog(app), 'nothing is automated before the clock moves').toEqual([]);

    // ── Fast-forward, reading the plan in the same step each time. A tab switch asks the scheduler
    // to evaluate a second later once its quiet start is over, so let that second pass first.
    await delay(2_500);
    await settled(app);
    const before = await lifecycleClock(app);

    // An hour of wall-clock time (61 minutes) plans the discards and no shelf: shelving counts
    // engaged time, which has not moved, so an absence alone moves nothing (§4.6).
    const hourLater = await lifecyclePlanWith(app, { clock: { wallMs: 61 * MINUTE } });
    expect(hourLater.filter((action) => action.kind !== 'discard')).toEqual([]);
    expect(discardIds(hourLater)).toHaveLength(10);
    // 100 engaged minutes is not yet 2 hours; 121 is.
    const almost = await lifecyclePlanWith(app, { clock: { engagedMs: 100 * MINUTE } });
    expect(almost.filter((action) => action.kind !== 'discard')).toEqual([]);
    const plan = await lifecyclePlanWith(app, { clock: { engagedMs: 21 * MINUTE } });
    const after = await lifecycleClock(app);
    expect(
      after.wallNow - before.wallNow,
      'the wall clock moved 61 minutes',
    ).toBeGreaterThanOrEqual(61 * MINUTE);
    expect(after.wallNow - before.wallNow).toBeLessThan(61 * MINUTE + 60_000);
    expect(
      after.engagedNow - before.engagedNow,
      'engaged time moved 2 hours and a minute',
    ).toBeGreaterThanOrEqual(2 * HOUR + MINUTE);
    expect(after.activeDay).toBe(before.activeDay);

    // The policy, from first principles (§4.7): V1..V10 are live, hidden for an hour, unprotected;
    // the pinned tabs are kept (Balanced), and so is the selected V11.
    const expectedDiscards = layout.shown.slice(0, -1);
    expect(discardIds(plan), 'discards, longest hidden first').toEqual(expectedDiscards);
    for (const action of plan.filter(isDiscardAction)) {
      expect(action).toMatchObject({ rule: 'discard-hidden', overrideSoft: false });
    }
    // Shelve: beyond the 10 most recently used unpinned tabs (V11, V10..V2), unused for 2 engaged
    // hours. V1 is planned as a discard for now: a tab gets one action.
    const shelves = plan.filter((action) => action.kind === 'shelve');
    expect(
      new Set(shelves.map((action) => action.tabId)),
      'the unloaded tabs are the shelves for now',
    ).toEqual(new Set(layout.neverShown));
    for (const action of shelves) {
      expect(action.rule).toBe('shelve-beyond-cap');
    }
    expect(plan.length, 'no freeze and no archive').toBe(discardIds(plan).length + shelves.length);

    // ── Carry it out.
    await drain(app);
    const log = await lifecycleLog(app);

    // Exactly the planned tabs were discarded: no more, no fewer; each logged with the rule.
    const discarded = log
      .filter((record) => isDiscardRecord(record) && word(record.result) === 'discarded')
      .map((record) => record.tabId);
    expect(new Set(discarded)).toEqual(new Set(expectedDiscards));
    expect(discarded, 'each is discarded once').toHaveLength(expectedDiscards.length);
    for (const tabId of expectedDiscards) {
      const attempts = attemptsAt(log, tabId);
      expect(attempts.results, `attempts at ${tabId}`).toEqual(['discarded']);
      expect(attempts.rules).toEqual(['discard-hidden']);
    }
    // Nothing else was ever attempted: not the pinned tabs, not the selected tab, not the
    // unloaded ones.
    expect(new Set(tabsAttempted(log))).toEqual(new Set(expectedDiscards));
    for (const record of log.filter(isDiscardRecord)) {
      expect(expectedDiscards, 'every discard record is for a planned tab').toContain(record.tabId);
    }
    // At most 3 started per evaluation, and the limit really held tabs back.
    expect(mostStartedPerEvaluation(log)).toBeLessThanOrEqual(3);
    expect(mostStartedPerEvaluation(log)).toBe(3);
    const limited = log.filter(
      (record) => isDiscardRecord(record) && record.result.outcome === 'rate-limited',
    );
    expect(limited.length, 'the first evaluation turned away 7 of the 10').toBeGreaterThanOrEqual(
      7,
    );
    // (The log lists a started discard when it ends, so the three are compared as a set.)
    const firstEvaluation = byEvaluation(log).find((group) => group.some(isDiscardRecord));
    expect(
      new Set(firstEvaluation?.filter(wasStarted).map((record) => record.tabId)),
      'the first evaluation starts the three that have been hidden longest',
    ).toEqual(new Set(expectedDiscards.slice(0, 3)));
    expect(
      new Set(
        firstEvaluation
          ?.filter((record) => isDiscardRecord(record) && record.result.outcome === 'rate-limited')
          .map((record) => record.tabId),
      ),
      'and turns the other seven away',
    ).toEqual(new Set(expectedDiscards.slice(3)));

    // The tabs: V1..V10 unloaded and their renderers gone; the pinned tabs and the selected one
    // untouched, with the web contents they had; the 37 never loaded.
    for (const tabId of expectedDiscards) {
      await expectUnloaded(app, tabId);
    }
    for (const pid of pids.values()) {
      await expectProcessGone(app, pid);
    }
    for (const tabId of [...layout.pinned, lastShown]) {
      expect(await tabState(app, tabId), `tab ${tabId} is untouched`).toMatchObject({
        runtime: 'live',
        webContentsId: contents.get(tabId),
      });
    }
    for (const tabId of layout.neverShown) {
      await expectUnloaded(app, tabId);
    }
    expect(await selectedTabId(app)).toBe(lastShown);
    const memoryDiscarded = await readMemory(app);
    note('memory', `after the 10 discards: ${JSON.stringify(memoryDiscarded)}`);

    // ── Shelving is carried out (M3.3): exactly the tabs beyond the 10 most recently used
    // unpinned ones, each once. A shelve costs nothing, so no limit held the 37 back: they all
    // went in the first evaluation, and V1 in one after its discard.
    await drainAll(app);
    const full = await lifecycleLog(app);
    const shelfIds = [firstShown, ...layout.neverShown];
    const shelveLog = full.filter((record) => record.kind === 'shelve');
    for (const record of shelveLog) {
      expect(record).toMatchObject({ rule: 'shelve-beyond-cap' });
      expect(word(record.result), `shelve of ${record.tabId}`).toBe('moved');
    }
    expect(shelveLog.map((record) => record.tabId).sort()).toEqual([...shelfIds].sort());
    expect(
      new Set(
        firstEvaluation?.filter((record) => record.kind === 'shelve').map((record) => record.tabId),
      ),
      'the first evaluation shelves the 37 at once',
    ).toEqual(new Set(layout.neverShown));
    expect(
      full.filter((record) => record.kind === 'archive' || record.kind === 'freeze'),
      'no archive and no freeze yet',
    ).toEqual([]);
    // Where the tabs are: the pinned ones and V2..V11 in the strip, in order; the rest Sleeping,
    // unloaded, never pinned (I8). The selected tab and the pinned ones kept their pages.
    const kept = layout.ids.filter((id) => !shelfIds.includes(id));
    await expect.poll(() => sidebarIds(shell)).toEqual(kept);
    expect((await tabStates(app)).map((tab) => tab.id)).toEqual(kept);
    const sleeping = await sleepingTabStates(app);
    expect(new Set(sleeping.map((tab) => tab.id))).toEqual(new Set(shelfIds));
    for (const tab of sleeping) {
      expect(tab, `Sleeping tab ${tab.id}`).toMatchObject({
        placement: 'shelf',
        pinned: false,
        runtime: 'unloaded',
        webContentsId: null,
      });
    }
    for (const tabId of [...layout.pinned, lastShown]) {
      expect(await tabState(app, tabId), `tab ${tabId} is untouched`).toMatchObject({
        placement: 'strip',
        runtime: 'live',
        webContentsId: contents.get(tabId),
      });
    }
    expect(await selectedTabId(app)).toBe(lastShown);
    // The plan is empty now, and stays so: nothing is planned twice.
    expect(await lifecyclePlan(app)).toEqual([]);
    // Each was logged locally with its rule, as the activity log shows it (§4.12).
    const activity = await activityEntries(app);
    expect(
      new Set(activity.filter((entry) => entry.action === 'discard').map((entry) => entry.tabId)),
    ).toEqual(new Set(expectedDiscards));
    expect(
      new Set(activity.filter((entry) => entry.action === 'shelve').map((entry) => entry.tabId)),
    ).toEqual(new Set(shelfIds));
    for (const entry of activity) {
      expect(entry.rule).toBe(entry.action === 'discard' ? 'discard-hidden' : 'shelve-beyond-cap');
      expect(entry.pressure).toBeNull();
      expect(entry.title).toBe('Lifecycle plain');
    }
    // The newest automated batch is offered for Undo (it may have expired on a slow run).
    const offer = await undoOffer(app);
    if (offer !== null) {
      expect(offer).toMatchObject({ automated: true, archived: 0 });
    }

    // ── Three active days later (Balanced), the Sleeping tabs are archived: they are unloaded,
    // so no limit holds them back. The strip holds exactly its cap of unpinned tabs, so nothing
    // more goes to Sleeping.
    const days = await lifecyclePlanWith(app, { clock: { activeDays: 3 } });
    expect(days.every((action) => action.kind === 'archive')).toBe(true);
    expect(new Set(days.map((action) => action.tabId))).toEqual(new Set(shelfIds));
    for (const action of days) {
      expect(action.rule).toBe('archive-dormant');
    }
    await drainAll(app);
    const archived = await archivedTabs(app);
    const archivedIds = shelfIds;
    expect(archived.count).toBe(archivedIds.length);
    expect(new Set(archived.entries.map((tab) => tab.id))).toEqual(new Set(archivedIds));
    for (const tab of archived.entries) {
      expect(tab.reason).toBe('auto');
    }
    expect(await sleepingTabStates(app)).toEqual([]);
    const strip = layout.ids.filter((id) => !archivedIds.includes(id));
    await expect.poll(() => sidebarIds(shell)).toEqual(strip);
    const archiveLog = (await lifecycleLog(app)).filter((record) => record.kind === 'archive');
    expect(archiveLog.map((record) => word(record.result))).toEqual(archivedIds.map(() => 'moved'));
    expect(
      new Set(
        (await activityEntries(app))
          .filter((entry) => entry.action === 'archive' && entry.rule === 'archive-dormant')
          .map((entry) => entry.tabId),
      ),
    ).toEqual(new Set(archivedIds));
    expect(await selectedTabId(app)).toBe(lastShown);
  });
});

// ── 2. The presets ──────────────────────────────────────────────────────────────────────────────

type PresetName = NonNullable<LifecycleSettingsChange['preset']>;

test.describe('presets', () => {
  test('Aggressive discards after 15 minutes, pinned tabs too; Balanced after 60, not pinned ones; Gentle after 4 hours', async ({
    launcher,
    fixtureServer,
  }) => {
    const rig = await launchRig(launcher);
    const { app, shell } = rig;
    /** The plan under a preset (and `clock` more time), with Balanced put back in the same step. */
    const planUnder = (
      preset: PresetName,
      then: PresetName,
      wallMs?: number,
    ): Promise<LifecycleAction[]> =>
      lifecyclePlanWith(app, {
        ...(wallMs === undefined ? {} : { clock: { wallMs } }),
        settings: { preset },
        then: { settings: { preset: then } },
      });

    // ── Aggressive: 15 minutes, and pinned tabs are discardable.
    const unpinnedA = await openPage(rig, plain(fixtureServer, 'preset-a-unpinned'));
    const pinnedA = await openPage(rig, plain(fixtureServer, 'preset-a-pinned'));
    await togglePinWithButton(shell, pinnedA.tabId);
    await showBlank(rig);
    expect(await planUnder('aggressive', 'balanced', 13 * MINUTE), 'at 13 minutes').toEqual([]);
    const aggressive = await planUnder('aggressive', 'balanced', 3 * MINUTE);
    expect(
      discardIds(aggressive),
      'at 16 minutes, Aggressive plans both, longest hidden first',
    ).toEqual([unpinnedA.tabId, pinnedA.tabId]);
    expect(await planUnder('balanced', 'balanced'), 'Balanced waits for 60 minutes').toEqual([]);
    expect(await planUnder('gentle', 'balanced'), 'Gentle waits for 4 hours').toEqual([]);
    await setLifecycleSettings(app, { preset: 'aggressive' });
    await drain(app);
    let log = await lifecycleLog(app);
    for (const tabId of [unpinnedA.tabId, pinnedA.tabId]) {
      expect(attemptsAt(log, tabId)).toMatchObject({
        results: ['discarded'],
        rules: ['discard-hidden'],
      });
      await expectUnloaded(app, tabId);
    }
    await setLifecycleSettings(app, { preset: 'balanced' });

    // ── Balanced: 60 minutes, and a pinned tab stays.
    const unpinnedB = await openPage(rig, plain(fixtureServer, 'preset-b-unpinned'));
    const pinnedB = await openPage(rig, plain(fixtureServer, 'preset-b-pinned'));
    await togglePinWithButton(shell, pinnedB.tabId);
    await showBlank(rig);
    expect(await planUnder('balanced', 'balanced', 58 * MINUTE), 'at 58 minutes').toEqual([]);
    expect(
      discardIds(await planUnder('balanced', 'balanced', 3 * MINUTE)),
      'at 61 minutes, Balanced plans the unpinned tab only',
    ).toEqual([unpinnedB.tabId]);
    expect(await planUnder('gentle', 'balanced'), 'Gentle still waits').toEqual([]);
    expect(
      discardIds(await planUnder('aggressive', 'balanced')),
      'Aggressive would take the pinned tab too',
    ).toEqual([unpinnedB.tabId, pinnedB.tabId]);
    await drain(app);
    log = await lifecycleLog(app);
    expect(attemptsAt(log, unpinnedB.tabId)).toMatchObject({ results: ['discarded'] });
    expect(log.filter((record) => record.tabId === pinnedB.tabId)).toEqual([]);
    await expectUnloaded(app, unpinnedB.tabId);
    await expectLive(app, pinnedB);

    // ── Gentle: nothing at 61 minutes, the unpinned tab after 4 hours, never the pinned one.
    const unpinnedC = await openPage(rig, plain(fixtureServer, 'preset-c-unpinned'));
    const pinnedC = await openPage(rig, plain(fixtureServer, 'preset-c-pinned'));
    await togglePinWithButton(shell, pinnedC.tabId);
    await showBlank(rig);
    await setLifecycleSettings(app, { preset: 'gentle' });
    expect(await planUnder('gentle', 'gentle', 61 * MINUTE), 'Gentle, 61 minutes').toEqual([]);
    expect(
      discardIds(await planUnder('balanced', 'gentle')),
      'the same tabs are a Balanced discard',
    ).toEqual([unpinnedC.tabId]);
    await lifecycleEvaluate(app);
    await settled(app);
    expect(
      (await lifecycleLog(app)).filter((record) => record.tabId === unpinnedC.tabId),
      'nothing was done to the tab at 61 minutes',
    ).toEqual([]);
    expect(await planUnder('gentle', 'gentle', 170 * MINUTE), 'Gentle, 3 h 51 min').toEqual([]);
    expect(
      discardIds(await planUnder('gentle', 'gentle', 20 * MINUTE)),
      'Gentle, 4 h 11 min: the unpinned tab, not the pinned one',
    ).toEqual([unpinnedC.tabId]);
    await drain(app);
    log = await lifecycleLog(app);
    expect(attemptsAt(log, unpinnedC.tabId)).toMatchObject({ results: ['discarded'] });
    expect(log.filter((record) => record.tabId === pinnedC.tabId)).toEqual([]);
    await expectUnloaded(app, unpinnedC.tabId);
    await expectLive(app, pinnedC);
    await expectLive(app, pinnedB);
  });
});

// ── 3. Protected tabs are never discarded ───────────────────────────────────────────────────────

test.describe('protections', () => {
  test('audio, capture, a page that objects to unloading, unsaved input, an open popup and open DevTools keep a tab, however far ahead the clock and under critical pressure; each is discardable once its protection ends', async ({
    launcher,
    fixtureServer,
  }) => {
    test.setTimeout(480_000);
    const rig = await launchRig(launcher);
    const { app, shell } = rig;

    // The tabs, one protection each, and a plain one as the control. Each is set up while it is
    // shown, then left.
    const audio = await openPlayingTab(rig, fixtureServer.url('/lifecycle-audio.html?case=auto'));
    const unload = await openPage(
      rig,
      fixtureServer.url('/lifecycle-unload.html?mode=always&case=auto'),
    );
    await clickElement(app, unload.contents, '#button');
    expect(await hasBeenActive(app, unload.contents), 'a real click activated the page').toBe(true);
    const dirty = await openPage(rig, fixtureServer.url('/lifecycle-form.html?case=auto-dirty'));
    await typeInto(app, dirty.contents, '#text', 'hi');
    const control = await openPage(rig, plain(fixtureServer, 'protections-control'));
    // Capture (a camera, a microphone or a screen share) is marked by a hook: see `markCaptured`.
    const captured = await openPage(rig, plain(fixtureServer, 'protections-captured'));
    await markCaptured(app, captured.contents, true);
    const opener = await openPage(rig, fixtureServer.url('/popup-opener.html?case=auto'));
    await clickElement(app, opener.contents, '#open-popup');
    await expect
      .poll(async () => (await popupWindows(app)).length, {
        message: 'a click should open one popup window',
        timeout: 30_000,
      })
      .toBe(1);
    const [popup] = await popupWindows(app);
    if (popup === undefined) {
      throw new Error('unreachable: one popup window is open');
    }
    const tools = await openPage(rig, fixtureServer.url('/page-a.html?case=auto-devtools'));
    await sendKey(app, tools.contents, 'F12');
    await expect
      .poll(() => isDevToolsOpened(app, tools.contents), { message: 'F12 should open DevTools' })
      .toBe(true);
    await showBlank(rig);
    expect(await isDevToolsOpened(app, tools.contents), 'DevTools stay open').toBe(true);
    expect(await isAudible(app, audio.contents)).toBe(true);

    // ── Far ahead (5 hours hidden, 3 engaged hours), Balanced: only what no protection or lesson
    // can know about is planned. The page's objection and the typed text are learned by asking.
    const plan = await lifecyclePlanWith(app, { clock: { wallMs: 5 * HOUR, engagedMs: 3 * HOUR } });
    expect(plan, 'no shelf with 8 tabs, no freeze').toHaveLength(3);
    expect(discardIds(plan), 'audio, capture, popup and DevTools are never planned').toEqual([
      unload.tabId,
      dirty.tabId,
      control.tabId,
    ]);
    await drain(app);
    let log = await lifecycleLog(app);
    expect(attemptsAt(log, control.tabId)).toMatchObject({ results: ['discarded'] });
    expect(attemptsAt(log, unload.tabId)).toMatchObject({
      results: ['blocked:page-unsaved-changes'],
      rules: ['discard-hidden'],
    });
    expect(attemptsAt(log, dirty.tabId)).toMatchObject({
      results: ['blocked:unsaved-input'],
      rules: ['discard-hidden'],
    });
    for (const never of [audio, captured, opener, tools]) {
      expect(
        log.filter((record) => record.tabId === never.tabId),
        `tab ${never.tabId} was never planned, so the log says nothing about it`,
      ).toEqual([]);
    }
    await expectUnloaded(app, control.tabId);
    for (const page of [audio, captured, unload, dirty, opener, tools]) {
      await expectLive(app, page);
    }
    expect(
      await fieldText(app, dirty.contents, '#text'),
      'the typed text is still there',
    ).toContain('hi');

    // ── Critical pressure overrides soft protections only: all of these are hard.
    await setMemoryPressure(app, 'critical');
    expect(await lifecyclePlan(app), 'critical pressure plans nothing here').toEqual([]);
    const logged = log.length;
    await lifecycleEvaluate(app);
    await settled(app);
    log = await lifecycleLog(app);
    expect(log, 'critical pressure discards nothing here either').toHaveLength(logged);
    for (const page of [audio, captured, unload, dirty, opener, tools]) {
      await expectLive(app, page);
    }
    await setMemoryPressure(app, 'none');

    // ── Each protection, lifted, lets the tab go: it was the protection that kept it.
    // An open popup window.
    await closeWindowShowing(app, popup.webContentsId);
    await expect
      .poll(async () => (await popupWindows(app)).length, { message: 'the popup should close' })
      .toBe(0);
    expect(discardIds(await lifecyclePlan(app))).toEqual([opener.tabId]);
    await drain(app);
    expect(attemptsAt(await lifecycleLog(app), opener.tabId)).toMatchObject({
      results: ['discarded'],
    });
    await expectUnloaded(app, opener.tabId);

    // Open DevTools.
    await closeDevTools(app, tools.contents);
    await expect
      .poll(() => isDevToolsOpened(app, tools.contents), { message: 'DevTools should close' })
      .toBe(false);
    expect(discardIds(await lifecyclePlan(app))).toEqual([tools.tabId]);
    await drain(app);
    expect(attemptsAt(await lifecycleLog(app), tools.tabId)).toMatchObject({
      results: ['discarded'],
    });
    await expectUnloaded(app, tools.tabId);

    // Capture.
    await markCaptured(app, captured.contents, false);
    expect(discardIds(await lifecyclePlan(app))).toEqual([captured.tabId]);
    await drain(app);
    expect(attemptsAt(await lifecycleLog(app), captured.tabId)).toMatchObject({
      results: ['discarded'],
    });
    await expectUnloaded(app, captured.tabId);

    // Audio protects for 2 minutes after it stops.
    await evaluateInTab(app, audio.contents, 'lifecycleAudio.stop()');
    await expect
      .poll(() => isAudible(app, audio.contents), {
        message: 'the tab should stop being audible',
        timeout: 30_000,
      })
      .toBe(false);
    expect(await lifecyclePlan(app), 'within 2 minutes of the tone, the tab is kept').toEqual([]);
    const afterGrace = discardIds(
      await lifecyclePlanWith(app, { clock: { wallMs: 2 * MINUTE + 5_000 } }),
    );
    const awake = (await workspaceSnapshot(shell)).tabs.find(
      (tab) => tab.id === audio.tabId,
    )?.keptAwake;
    expect(afterGrace, `after the 2 minutes it is planned (kept awake: ${String(awake)})`).toEqual([
      audio.tabId,
    ]);
    await drain(app);
    expect(attemptsAt(await lifecycleLog(app), audio.tabId)).toMatchObject({
      results: ['discarded'],
    });
    await expectUnloaded(app, audio.tabId);

    // What a discard learned stays for 30 minutes (real time): the two pages stay as they are.
    await expectLive(app, unload);
    await expectLive(app, dirty);
    expect(await lifecyclePlan(app)).toEqual([]);
    const finalLog = await lifecycleLog(app);
    for (const page of [unload, dirty]) {
      expect(
        attemptsAt(finalLog, page.tabId).results.every((result) => result.startsWith('blocked:')),
      ).toBe(true);
    }
  });

  test('never planned, however long the wait: the selected tab, a tab showing no web page, a tab that is loading', async ({
    launcher,
    fixtureServer,
  }) => {
    const rig = await launchRig(launcher);
    const { app, shell } = rig;
    const control = await openPage(rig, plain(fixtureServer, 'never-control'));
    // A tab with a page that starts another load, which the server holds back: it is loading
    // while it shows a web page.
    const loading = await openPage(rig, plain(fixtureServer, 'never-loading'));
    const key = `automation-never-${String(Date.now())}`;
    await typeAddress(shell, fixtureServer.url(`/held?key=${key}`));
    await expect
      .poll(async () => (await tabState(app, loading.tabId))?.loading, {
        message: 'the held page should keep the tab loading',
      })
      .toBe(true);
    // A tab on an error page: nothing listens on a closed server's port.
    const closed = await startFixtureServer();
    const refused = closed.url('/page-a.html?case=automation-never-error');
    await closed.close();
    const failed = await openTabAt(shell, refused);
    await expect(internalPage(shell, 'network-error')).toBeVisible({ timeout: 30_000 });
    // The selected tab, last.
    const selected = await openPage(rig, plain(fixtureServer, 'never-selected'));
    await delay(2_500);

    const plan = await lifecyclePlanWith(app, { clock: { wallMs: 5 * HOUR, engagedMs: 3 * HOUR } });
    expect(
      discardIds(plan),
      'the plain hidden tab is the only candidate: not the selected one, not the new-tab page, not the error page, not the loading tab',
    ).toEqual([control.tabId]);
    await drain(app);
    let log = await lifecycleLog(app);
    expect(attemptsAt(log, control.tabId)).toMatchObject({ results: ['discarded'] });
    for (const tabId of [rig.blank, failed, loading.tabId, selected.tabId]) {
      expect(log.filter((record) => record.tabId === tabId)).toEqual([]);
    }
    await expectLive(app, selected);
    expect(await tabState(app, failed)).toMatchObject({ page: { kind: 'internal' } });

    // The load ends: the tab shows a web page and is no longer busy, and it goes.
    fixtureServer.release(key);
    await expect
      .poll(async () => (await tabState(app, loading.tabId))?.loading, {
        message: 'the held page should finish loading',
        timeout: 30_000,
      })
      .toBe(false);
    expect(discardIds(await lifecyclePlan(app))).toEqual([loading.tabId]);
    await drain(app);
    log = await lifecycleLog(app);
    expect(attemptsAt(log, loading.tabId)).toMatchObject({ results: ['discarded'] });
    await expectUnloaded(app, loading.tabId);
    await expectLive(app, selected);
  });
});

// ── 3b. The scheduler and the pages it works on ─────────────────────────────────────────────────

test.describe('the scheduler and the pages it works on', () => {
  test('a tab the user comes back to while the scheduler is discarding it is not lost', async ({
    launcher,
    fixtureServer,
  }) => {
    const rig = await launchRig(launcher);
    const { app, shell } = rig;
    const target = await openPage(rig, plain(fixtureServer, 'race'));
    await showBlank(rig);
    // The page keeps its main thread busy for 4 seconds from now, so it cannot answer the wake-up
    // that opens a discard: the discard stays in flight, and the user has time to come back.
    await evaluateInTab(
      app,
      target.contents,
      'setTimeout(() => { const end = Date.now() + 4000; while (Date.now() < end) { /* busy */ } }, 0); 0',
    );
    const plan = await lifecyclePlanWith(app, { clock: { wallMs: 61 * MINUTE } });
    expect(discardIds(plan)).toEqual([target.tabId]);
    const evaluating = lifecycleEvaluate(app);
    await expect
      .poll(async () => (await tabState(app, target.tabId))?.runtime, {
        message: 'the scheduler should be discarding the tab',
      })
      .toBe('discarding');

    // The user clicks the tab in the sidebar.
    await selectTab(rig, target.tabId);
    await evaluating;
    await settled(app);

    // The scheduler's decision no longer held: it is logged as cancelled, and the page it was
    // closing is still there, answering.
    const log = await lifecycleLog(app);
    expect(attemptsAt(log, target.tabId)).toMatchObject({
      results: ['skipped:cancelled'],
      rules: ['discard-hidden'],
    });
    await waitForLoaded(app, target.tabId);
    expect(await selectedTabId(app)).toBe(target.tabId);
    expect(await tabState(app, target.tabId)).toMatchObject({
      runtime: 'live',
      attached: true,
      title: 'Lifecycle plain',
      webContentsId: target.contents,
    });
    expect(await evaluateInTab(app, target.contents, '1 + 1')).toBe(2);
    await expectConsistent(app, shell);
    expect(await lifecyclePlan(app), 'the selected tab is never planned').toEqual([]);
  });

  test('a page that cannot answer in time keeps its tab for that evaluation only: the next evaluation plans it again', async ({
    launcher,
    fixtureServer,
  }) => {
    test.setTimeout(480_000);
    const rig = await launchRig(launcher);
    const { app } = rig;
    const target = await openPage(rig, plain(fixtureServer, 'unanswered'));
    await showBlank(rig);
    // The page is busy for 7 seconds from now. A discard first wakes the renderer within 5
    // seconds (ADR-0003 item 12), and this page cannot answer by then.
    await evaluateInTab(
      app,
      target.contents,
      'setTimeout(() => { const end = Date.now() + 7000; while (Date.now() < end) { /* busy */ } }, 0); 0',
    );
    const plan = await lifecyclePlanWith(app, { clock: { wallMs: 61 * MINUTE } });
    expect(discardIds(plan)).toEqual([target.tabId]);

    await lifecycleEvaluate(app);
    await settled(app);
    let log = await lifecycleLog(app);
    const first = log.filter((record) => record.tabId === target.tabId && wasStarted(record));
    expect(first.map((record) => word(record.result))).toEqual(['blocked:probe-unanswered']);
    await expectLive(app, target);
    // Nothing was learned from it: the tab is still a candidate, and the next evaluation goes on.
    expect(discardIds(await lifecyclePlan(app))).toEqual([target.tabId]);
    await drain(app);
    log = await lifecycleLog(app);
    const attempts = attemptsAt(log, target.tabId);
    expect(attempts.unanswered).toBe(1);
    expect(attempts.results).toEqual(['discarded']);
    await expectUnloaded(app, target.tabId);
  });
});

// ── 4. Memory pressure ──────────────────────────────────────────────────────────────────────────

/**
 * Polls the plan under the REAL memory monitor (`setMemoryPressure(null)`, put back to 'none' in
 * the same step) until it agrees with the machine's free memory, and says what it found. The
 * monitor polls every 10 s, needs two polls in a row to enter a level, and releases moderate at 12%
 * free (src/main/lifecycle/memory-pressure.ts), so only the clear cases are asserted:
 *   under 8% free throughout: the monitor reads moderate or critical, which plans a pressure discard;
 *   13% or more throughout: it reads none, which plans nothing.
 * In between, or if the memory keeps crossing those lines, the check is inconclusive and says so.
 * The caller's clock must be below the discard-hidden rule, so that only pressure can plan.
 */
async function realMonitorAgrees(app: ElectronApplication): Promise<string> {
  const deadline = Date.now() + 45_000;
  let samples = 0;
  for (;;) {
    const before = freemem() / totalmem();
    const real = await lifecyclePlanWith(app, { pressure: null, then: { pressure: 'none' } });
    const after = freemem() / totalmem();
    samples += 1;
    for (const action of real) {
      expect(action.rule, 'only pressure can plan anything at this clock').toBe('pressure-discard');
    }
    expect(real.length).toBeLessThanOrEqual(3);
    const percent = (fraction: number): string => (100 * fraction).toFixed(1);
    if (Math.max(before, after) < 0.08 && real.length > 0) {
      return `${percent(before)}% free: the real monitor reads pressure and plans ${String(real.length)} discard(s) (sample ${String(samples)})`;
    }
    if (Math.min(before, after) >= 0.13 && real.length === 0) {
      return `${percent(before)}% free: the real monitor reads none and plans nothing (sample ${String(samples)})`;
    }
    if (Date.now() > deadline) {
      const clear = Math.max(before, after) < 0.08 || Math.min(before, after) >= 0.13;
      expect(
        clear,
        `${percent(before)}% free, yet the real monitor planned ${String(real.length)} action(s) for 45 s`,
      ).toBe(false);
      return `inconclusive: free memory stayed between 8% and 13% (${percent(before)}% last)`;
    }
    await delay(2_000);
  }
}

test.describe('memory pressure', () => {
  test('moderate pressure discards one tab per evaluation, least recently used first, and only tabs hidden 15 minutes or more', async ({
    launcher,
    fixtureServer,
  }) => {
    const rig = await launchRig(launcher);
    const { app } = rig;
    const old: OpenedPage[] = [];
    for (const name of ['a', 'b', 'c', 'd']) {
      old.push(await openPage(rig, plain(fixtureServer, `moderate-${name}`)));
    }
    await showBlank(rig);
    await advanceLifecycleClock(app, { wallMs: 20 * MINUTE });
    // Hidden for 3 minutes only, and touched with a real click.
    const recent = await openPage(rig, plain(fixtureServer, 'moderate-e'));
    await clickElement(app, recent.contents, '#text');
    await showBlank(rig);
    await advanceLifecycleClock(app, { wallMs: 3 * MINUTE });
    const order = old.map((page) => page.tabId);

    // No pressure: 23 minutes hidden is nothing (Balanced waits for 60).
    expect(await lifecyclePlan(app)).toEqual([]);

    // Back on the real monitor (`null`). With this clock only pressure can plan anything, so
    // whatever it reads, every action is a pressure discard, at most the critical budget of 3.
    note('real-monitor', await realMonitorAgrees(app));

    // Moderate: one per evaluation, in order of last use (checked on the log below), never
    // `recent`. Once the app's own timer is running it may take a turn, so the loop goes on until
    // nothing is planned instead of counting rounds.
    expect(await lifecyclePlanWith(app, { pressure: 'moderate' })).toMatchObject([
      { tabId: order[0], kind: 'discard', rule: 'pressure-discard', overrideSoft: false },
    ]);
    for (let round = 1; ; round += 1) {
      await settled(app);
      const plan = await lifecyclePlan(app);
      if (plan.length === 0) {
        break;
      }
      expect(round, 'four tabs take at most four evaluations').toBeLessThanOrEqual(order.length);
      expect(plan, `round ${String(round)}: one action`).toHaveLength(1);
      expect(plan[0]).toMatchObject({
        kind: 'discard',
        rule: 'pressure-discard',
        overrideSoft: false,
      });
      expect(order).toContain(plan[0]?.tabId);
      await lifecycleEvaluate(app);
    }
    await settled(app);
    expect(
      await lifecyclePlan(app),
      'the tab hidden for 3 minutes is not taken at moderate',
    ).toEqual([]);
    let log = await lifecycleLog(app);
    expect(tabsAttempted(log), 'least recently used first').toEqual(order);
    expect(mostStartedPerEvaluation(log), 'at most 1 per evaluation').toBe(1);
    for (const tabId of order) {
      expect(attemptsAt(log, tabId)).toMatchObject({
        results: ['discarded'],
        rules: ['pressure-discard'],
      });
      await expectUnloaded(app, tabId);
    }
    await expectLive(app, recent);
    expect(log.filter((record) => record.tabId === recent.tabId)).toEqual([]);

    // Critical: the budget is 3 and the minimum 2 minutes. It takes `recent` (3 minutes hidden)
    // although the click made it softly protected (the guard is 15 minutes): critical overrides.
    const plan = await lifecyclePlanWith(app, { pressure: 'critical' });
    expect(plan).toMatchObject([
      { tabId: recent.tabId, kind: 'discard', rule: 'pressure-discard', overrideSoft: true },
    ]);
    await drain(app);
    log = await lifecycleLog(app);
    expect(attemptsAt(log, recent.tabId)).toMatchObject({
      results: ['discarded'],
      rules: ['pressure-discard'],
    });
    await expectUnloaded(app, recent.tabId);
  });

  test('critical pressure discards up to 3 tabs per evaluation, those hidden 2 minutes or more', async ({
    launcher,
    fixtureServer,
  }) => {
    const rig = await launchRig(launcher);
    const { app } = rig;
    const old: OpenedPage[] = [];
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      old.push(await openPage(rig, plain(fixtureServer, `critical-${name}`)));
    }
    await showBlank(rig);
    await advanceLifecycleClock(app, { wallMs: 3 * MINUTE });
    // Hidden for under a minute when the pressure comes.
    const fresh = await openPage(rig, plain(fixtureServer, 'critical-f'));
    await showBlank(rig);
    const order = old.map((page) => page.tabId);

    // Moderate pressure needs 15 minutes: 3 minutes is nothing.
    expect(await lifecyclePlanWith(app, { pressure: 'moderate' })).toEqual([]);

    // Critical: the three least recently used, soft protections overridden.
    const plan = await lifecyclePlanWith(app, { pressure: 'critical' });
    expect(
      plan.map((action) => action.tabId),
      'budget 3, least recently used first',
    ).toEqual(order.slice(0, 3));
    for (const action of plan) {
      expect(action).toMatchObject({
        kind: 'discard',
        rule: 'pressure-discard',
        overrideSoft: true,
      });
    }
    await lifecycleEvaluate(app);
    await settled(app);
    let log = await lifecycleLog(app);
    const firstEvaluation = byEvaluation(log).find((group) => group.some(wasStarted));
    expect(new Set(firstEvaluation?.filter(wasStarted).map((record) => record.tabId))).toEqual(
      new Set(order.slice(0, 3)),
    );
    // The next evaluation takes the other two; the tab hidden for under 2 minutes waits.
    await drain(app);
    log = await lifecycleLog(app);
    expect(new Set(tabsAttempted(log))).toEqual(new Set(order));
    expect(mostStartedPerEvaluation(log)).toBeLessThanOrEqual(3);
    for (const tabId of order) {
      expect(attemptsAt(log, tabId)).toMatchObject({
        results: ['discarded'],
        rules: ['pressure-discard'],
      });
      await expectUnloaded(app, tabId);
    }
    await expectLive(app, fresh);
    expect(await lifecyclePlan(app), 'hidden under 2 minutes: not taken').toEqual([]);

    // It is taken once it has been hidden for 2 minutes.
    const later = await lifecyclePlanWith(app, { clock: { wallMs: 2 * MINUTE } });
    expect(later).toMatchObject([
      { tabId: fresh.tabId, kind: 'discard', rule: 'pressure-discard', overrideSoft: true },
    ]);
    await drain(app);
    expect(attemptsAt(await lifecycleLog(app), fresh.tabId)).toMatchObject({
      results: ['discarded'],
    });
    await expectUnloaded(app, fresh.tabId);
  });

  test('critical pressure lets soft protections go (a sensitive page, a focused editor) and keeps the hard ones', async ({
    launcher,
    fixtureServer,
  }) => {
    test.setTimeout(480_000);
    const rig = await launchRig(launcher);
    const { app } = rig;
    // In this order, which is the order of last use.
    const sensitive = await openPage(
      rig,
      fixtureServer.url('/lifecycle-sensitive.html?case=pressure-soft'),
    );
    const editing = await openPage(rig, fixtureServer.url('/lifecycle-form.html?case=pressure-ce'));
    await clickElement(app, editing.contents, '#ce');
    expect(await focusedId(app, editing.contents), 'the caret is in the editable region').toBe(
      'ce',
    );
    const dirty = await openPage(
      rig,
      fixtureServer.url('/lifecycle-form.html?case=pressure-dirty'),
    );
    await typeInto(app, dirty.contents, '#text', 'hi');
    const unload = await openPage(
      rig,
      fixtureServer.url('/lifecycle-unload.html?mode=always&case=pressure-unload'),
    );
    await clickElement(app, unload.contents, '#button');
    const audio = await openPlayingTab(
      rig,
      fixtureServer.url('/lifecycle-audio.html?case=pressure-audio'),
    );
    const control = await openPage(rig, plain(fixtureServer, 'pressure-control'));
    await showBlank(rig);
    await advanceLifecycleClock(app, { wallMs: 20 * MINUTE });

    // ── Moderate: one tab per evaluation, in order. Soft protections still protect, but the
    // policy learns them by asking: each is a `blocked` outcome with its reason.
    await setMemoryPressure(app, 'moderate');
    await drain(app);
    let log = await lifecycleLog(app);
    expect(tabsAttempted(log), 'in order of last use; audio is never asked').toEqual([
      sensitive.tabId,
      editing.tabId,
      dirty.tabId,
      unload.tabId,
      control.tabId,
    ]);
    const expected: [OpenedPage, string][] = [
      [sensitive, 'blocked:sensitive-page'],
      [editing, 'blocked:editing'],
      [dirty, 'blocked:unsaved-input'],
      [unload, 'blocked:page-unsaved-changes'],
      [control, 'discarded'],
    ];
    for (const [page, result] of expected) {
      expect(attemptsAt(log, page.tabId)).toMatchObject({
        results: [result],
        rules: ['pressure-discard'],
      });
    }
    expect(mostStartedPerEvaluation(log)).toBe(1);
    expect(log.filter((record) => record.tabId === audio.tabId)).toEqual([]);
    await expectUnloaded(app, control.tabId);
    for (const page of [sensitive, editing, dirty, unload, audio]) {
      await expectLive(app, page);
    }
    expect(await lifecyclePlan(app), 'everything left is protected at moderate').toEqual([]);

    // ── Critical: the two soft ones are taken, the hard ones (typed text, the page's objection,
    // audio) are not.
    const plan = await lifecyclePlanWith(app, { pressure: 'critical' });
    expect(plan.map((action) => action.tabId).sort()).toEqual(
      [sensitive.tabId, editing.tabId].sort(),
    );
    for (const action of plan) {
      expect(action).toMatchObject({ rule: 'pressure-discard', overrideSoft: true });
    }
    await drain(app);
    log = await lifecycleLog(app);
    for (const page of [sensitive, editing]) {
      expect(attemptsAt(log, page.tabId)).toMatchObject({
        results: [expected.find(([candidate]) => candidate === page)?.[1], 'discarded'],
      });
      await expectUnloaded(app, page.tabId);
    }
    for (const page of [dirty, unload, audio]) {
      await expectLive(app, page);
    }
    expect(await lifecyclePlan(app), 'the hard protections still hold').toEqual([]);
    expect(await fieldText(app, dirty.contents, '#text')).toContain('hi');
  });
});

// ── 5. The quiet start, and pausing ─────────────────────────────────────────────────────────────

test.describe('the quiet start and pause', () => {
  test('nothing is automated in the first minute, whatever the clock says; the first evaluation then comes by itself', async ({
    launcher,
    fixtureServer,
  }) => {
    test.setTimeout(420_000);
    const rig = await launchRig(launcher);
    const { app } = rig;
    const hidden = await openPage(rig, plain(fixtureServer, 'quiet'));
    await showBlank(rig);

    // Far ahead: the plan is there to see, so an empty log is the quiet start's doing.
    const plan = await lifecyclePlanWith(app, { clock: { wallMs: 5 * HOUR, engagedMs: 3 * HOUR } });
    expect(plan).toMatchObject([{ tabId: hidden.tabId, kind: 'discard', rule: 'discard-hidden' }]);
    // Events that ask the scheduler to evaluate, a second later: a tab switch and a settings
    // change. They are ignored while it is quiet. (The new tab was hidden just now, so it is no
    // candidate; neither is the one the app started with, which shows no web page.)
    const other = await openPage(rig, plain(fixtureServer, 'quiet-other'));
    await showBlank(rig);
    await setLifecycleSettings(app, { preset: 'balanced' });

    await delay(Math.max(0, rig.readyAt + 45_000 - Date.now()));
    expect(await lifecycleLog(app), 'nothing was planned or done in the quiet start').toEqual([]);
    await expectLive(app, hidden);
    await expectLive(app, other);

    // The quiet start is 2 minutes from the scheduler's start, which is a moment before the app was
    // ready. Then the timer evaluates by itself: no hook is called from here on.
    await expect
      .poll(
        async () =>
          (await lifecycleLog(app))
            .filter(wasStarted)
            .map((record) => `${record.tabId}:${word(record.result)}`),
        {
          message: 'the first tick should discard the hidden tab by itself',
          timeout: 180_000,
          intervals: [2_000],
        },
      )
      .toContain(`${hidden.tabId}:discarded`);
    const elapsed = Date.now() - rig.readyAt;
    note(
      'quiet-start',
      `the tab was discarded ${String(Math.round(elapsed / 1000))} s after the app was ready`,
    );
    expect(elapsed, 'not before the 2-minute quiet start was over').toBeGreaterThanOrEqual(90_000);
    const log = await lifecycleLog(app);
    expect(attemptsAt(log, hidden.tabId)).toMatchObject({
      results: ['discarded'],
      rules: ['discard-hidden'],
    });
    await expectUnloaded(app, hidden.tabId);
    await expectLive(app, other);
  });

  test('paused plans nothing, under any pressure; resuming plans the discard again', async ({
    launcher,
    fixtureServer,
  }) => {
    const rig = await launchRig(launcher);
    const { app } = rig;
    const hidden = await openPage(rig, plain(fixtureServer, 'pause'));
    await showBlank(rig);

    expect(
      await lifecyclePlanWith(app, {
        clock: { wallMs: 5 * HOUR, engagedMs: 3 * HOUR },
        settings: { paused: true },
      }),
      'paused, 5 hours ahead',
    ).toEqual([]);
    expect(
      await lifecyclePlanWith(app, { pressure: 'critical', then: { pressure: 'none' } }),
      'paused, critical pressure',
    ).toEqual([]);
    await lifecycleEvaluate(app);
    await settled(app);
    expect(await lifecycleLog(app), 'an evaluation while paused logs nothing').toEqual([]);
    await expectLive(app, hidden);

    const resumed = await lifecyclePlanWith(app, { settings: { paused: false } });
    expect(resumed).toMatchObject([
      { tabId: hidden.tabId, kind: 'discard', rule: 'discard-hidden' },
    ]);
    await drain(app);
    expect(attemptsAt(await lifecycleLog(app), hidden.tabId)).toMatchObject({
      results: ['discarded'],
    });
    await expectUnloaded(app, hidden.tabId);
  });
});

// ── 6. Activity: the recent-interaction guard ───────────────────────────────────────────────────

test.describe('activity', () => {
  test('a tab you just interacted with is softly protected for the guard (15 minutes, wall clock); critical pressure overrides it', async ({
    launcher,
    fixtureServer,
  }) => {
    const rig = await launchRig(launcher);
    const { app } = rig;

    // The control: hidden first and for longer than the guard, so any input it ever got (a real
    // mouse over the window while it was shown) is older than the guard by the time it matters.
    const untouched = await openPage(rig, plain(fixtureServer, 'guard-untouched'));
    const stray = await recordInputEvents(app, untouched.contents);
    await showBlank(rig);
    await advanceLifecycleClock(app, { wallMs: 16 * MINUTE });
    // The tab under test: a real click on plain text, then left. Nothing is typed, so there is no
    // unsaved input: the guard is the only thing that can keep it.
    const touched = await openPage(rig, plain(fixtureServer, 'guard-touched'));
    await clickElement(app, touched.contents, '#text');
    await showBlank(rig);

    // Why an override: with the shipped presets a tab hidden long enough to be discarded was last
    // touched at least as long ago, because only a shown tab takes input, so the guard (15 min)
    // cannot outlast the 60-minute rule. A user's override of the discard time can (§4.7).
    // 6 more minutes: `untouched` has been hidden 22, `touched` 6, and its click is 6 old.
    const guarded = await lifecyclePlanWith(app, {
      clock: { wallMs: 6 * MINUTE },
      settings: { overrides: { discardAfterMs: 5 * MINUTE } },
    });
    expect(
      discardIds(guarded),
      `only the untouched tab is planned (it saw ${String((await stray.all()).length)} input events)`,
    ).toEqual([untouched.tabId]);
    // Under critical pressure the soft guard gives way, and the tab hidden 2 minutes or more is
    // taken as a pressure discard. (Read and put back in one step.)
    const critical = await lifecyclePlanWith(app, {
      pressure: 'critical',
      then: { pressure: 'none' },
    });
    expect(critical.find((action) => action.tabId === touched.tabId)).toMatchObject({
      kind: 'discard',
      rule: 'pressure-discard',
      overrideSoft: true,
    });

    // Carry out the first plan: the untouched tab goes, the touched one is not even attempted.
    await drain(app);
    let log = await lifecycleLog(app);
    expect(attemptsAt(log, untouched.tabId)).toMatchObject({
      results: ['discarded'],
      rules: ['discard-hidden'],
    });
    await expectUnloaded(app, untouched.tabId);
    expect(log.filter((record) => record.tabId === touched.tabId)).toEqual([]);
    await expectLive(app, touched);

    // 12 minutes after the click: still inside the guard.
    expect(await lifecyclePlanWith(app, { clock: { wallMs: 6 * MINUTE } })).toEqual([]);
    // 16 minutes after it: the guard is over, and the tab can go.
    const over = await lifecyclePlanWith(app, { clock: { wallMs: 4 * MINUTE } });
    expect(over).toMatchObject([
      { tabId: touched.tabId, kind: 'discard', rule: 'discard-hidden', overrideSoft: false },
    ]);
    await drain(app);
    log = await lifecycleLog(app);
    expect(attemptsAt(log, touched.tabId)).toMatchObject({ results: ['discarded'] });
    await expectUnloaded(app, touched.tabId);
  });
});

// ── 7. Moves and Undo (M3.3) ────────────────────────────────────────────────────────────────────

test.describe('moves and Undo', () => {
  test('an automated batch can be undone: the tabs go back where they were, the undo is logged, and they are not moved straight back', async ({
    launcher,
    fixtureServer,
  }) => {
    const rig = await launchRig(launcher);
    const { app, shell } = rig;
    // 12 pages and the new-tab page: 13 unpinned tabs, 3 beyond Balanced's cap of 10.
    const pages: OpenedPage[] = [];
    for (let index = 0; index < 12; index += 1) {
      pages.push(await openPage(rig, plain(fixtureServer, `undo-${String(index)}`)));
    }
    await showBlank(rig);
    const strip = await sidebarIds(shell);
    const oldest = pages.slice(0, 3).map((page) => page.tabId);
    const next = pages.slice(3, 6).map((page) => page.tabId);

    // Three engaged hours later the three least recently used go to Sleeping, in one batch. The
    // wall clock moves 16 minutes, past the recent-interaction guard (a real mouse over the
    // window counts as input to the page shown) but short of the 60-minute discard rule.
    await advanceLifecycleClock(app, { engagedMs: 3 * HOUR, wallMs: 16 * MINUTE });
    const plan = await lifecyclePlan(app);
    expect(plan.every((action) => action.kind === 'shelve')).toBe(true);
    expect(new Set(plan.map((action) => action.tabId))).toEqual(new Set(oldest));
    await lifecycleEvaluate(app);
    await settled(app);
    const moved = (await lifecycleLog(app)).filter(
      (record) => record.kind === 'shelve' && record.result.outcome === 'moved',
    );
    expect(new Set(moved.map((record) => record.tabId))).toEqual(new Set(oldest));
    expect(new Set(moved.map((record) => record.batchId)).size, 'one batch').toBe(1);
    await expect.poll(() => sidebarIds(shell)).toEqual(strip.filter((id) => !oldest.includes(id)));
    const offer = await undoOffer(app);
    expect(offer).toMatchObject({ automated: true, shelved: 3, archived: 0 });
    expect(offer?.batchId).toBe(moved[0]?.batchId);

    // Undo, as the toast's button does: back in their places, still live, not selected.
    const undone = await shell.evaluate(
      (batchId) => (globalThis as PageGlobal).veltriva.lifecycle.undo({ batchId }),
      offer?.batchId ?? '',
    );
    expect(undone).toEqual({ ok: true, value: { undone: 3 } });
    await expect.poll(() => sidebarIds(shell)).toEqual(strip);
    expect(await sleepingTabStates(app)).toEqual([]);
    expect(await undoOffer(app)).toBeNull();
    expect(await selectedTabId(app)).toBe(rig.blank);
    for (const page of pages.slice(0, 3)) {
      await expectLive(app, page);
    }
    // The activity log tells the story: three moves and three undos, newest first.
    const activity = await activityEntries(app);
    expect(activity.slice(0, 3).map((entry) => entry.action)).toEqual(['undo', 'undo', 'undo']);
    expect(new Set(activity.slice(0, 3).map((entry) => entry.tabId))).toEqual(new Set(oldest));
    expect(
      new Set(
        activity
          .filter((entry) => entry.action === 'shelve' && entry.rule === 'shelve-beyond-cap')
          .map((entry) => entry.tabId),
      ),
    ).toEqual(new Set(oldest));

    // An undo counts as using the tabs: the next plan leaves them alone and takes the next three.
    const after = await lifecyclePlan(app);
    expect(new Set(after.map((action) => action.tabId))).toEqual(new Set(next));
  });
});
