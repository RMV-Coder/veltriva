// TabManager's protections and "why", driven by hand (M3.4: assessment §4.10 and §4.13). What keeps
// a tab as it is comes from several places, and TabManager composes them in one function that both
// the policy's facts (`lifecycleTabs`) and the discard and freeze refusals read: the protection
// monitor's signals (the `protections` option), the tab's HTML fullscreen, its activity in the
// background (a title or icon that changes while hidden), the user's protection and the lessons a
// discard learned. These tests walk each source once, then the pieces M3.4's "why" reads: the
// reasons `keptAwake` names, how low memory was when pressure unloaded a tab (`unloadPressure`),
// who moved a Sleeping tab there (`movedBy`), and the `onAutomaticUnloadShown` hook that counts a
// tab the user brings back.
//
// The fake runtime hands out deferred promises for `probe`, `closeForDiscard` and `freeze` (the
// ping answers at once), and the timers are manual: a test decides when the page answers, when it
// objects, and when a deadline passes. The clock is a number a test moves. It has two faces, as in
// the app: the plain `now` option, and the activity clock whose wall time is what protections and
// settling compare (`advance` moves both; one test moves them apart to see which one is read).
// The fake follows the Electron runtime's contract (./tab-runtime.ts):
//   - `closeForDiscard` settles `closed` when the web contents is destroyed, and the runtime then
//     reports `gone()` synchronously (TabManager ignores that one while its own close is in flight);
//   - `destroy()` settles pending closes as `closed`, without `gone`;
//   - `restore()` only into a brand-new runtime that is attached first (spike S2).
// Anything else the fake notices (a call into a gone web contents, a restore into a detached view)
// is recorded, and the invariants checked after every test (I1, I3, I4, I6, I7, I8) fail on it.
import { afterEach, describe, expect, it } from 'vitest';

import { LEARNED_RECHECK_MS } from '../../core/lifecycle/discard';
import type {
  DiscardBlock,
  DiscardOutcome,
  DiscardRequest,
  DiscardSkip,
  Timers,
} from '../../core/lifecycle/discard';
import type { MoveOutcome, MoveRequest, PlacementMove } from '../../core/lifecycle/placement';
import type { CloseMode, ProbeReading } from '../../core/lifecycle/probe';
import {
  BACKGROUND_ACTIVITY_MS,
  BACKGROUND_SETTLE_MS,
  LIFECYCLE_ACTIONS,
  PROTECTION_REASONS,
  blockingProtection,
  protectionFor,
} from '../../core/lifecycle/protections';
import type { Protection, ProtectionReason } from '../../core/lifecycle/protections';
import type { NavigationSnapshot } from '../../core/lifecycle/snapshot';
import type { TabHistory } from '../../core/session/history';
import { TabManager } from './tab-manager';
import type {
  CloseResult,
  FreezeOutcome,
  SessionTab,
  TabId,
  TabRuntime,
  TabRuntimeEvents,
  TabState,
} from './tab-manager';

const A = 'https://a.example/';
const B = 'https://b.example/page';
const C = 'https://c.example/';

const MINUTE = 60 * 1000;
const START = 1_000_000;

const AUTOMATION: DiscardRequest = { origin: 'automation' };
const USER: DiscardRequest = { origin: 'user' };
const CRITICAL: DiscardRequest = { origin: 'pressure', pressure: 'critical', overrideSoft: true };
const MODERATE: DiscardRequest = { origin: 'pressure', pressure: 'moderate' };

const USER_MOVE: MoveRequest = { origin: 'user' };
const AUTOMATION_MOVE: MoveRequest = { origin: 'automation' };

const DISCARDED: DiscardOutcome = { outcome: 'discarded' };
const blockedBy = (reason: DiscardBlock): DiscardOutcome => ({ outcome: 'blocked', reason });
const skippedAs = (why: DiscardSkip): DiscardOutcome => ({ outcome: 'skipped', why });

/** Lets every pending microtask run, so a continuation chained on a resolved promise has run. */
const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/** The item at `index`, or a failure that says what was missing (no `!` or silent undefined). */
function pick<T>(list: readonly T[], index: number, what: string): T {
  const item = list[index];
  if (item === undefined) {
    throw new Error(`no ${what} at ${String(index)} (there are ${String(list.length)})`);
  }
  return item;
}

/** Timers a test fires by hand. */
class ManualTimers implements Timers {
  #next = 1;
  readonly #pending = new Map<number, { readonly callback: () => void; readonly ms: number }>();

  setTimeout(callback: () => void, ms: number): number {
    const handle = this.#next;
    this.#next += 1;
    this.#pending.set(handle, { callback, ms });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') {
      this.#pending.delete(handle);
    }
  }
}

/** One back/forward entry of the fake's web contents; `pageState` is Chromium's, in memory. */
interface FakeEntry {
  url: string;
  title: string;
  pageState?: string;
}

interface RestoreCall {
  readonly history: NavigationSnapshot;
  /** Whether the view was shown by the time `restore()` ran (S2: attached first). */
  readonly shownFirst: boolean;
  /** Whether it was attached invisibly instead. */
  readonly hiddenFirst: boolean;
}

class FakeRuntime implements TabRuntime {
  /** Everything TabManager asked of this runtime, in order. */
  readonly calls: string[] = [];
  readonly loads: string[] = [];
  readonly restores: RestoreCall[] = [];
  /** One deferred per `probe()` call; the test answers it. */
  readonly probes: PromiseWithResolvers<unknown>[] = [];
  readonly closes: {
    readonly mode: CloseMode;
    readonly settle: PromiseWithResolvers<CloseResult>;
  }[] = [];
  readonly freezes: PromiseWithResolvers<undefined>[] = [];
  /** The web contents exists: false once it was destroyed, by TabManager or by itself. */
  alive = true;
  shown = false;
  hiddenAttached = false;
  frozen = false;
  /** The back/forward stack of the page: what `history()` and `snapshot()` report. */
  entries: FakeEntry[] = [];
  index = 0;

  constructor(
    readonly tabId: TabId,
    readonly events: TabRuntimeEvents,
    readonly failures: string[],
  ) {}

  load(url: string): void {
    this.#use('load');
    this.loads.push(url);
  }
  goBack(): void {
    this.#use('goBack');
  }
  goForward(): void {
    this.#use('goForward');
  }
  reload(): void {
    this.#use('reload');
  }
  stop(): void {
    this.calls.push('stop');
  }
  find(): number {
    return 1;
  }
  stopFind(): void {
    this.calls.push('stopFind');
  }
  zoomFactor(): number {
    return 1;
  }
  setZoomFactor(): void {
    this.calls.push('zoom');
  }
  toggleDevTools(): void {
    this.calls.push('devtools');
  }
  exitFullscreen(): void {
    this.calls.push('exitFullscreen');
  }
  show(): void {
    this.#use('show');
    this.shown = true;
    this.hiddenAttached = false;
  }
  showHidden(): void {
    this.#use('showHidden');
    this.shown = false;
    this.hiddenAttached = true;
  }
  hide(): void {
    this.calls.push('hide');
    this.shown = false;
    this.hiddenAttached = false;
  }
  focus(): void {
    this.calls.push('focus');
  }
  destroy(): void {
    this.calls.push('destroy');
    this.shown = false;
    this.hiddenAttached = false;
    if (this.alive) {
      this.alive = false;
      this.#webContentsGone();
    }
  }
  restore(history: NavigationSnapshot): void {
    this.#use('restore');
    if (this.loads.length > 0 || this.restores.length > 0) {
      this.failures.push(`S2: restore() into a runtime of ${this.tabId} that already loaded`);
    }
    if (!this.shown && !this.hiddenAttached) {
      this.failures.push(`S2: restore() into a detached runtime of ${this.tabId}`);
    }
    this.restores.push({ history, shownFirst: this.shown, hiddenFirst: this.hiddenAttached });
    // Chromium has the restored stack from then on: a later snapshot reads it.
    this.entries = history.entries.map((entry) => ({ ...entry }));
    this.index = history.index;
  }
  history(): TabHistory | null {
    if (!this.alive || this.entries.length === 0) {
      return null;
    }
    return {
      index: this.index,
      entries: this.entries.map(({ url, title }) => ({ url, title })),
    };
  }
  ping(): Promise<unknown> {
    this.#use('ping');
    return Promise.resolve(undefined); // The renderer is awake.
  }
  probe(): Promise<unknown> {
    this.#use('probe');
    const probe = Promise.withResolvers<unknown>();
    this.probes.push(probe);
    return probe.promise;
  }
  snapshot(): { readonly index: number; readonly entries: readonly unknown[] } | null {
    this.calls.push('snapshot');
    if (!this.alive || this.entries.length === 0) {
      return null;
    }
    return { index: this.index, entries: this.entries.map((entry) => ({ ...entry })) };
  }
  closeForDiscard(mode: CloseMode): Promise<CloseResult> {
    this.#use(`closeForDiscard:${mode}`);
    const settle = Promise.withResolvers<CloseResult>();
    this.closes.push({ mode, settle });
    // ADR-0002 §2: the real runtime detaches the view before it closes.
    this.shown = false;
    this.hiddenAttached = false;
    return settle.promise;
  }
  freeze(): Promise<void> {
    this.#use('freeze');
    this.frozen = true;
    const freeze = Promise.withResolvers<undefined>();
    this.freezes.push(freeze);
    return freeze.promise;
  }
  thaw(): void {
    this.calls.push('thaw');
    this.frozen = false;
  }

  // What the test does to the page. `nth` defaults to the latest call.

  /** The probe answers. */
  answerProbe(value: unknown, nth = this.probes.length - 1): void {
    pick(this.probes, nth, 'probe').resolve(value);
  }
  /** The page's beforeunload handler objects: the close settles `prevented` and the page lives. */
  prevent(nth = this.closes.length - 1): void {
    pick(this.closes, nth, 'close').settle.resolve('prevented');
  }
  /**
   * The web contents is destroyed without destroy(): the pending closes settle as `closed`, and
   * the runtime reports `gone()` straight after (./tab-runtime.ts).
   */
  contentsDestroyed(): void {
    if (!this.alive) {
      return;
    }
    this.alive = false;
    this.shown = false;
    this.hiddenAttached = false;
    this.#webContentsGone();
    this.events.gone();
  }

  /** Pending closes settle as `closed`; a script still running in the page fails. */
  #webContentsGone(): void {
    for (const close of this.closes) {
      close.settle.resolve('closed');
    }
    for (const probe of this.probes) {
      probe.reject(new Error('the web contents was destroyed'));
    }
  }

  #use(call: string): void {
    this.calls.push(call);
    if (!this.alive) {
      this.failures.push(`${call}() on a runtime of ${this.tabId} whose web contents is gone`);
    }
  }
}

/** An operation's result, once it settles. A rejection is recorded as a failure. */
class Tracked<T> {
  #value: T | undefined;
  settled = false;

  constructor(promise: Promise<T>, failures: string[]) {
    void promise.then(
      (value) => {
        this.#value = value;
        this.settled = true;
      },
      (error: unknown) => {
        this.settled = true;
        failures.push(`an operation rejected: ${String(error)}`);
      },
    );
  }

  /** The result; throws if the operation hasn't settled (a test that forgot to flush). */
  get value(): T {
    if (!this.settled || this.#value === undefined) {
      throw new Error('the operation has not settled');
    }
    return this.#value;
  }
}

/** A probe's answer: clean unless the test says otherwise. */
function reading(overrides: Partial<ProbeReading> = {}): ProbeReading {
  return {
    changedFields: 0,
    editedFields: 0,
    focusedEditable: false,
    sensitive: false,
    playingMedia: false,
    hasBeenActive: false,
    flushed: true,
    ...overrides,
  };
}

function commit(
  runtime: FakeRuntime,
  url: string,
  options: { readonly sameDocument?: boolean; readonly canGoBack?: boolean } = {},
): void {
  runtime.events.committed({
    url,
    sameDocument: options.sameDocument ?? false,
    canGoBack: options.canGoBack ?? false,
    canGoForward: false,
  });
}

/** A page that committed and stopped loading. */
function finishLoad(runtime: FakeRuntime, url: string): void {
  commit(runtime, url);
  runtime.events.loadingChanged(false);
}

interface WebTabOptions {
  readonly select?: boolean;
  readonly title?: string;
}

/** What `onAutomaticUnloadShown` was told, with how the tab looked at that moment. */
interface AutomaticUnloadShown {
  readonly tabId: TabId;
  readonly unloadedBy: 'automation' | 'pressure';
  /** The tab's runtime state when the hook ran: the reload hasn't started if it is `unloaded`. */
  readonly runtime: TabState['runtime'];
  /** How many runtimes the tab had had by then. */
  readonly runtimes: number;
  readonly selected: TabId | null;
}

function build() {
  const timers = new ManualTimers();
  // `now` is the plain option (createdAt and the like); `wall` is the activity clock's wall time,
  // which protections, settling and lessons compare. `advance` moves both.
  const clock = { now: START, wall: START, engaged: 0, activeDay: 1 };
  const runtimes: FakeRuntime[] = [];
  const failures: string[] = [];
  const protections = new Map<TabId, Protection[]>();
  const shown: AutomaticUnloadShown[] = [];
  let nextId = 0;
  let edits = 0;

  /** Every runtime a tab has had, oldest first. */
  const runtimesOf = (tabId: TabId): FakeRuntime[] =>
    runtimes.filter((runtime) => runtime.tabId === tabId);
  const manager = new TabManager({
    createRuntime: (tabId, events) => {
      const runtime = new FakeRuntime(tabId, events, failures);
      runtimes.push(runtime);
      return runtime;
    },
    newId: () => `tab-${String((nextId += 1))}`,
    onChange: () => undefined,
    now: () => clock.now,
    activityClock: () => ({
      wallNow: clock.wall,
      engagedNow: clock.engaged,
      activeDay: clock.activeDay,
    }),
    timers,
    protections: (tabId) => protections.get(tabId) ?? [],
    onAutomaticUnloadShown: (tabId, unloadedBy) => {
      shown.push({
        tabId,
        unloadedBy,
        runtime: manager.get(tabId).runtime,
        runtimes: runtimesOf(tabId).length,
        selected: manager.selectedTabId(),
      });
    },
  });

  /** The one runtime of the tab whose web contents exists. */
  const runtimeOf = (tabId: TabId): FakeRuntime => {
    const alive = runtimesOf(tabId).filter((runtime) => runtime.alive);
    const [runtime] = alive;
    if (alive.length !== 1 || runtime === undefined) {
      throw new Error(`expected one live runtime for ${tabId}, found ${String(alive.length)}`);
    }
    return runtime;
  };
  /** A tab showing a committed page that stopped loading, as a user's own navigation leaves it. */
  const webTab = (url: string, tab: WebTabOptions = {}): TabId => {
    const id = manager.create({ select: tab.select ?? false });
    manager.navigate(id, url);
    const runtime = runtimeOf(id);
    const title = tab.title ?? 'Page';
    runtime.entries = [{ url, title, pageState: `ps:${url}` }];
    runtime.index = 0;
    commit(runtime, url);
    runtime.events.titleChanged(title);
    runtime.events.loadingChanged(false);
    return id;
  };
  const track = <T>(promise: Promise<T>): Tracked<T> => new Tracked(promise, failures);
  return {
    manager,
    clock,
    runtimes,
    failures,
    protections,
    shown,
    runtimesOf,
    runtimeOf,
    webTab,
    track,
    /** Time passes, on both faces of the clock. */
    advance: (ms: number): void => {
      clock.now += ms;
      clock.wall += ms;
    },
    discard: (tabId: TabId, request: DiscardRequest = AUTOMATION): Tracked<DiscardOutcome> =>
      track(manager.discard(tabId, request)),
    freeze: (tabId: TabId): Tracked<FreezeOutcome> => track(manager.freeze(tabId)),
    /** A page's title changes to something it wasn't (a new one every time). */
    changeTitle: (tabId: TabId): void => {
      edits += 1;
      runtimeOf(tabId).events.titleChanged(`Inbox (${String(edits)})`);
    },
    /** A page's icon changes to one it didn't have (a new one every time). */
    changeIcon: (tabId: TabId): void => {
      edits += 1;
      runtimeOf(tabId).events.faviconChanged(`https://a.example/icon-${String(edits)}.png`);
    },
    /** The reasons that keep the tab awake, as M3.4's "why" names them. */
    kept: (tabId: TabId): ProtectionReason[] => manager.keptAwake(tabId),
    /** What the policy is told about one tab. */
    factsOf: (tabId: TabId) => {
      const facts = manager.lifecycleTabs().find((tab) => tab.id === tabId);
      if (facts === undefined) {
        throw new Error(`the policy sees no tab ${tabId}`);
      }
      return facts;
    },
    sessionTab: (tabId: TabId): SessionTab | undefined =>
      manager.sessionTabs().find((tab) => tab.id === tabId),
    sleeping: (): TabId[] => manager.sleepingTabs().map((tab) => tab.id),
    archived: (): TabId[] => manager.archivedTabs().map((tab) => tab.id),
  };
}

type Base = ReturnType<typeof build>;
type Env = Base & { readonly home: TabId };

/** The test being run, for the invariants checked after it. */
let active: Base | undefined;

/** A manager with no tabs: for restoreSession, which needs an empty one. */
function setupEmpty(): Base {
  const base = build();
  active = base;
  return base;
}

/** A manager with a selected new-tab page, `home`, so the tabs a test makes can stay in the background. */
function setup(): Env {
  const base = setupEmpty();
  return { ...base, home: base.manager.create() };
}

/**
 * I1 (every tab in exactly one placement, the selected one in the strip), I3 (no web contents in
 * the Archive), I4, I6, I7 and I8 (tab-manager.ts), plus whatever the fakes noticed.
 */
function checkInvariants(env: Base): void {
  const { manager } = env;
  const problems = [...env.failures];
  const strip = manager.tabs();
  const sleeping = manager.sleepingTabs();
  const archived = manager.archivedTabs();
  const stripIds = new Set(strip.map((tab) => tab.id));
  const resident = [...strip, ...sleeping];
  const residentIds = new Set(resident.map((tab) => tab.id));
  const everyId = [...resident.map((tab) => tab.id), ...archived.map((tab) => tab.id)];
  // I1
  if (new Set(everyId).size !== everyId.length) {
    problems.push('I1: a tab is in two placements');
  }
  for (const tab of strip) {
    if (tab.placement !== 'strip') {
      problems.push(`I1: ${tab.id} is in the strip with placement ${tab.placement}`);
    }
  }
  for (const tab of sleeping) {
    if (tab.placement !== 'shelf') {
      problems.push(`I1: ${tab.id} is Sleeping with placement ${tab.placement}`);
    }
  }
  const selected = manager.selectedTabId();
  if (strip.length === 0) {
    problems.push('I1: the strip is empty');
  }
  if (selected === null || !stripIds.has(selected)) {
    problems.push(`I1: the selected tab ${String(selected)} is not in the strip`);
  } else {
    const tab = manager.get(selected);
    const held = manager.lifecycleFacts(selected).heldUnloaded;
    const unloadedOk = tab.runtime === 'unloaded' && (tab.page.kind === 'internal' || held);
    if (!['creating', 'live', 'crashed'].includes(tab.runtime) && !unloadedOk) {
      problems.push(`I2: the selected tab ${selected} is ${tab.runtime}`);
    }
  }
  // I8
  for (const tab of sleeping) {
    if (tab.pinned) {
      problems.push(`I8: ${tab.id} is pinned and Sleeping`);
    }
  }
  for (const tab of archived) {
    if (tab.pinned) {
      problems.push(`I8: ${tab.id} is pinned and archived`);
    }
  }
  // I3 and I4: a tab holds a web contents exactly when it isn't unloaded; a closed or archived tab
  // holds none.
  const alive = new Map<TabId, number>();
  for (const runtime of env.runtimes.filter((candidate) => candidate.alive)) {
    alive.set(runtime.tabId, (alive.get(runtime.tabId) ?? 0) + 1);
  }
  for (const [tabId, count] of alive) {
    if (!residentIds.has(tabId)) {
      problems.push(`I3/I4: a zombie runtime for ${tabId}, which is closed or archived`);
    }
    if (count > 1) {
      problems.push(`I4: ${tabId} has ${String(count)} live runtimes`);
    }
  }
  for (const tab of resident) {
    const count = alive.get(tab.id) ?? 0;
    if ((tab.runtime === 'unloaded') !== (count === 0)) {
      problems.push(`I4: ${tab.id} is ${tab.runtime} with ${String(count)} live runtimes`);
    }
    if (manager.lifecycleFacts(tab.id).running > 1) {
      problems.push(`I7: ${tab.id} runs more than one lifecycle operation`);
    }
  }
  // At most one view is shown: the selected tab's, and only while it shows web content.
  const shown = env.runtimes.filter((runtime) => runtime.shown);
  if (shown.length > 1) {
    problems.push(`${String(shown.length)} views shown`);
  }
  for (const runtime of shown) {
    if (runtime.tabId !== selected) {
      problems.push(`the view of ${runtime.tabId} is shown but ${String(selected)} is selected`);
    }
  }
  // I6: an ephemeral tab never reaches the session, whether it is in the strip or Sleeping.
  const ephemeral = new Set(resident.filter((tab) => tab.ephemeral).map((tab) => tab.id));
  for (const tab of [...manager.sessionTabs(), ...manager.shelfSessionTabs()]) {
    if (ephemeral.has(tab.id)) {
      problems.push(`I6: ephemeral ${tab.id} reached the session`);
    }
  }
  for (const tab of archived) {
    if (manager.has(tab.id)) {
      problems.push(`I1: archived ${tab.id} is also a live record`);
    }
  }
  expect(problems).toEqual([]);
}

afterEach(() => {
  const env = active;
  active = undefined;
  if (env !== undefined) {
    checkInvariants(env);
  }
});

/** A saved tab with two history entries, the second active. */
function savedTab(id: string): SessionTab {
  const url = `https://${id}.example/`;
  return {
    id,
    pinned: false,
    url,
    title: `Title ${id}`,
    history: {
      index: 1,
      entries: [
        { url: `${url}old`, title: `Old ${id}` },
        { url, title: `Title ${id}` },
      ],
    },
    createdAt: 1000,
    lastUsedAt: 2000,
    lastUsedEngaged: 0,
    lastUsedActiveDay: 1,
    userProtected: false,
    placementChangedAt: 1000,
  };
}

function session(
  overrides: Partial<Parameters<TabManager['restoreSession']>[0]> = {},
): Parameters<TabManager['restoreSession']>[0] {
  return { tabs: [], selectedTabId: null, closed: [], loadSelected: false, ...overrides };
}

/**
 * A manager whose strip holds the saved tabs `ids` (the first selected), none of them loaded: a
 * tab that was never live can move without a discard.
 */
function savedStrip(ids: readonly string[]): Base {
  const env = setupEmpty();
  env.manager.restoreSession(
    session({ tabs: ids.map((id) => savedTab(id)), selectedTabId: ids[0] ?? null }),
  );
  return env;
}

/** Discards a background tab all the way: a clean probe, a plain close that goes through. */
async function discardCompletely(
  env: Base,
  tabId: TabId,
  request: DiscardRequest = AUTOMATION,
): Promise<void> {
  const runtime = env.runtimeOf(tabId);
  const discard = env.discard(tabId, request);
  await flush();
  runtime.answerProbe(reading());
  await flush();
  runtime.contentsDestroyed();
  await flush();
  expect(discard.value).toEqual(DISCARDED);
  expect(env.manager.get(tabId).runtime).toBe('unloaded');
}

/** A discard whose probe finds unsaved input: the tab stays, and the discard learns why. */
async function learnUnsavedInput(env: Base, tabId: TabId): Promise<void> {
  const discard = env.discard(tabId, AUTOMATION);
  await flush();
  env.runtimeOf(tabId).answerProbe(reading({ editedFields: 1 }));
  await flush();
  expect(discard.value).toEqual(blockedBy('unsaved-input'));
}

/** The page of an unloaded tab loads again; then the tab goes back to the background. */
function reloadInBackground(env: Env, tabId: TabId): void {
  env.manager.select(tabId);
  finishLoad(env.runtimeOf(tabId), A);
  env.manager.select(env.home);
}

describe('TabManager protection: background activity', () => {
  it('protects a hidden tab softly once its title changes after the settle time', () => {
    const env = setup();
    const id = env.webTab(A);
    expect(env.kept(id)).toEqual([]);

    env.advance(BACKGROUND_SETTLE_MS);
    env.changeTitle(id);

    expect(env.kept(id)).toEqual(['background-activity']);
    expect(env.factsOf(id).protections).toEqual([protectionFor('background-activity')]);
    // Soft, and it concerns freezing and discarding only.
    expect(protectionFor('background-activity')).toMatchObject({
      hard: false,
      blocks: ['freeze', 'discard'],
    });
  });

  it('does the same for a change of its icon', () => {
    const env = setup();
    const id = env.webTab(A);

    env.advance(BACKGROUND_SETTLE_MS);
    env.changeIcon(id);

    expect(env.kept(id)).toEqual(['background-activity']);
  });

  it.each(['title', 'icon'] as const)(
    'counts a %s change only from the settle time on, to the millisecond',
    (kind) => {
      const change = (env: Env, id: TabId): void => {
        if (kind === 'title') {
          env.changeTitle(id);
        } else {
          env.changeIcon(id);
        }
      };
      const early = setup();
      const earlyTab = early.webTab(A);
      early.advance(BACKGROUND_SETTLE_MS - 1);
      change(early, earlyTab);
      expect(early.kept(earlyTab)).toEqual([]);

      const settled = setup();
      const settledTab = settled.webTab(A);
      settled.advance(BACKGROUND_SETTLE_MS);
      change(settled, settledTab);
      expect(settled.kept(settledTab)).toEqual(['background-activity']);
    },
  );

  it('measures the settle time from when the tab was hidden, not from when it was made', () => {
    const env = setup();
    const id = env.webTab(A);
    env.manager.select(id);
    env.advance(10 * MINUTE);
    env.manager.select(env.home); // Hidden from here on.

    env.advance(BACKGROUND_SETTLE_MS - 1);
    env.changeTitle(id);
    expect(env.kept(id)).toEqual([]);

    env.advance(1);
    env.changeTitle(id);
    expect(env.kept(id)).toEqual(['background-activity']);
  });

  it('never stamps the selected tab, and a tab just hidden has to settle again', () => {
    const env = setup();
    const id = env.webTab(A);
    env.manager.select(id);
    env.advance(60 * MINUTE);

    env.changeTitle(id);
    env.changeIcon(id);
    expect(env.kept(id)).toEqual([]);

    // It was in use for an hour, but it has only just been hidden.
    env.manager.select(env.home);
    env.changeTitle(id);
    expect(env.kept(id)).toEqual([]);
    expect(env.factsOf(id).protections).toEqual([]);
  });

  it('ignores a title or icon that does not change, however it is spelled', () => {
    const env = setup();
    const id = env.webTab(A, { title: 'Inbox' });
    const runtime = env.runtimeOf(id);
    env.advance(BACKGROUND_SETTLE_MS);

    runtime.events.titleChanged('Inbox');
    // Page titles are sanitized: these are the same title.
    runtime.events.titleChanged('  Inbox​\u0007 ');
    runtime.events.faviconChanged(null); // There was no icon, and there still is none.
    expect(env.kept(id)).toEqual([]);

    runtime.events.titleChanged('Inbox (1)');
    expect(env.kept(id)).toEqual(['background-activity']);
  });

  it('ignores an icon that is the one it has', () => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);
    runtime.events.faviconChanged('https://a.example/icon.png'); // Young: not yet activity.
    env.advance(BACKGROUND_SETTLE_MS);

    runtime.events.faviconChanged('https://a.example/icon.png');
    expect(env.kept(id)).toEqual([]);

    runtime.events.faviconChanged('https://a.example/other.png');
    expect(env.kept(id)).toEqual(['background-activity']);
  });

  it('lasts an hour after the last change, to the millisecond', () => {
    const env = setup();
    const id = env.webTab(A);
    env.advance(BACKGROUND_SETTLE_MS);
    env.changeTitle(id);

    env.advance(BACKGROUND_ACTIVITY_MS - 1);
    expect(env.kept(id)).toEqual(['background-activity']);
    expect(env.factsOf(id).protections).toHaveLength(1);

    env.advance(1);
    expect(env.kept(id)).toEqual([]);
    expect(env.factsOf(id).protections).toEqual([]);
  });

  it('is renewed by every later change', () => {
    const env = setup();
    const id = env.webTab(A);
    env.advance(BACKGROUND_SETTLE_MS);
    env.changeTitle(id);

    env.advance(50 * MINUTE);
    env.changeTitle(id);
    env.advance(50 * MINUTE); // 100 minutes since the first change, 50 since the last.
    expect(env.kept(id)).toEqual(['background-activity']);

    env.advance(10 * MINUTE);
    expect(env.kept(id)).toEqual([]);
  });

  it('ends with a new document, but not with a change inside the same one', () => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);
    env.advance(BACKGROUND_SETTLE_MS);
    env.changeTitle(id);

    commit(runtime, `${A}#section`, { sameDocument: true });
    expect(env.kept(id)).toEqual(['background-activity']);

    commit(runtime, B);
    expect(env.kept(id)).toEqual([]);

    // The new document is a page of its own: it settles first, then has to be active again.
    env.changeTitle(id);
    expect(env.kept(id)).toEqual([]);
    env.advance(BACKGROUND_SETTLE_MS);
    env.changeTitle(id);
    expect(env.kept(id)).toEqual(['background-activity']);
  });

  it('reads the activity clock, not the plain one', () => {
    const settling = setup();
    const young = settling.webTab(A);
    settling.clock.now += BACKGROUND_SETTLE_MS * 10; // Only the plain clock moves.
    settling.changeTitle(young);
    expect(settling.kept(young)).toEqual([]);

    const lasting = setup();
    const id = lasting.webTab(A);
    lasting.advance(BACKGROUND_SETTLE_MS);
    lasting.changeTitle(id);
    lasting.clock.now += BACKGROUND_ACTIVITY_MS * 2; // Only the plain clock moves.
    expect(lasting.kept(id)).toEqual(['background-activity']);

    lasting.clock.wall += BACKGROUND_ACTIVITY_MS; // Now the one that counts does.
    expect(lasting.kept(id)).toEqual([]);
  });

  it('does not protect on a clock that went backwards', () => {
    const env = setup();
    const id = env.webTab(A);
    env.advance(BACKGROUND_SETTLE_MS);
    env.changeTitle(id);
    expect(env.kept(id)).toEqual(['background-activity']);

    env.clock.wall -= 1;

    expect(env.kept(id)).toEqual([]);
  });

  it('ignores the events of a page that is gone', async () => {
    const env = setup();
    const id = env.webTab(A);
    const old = env.runtimeOf(id);
    await discardCompletely(env, id);
    env.advance(BACKGROUND_SETTLE_MS);

    old.events.titleChanged('Late news');
    old.events.faviconChanged('https://a.example/late.png');

    expect(env.kept(id)).toEqual([]);
  });

  it('keeps a Sleeping tab awake as well, and Sleeping is still open to automation', () => {
    const env = setup();
    const id = env.webTab(A);
    env.advance(BACKGROUND_SETTLE_MS);
    env.changeTitle(id);

    // Soft, and for freezing and discarding only: it does not stop a move.
    expect(env.manager.shelve(id, AUTOMATION_MOVE).outcome).toBe('moved');
    expect(env.sleeping()).toEqual([id]);
    expect(env.kept(id)).toEqual(['background-activity']);
    expect(env.factsOf(id)).toMatchObject({ placement: 'shelf' });
  });
});

describe('TabManager protection: what a discard and a freeze refuse', () => {
  /** A hidden tab whose title changed after the settle time. */
  function activeTab(env: Env): TabId {
    const id = env.webTab(A);
    env.advance(BACKGROUND_SETTLE_MS);
    env.changeTitle(id);
    return id;
  }

  it('refuses an automatic discard of a tab active in the background before asking the page anything', async () => {
    const env = setup();
    const id = activeTab(env);
    const runtime = env.runtimeOf(id);

    const discard = env.discard(id, AUTOMATION);
    await flush();

    expect(discard.value).toEqual(blockedBy('background-activity'));
    expect(runtime.calls).not.toContain('ping');
    expect(runtime.probes).toHaveLength(0);
    expect(env.manager.get(id).runtime).toBe('live');
    // The policy was told the same: a soft protection that blocks a discard.
    expect(blockingProtection(env.factsOf(id).protections, 'discard')?.reason).toBe(
      'background-activity',
    );
  });

  it('refuses a freeze the same way', async () => {
    const env = setup();
    const id = activeTab(env);
    const runtime = env.runtimeOf(id);

    const freeze = env.freeze(id);
    await flush();

    expect(freeze.value).toEqual({ outcome: 'blocked', reason: 'background-activity' });
    expect(runtime.calls).not.toContain('freeze');
    expect(env.manager.get(id).runtime).toBe('live');
  });

  it('lets only critical pressure past it', async () => {
    const env = setup();
    const id = activeTab(env);

    // Moderate pressure does not override soft protections.
    const moderate = env.discard(id, MODERATE);
    await flush();
    expect(moderate.value).toEqual(blockedBy('background-activity'));
    expect(env.runtimeOf(id).probes).toHaveLength(0);

    await discardCompletely(env, id, CRITICAL);
    expect(env.manager.get(id)).toMatchObject({
      runtime: 'unloaded',
      unloadedBy: 'pressure',
      unloadPressure: 'critical',
    });
  });

  it('lets go of the tab when the hour is up', async () => {
    const env = setup();
    const id = activeTab(env);
    env.advance(BACKGROUND_ACTIVITY_MS);

    await discardCompletely(env, id);
  });

  it('checks again after the probe: a change that arrives meanwhile keeps the tab', async () => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);
    env.advance(BACKGROUND_SETTLE_MS);
    const discard = env.discard(id, AUTOMATION);
    await flush();
    expect(env.manager.get(id).runtime).toBe('discarding');

    env.changeTitle(id); // The page's script reacts while the probe is out.
    runtime.answerProbe(reading());
    await flush();

    expect(discard.value).toEqual(blockedBy('background-activity'));
    expect(runtime.closes).toHaveLength(0);
    expect(env.manager.get(id).runtime).toBe('live');
    expect(env.kept(id)).toEqual(['background-activity']);
  });

  it('refuses automation and pressure a tab the user protected, at once and whatever the pressure', async () => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);
    env.manager.setProtected(id, true);

    for (const request of [AUTOMATION, MODERATE, CRITICAL]) {
      const discard = env.discard(id, request);
      await flush();
      expect(discard.value).toEqual(blockedBy('user-protected'));
    }
    expect(runtime.probes).toHaveLength(0);
    expect(runtime.calls).not.toContain('ping');

    const freeze = env.freeze(id);
    await flush();
    expect(freeze.value).toEqual({ outcome: 'blocked', reason: 'user-protected' });
  });

  it('lets the user discard a tab they protected themselves', async () => {
    const env = setup();
    const id = env.webTab(A);
    env.manager.setProtected(id, true);

    await discardCompletely(env, id, USER);

    expect(env.manager.get(id)).toMatchObject({ userProtected: true, unloadedBy: 'user' });
  });

  it('checks the tab protection again after the probe, for automation and not for the user', async () => {
    for (const request of [AUTOMATION, USER]) {
      const env = setup();
      const id = env.webTab(A);
      const runtime = env.runtimeOf(id);
      const discard = env.discard(id, request);
      await flush();

      env.manager.setProtected(id, true); // Protected while the probe is out.
      runtime.answerProbe(reading());
      await flush();

      if (request.origin === 'automation') {
        expect(discard.value).toEqual(blockedBy('user-protected'));
        expect(runtime.closes).toHaveLength(0);
        expect(env.manager.get(id).runtime).toBe('live');
      } else {
        runtime.contentsDestroyed();
        await flush();
        expect(discard.value).toEqual(DISCARDED);
      }
    }
  });

  it('refuses a tab for what a discard learned, to automation and not to the user', async () => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);
    await learnUnsavedInput(env, id);
    expect(runtime.probes).toHaveLength(1);

    // Automation does not ask the page again.
    const again = env.discard(id, AUTOMATION);
    await flush();
    expect(again.value).toEqual(blockedBy('unsaved-input'));
    expect(runtime.probes).toHaveLength(1);

    // An explicit request does.
    const explicit = env.discard(id, USER);
    await flush();
    expect(runtime.probes).toHaveLength(2);
    runtime.answerProbe(reading());
    await flush();
    runtime.contentsDestroyed();
    await flush();
    expect(explicit.value).toEqual(DISCARDED);
  });
});

describe('TabManager protection: fullscreen', () => {
  it('protects the tab in HTML fullscreen against everything, and only for as long as it is', () => {
    const env = setup();
    const id = env.webTab(A);
    env.manager.select(id);
    const runtime = env.runtimeOf(id);

    runtime.events.fullscreenChanged(true);

    expect(env.manager.fullscreenTabId()).toBe(id);
    expect(env.kept(id)).toEqual(['fullscreen']);
    const { protections } = env.factsOf(id);
    expect(protections).toEqual([protectionFor('fullscreen')]);
    expect(protectionFor('fullscreen').hard).toBe(true);
    for (const action of LIFECYCLE_ACTIONS) {
      // Hard, so not even critical pressure gets past it.
      expect(blockingProtection(protections, action, { overrideSoft: true })?.reason).toBe(
        'fullscreen',
      );
    }

    runtime.events.fullscreenChanged(false);

    expect(env.kept(id)).toEqual([]);
    expect(env.factsOf(id).protections).toEqual([]);
  });

  it('does not put it on any other tab', () => {
    const env = setup();
    const id = env.webTab(A);
    const other = env.webTab(B);
    env.manager.select(id);

    env.runtimeOf(id).events.fullscreenChanged(true);

    expect(env.kept(other)).toEqual([]);
    expect(env.kept(env.home)).toEqual([]);
    expect(env.factsOf(other).protections).toEqual([]);
  });

  it('is gone once the user switches to another tab, which leaves fullscreen', () => {
    const env = setup();
    const id = env.webTab(A);
    env.manager.select(id);
    const runtime = env.runtimeOf(id);
    runtime.events.fullscreenChanged(true);

    env.manager.select(env.home);

    expect(env.manager.fullscreenTabId()).toBeNull();
    expect(runtime.calls).toContain('exitFullscreen');
    expect(env.kept(id)).toEqual([]);
  });

  it('is gone once the user moves the tab to Sleeping, which also leaves fullscreen', () => {
    const env = setup();
    const id = env.webTab(A);
    env.manager.select(id);
    env.runtimeOf(id).events.fullscreenChanged(true);
    expect(env.kept(id)).toEqual(['fullscreen']);

    expect(env.manager.shelve(id, USER_MOVE).outcome).toBe('moved');

    expect(env.manager.fullscreenTabId()).toBeNull();
    expect(env.sleeping()).toEqual([id]);
    expect(env.kept(id)).toEqual([]);
  });

  it('refuses a request from a tab that is not selected, and does not protect it', () => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);

    runtime.events.fullscreenChanged(true);

    expect(runtime.calls).toContain('exitFullscreen');
    expect(env.manager.fullscreenTabId()).toBeNull();
    expect(env.kept(id)).toEqual([]);
  });

  it('is gone when the page crashes', () => {
    const env = setup();
    const id = env.webTab(A);
    env.manager.select(id);
    env.runtimeOf(id).events.fullscreenChanged(true);

    env.runtimeOf(id).events.crashed({ code: 9, name: 'crashed' });

    expect(env.manager.fullscreenTabId()).toBeNull();
    expect(env.kept(id)).toEqual([]);
  });
});

describe('TabManager protection: what the policy is told', () => {
  it('carries the monitor, the activity, the user and the lessons together, each once', async () => {
    const env = setup();
    const id = env.webTab(A);
    await learnUnsavedInput(env, id);
    env.advance(BACKGROUND_SETTLE_MS);
    env.changeTitle(id);
    env.manager.setProtected(id, true);
    env.protections.set(id, [protectionFor('audio')]);

    const reasons = env
      .factsOf(id)
      .protections.map((protection) => protection.reason)
      .sort();

    expect(reasons).toEqual(['audio', 'background-activity', 'unsaved-input', 'user-protected']);
  });

  it('names the user protection as a hard protection against every action', () => {
    const env = setup();
    const id = env.webTab(A);
    env.manager.setProtected(id, true);

    for (const action of LIFECYCLE_ACTIONS) {
      expect(
        blockingProtection(env.factsOf(id).protections, action, { overrideSoft: true })?.reason,
      ).toBe('user-protected');
    }

    env.manager.setProtected(id, false);
    expect(env.factsOf(id).protections).toEqual([]);
  });

  it('puts a hard reason before a soft one when something blocks a discard', () => {
    const env = setup();
    const id = env.webTab(A);
    env.advance(BACKGROUND_SETTLE_MS);
    env.changeTitle(id);
    env.protections.set(id, [protectionFor('notifications')]);
    expect(blockingProtection(env.factsOf(id).protections, 'discard')?.reason).toBe(
      'notifications',
    );

    env.manager.setProtected(id, true);

    expect(blockingProtection(env.factsOf(id).protections, 'discard')?.reason).toBe(
      'user-protected',
    );
  });
});

describe('TabManager protection: keptAwake', () => {
  it('is empty for a tab nothing keeps, for a tab that is gone and for one that never was', () => {
    const env = setup();
    const id = env.webTab(A);
    expect(env.kept(id)).toEqual([]);
    expect(env.kept(env.home)).toEqual([]);

    env.manager.close(id);

    expect(env.kept(id)).toEqual([]);
    expect(env.kept('no-such-tab')).toEqual([]);
  });

  it.each(PROTECTION_REASONS)('names %s when the monitor reports it', (reason) => {
    const env = setup();
    const id = env.webTab(A);
    env.protections.set(id, [protectionFor(reason)]);

    expect(env.kept(id)).toEqual([reason]);
  });

  it('names each reason once, in the order the sidebar lists them, whatever the order they came in', async () => {
    const env = setup();
    const id = env.webTab(A);
    await learnUnsavedInput(env, id);
    env.advance(BACKGROUND_SETTLE_MS);
    env.changeTitle(id);
    env.manager.setProtected(id, true);
    const reported: ProtectionReason[] = [
      'video',
      'recent-interaction',
      'protected-site',
      'audio',
      'capture',
      'audio',
    ];
    env.protections.set(
      id,
      reported.map((reason) => protectionFor(reason)),
    );

    expect(env.kept(id)).toEqual([
      'user-protected',
      'protected-site',
      'capture',
      'audio',
      'video',
      'unsaved-input',
      'background-activity',
      'recent-interaction',
    ]);
  });

  it('names the fullscreen of the selected tab between the user and the page', () => {
    const env = setup();
    const id = env.webTab(A);
    env.manager.select(id);
    env.runtimeOf(id).events.fullscreenChanged(true);
    env.manager.setProtected(id, true);
    env.protections.set(id, [protectionFor('audio')]);

    expect(env.kept(id)).toEqual(['user-protected', 'fullscreen', 'audio']);
  });

  it('follows the user protection on and off', () => {
    const env = setup();
    const id = env.webTab(A);

    env.manager.setProtected(id, true);
    expect(env.kept(id)).toEqual(['user-protected']);

    env.manager.setProtected(id, false);
    expect(env.kept(id)).toEqual([]);
  });

  it('forgets what a discard learned after the recheck time, to the millisecond', async () => {
    const env = setup();
    const id = env.webTab(A);
    await learnUnsavedInput(env, id);
    expect(env.kept(id)).toEqual(['unsaved-input']);

    env.advance(LEARNED_RECHECK_MS - 1);
    expect(env.kept(id)).toEqual(['unsaved-input']);

    env.advance(1);
    expect(env.kept(id)).toEqual([]);
  });

  it('forgets what a discard learned when a new document arrives', async () => {
    const env = setup();
    const id = env.webTab(A);
    await learnUnsavedInput(env, id);

    commit(env.runtimeOf(id), B);

    expect(env.kept(id)).toEqual([]);
  });

  it('answers for a Sleeping tab and for an unloaded one', async () => {
    const env = setup();
    const sleeper = env.webTab(A);
    const unloaded = env.webTab(B);
    await discardCompletely(env, unloaded);
    env.manager.setProtected(sleeper, true);
    env.manager.setProtected(unloaded, true);
    env.manager.shelve(sleeper, USER_MOVE);

    expect(env.manager.get(sleeper).placement).toBe('shelf');
    expect(env.kept(sleeper)).toEqual(['user-protected']);
    expect(env.kept(unloaded)).toEqual(['user-protected']);
  });

  it('hands out a list of its own: changing it changes nothing', () => {
    const env = setup();
    const id = env.webTab(A);
    env.manager.setProtected(id, true);

    env.kept(id).length = 0;

    expect(env.kept(id)).toEqual(['user-protected']);
  });
});

/** A discard whose probe finds a video or audio element playing: the tab stays, and it is learned. */
async function learnPlayingMedia(
  env: Base,
  tabId: TabId,
  request: DiscardRequest = AUTOMATION,
): Promise<void> {
  const discard = env.discard(tabId, request);
  await flush();
  env.runtimeOf(tabId).answerProbe(reading({ playingMedia: true }));
  await flush();
  expect(discard.value).toEqual(blockedBy('video'));
}

describe('TabManager protection: playing media, learned from the discard probe (M3.4)', () => {
  /** How many times TabManager woke this runtime's renderer: one per discard that gets that far. */
  const pings = (runtime: FakeRuntime): number =>
    runtime.calls.filter((call) => call === 'ping').length;

  describe('what a probe that finds media playing does to the discard', () => {
    it('blocks it with video, and the tab stays live with its page', async () => {
      const env = setup();
      const id = env.webTab(A);
      const runtime = env.runtimeOf(id);

      const discard = env.discard(id, AUTOMATION);
      await flush();
      expect(env.manager.get(id).runtime).toBe('discarding');
      runtime.answerProbe(reading({ playingMedia: true }));
      await flush();

      expect(discard.value).toEqual(blockedBy('video'));
      expect(env.manager.get(id).runtime).toBe('live');
      expect(runtime.alive).toBe(true);
      expect(runtime.closes).toHaveLength(0);
      expect(env.runtimesOf(id)).toHaveLength(1);
    });

    it.each([
      ['automation', AUTOMATION],
      ['the user', USER],
      ['moderate pressure', MODERATE],
      // origin 'pressure' with overrideSoft: true, which releases every soft protection
      ['critical pressure', CRITICAL],
    ])('does so for %s: hard, so no origin gets past it', async (_name, request) => {
      const env = setup();
      const id = env.webTab(A);
      const runtime = env.runtimeOf(id);

      await learnPlayingMedia(env, id, request);

      expect(runtime.closes).toHaveLength(0);
      expect(env.manager.get(id)).toMatchObject({
        runtime: 'live',
        unloadedBy: null,
        unloadPressure: null,
      });
    });

    it('lets critical pressure past a soft finding but not past playing media', async () => {
      const env = setup();
      const soft = env.webTab(A);
      const playing = env.webTab(B);

      const softDiscard = env.discard(soft, CRITICAL);
      await flush();
      env.runtimeOf(soft).answerProbe(reading({ sensitive: true, focusedEditable: true }));
      await flush();
      env.runtimeOf(soft).contentsDestroyed();
      await flush();
      expect(softDiscard.value).toEqual(DISCARDED);

      const playingDiscard = env.discard(playing, CRITICAL);
      await flush();
      env
        .runtimeOf(playing)
        .answerProbe(reading({ playingMedia: true, sensitive: true, focusedEditable: true }));
      await flush();
      expect(playingDiscard.value).toEqual(blockedBy('video'));
      expect(env.manager.get(playing).runtime).toBe('live');
    });

    it('blocks a tab the user activated as well: playing media does not depend on the activation', async () => {
      const env = setup();
      const id = env.webTab(A);

      const discard = env.discard(id, AUTOMATION);
      await flush();
      env.runtimeOf(id).answerProbe(reading({ playingMedia: true, hasBeenActive: true }));
      await flush();

      expect(discard.value).toEqual(blockedBy('video'));
      expect(env.runtimeOf(id).closes).toHaveLength(0);
    });

    it('gives way to unsaved input, which the probe judges first, and learns that one only', async () => {
      const env = setup();
      const id = env.webTab(A);

      const discard = env.discard(id, AUTOMATION);
      await flush();
      env.runtimeOf(id).answerProbe(reading({ playingMedia: true, editedFields: 1 }));
      await flush();

      expect(discard.value).toEqual(blockedBy('unsaved-input'));
      expect(env.kept(id)).toEqual(['unsaved-input']);
    });

    it('learns nothing from an answer the probe format does not allow (no playingMedia, or not a boolean)', async () => {
      const env = setup();
      const id = env.webTab(A);
      const withoutIt = Object.fromEntries(
        Object.entries(reading()).filter(([field]) => field !== 'playingMedia'),
      );

      for (const answer of [withoutIt, { ...reading(), playingMedia: 'yes' }]) {
        const discard = env.discard(id, AUTOMATION);
        await flush();
        env.runtimeOf(id).answerProbe(answer);
        await flush();
        expect(discard.value).toEqual(blockedBy('probe-unanswered'));
      }

      expect(env.kept(id)).toEqual([]);
      expect(env.manager.get(id).runtime).toBe('live');
    });

    it('learns nothing when no media is playing: the discard goes through', async () => {
      const env = setup();
      const id = env.webTab(A);

      await discardCompletely(env, id);

      expect(env.kept(id)).toEqual([]);
    });
  });

  describe('what the tab then shows', () => {
    it('names video in keptAwake after the attempt and not before', async () => {
      const env = setup();
      const id = env.webTab(A);
      expect(env.kept(id)).toEqual([]);

      await learnPlayingMedia(env, id);

      expect(env.kept(id)).toEqual(['video']);
      expect(env.manager.lifecycleFacts(id).learned).toEqual(['video']);
    });

    it('tells the policy: a hard protection that blocks a freeze and a discard, and nothing else', async () => {
      const env = setup();
      const id = env.webTab(A);
      expect(env.factsOf(id).protections).toEqual([]);

      await learnPlayingMedia(env, id);

      const { protections } = env.factsOf(id);
      expect(protections).toEqual([protectionFor('video')]);
      for (const action of ['freeze', 'discard'] as const) {
        expect(blockingProtection(protections, action, { overrideSoft: true })?.reason).toBe(
          'video',
        );
      }
      expect(blockingProtection(protections, 'shelve', { overrideSoft: true })).toBeNull();
      expect(blockingProtection(protections, 'archive', { overrideSoft: true })).toBeNull();
    });

    it('keeps the monitor beside it, each reason once, in the order the sidebar lists them', async () => {
      const env = setup();
      const id = env.webTab(A);
      await learnPlayingMedia(env, id);
      env.protections.set(id, [protectionFor('audio'), protectionFor('capture')]);
      env.manager.setProtected(id, true);

      expect(env.kept(id)).toEqual(['user-protected', 'capture', 'audio', 'video']);
      expect(
        env
          .factsOf(id)
          .protections.map((protection) => protection.reason)
          .sort(),
      ).toEqual(['audio', 'capture', 'user-protected', 'video']);
    });

    it('names it once when the monitor reports video as well', async () => {
      const env = setup();
      const id = env.webTab(A);
      await learnPlayingMedia(env, id);
      env.protections.set(id, [protectionFor('video')]);

      expect(env.kept(id)).toEqual(['video']);
    });

    it('keeps it beside what a later attempt finds: newest first for the policy, sidebar order for the why', async () => {
      const env = setup();
      const id = env.webTab(A);
      await learnPlayingMedia(env, id);
      env.advance(1);

      const user = env.discard(id, USER); // asks again: the video is paused, the field has text
      await flush();
      env.runtimeOf(id).answerProbe(reading({ editedFields: 1 }));
      await flush();

      expect(user.value).toEqual(blockedBy('unsaved-input'));
      expect(env.manager.lifecycleFacts(id).learned).toEqual(['unsaved-input', 'video']);
      expect(env.kept(id)).toEqual(['video', 'unsaved-input']);
    });

    it('belongs to the tab whose page played, and to no other', async () => {
      const env = setup();
      const playing = env.webTab(A);
      const quiet = env.webTab(B);

      await learnPlayingMedia(env, playing);

      expect(env.kept(playing)).toEqual(['video']);
      expect(env.kept(quiet)).toEqual([]);
      expect(env.kept(env.home)).toEqual([]);
      expect(env.factsOf(quiet).protections).toEqual([]);
      await discardCompletely(env, quiet); // the other tab is unloaded as usual
    });
  });

  describe('automation and pressure after the attempt', () => {
    it.each([
      ['automation', AUTOMATION],
      ['moderate pressure', MODERATE],
      ['critical pressure', CRITICAL],
    ])('are refused for %s without asking the page again', async (_name, request) => {
      const env = setup();
      const id = env.webTab(A);
      const runtime = env.runtimeOf(id);
      await learnPlayingMedia(env, id);
      expect(runtime.probes).toHaveLength(1);
      expect(pings(runtime)).toBe(1);

      const again = env.discard(id, request);
      await flush();

      expect(again.value).toEqual(blockedBy('video'));
      expect(runtime.probes).toHaveLength(1);
      expect(pings(runtime)).toBe(1);
      expect(runtime.closes).toHaveLength(0);
      expect(env.manager.get(id).runtime).toBe('live');
    });

    it('refuses a freeze as well, with the same reason', async () => {
      const env = setup();
      const id = env.webTab(A);
      const runtime = env.runtimeOf(id);
      await learnPlayingMedia(env, id);

      const freeze = env.freeze(id);
      await flush();

      expect(freeze.value).toEqual({ outcome: 'blocked', reason: 'video' });
      expect(runtime.calls).not.toContain('freeze');
      expect(env.manager.get(id).runtime).toBe('live');
    });

    it('asks again once LEARNED_RECHECK_MS has passed, to the millisecond', async () => {
      const env = setup();
      const id = env.webTab(A);
      const runtime = env.runtimeOf(id);
      await learnPlayingMedia(env, id);

      env.advance(LEARNED_RECHECK_MS - 1);
      const early = env.discard(id, AUTOMATION);
      await flush();
      expect(early.value).toEqual(blockedBy('video'));
      expect(runtime.probes).toHaveLength(1);
      expect(env.kept(id)).toEqual(['video']);

      env.advance(1);
      expect(env.kept(id)).toEqual([]);
      await discardCompletely(env, id); // the page is asked, and the video has stopped
      expect(runtime.probes).toHaveLength(2);
      expect(pings(runtime)).toBe(2);
    });

    it('asks again and is refused again if the video still plays: the wait starts over', async () => {
      const env = setup();
      const id = env.webTab(A);
      const runtime = env.runtimeOf(id);
      await learnPlayingMedia(env, id);

      env.advance(LEARNED_RECHECK_MS);
      await learnPlayingMedia(env, id); // asked again, found playing again
      expect(runtime.probes).toHaveLength(2);

      env.advance(LEARNED_RECHECK_MS - 1);
      const early = env.discard(id, AUTOMATION);
      await flush();
      expect(early.value).toEqual(blockedBy('video'));
      expect(runtime.probes).toHaveLength(2); // not asked: the second finding is still fresh
      expect(env.kept(id)).toEqual(['video']);

      env.advance(1);
      expect(env.kept(id)).toEqual([]);
    });

    it('measures the wait on the lifecycle clock: the plain clock moving changes nothing', async () => {
      const env = setup();
      const id = env.webTab(A);
      await learnPlayingMedia(env, id);

      env.clock.now += 10 * LEARNED_RECHECK_MS; // only the plain face of the clock
      expect(env.kept(id)).toEqual(['video']);

      env.clock.wall += LEARNED_RECHECK_MS - 1; // the lifecycle clock
      expect(env.kept(id)).toEqual(['video']);
      env.clock.wall += 1;
      expect(env.kept(id)).toEqual([]);
    });

    it('does not hold the tab on a lifecycle clock that went backwards', async () => {
      const env = setup();
      const id = env.webTab(A);
      await learnPlayingMedia(env, id);

      env.clock.wall -= 1;

      expect(env.kept(id)).toEqual([]);
    });
  });

  describe('an explicit request', () => {
    it('asks the page again, and discards the tab once the video has stopped', async () => {
      const env = setup();
      const id = env.webTab(A);
      const runtime = env.runtimeOf(id);
      await learnPlayingMedia(env, id);
      expect(runtime.probes).toHaveLength(1);

      const explicit = env.discard(id, USER);
      await flush();
      expect(runtime.probes).toHaveLength(2);
      runtime.answerProbe(reading());
      await flush();
      runtime.contentsDestroyed();
      await flush();

      expect(explicit.value).toEqual(DISCARDED);
      expect(env.manager.get(id)).toMatchObject({ runtime: 'unloaded', unloadedBy: 'user' });
    });

    // Found by these tests: an unloaded tab kept naming what an earlier attempt learned, and a
    // learned hard reason would have held it out of the Archive.
    it('forgets what a discard learned once the tab is unloaded by a discard that found the page clean', async () => {
      const env = setup();
      const id = env.webTab(A);
      const runtime = env.runtimeOf(id);
      await learnPlayingMedia(env, id);
      expect(env.kept(id)).toEqual(['video']);

      const explicit = env.discard(id, USER);
      await flush();
      runtime.answerProbe(reading());
      await flush();
      runtime.contentsDestroyed();
      await flush();

      expect(explicit.value).toEqual(DISCARDED);
      expect(env.kept(id)).toEqual([]);
      expect(env.factsOf(id).protections).toEqual([]);
    });

    it('is refused when the video still plays, and the wait for automation starts over', async () => {
      const env = setup();
      const id = env.webTab(A);
      const runtime = env.runtimeOf(id);
      await learnPlayingMedia(env, id);

      env.advance(LEARNED_RECHECK_MS - 1);
      await learnPlayingMedia(env, id, USER);
      expect(runtime.probes).toHaveLength(2);

      env.advance(LEARNED_RECHECK_MS - 1); // 1 ms short of the second finding's end
      const automation = env.discard(id, AUTOMATION);
      await flush();
      expect(automation.value).toEqual(blockedBy('video'));
      expect(runtime.probes).toHaveLength(2);
    });
  });

  describe('a new document', () => {
    it('forgets it, so the tab shows nothing and automation asks the new page', async () => {
      const env = setup();
      const id = env.webTab(A);
      const runtime = env.runtimeOf(id);
      await learnPlayingMedia(env, id);
      expect(env.kept(id)).toEqual(['video']);

      finishLoad(runtime, B);

      expect(env.kept(id)).toEqual([]);
      expect(env.factsOf(id).protections).toEqual([]);
      expect(env.manager.lifecycleFacts(id).learned).toEqual([]);
      await discardCompletely(env, id);
      expect(runtime.probes).toHaveLength(2);
    });

    it('is not what a same-document navigation brings: the page is the one that played', async () => {
      const env = setup();
      const id = env.webTab(A);
      await learnPlayingMedia(env, id);

      commit(env.runtimeOf(id), `${A}#chapter-2`, { sameDocument: true });

      expect(env.kept(id)).toEqual(['video']);
      const again = env.discard(id, AUTOMATION);
      await flush();
      expect(again.value).toEqual(blockedBy('video'));
      expect(env.runtimeOf(id).probes).toHaveLength(1);
    });
  });
});

describe('TabManager protection: how low memory was when pressure unloaded a tab', () => {
  it.each(['critical', 'moderate'] as const)(
    'records %s pressure on the tab it unloads, with who unloaded it',
    async (pressure) => {
      const env = setup();
      const id = env.webTab(A);
      expect(env.manager.get(id)).toMatchObject({ unloadedBy: null, unloadPressure: null });

      await discardCompletely(env, id, { origin: 'pressure', pressure });

      expect(env.manager.get(id)).toMatchObject({
        runtime: 'unloaded',
        unloadedBy: 'pressure',
        unloadPressure: pressure,
      });
    },
  );

  it('sets neither while the discard is under way, and keeps them off when it is blocked', async () => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);
    const discard = env.discard(id, { origin: 'pressure', pressure: 'critical' });
    await flush();
    expect(env.manager.get(id)).toMatchObject({
      runtime: 'discarding',
      unloadedBy: null,
      unloadPressure: null,
    });

    // The page objects to unloading and lives on.
    runtime.answerProbe(reading({ hasBeenActive: true }));
    await flush();
    runtime.prevent();
    await flush();

    expect(discard.value).toEqual(blockedBy('page-unsaved-changes'));
    expect(env.manager.get(id)).toMatchObject({
      runtime: 'live',
      unloadedBy: null,
      unloadPressure: null,
    });
  });

  it('keeps them off a discard refused before it starts', async () => {
    const env = setup();
    const id = env.webTab(A);
    env.protections.set(id, [protectionFor('audio')]);

    const discard = env.discard(id, { origin: 'pressure', pressure: 'critical' });
    await flush();

    expect(discard.value).toEqual(blockedBy('audio'));
    expect(env.manager.get(id)).toMatchObject({ unloadedBy: null, unloadPressure: null });
  });

  it('leaves the pressure out when the request does not say how low memory was', async () => {
    const env = setup();
    const id = env.webTab(A);

    await discardCompletely(env, id, { origin: 'pressure' });

    expect(env.manager.get(id)).toMatchObject({ unloadedBy: 'pressure', unloadPressure: null });
  });

  it.each<DiscardRequest>([
    { origin: 'automation' },
    { origin: 'user' },
    // A pressure that is not a pressure discard's is not recorded.
    { origin: 'automation', pressure: 'critical' },
    { origin: 'user', pressure: 'moderate' },
  ])('records no pressure for %o', async (request) => {
    const env = setup();
    const id = env.webTab(A);

    await discardCompletely(env, id, request);

    expect(env.manager.get(id)).toMatchObject({
      unloadedBy: request.origin,
      unloadPressure: null,
    });
  });

  it('records the pressure of a discard that ended because the renderer died', async () => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);
    const discard = env.discard(id, MODERATE);
    await flush();

    runtime.events.crashed({ code: 9, name: 'crashed' });
    await flush();

    expect(discard.value).toEqual(DISCARDED);
    expect(env.manager.get(id)).toMatchObject({
      runtime: 'unloaded',
      unloadedBy: 'pressure',
      unloadPressure: 'moderate',
    });
  });

  it.each(['select', 'reload', 'navigate'] as const)(
    'drops both as soon as the tab loads again (%s)',
    async (way) => {
      const env = setup();
      const id = env.webTab(A);
      await discardCompletely(env, id, CRITICAL);
      expect(env.manager.get(id)).toMatchObject({
        unloadedBy: 'pressure',
        unloadPressure: 'critical',
      });

      if (way === 'select') {
        env.manager.select(id);
      } else if (way === 'reload') {
        env.manager.reload(id);
      } else {
        env.manager.navigate(id, B);
      }

      expect(env.manager.get(id)).toMatchObject({
        runtime: 'creating',
        unloadedBy: null,
        unloadPressure: null,
      });
    },
  );

  it('records the latest unload when a tab is unloaded again', async () => {
    const env = setup();
    const id = env.webTab(A);
    await discardCompletely(env, id, CRITICAL);
    reloadInBackground(env, id);
    expect(env.manager.get(id)).toMatchObject({ unloadedBy: null, unloadPressure: null });

    await discardCompletely(env, id, MODERATE);

    expect(env.manager.get(id)).toMatchObject({
      unloadedBy: 'pressure',
      unloadPressure: 'moderate',
    });

    // And an unload that was not pressure's leaves none of the earlier one.
    reloadInBackground(env, id);
    await discardCompletely(env, id, AUTOMATION);
    expect(env.manager.get(id)).toMatchObject({ unloadedBy: 'automation', unloadPressure: null });
  });
});

describe('TabManager protection: who moved a Sleeping tab there', () => {
  it('says automation when automation shelved it, and the user when the user did', () => {
    const env = setup();
    const byAutomation = env.webTab(A);
    const byUser = env.webTab(B);
    expect(env.manager.get(byAutomation).movedBy).toBeNull();

    env.manager.shelve(byAutomation, AUTOMATION_MOVE);
    env.manager.shelve(byUser, USER_MOVE);

    expect(env.manager.get(byAutomation)).toMatchObject({
      placement: 'shelf',
      movedBy: 'automation',
    });
    expect(env.manager.get(byUser)).toMatchObject({ placement: 'shelf', movedBy: 'user' });
  });

  it('says the user for the selected tab the user shelved', () => {
    const env = setup();

    env.manager.shelve(env.home, USER_MOVE);

    expect(env.manager.get(env.home)).toMatchObject({ placement: 'shelf', movedBy: 'user' });
  });

  it('is not set by a move that is refused', () => {
    const env = setup();
    const id = env.webTab(A);
    env.manager.setProtected(id, true);

    expect(env.manager.shelve(id, AUTOMATION_MOVE)).toEqual({
      outcome: 'blocked',
      reason: 'user-protected',
    } satisfies MoveOutcome);

    expect(env.manager.get(id)).toMatchObject({ placement: 'strip', movedBy: null });
  });

  it.each([AUTOMATION_MOVE, USER_MOVE])(
    'is cleared when the tab comes back to the strip ($origin shelved it)',
    (request) => {
      const env = setup();
      const id = env.webTab(A);
      env.manager.shelve(id, request);
      expect(env.manager.get(id).movedBy).toBe(request.origin);

      env.manager.restoreToStrip(id);

      expect(env.manager.get(id)).toMatchObject({ placement: 'strip', movedBy: null });
    },
  );

  it('is cleared when the user picks the Sleeping tab, and by an Undo of the move', () => {
    const env = setup();
    const picked = env.webTab(A);
    const undone = env.webTab(B);
    env.manager.shelve(picked, AUTOMATION_MOVE);
    const move = env.manager.shelve(undone, AUTOMATION_MOVE);
    expect(env.manager.get(picked).movedBy).toBe('automation');
    if (move.outcome !== 'moved') {
      throw new Error('the shelve did not go through');
    }

    env.manager.select(picked);
    const redone = env.manager.undoMoves([move.move]);

    expect(redone).toEqual<PlacementMove[]>([move.move]);
    expect(env.manager.get(picked)).toMatchObject({ placement: 'strip', movedBy: null });
    expect(env.manager.get(undone)).toMatchObject({ placement: 'strip', movedBy: null });
  });

  it('is set again, by whoever does it, when the tab is moved a second time', () => {
    const env = setup();
    const id = env.webTab(A);
    env.manager.shelve(id, AUTOMATION_MOVE);
    env.manager.restoreToStrip(id, { select: false });

    env.manager.shelve(id, USER_MOVE);

    expect(env.manager.get(id).movedBy).toBe('user');
  });

  it('is unknown for a Sleeping tab restored from the session', () => {
    const env = setupEmpty();
    env.manager.restoreSession(
      session({
        tabs: [savedTab('a')],
        shelf: [savedTab('s')],
        selectedTabId: 'a',
      }),
    );

    expect(env.manager.get('s')).toMatchObject({ placement: 'shelf', movedBy: null });
    expect(env.manager.get('a')).toMatchObject({ placement: 'strip', movedBy: null });
  });

  it('is unknown for a Sleeping tab that an Undo brought back from the Archive', async () => {
    const env = savedStrip(['a', 'b']);
    const shelved = env.manager.shelve('b', AUTOMATION_MOVE);
    expect(env.manager.get('b').movedBy).toBe('automation');
    expect(shelved.outcome).toBe('moved');

    // Archived from Sleeping by automation, then the user presses Undo.
    const archived = await env.manager.archive('b', AUTOMATION_MOVE);
    if (archived.outcome !== 'moved') {
      throw new Error(`the archive did not go through: ${JSON.stringify(archived)}`);
    }
    expect(env.archived()).toEqual(['b']);
    expect(archived.move).toMatchObject({ from: 'shelf', to: 'archive' });
    const undone = env.manager.undoMoves([archived.move]);

    expect(undone).toHaveLength(1);
    expect(env.manager.get('b')).toMatchObject({ placement: 'shelf', movedBy: null });
    expect(env.sleeping()).toEqual(['b']);
  });

  it('is unknown for a tab restored from the Archive straight into Sleeping', async () => {
    const env = savedStrip(['a', 'b']);
    expect((await env.manager.archive('b', USER_MOVE)).outcome).toBe('moved');

    expect(env.manager.restoreArchived('b', { to: 'shelf', select: false })).toBe('b');

    expect(env.manager.get('b')).toMatchObject({ placement: 'shelf', movedBy: null });
  });

  it('is in memory only: no stored list of tabs carries it, or the other reasons', async () => {
    const env = setup();
    const sleeper = env.webTab(A);
    const closed = env.webTab(B);
    const archived = env.webTab(C);
    env.manager.shelve(sleeper, AUTOMATION_MOVE);
    await discardCompletely(env, archived, CRITICAL);
    expect((await env.manager.archive(archived, USER_MOVE)).outcome).toBe('moved');
    env.manager.close(closed);

    const stored: readonly SessionTab[] = [
      ...env.manager.sessionTabs(),
      ...env.manager.shelfSessionTabs(),
      ...env.manager.archivedTabs(),
      ...env.manager.closedTabs(),
    ];

    // One of each list: the strip, Sleeping, the Archive and Recently closed.
    expect(stored.map((tab) => tab.id)).toEqual(
      expect.arrayContaining([env.home, sleeper, archived, closed]),
    );
    for (const tab of stored) {
      expect(tab).not.toHaveProperty('movedBy');
      expect(tab).not.toHaveProperty('unloadedBy');
      expect(tab).not.toHaveProperty('unloadPressure');
    }
  });

  it('is forgotten by a new run: the session restores everything with no reason', async () => {
    const env = setup();
    const sleeper = env.webTab(A);
    const unloaded = env.webTab(B);
    env.manager.shelve(sleeper, AUTOMATION_MOVE);
    await discardCompletely(env, unloaded, CRITICAL);
    const tabs = [...env.manager.sessionTabs()];
    const shelf = [...env.manager.shelfSessionTabs()];

    const next = setupEmpty();
    next.manager.restoreSession(session({ tabs, shelf, selectedTabId: env.home }));

    expect(next.manager.get(sleeper)).toMatchObject({ placement: 'shelf', movedBy: null });
    expect(next.manager.get(unloaded)).toMatchObject({
      runtime: 'unloaded',
      unloadedBy: null,
      unloadPressure: null,
    });
  });
});

describe('TabManager protection: a tab the user brings back after automation unloaded it', () => {
  it('is told when the user selects a tab automation unloaded, before the reload starts', async () => {
    const env = setup();
    const id = env.webTab(A);
    await discardCompletely(env, id, AUTOMATION);
    expect(env.shown).toEqual([]);
    const runtimes = env.runtimesOf(id).length;

    env.manager.select(id);

    expect(env.shown).toEqual<AutomaticUnloadShown[]>([
      { tabId: id, unloadedBy: 'automation', runtime: 'unloaded', runtimes, selected: id },
    ]);
    // And then the page does load again.
    expect(env.manager.get(id).runtime).toBe('creating');
    expect(env.runtimesOf(id)).toHaveLength(runtimes + 1);
  });

  it.each(['critical', 'moderate'] as const)(
    'tells pressure when %s memory pressure unloaded it',
    async (pressure) => {
      const env = setup();
      const id = env.webTab(A);
      await discardCompletely(env, id, { origin: 'pressure', pressure });

      env.manager.select(id);

      expect(env.shown.map((entry) => [entry.tabId, entry.unloadedBy])).toEqual([[id, 'pressure']]);
    },
  );

  it('tells it when the user picks a Sleeping tab that automation unloaded', async () => {
    const env = setup();
    const id = env.webTab(A);
    env.manager.shelve(id, AUTOMATION_MOVE);
    await discardCompletely(env, id, AUTOMATION);
    // An Undo that leaves the tab in the strip, unselected, is not "shown".
    env.manager.restoreToStrip(id, { select: false });
    expect(env.shown).toEqual([]);

    env.manager.select(id);

    expect(env.shown.map((entry) => entry.tabId)).toEqual([id]);
  });

  it('is not told about a tab the user unloaded', async () => {
    const env = setup();
    const id = env.webTab(A);
    await discardCompletely(env, id, USER);
    expect(env.manager.get(id).unloadedBy).toBe('user');

    env.manager.select(id);

    expect(env.shown).toEqual([]);
    expect(env.manager.get(id).runtime).toBe('creating');
  });

  it('is not told about a tab that was never loaded since the app started', () => {
    const env = savedStrip(['a', 'b']);
    expect(env.manager.get('b')).toMatchObject({ runtime: 'unloaded', unloadedBy: null });

    env.manager.select('b');

    expect(env.shown).toEqual([]);
    expect(env.manager.get('b').runtime).toBe('creating');
  });

  it('is not told about a Sleeping tab restored from the session', () => {
    const env = setupEmpty();
    env.manager.restoreSession(
      session({ tabs: [savedTab('a')], shelf: [savedTab('s')], selectedTabId: 'a' }),
    );

    env.manager.select('s');

    expect(env.shown).toEqual([]);
  });

  it('is not told about a tab that is live, whether it is picked or already selected', () => {
    const env = setup();
    const id = env.webTab(A);

    env.manager.select(id);
    env.manager.select(id);
    env.manager.select(env.home);
    env.manager.select(id);

    expect(env.shown).toEqual([]);
  });

  it('is not told about a tab the user picked while its discard was only probing', async () => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);
    const discard = env.discard(id, AUTOMATION);
    await flush();
    expect(env.manager.get(id).runtime).toBe('discarding');

    env.manager.select(id);
    runtime.answerProbe(reading());
    await flush();

    expect(discard.value).toEqual(skippedAs('cancelled'));
    expect(env.shown).toEqual([]);
    expect(env.manager.get(id)).toMatchObject({ runtime: 'live', unloadedBy: null });
  });

  it('is not told about a tab the user picked while its page was closing: it never was unloaded', async () => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);
    const discard = env.discard(id, AUTOMATION);
    await flush();
    runtime.answerProbe(reading({ hasBeenActive: true }));
    await flush();
    expect(runtime.closes).toHaveLength(1);

    env.manager.select(id);
    runtime.contentsDestroyed();
    await flush();

    expect(discard.value).toEqual(DISCARDED);
    expect(env.shown).toEqual([]);
    expect(env.manager.get(id)).toMatchObject({ runtime: 'creating', unloadedBy: null });
  });

  it('is told once for each unload, not for each time the tab is picked', async () => {
    const env = setup();
    const id = env.webTab(A);
    await discardCompletely(env, id, AUTOMATION);

    env.manager.select(id); // The reload starts.
    env.manager.select(env.home);
    env.manager.select(id); // Still loading, and later loaded: nothing to count.
    finishLoad(env.runtimeOf(id), A);
    env.manager.select(env.home);
    env.manager.select(id);
    expect(env.shown.map((entry) => entry.unloadedBy)).toEqual(['automation']);

    // Unloaded again, by pressure this time: the user is told again.
    env.manager.select(env.home);
    await discardCompletely(env, id, CRITICAL);
    env.manager.select(id);

    expect(env.shown.map((entry) => entry.unloadedBy)).toEqual(['automation', 'pressure']);
  });

  it('is not told about a tab that was reloaded in the background and picked afterwards', async () => {
    const env = setup();
    const id = env.webTab(A);
    await discardCompletely(env, id, AUTOMATION);

    env.manager.reload(id); // The reason it was unloaded no longer applies.
    expect(env.manager.get(id).unloadedBy).toBeNull();
    env.manager.select(id);

    expect(env.shown).toEqual([]);
  });
});

// Found while writing these tests (M3.4), and fixed: the steps that showed each problem.
describe('TabManager protection: found by these tests', () => {
  // REPRO: webTab(A) (a live tab, hidden since it was made); discard it (unloaded); advance the
  // clock by 2 hours; manager.reload(tabId) (a reload of a background tab: the sidebar's "Reload"
  // on a tab that is not selected); the restored page commits (cross-document), then reports its
  // title and icon: runtime.events.faviconChanged('https://a.example/icon.png').
  // WRONG: manager.keptAwake(tabId) is ['background-activity'], for an hour, though the tab only
  // loaded. A document's commit resets favicon to null, so its icon always "changes" when it
  // arrives, and #noteBackgroundActivity measures the settle time from `hiddenSince` (when the
  // tab was last hidden), not from the document's start. The comment on BACKGROUND_SETTLE_MS says
  // "a page that finishes loading in the background isn't 'active'".
  // FIX (suggested): measure the settle time from max(hiddenSince, time of the last cross-document
  // commit), or ignore title/icon events while `state.loading` is true.
  it('does not count the title and icon a page reports while it loads in the background', async () => {
    const env = setup();
    const id = env.webTab(A);
    await discardCompletely(env, id);
    env.advance(2 * 60 * 60 * 1000);
    env.manager.reload(id);
    const runtime = env.runtimeOf(id);
    commit(runtime, A);
    runtime.events.titleChanged('Alpha');
    runtime.events.faviconChanged('https://a.example/icon.png');
    runtime.events.loadingChanged(false);
    // Loaded, settled for less than the settle time since the document began: still no activity.
    runtime.events.faviconChanged('https://a.example/other.png');
    expect(env.kept(id)).toEqual([]);
    // A change once the document has settled is activity again.
    env.advance(BACKGROUND_SETTLE_MS);
    env.changeTitle(id);
    expect(env.kept(id)).toEqual(['background-activity']);
  });

  // REPRO: webTab(A); advance(BACKGROUND_SETTLE_MS); change its title (stamps backgroundActivityAt);
  // discard it with { origin: 'pressure', pressure: 'critical', overrideSoft: true } (the soft
  // protection is overridden, the tab is unloaded).
  // WRONG: manager.keptAwake(tabId) and lifecycleTabs()[tabId].protections still name
  // 'background-activity' on the unloaded tab for up to an hour (until a cross-document commit
  // clears it), so the sidebar tooltip (renderer/features/sidebar/tab-display.ts tabTooltip) says
  // both "Unloaded to save memory" and "Kept awake: active in the background".
  // FIX (suggested): reset record.backgroundActivityAt in #completeDiscard (the page is gone),
  // or leave the reason out of #protectionsNow while record.runtime is undefined.
  it('stops naming background activity once the tab is unloaded', async () => {
    const env = setup();
    const id = env.webTab(A);
    env.advance(BACKGROUND_SETTLE_MS);
    env.changeTitle(id);
    expect(env.kept(id)).toEqual(['background-activity']);

    await discardCompletely(env, id, {
      origin: 'pressure',
      pressure: 'critical',
      overrideSoft: true,
    });

    expect(env.kept(id)).toEqual([]);
    expect(env.factsOf(id).protections).toEqual([]);
  });
});
