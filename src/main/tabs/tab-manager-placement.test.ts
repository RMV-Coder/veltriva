// TabManager's placement dimension, driven by hand (M3.3: assessment §4.4, §4.9 Archive and Close,
// ADR-0003 invariants I1, I3 and I8). tab-manager-model.test.ts throws random sequences at it; these
// tests walk each path once, in a fixed order, so a failure names the scenario. They cover Sleeping
// (shelve, restore, select), the Archive (a discard first, then data only), Undo, protecting a tab,
// "Leave page?" on a user close, and what the session stores and restores.
//
// The fake runtime hands out deferred promises for `probe`, `closeForDiscard` and `freeze` (the
// ping answers at once), and the timers are manual: a test decides when the page answers, when it
// objects, and when a deadline passes. It follows the Electron runtime's contract
// (./tab-runtime.ts):
//   - `closeForDiscard` settles `closed` when the web contents is destroyed, and the runtime then
//     reports `gone()` synchronously (TabManager ignores that one while its own close is in flight);
//   - `destroy()` settles pending closes as `closed`, without `gone`;
//   - `restore()` only into a brand-new runtime that is attached first (spike S2).
// Anything else the fake notices (a call into a gone web contents, a restore into a detached view)
// is recorded, and the invariants checked after every test (I1, I3, I4, I6, I7, I8) fail on it.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CLOSE_TIMEOUT_MS } from '../../core/lifecycle/discard';
import type { DiscardBlock, Timers } from '../../core/lifecycle/discard';
import type {
  MoveOutcome,
  MoveRequest,
  MoveSkip,
  PlacementMove,
} from '../../core/lifecycle/placement';
import type { CloseMode, ProbeReading } from '../../core/lifecycle/probe';
import { protectionFor } from '../../core/lifecycle/protections';
import type { Protection, ProtectionReason } from '../../core/lifecycle/protections';
import type { NavigationSnapshot } from '../../core/lifecycle/snapshot';
import type { TabHistory } from '../../core/session/history';
import { MAX_ARCHIVED_IN_MEMORY, SESSION_NEW_TAB_URL, TabManager } from './tab-manager';
import type {
  ArchivedTab,
  CloseResult,
  RuntimeTransition,
  SessionTab,
  TabHistoryObserver,
  TabId,
  TabRuntime,
  TabRuntimeEvents,
} from './tab-manager';

const A = 'https://a.example/';
const B = 'https://b.example/page';
const C = 'https://c.example/';

const USER: MoveRequest = { origin: 'user' };
const AUTOMATION: MoveRequest = { origin: 'automation' };

const moved = (move: PlacementMove): MoveOutcome => ({ outcome: 'moved', move });
const skippedAs = (why: MoveSkip): MoveOutcome => ({ outcome: 'skipped', why });
const blockedBy = (reason: DiscardBlock): MoveOutcome => ({ outcome: 'blocked', reason });

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

  /** Fires every pending timer with this delay. Throws if there is none: a missing deadline is a bug. */
  fire(ms: number): void {
    const due = [...this.#pending].filter(([, timer]) => timer.ms === ms);
    if (due.length === 0) {
      throw new Error(`no ${String(ms)} ms timer is pending`);
    }
    for (const [handle, timer] of due) {
      this.#pending.delete(handle);
      timer.callback();
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
  /** The freeze command succeeds. */
  finishFreeze(nth = this.freezes.length - 1): void {
    pick(this.freezes, nth, 'freeze').resolve(undefined);
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
  /** The user touches the page (a click, a key press): Chromium's user activation. */
  activate(): void {
    this.events.activated?.();
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

interface WebTabOptions {
  readonly select?: boolean;
  readonly title?: string;
  readonly pinned?: boolean;
  /** The runtime's back/forward stack. The default is one entry at the URL. */
  readonly stack?: readonly { readonly url: string; readonly title: string }[];
  /** The active entry of the stack; the last one by default. */
  readonly index?: number;
}

/** "Leave page?" as the user would see it: answered by the test. */
interface LeaveQuestion {
  readonly tabId: TabId;
  /** The selected tab when the question was asked: it must be the tab itself. */
  readonly selected: TabId | null;
  readonly answer: PromiseWithResolvers<boolean>;
}

function build(
  options: { readonly confirmLeave?: boolean; readonly newIds?: readonly string[] } = {},
) {
  const timers = new ManualTimers();
  // The wall clock, and the engagement clock's two values (§4.6) that a tab's last use is stamped
  // with. Tests move them apart to see which one a stamp read.
  const clock = { now: 1_000_000, engaged: 0, activeDay: 1 };
  /** Called after every change, so a test can see what a listener would read at that moment. */
  const changeHooks: (() => void)[] = [];
  const runtimes: FakeRuntime[] = [];
  const failures: string[] = [];
  const transitions: RuntimeTransition[] = [];
  const pageGone: TabId[] = [];
  const memory: string[] = [];
  const protections = new Map<TabId, Protection[]>();
  const leaveQuestions: LeaveQuestion[] = [];
  const queuedIds = [...(options.newIds ?? [])];
  let changes = 0;
  let nextId = 0;
  const remember =
    (kind: string) =>
    (tabId: TabId): void => {
      memory.push(`${kind}:${tabId}`);
    };
  const observer: TabHistoryObserver = {
    committed: remember('committed'),
    titleChanged: remember('titleChanged'),
    faviconChanged: remember('faviconChanged'),
    closed: remember('closed'),
  };
  const manager = new TabManager({
    createRuntime: (tabId, events) => {
      const runtime = new FakeRuntime(tabId, events, failures);
      runtimes.push(runtime);
      return runtime;
    },
    newId: () => queuedIds.shift() ?? `tab-${String((nextId += 1))}`,
    onChange: () => {
      changes += 1;
      for (const hook of changeHooks) {
        hook();
      }
    },
    onPageGone: (tabId) => {
      pageGone.push(tabId);
    },
    history: observer,
    now: () => clock.now,
    activityClock: () => ({
      wallNow: clock.now,
      engagedNow: clock.engaged,
      activeDay: clock.activeDay,
    }),
    timers,
    protections: (tabId) => protections.get(tabId) ?? [],
    onTransition: (transition) => {
      transitions.push(transition);
    },
    ...(options.confirmLeave === false
      ? {}
      : {
          confirmLeave: (tabId: TabId): Promise<boolean> => {
            const answer = Promise.withResolvers<boolean>();
            leaveQuestions.push({ tabId, selected: manager.selectedTabId(), answer });
            return answer.promise;
          },
        }),
  });

  /** Every runtime a tab has had, oldest first. */
  const runtimesOf = (tabId: TabId): FakeRuntime[] =>
    runtimes.filter((runtime) => runtime.tabId === tabId);
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
    const stack = tab.stack ?? [{ url, title }];
    runtime.entries = stack.map((entry) => ({ ...entry, pageState: `ps:${entry.url}` }));
    runtime.index = tab.index ?? stack.length - 1;
    commit(runtime, url, { canGoBack: runtime.index > 0 });
    runtime.events.titleChanged(title);
    runtime.events.loadingChanged(false);
    if (tab.pinned === true) {
      manager.setPinned(id, true);
    }
    return id;
  };
  const track = <T>(promise: Promise<T>): Tracked<T> => new Tracked(promise, failures);
  return {
    manager,
    timers,
    clock,
    runtimes,
    failures,
    transitions,
    pageGone,
    memory,
    protections,
    leaveQuestions,
    changes: () => changes,
    changeHooks,
    runtimesOf,
    runtimeOf,
    webTab,
    track,
    /** The tab ids of the strip, Sleeping and the Archive in memory, as the sidebar lists them. */
    strip: (): TabId[] => manager.tabs().map((tab) => tab.id),
    sleeping: (): TabId[] => manager.sleepingTabs().map((tab) => tab.id),
    archived: (): TabId[] => manager.archivedTabs().map((tab) => tab.id),
    sessionTab: (tabId: TabId): SessionTab | undefined =>
      manager.sessionTabs().find((tab) => tab.id === tabId),
  };
}

type Base = ReturnType<typeof build>;
type Env = Base & { readonly home: TabId };

/** The test being run, for the invariants checked after it. */
let active: Base | undefined;

/** A manager with no tabs: for restoreSession, which needs an empty one. */
function setupEmpty(options: Parameters<typeof build>[0] = {}): Base {
  const base = build(options);
  active = base;
  return base;
}

/** A manager with a selected new-tab page, `home`, so the tabs a test makes can stay in the background. */
function setup(options: Parameters<typeof build>[0] = {}): Env {
  const base = setupEmpty(options);
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
  const firstUnpinned = strip.findIndex((tab) => !tab.pinned);
  if (firstUnpinned !== -1 && strip.slice(firstUnpinned).some((tab) => tab.pinned)) {
    problems.push('a pinned tab after an unpinned one');
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
  if (manager.archivedCount() < archived.length) {
    problems.push('the Archive count is below the tabs in memory');
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
function savedTab(id: string, overrides: Partial<SessionTab> = {}): SessionTab {
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
    ...overrides,
  };
}

function archivedTab(id: string, overrides: Partial<ArchivedTab> = {}): ArchivedTab {
  return { ...savedTab(id), archivedAt: 5000, reason: 'auto', ...overrides };
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
function savedStrip(
  ids: readonly string[],
  extra: Partial<Parameters<TabManager['restoreSession']>[0]> = {},
): Base {
  const env = setupEmpty();
  env.manager.restoreSession(
    session({ tabs: ids.map((id) => savedTab(id)), selectedTabId: ids[0] ?? null, ...extra }),
  );
  return env;
}

/**
 * Archives a live tab all the way: a clean probe, a plain close that goes through. The tab must
 * not be the selected one (the user's own archive of that one is tested separately).
 */
async function archiveLive(
  env: Base,
  tabId: TabId,
  request: MoveRequest = USER,
): Promise<MoveOutcome> {
  const runtime = env.runtimeOf(tabId);
  const archive = env.track(env.manager.archive(tabId, request));
  await flush();
  runtime.answerProbe(reading());
  await flush();
  runtime.contentsDestroyed();
  await flush();
  return archive.value;
}

describe('TabManager placement: shelving a strip tab', () => {
  it('moves it to Sleeping, newest first, and reports where it was', () => {
    const env = setup();
    const a = env.webTab(A);
    const b = env.webTab(B);
    const c = env.webTab(C);
    const changes = env.changes();

    const outcome = env.manager.shelve(b, USER);

    expect(outcome).toEqual(moved({ tabId: b, from: 'strip', to: 'shelf', index: 2 }));
    expect(env.strip()).toEqual([env.home, a, c]);
    expect(env.sleeping()).toEqual([b]);
    expect(env.manager.get(b)).toMatchObject({ placement: 'shelf', pinned: false });
    expect(env.changes()).toBeGreaterThan(changes);

    // The next one goes in front: Sleeping lists the latest first.
    expect(env.manager.shelve(a, USER)).toEqual(
      moved({ tabId: a, from: 'strip', to: 'shelf', index: 1 }),
    );
    expect(env.sleeping()).toEqual([a, b]);
  });

  it('refuses a pinned tab, a tab that is already Sleeping, and a tab that is gone', () => {
    const env = setup();
    const pinned = env.webTab(A, { pinned: true });
    const sleeper = env.webTab(B);
    expect(env.manager.shelve(sleeper, USER).outcome).toBe('moved');

    for (const request of [USER, AUTOMATION]) {
      expect(env.manager.shelve(pinned, request)).toEqual(skippedAs('pinned'));
      expect(env.manager.shelve(sleeper, request)).toEqual(skippedAs('wrong-placement'));
      expect(env.manager.shelve('no-such-tab', request)).toEqual(skippedAs('closed'));
    }
    expect(env.strip()).toEqual([pinned, env.home]);
    expect(env.sleeping()).toEqual([sleeper]);
  });

  it('keeps the web contents of a live tab: Sleeping may still be live', () => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);
    env.pageGone.length = 0;

    expect(env.manager.shelve(id, USER).outcome).toBe('moved');

    expect(env.manager.get(id).runtime).toBe('live');
    expect(runtime.alive).toBe(true);
    expect(runtime.shown).toBe(false);
    expect(runtime.calls).not.toContain('destroy');
    expect(env.pageGone).not.toContain(id);
  });

  it('lets automation shelve a background tab whose decision still holds', () => {
    const env = setup();
    const id = env.webTab(A);
    const epoch = env.manager.lifecycleFacts(id).epoch;

    expect(env.manager.shelve(id, { origin: 'automation', epoch })).toEqual(
      moved({ tabId: id, from: 'strip', to: 'shelf', index: 1 }),
    );
    expect(env.sleeping()).toEqual([id]);
  });

  it('refuses automation for the selected tab', () => {
    const env = setup();
    env.webTab(A);

    expect(env.manager.shelve(env.home, AUTOMATION)).toEqual(skippedAs('selected'));
    expect(env.strip()).toContain(env.home);
    expect(env.sleeping()).toEqual([]);
  });

  it('refuses automation a decision made before the tab changed (a stale epoch, I5)', () => {
    const env = setup();
    const id = env.webTab(A);
    const epoch = env.manager.lifecycleFacts(id).epoch;

    expect(env.manager.shelve(id, { origin: 'automation', epoch: epoch - 1 })).toEqual(
      skippedAs('stale'),
    );
    expect(env.manager.get(id).placement).toBe('strip');
  });

  it('refuses automation a tab while a lifecycle operation runs on it, but not the user', async () => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);
    const discard = env.track(env.manager.discard(id, { origin: 'automation' }));
    await flush();
    expect(env.manager.get(id).runtime).toBe('discarding');

    expect(env.manager.shelve(id, AUTOMATION)).toEqual(skippedAs('cancelled'));
    expect(env.manager.get(id).placement).toBe('strip');

    // The user's move goes through, and the discard still finishes: Sleeping may hold an
    // unloaded tab.
    expect(env.manager.shelve(id, USER).outcome).toBe('moved');
    runtime.answerProbe(reading());
    await flush();
    runtime.contentsDestroyed();
    await flush();
    expect(discard.value).toEqual({ outcome: 'discarded' });
    expect(env.manager.get(id)).toMatchObject({ placement: 'shelf', runtime: 'unloaded' });
  });

  it.each<ProtectionReason>(['audio', 'capture', 'recent-interaction'])(
    'refuses automation a tab the monitor protects with %s',
    (reason) => {
      const env = setup();
      const id = env.webTab(A);
      env.protections.set(id, [protectionFor(reason)]);

      expect(env.manager.shelve(id, AUTOMATION)).toEqual(blockedBy(reason));
      expect(env.manager.get(id).placement).toBe('strip');

      // The user decides for themselves.
      expect(env.manager.shelve(id, USER).outcome).toBe('moved');
    },
  );

  it.each<ProtectionReason>([
    'unsaved-input',
    'page-unsaved-changes',
    'editing',
    'sensitive-page',
    'devtools',
    'open-popup',
  ])('is not stopped by %s, which does not concern shelving', (reason) => {
    const env = setup();
    const id = env.webTab(A);
    env.protections.set(id, [protectionFor(reason)]);

    expect(env.manager.shelve(id, AUTOMATION).outcome).toBe('moved');
  });

  it('refuses automation a tab the user protected, but not the user', () => {
    const env = setup();
    const id = env.webTab(A);
    env.manager.setProtected(id, true);

    expect(env.manager.shelve(id, AUTOMATION)).toEqual(blockedBy('user-protected'));
    expect(env.manager.get(id).placement).toBe('strip');
    expect(env.manager.shelve(id, USER).outcome).toBe('moved');
    expect(env.manager.get(id).userProtected).toBe(true);
  });

  it('lets the user shelve the selected tab and selects the one next to it', () => {
    const env = setup();
    const a = env.webTab(A);
    const b = env.webTab(B);
    env.manager.select(a);
    const hidden = env.runtimeOf(a);

    expect(env.manager.shelve(a, USER)).toEqual(
      moved({ tabId: a, from: 'strip', to: 'shelf', index: 1 }),
    );

    expect(env.manager.selectedTabId()).toBe(b);
    expect(env.runtimeOf(b).shown).toBe(true);
    // The shelved page is still there, out of sight.
    expect(hidden.alive).toBe(true);
    expect(hidden.shown).toBe(false);
  });

  it('selects the previous tab when the user shelves the last one', () => {
    const env = setup();
    const a = env.webTab(A);
    const b = env.webTab(B);
    env.manager.select(b);

    expect(env.manager.shelve(b, USER).outcome).toBe('moved');

    expect(env.manager.selectedTabId()).toBe(a);
  });

  it('never leaves the strip empty: shelving the only tab opens a new-tab page', () => {
    const env = setup();

    expect(env.manager.shelve(env.home, USER)).toEqual(
      moved({ tabId: env.home, from: 'strip', to: 'shelf', index: 0 }),
    );

    expect(env.strip()).toHaveLength(1);
    const [fresh] = env.strip();
    expect(fresh).not.toBe(env.home);
    expect(env.manager.selectedTabId()).toBe(fresh);
    expect(env.manager.get(pick(env.strip(), 0, 'tab'))).toMatchObject({
      page: { kind: 'internal', name: 'new-tab' },
      placement: 'strip',
    });
    expect(env.sleeping()).toEqual([env.home]);
  });
});

describe('TabManager placement: bringing a Sleeping tab back', () => {
  it('puts it next to the selected tab and selects it', () => {
    const env = setup();
    const a = env.webTab(A);
    const b = env.webTab(B);
    const c = env.webTab(C);
    env.manager.shelve(b, USER);
    env.manager.select(a);

    env.manager.restoreToStrip(b);

    expect(env.strip()).toEqual([env.home, a, b, c]);
    expect(env.manager.selectedTabId()).toBe(b);
    expect(env.sleeping()).toEqual([]);
    expect(env.manager.get(b).placement).toBe('strip');
    expect(env.runtimeOf(b).shown).toBe(true);
  });

  it('puts it at `index` when given one, clamped to the unpinned section', () => {
    const env = setup();
    const pinned = env.webTab(A, { pinned: true });
    const b = env.webTab(B);
    const c = env.webTab(C);
    const d = env.webTab('https://d.example/');
    env.manager.shelve(b, USER);
    env.manager.shelve(c, USER);
    env.manager.shelve(d, USER);
    // Strip: [pinned, home].

    env.manager.restoreToStrip(b, { index: 0, select: false });
    expect(env.strip()).toEqual([pinned, b, env.home]);

    env.manager.restoreToStrip(c, { index: 99, select: false });
    expect(env.strip()).toEqual([pinned, b, env.home, c]);

    env.manager.restoreToStrip(d, { index: 2, select: false });
    expect(env.strip()).toEqual([pinned, b, d, env.home, c]);
  });

  it('leaves the selection and the view alone with select: false', () => {
    const env = setup();
    const a = env.webTab(A);
    env.manager.shelve(a, USER);

    env.manager.restoreToStrip(a, { select: false });

    expect(env.manager.selectedTabId()).toBe(env.home);
    expect(env.strip()).toEqual([env.home, a]);
    expect(env.runtimeOf(a).shown).toBe(false);
  });

  it('does nothing for a tab that is not Sleeping', () => {
    const env = setup();
    const a = env.webTab(A);
    const changes = env.changes();

    env.manager.restoreToStrip(a);

    expect(env.changes()).toBe(changes);
    expect(env.strip()).toEqual([env.home, a]);
    expect(env.manager.selectedTabId()).toBe(env.home);
  });

  it('selecting a Sleeping tab brings it back to the strip and selects it', () => {
    const env = setup();
    const a = env.webTab(A);
    const b = env.webTab(B);
    env.manager.shelve(a, USER);

    env.manager.select(a);

    expect(env.manager.selectedTabId()).toBe(a);
    expect(env.strip()).toEqual([env.home, a, b]);
    expect(env.sleeping()).toEqual([]);
    expect(env.runtimeOf(a).shown).toBe(true);
    expect(env.runtimeOf(a).calls).toContain('focus');
  });

  it('keeps the page focus where it is when selecting a Sleeping tab with focus: false', () => {
    const env = setup();
    const a = env.webTab(A);
    env.manager.shelve(a, USER);

    env.manager.select(a, { focus: false });

    expect(env.manager.selectedTabId()).toBe(a);
    expect(env.runtimeOf(a).calls).not.toContain('focus');
  });

  it('restores an unloaded Sleeping tab into a new web contents, attached first', () => {
    const env = setupEmpty();
    env.manager.restoreSession(
      session({ tabs: [savedTab('h')], selectedTabId: 'h', shelf: [savedTab('s')] }),
    );
    expect(env.runtimes).toHaveLength(0);

    env.manager.select('s');

    expect(env.strip()).toEqual(['h', 's']);
    expect(env.manager.get('s').runtime).toBe('creating');
    const restore = pick(env.runtimeOf('s').restores, 0, 'restore');
    expect(restore.shownFirst).toBe(true);
    expect(restore.history).toStrictEqual({
      index: 1,
      entries: [
        { url: 'https://s.example/old', title: 'Old s' },
        { url: 'https://s.example/', title: 'Title s' },
      ],
    });
  });

  it('pinning a Sleeping tab brings it to the end of the pinned tabs, unselected (I8)', () => {
    const env = setup();
    const p = env.webTab(A, { pinned: true });
    const b = env.webTab(B);
    env.manager.shelve(b, USER);
    expect(env.strip()).toEqual([p, env.home]);

    env.manager.setPinned(b, true);

    expect(env.strip()).toEqual([p, b, env.home]);
    expect(env.sleeping()).toEqual([]);
    expect(env.manager.get(b)).toMatchObject({ pinned: true, placement: 'strip' });
    expect(env.manager.selectedTabId()).toBe(env.home);
  });

  it('opening a tab after a Sleeping one appends it to the strip', () => {
    const env = setup();
    const a = env.webTab(A);
    const b = env.webTab(B);
    env.manager.shelve(a, USER);

    const fresh = env.manager.create({ afterTabId: a });

    expect(env.strip()).toEqual([env.home, b, fresh]);
    expect(env.sleeping()).toEqual([a]);
    expect(env.manager.get(fresh)).toMatchObject({ placement: 'strip', pinned: false });
    expect(env.manager.selectedTabId()).toBe(fresh);
  });

  // Found by this file: `move()` spliced `#order.indexOf(tabId)`, -1 for a Sleeping tab, so it cut
  // the last strip tab out of the strip and put the Sleeping id into it (I1).
  it('leaves the strip alone when a Sleeping tab is asked to move', () => {
    const env = setup();
    const a = env.webTab(A);
    const b = env.webTab(B);
    env.manager.shelve(a, USER);

    env.manager.move(a, 0);

    expect(env.strip()).toEqual([env.home, b]);
    expect(env.sleeping()).toEqual([a]);
    expect(env.runtimeOf(b).alive).toBe(true);
  });
});

describe('TabManager placement: archiving', () => {
  it('discards a live tab first, then keeps its data: newest first, reason, never pinned, no runtime', async () => {
    const env = setup();
    const a = env.webTab(A, { title: 'Alpha' });
    const b = env.webTab(B, { title: 'Beta' });
    const runtime = env.runtimeOf(a);
    env.pageGone.length = 0;

    const archive = env.track(env.manager.archive(a, USER));
    await flush();
    // The same procedure as a discard: wake, probe, snapshot, a plain close for a page the user
    // never touched. Nothing is archived while the page is still closing.
    expect(archive.settled).toBe(false);
    expect(env.manager.get(a).runtime).toBe('discarding');
    runtime.answerProbe(reading());
    await flush();
    expect(runtime.closes.map((close) => close.mode)).toEqual(['plain']);
    expect(env.archived()).toEqual([]);
    expect(env.manager.has(a)).toBe(true);

    runtime.contentsDestroyed();
    await flush();
    expect(archive.value).toEqual(moved({ tabId: a, from: 'strip', to: 'archive', index: 1 }));
    // I3: the tab is data now; its web contents is gone.
    expect(runtime.alive).toBe(false);
    expect(env.manager.has(a)).toBe(false);
    expect(env.strip()).toEqual([env.home, b]);
    expect(env.manager.archivedCount()).toBe(1);
    expect(pick(env.manager.archivedTabs(), 0, 'archived tab')).toMatchObject({
      id: a,
      url: A,
      title: 'Alpha',
      pinned: false,
      reason: 'manual',
      archivedAt: env.clock.now,
      // The stack is kept; Chromium's page state is not.
      history: { index: 0, entries: [{ url: A, title: 'Alpha' }] },
    });
    expect(env.pageGone).toContain(a);
    expect(env.memory).toContain(`closed:${a}`);

    // Automation archives the next one: newest first, with its own reason.
    env.clock.now += 5000;
    expect((await archiveLive(env, b, AUTOMATION)).outcome).toBe('moved');
    expect(env.archived()).toEqual([b, a]);
    expect(env.manager.archivedTabs().map((tab) => tab.reason)).toEqual(['auto', 'manual']);
    expect(env.manager.archivedCount()).toBe(2);
  });

  it('archives a Sleeping tab and says where it was in Sleeping', async () => {
    const env = setup();
    const a = env.webTab(A);
    const b = env.webTab(B);
    env.manager.shelve(a, USER);
    env.manager.shelve(b, USER);
    expect(env.sleeping()).toEqual([b, a]);

    // A Sleeping tab may still be live: it is discarded first, like a strip tab.
    expect(await archiveLive(env, a, USER)).toEqual(
      moved({ tabId: a, from: 'shelf', to: 'archive', index: 1 }),
    );
    expect(env.sleeping()).toEqual([b]);
    expect(env.archived()).toEqual([a]);
  });

  it('archives a tab that was never loaded without waking it', async () => {
    const env = savedStrip(['h', 'x']);

    const outcome = await env.manager.archive('x', AUTOMATION);

    expect(outcome).toEqual(moved({ tabId: 'x', from: 'strip', to: 'archive', index: 1 }));
    expect(env.runtimes).toHaveLength(0);
    expect(pick(env.manager.archivedTabs(), 0, 'archived tab')).toMatchObject({
      id: 'x',
      url: 'https://x.example/',
      reason: 'auto',
      history: savedTab('x').history,
    });
  });

  it('lets the user archive a pinned tab, which is unpinned in the Archive (I8)', async () => {
    const env = setup();
    const p = env.webTab(A, { pinned: true });

    expect(await archiveLive(env, p, USER)).toEqual(
      moved({ tabId: p, from: 'strip', to: 'archive', index: 0 }),
    );

    expect(pick(env.manager.archivedTabs(), 0, 'archived tab').pinned).toBe(false);
  });

  it('refuses automation a pinned tab, the selected tab and a stale decision', async () => {
    const env = setup();
    const p = env.webTab(A, { pinned: true });
    const b = env.webTab(B);
    const epoch = env.manager.lifecycleFacts(b).epoch;

    expect(await env.manager.archive(p, AUTOMATION)).toEqual(skippedAs('pinned'));
    expect(await env.manager.archive(env.home, AUTOMATION)).toEqual(skippedAs('selected'));
    expect(await env.manager.archive(b, { origin: 'automation', epoch: epoch - 1 })).toEqual(
      skippedAs('stale'),
    );
    expect(await env.manager.archive('no-such-tab', AUTOMATION)).toEqual(skippedAs('closed'));

    expect(env.archived()).toEqual([]);
    expect(env.strip()).toEqual([p, env.home, b]);
    expect(env.runtimeOf(b).alive).toBe(true);
  });

  it.each<ProtectionReason>([
    'unsaved-input',
    'editing',
    'capture',
    'open-popup',
    'recent-interaction',
  ])(
    'refuses automation a tab the monitor protects with %s, without touching the page',
    async (reason) => {
      const env = setup();
      const id = env.webTab(A);
      env.protections.set(id, [protectionFor(reason)]);
      const runtime = env.runtimeOf(id);

      expect(await env.manager.archive(id, AUTOMATION)).toEqual(blockedBy(reason));

      expect(runtime.probes).toHaveLength(0);
      expect(env.manager.get(id).runtime).toBe('live');
      expect(env.strip()).toContain(id);
      expect(env.archived()).toEqual([]);
    },
  );

  it('refuses automation a tab the user protected', async () => {
    const env = setup();
    const id = env.webTab(A);
    env.manager.setProtected(id, true);

    expect(await env.manager.archive(id, AUTOMATION)).toEqual(blockedBy('user-protected'));

    expect(env.runtimeOf(id).probes).toHaveLength(0);
    expect(env.archived()).toEqual([]);
  });

  it('refuses automation a tab playing audio, through the discard it would need', async () => {
    const env = setup();
    const id = env.webTab(A);
    env.protections.set(id, [protectionFor('audio')]);

    // Audio doesn't block archiving as such, but it blocks the discard an archive needs.
    expect(await env.manager.archive(id, AUTOMATION)).toEqual(blockedBy('audio'));
    expect(env.manager.get(id).runtime).toBe('live');
    expect(env.archived()).toEqual([]);
  });

  it('destroys the runtime of a crashed tab instead of discarding it, then archives it', async () => {
    const env = setup();
    const id = env.webTab(A, { title: 'Alpha' });
    const runtime = env.runtimeOf(id);
    runtime.events.crashed({ code: 1, name: 'crashed' });
    expect(env.manager.get(id).runtime).toBe('crashed');

    const outcome = await env.manager.archive(id, USER);

    expect(outcome).toEqual(moved({ tabId: id, from: 'strip', to: 'archive', index: 1 }));
    expect(runtime.alive).toBe(false);
    expect(runtime.calls).toContain('destroy');
    expect(runtime.probes).toHaveLength(0);
    expect(runtime.closes).toHaveLength(0);
    // It keeps the address it was on.
    expect(pick(env.manager.archivedTabs(), 0, 'archived tab')).toMatchObject({
      id,
      url: A,
      title: 'Alpha',
    });
  });

  it('refuses an ephemeral tab: it is never stored (I6)', async () => {
    const env = setup();
    const id = env.manager.create({ ephemeral: true, select: false });

    expect(await env.manager.archive(id, USER)).toEqual(skippedAs('wrong-placement'));

    expect(env.strip()).toEqual([env.home, id]);
    expect(env.archived()).toEqual([]);
  });

  it('skips a tab that is loading', async () => {
    const env = setup();
    const id = env.manager.create({ select: false });
    env.manager.navigate(id, A);
    expect(env.manager.get(id).loading).toBe(true);

    expect(await env.manager.archive(id, USER)).toEqual(skippedAs('loading'));
    expect(await env.manager.archive(id, AUTOMATION)).toEqual(skippedAs('loading'));

    expect(env.strip()).toContain(id);
    expect(env.archived()).toEqual([]);
  });

  it('leaves a tab where it was when the page objects to unloading', async () => {
    const env = setup();
    const a = env.webTab(A);
    const b = env.webTab(B);
    const runtime = env.runtimeOf(b);

    const archive = env.track(env.manager.archive(b, USER));
    await flush();
    runtime.answerProbe(reading({ hasBeenActive: true }));
    await flush();
    expect(runtime.closes.map((close) => close.mode)).toEqual(['beforeunload']);
    runtime.prevent();
    await flush();

    expect(archive.value).toEqual(blockedBy('page-unsaved-changes'));
    expect(env.strip()).toEqual([env.home, a, b]);
    expect(env.manager.get(b).runtime).toBe('live');
    expect(runtime.alive).toBe(true);
    expect(env.archived()).toEqual([]);
    expect(env.manager.archivedCount()).toBe(0);
  });

  it('leaves a tab where it was when the probe finds unsaved input', async () => {
    const env = setup();
    const a = env.webTab(A);
    const runtime = env.runtimeOf(a);

    const archive = env.track(env.manager.archive(a, USER));
    await flush();
    runtime.answerProbe(reading({ editedFields: 1 }));
    await flush();

    expect(archive.value).toEqual(blockedBy('unsaved-input'));
    expect(env.strip()).toEqual([env.home, a]);
    expect(runtime.alive).toBe(true);
  });

  it('selects a neighbour when the user archives the selected tab, and archives the tab', async () => {
    const env = setup();
    const a = env.webTab(A);
    const b = env.webTab(B);
    env.manager.select(a);

    const archive = env.track(env.manager.archive(a, USER));
    await flush();
    // The tab in use is left first: its page can then be discarded, and the user is looking at
    // the one next to it.
    expect(env.manager.selectedTabId()).toBe(b);
    const runtime = env.runtimeOf(a);
    runtime.answerProbe(reading());
    await flush();
    runtime.contentsDestroyed();
    await flush();

    expect(archive.value).toEqual(moved({ tabId: a, from: 'strip', to: 'archive', index: 1 }));
    expect(env.strip()).toEqual([env.home, b]);
    expect(env.manager.selectedTabId()).toBe(b);
  });

  it('opens a new-tab page when the user archives the only tab', async () => {
    const env = setup();

    const outcome = await env.manager.archive(env.home, USER);

    expect(outcome).toEqual(moved({ tabId: env.home, from: 'strip', to: 'archive', index: 0 }));
    expect(env.strip()).toHaveLength(1);
    expect(env.manager.selectedTabId()).toBe(pick(env.strip(), 0, 'tab'));
    expect(env.archived()).toEqual([env.home]);
  });

  it('leaves the strip consistent when the page objects to archiving the selected tab', async () => {
    const env = setup();
    const a = env.webTab(A);
    env.manager.select(a);
    const runtime = env.runtimeOf(a);

    const archive = env.track(env.manager.archive(a, USER));
    await flush();
    runtime.answerProbe(reading({ hasBeenActive: true }));
    await flush();
    runtime.prevent();
    await flush();

    expect(archive.value).toEqual(blockedBy('page-unsaved-changes'));
    expect(env.strip()).toEqual([env.home, a]);
    expect(env.archived()).toEqual([]);
    expect(runtime.alive).toBe(true);
    expect(env.manager.get(a).runtime).toBe('live');
  });

  it('stops when the tab is closed while its page is still being probed', async () => {
    const env = setup();
    const a = env.webTab(A);
    const archive = env.track(env.manager.archive(a, USER));
    await flush();
    expect(env.manager.get(a).runtime).toBe('discarding');

    env.manager.close(a);
    await flush();
    // The probe's script fails with the web contents gone, and the archive notices.
    expect(env.runtimesOf(a).every((runtime) => !runtime.alive)).toBe(true);

    expect(archive.value).toEqual(skippedAs('closed'));
    expect(env.archived()).toEqual([]);
    expect(env.manager.closedTabs()[0]?.id).toBe(a);
  });

  it('stops when the user picks the tab again while its page is closing', async () => {
    const env = setup();
    const a = env.webTab(A);
    const runtime = env.runtimeOf(a);
    const archive = env.track(env.manager.archive(a, USER));
    await flush();
    runtime.answerProbe(reading());
    await flush();
    expect(runtime.closes).toHaveLength(1);

    env.manager.select(a);
    runtime.contentsDestroyed();
    await flush();

    // The page closed, but the tab was picked: it comes back from its stack instead of leaving.
    expect(archive.value).toEqual(skippedAs('cancelled'));
    expect(env.manager.selectedTabId()).toBe(a);
    expect(env.archived()).toEqual([]);
    expect(env.strip()).toEqual([env.home, a]);
    expect(env.manager.get(a).runtime).toBe('creating');
  });

  it('keeps the newest MAX_ARCHIVED_IN_MEMORY in memory and still counts the rest', async () => {
    const ids = Array.from({ length: MAX_ARCHIVED_IN_MEMORY + 1 }, (_, n) => `t${String(n)}`);
    const env = savedStrip(['h'], { shelf: ids.map((id) => savedTab(id)) });
    expect(env.sleeping()).toHaveLength(MAX_ARCHIVED_IN_MEMORY + 1);

    for (const id of ids) {
      expect((await env.manager.archive(id, AUTOMATION)).outcome).toBe('moved');
    }

    expect(env.manager.archivedTabs()).toHaveLength(MAX_ARCHIVED_IN_MEMORY);
    expect(env.manager.archivedCount()).toBe(MAX_ARCHIVED_IN_MEMORY + 1);
    // The first one archived is the one that left memory; the newest is first.
    expect(env.archived()).not.toContain('t0');
    expect(env.archived()[0]).toBe(`t${String(MAX_ARCHIVED_IN_MEMORY)}`);
    expect(env.manager.restoreArchived('t0')).toBeNull();
    expect(env.manager.archivedCount()).toBe(MAX_ARCHIVED_IN_MEMORY + 1);
  });
});

describe('TabManager placement: bringing back an archived tab', () => {
  it('puts it next to the selected tab and selects it', () => {
    const env = setupEmpty();
    env.manager.restoreSession(
      session({
        tabs: [savedTab('a'), savedTab('b')],
        selectedTabId: 'a',
        archived: [archivedTab('x'), archivedTab('y')],
        archivedCount: 2,
      }),
    );

    expect(env.manager.restoreArchived('x')).toBe('x');

    expect(env.strip()).toEqual(['a', 'x', 'b']);
    expect(env.manager.selectedTabId()).toBe('x');
    expect(env.archived()).toEqual(['y']);
    expect(env.manager.archivedCount()).toBe(1);
    // Selecting restores it, from its stack.
    expect(env.manager.get('x').runtime).toBe('creating');
    expect(pick(env.runtimeOf('x').restores, 0, 'restore').shownFirst).toBe(true);
  });

  it('can bring it back without selecting it', () => {
    const env = setupEmpty();
    env.manager.restoreSession(
      session({ tabs: [savedTab('a')], selectedTabId: 'a', archived: [archivedTab('x')] }),
    );

    expect(env.manager.restoreArchived('x', { select: false })).toBe('x');

    expect(env.strip()).toEqual(['a', 'x']);
    expect(env.manager.selectedTabId()).toBe('a');
    expect(env.manager.get('x').runtime).toBe('unloaded');
    expect(env.runtimes).toHaveLength(0);
  });

  it('can bring it back into Sleeping, at an index, without selecting it', () => {
    const env = setupEmpty();
    env.manager.restoreSession(
      session({
        tabs: [savedTab('a')],
        selectedTabId: 'a',
        shelf: [savedTab('s1'), savedTab('s2')],
        archived: [archivedTab('x'), archivedTab('y')],
      }),
    );

    expect(env.manager.restoreArchived('x', { to: 'shelf' })).toBe('x');
    expect(env.manager.restoreArchived('y', { to: 'shelf', index: 2 })).toBe('y');

    expect(env.sleeping()).toEqual(['x', 's1', 'y', 's2']);
    expect(env.manager.get('x')).toMatchObject({ placement: 'shelf', runtime: 'unloaded' });
    expect(env.strip()).toEqual(['a']);
    expect(env.manager.selectedTabId()).toBe('a');
  });

  it('puts it back at an index in the strip, within the unpinned tabs', () => {
    const env = setupEmpty();
    env.manager.restoreSession(
      session({
        tabs: [savedTab('p', { pinned: true }), savedTab('a'), savedTab('b')],
        selectedTabId: 'a',
        archived: [archivedTab('x'), archivedTab('y')],
      }),
    );

    env.manager.restoreArchived('x', { index: 0, select: false });
    env.manager.restoreArchived('y', { index: 99, select: false });

    expect(env.strip()).toEqual(['p', 'x', 'a', 'b', 'y']);
  });

  it('keeps its back/forward stack and drops Chromium page state', async () => {
    const env = setup();
    const stack = [
      { url: A, title: 'First' },
      { url: B, title: 'Second' },
    ];
    const a = env.webTab(B, { stack, title: 'Second' });
    await archiveLive(env, a, USER);

    expect(env.manager.restoreArchived(a)).toBe(a);

    const restore = pick(env.runtimeOf(a).restores, 0, 'restore');
    expect(restore.history).toStrictEqual({
      index: 1,
      entries: [
        { url: A, title: 'First' },
        { url: B, title: 'Second' },
      ],
    });
  });

  it('is never pinned, whatever the saved row says (I8), and keeps the user protection', () => {
    const env = setupEmpty();
    env.manager.restoreSession(
      session({
        tabs: [savedTab('p', { pinned: true }), savedTab('a')],
        selectedTabId: 'a',
        archived: [archivedTab('x', { pinned: true, userProtected: true })],
      }),
    );

    env.manager.restoreArchived('x', { select: false });

    expect(env.manager.get('x')).toMatchObject({ pinned: false, userProtected: true });
    expect(env.strip()).toEqual(['p', 'a', 'x']);
  });

  it('stamps the time it came back', () => {
    const env = setupEmpty();
    env.manager.restoreSession(
      session({
        tabs: [savedTab('a')],
        selectedTabId: 'a',
        archived: [archivedTab('x', { placementChangedAt: 1234 })],
      }),
    );
    env.clock.now = 9_999_000;

    env.manager.restoreArchived('x', { select: false });

    expect(env.sessionTab('x')?.placementChangedAt).toBe(9_999_000);
  });

  it('gives it a new id when its own is taken', () => {
    // The first id the manager makes is the one the Archive already holds.
    const env = setupEmpty({ newIds: ['x', 'fresh'] });
    env.manager.restoreSession(session({ archived: [archivedTab('x')] }));
    expect(env.strip()).toEqual(['x']);

    const id = env.manager.restoreArchived('x', { select: false });

    expect(id).toBe('fresh');
    expect(env.strip()).toEqual(['x', 'fresh']);
    expect(env.manager.get('fresh').url).toBe('https://x.example/');
    expect(env.archived()).toEqual([]);
  });

  it('answers null for a tab that is not archived, and for one already brought back', () => {
    const env = setupEmpty();
    env.manager.restoreSession(
      session({ tabs: [savedTab('a')], selectedTabId: 'a', archived: [archivedTab('x')] }),
    );

    expect(env.manager.restoreArchived('nobody')).toBeNull();
    expect(env.manager.restoreArchived('a')).toBeNull(); // Live, not archived.
    expect(env.manager.restoreArchived('x')).toBe('x');
    expect(env.manager.restoreArchived('x')).toBeNull();
  });
});

describe('TabManager placement: undoing moves', () => {
  it('puts shelved tabs back in reverse order, at their original places', () => {
    const env = setup();
    const a = env.webTab(A);
    const b = env.webTab(B);
    const c = env.webTab(C);
    const d = env.webTab('https://d.example/');
    const moves: PlacementMove[] = [];
    for (const id of [b, d, a]) {
      const outcome = env.manager.shelve(id, AUTOMATION);
      if (outcome.outcome !== 'moved') {
        throw new Error(`could not shelve ${id}`);
      }
      moves.push(outcome.move);
    }
    expect(moves.map((move) => move.index)).toEqual([2, 3, 1]);
    expect(env.strip()).toEqual([env.home, c]);

    const undone = env.manager.undoMoves(moves);

    expect(undone).toEqual(moves);
    expect(env.strip()).toEqual([env.home, a, b, c, d]);
    expect(env.sleeping()).toEqual([]);
    // Undo doesn't take the user to the tabs it brings back.
    expect(env.manager.selectedTabId()).toBe(env.home);
  });

  it('puts archived tabs back, from the strip and from Sleeping, where they were', async () => {
    const env = savedStrip(['h', 'a', 'b', 'c', 'd']);
    const moves: PlacementMove[] = [];
    const record = (outcome: MoveOutcome): void => {
      if (outcome.outcome !== 'moved') {
        throw new Error(`a move did not happen: ${JSON.stringify(outcome)}`);
      }
      moves.push(outcome.move);
    };
    record(await env.manager.archive('b', AUTOMATION)); // strip [h a c d], b gone from index 2
    record(env.manager.shelve('a', AUTOMATION)); // index 1
    record(env.manager.shelve('d', AUTOMATION)); // index 2, Sleeping [d a]
    record(await env.manager.archive('a', AUTOMATION)); // from Sleeping, index 1
    expect(env.strip()).toEqual(['h', 'c']);
    expect(env.sleeping()).toEqual(['d']);
    expect(env.archived()).toEqual(['a', 'b']);

    const undone = env.manager.undoMoves(moves);

    expect(undone).toEqual(moves);
    expect(env.strip()).toEqual(['h', 'a', 'b', 'c', 'd']);
    expect(env.sleeping()).toEqual([]);
    expect(env.archived()).toEqual([]);
    expect(env.manager.archivedCount()).toBe(0);
    expect(env.manager.selectedTabId()).toBe('h');
  });

  it('puts an archived tab back into Sleeping when it was archived from there', async () => {
    const env = savedStrip(['h', 'a', 'b']);
    env.manager.shelve('a', USER);
    env.manager.shelve('b', USER);
    expect(env.sleeping()).toEqual(['b', 'a']);
    const outcome = await env.manager.archive('a', USER);
    if (outcome.outcome !== 'moved') {
      throw new Error('could not archive a');
    }

    const undone = env.manager.undoMoves([outcome.move]);

    expect(undone).toEqual([outcome.move]);
    expect(env.sleeping()).toEqual(['b', 'a']);
    expect(env.manager.get('a').placement).toBe('shelf');
  });

  it('leaves a tab the user moved meanwhile alone, and does not report it', async () => {
    const env = savedStrip(['h', 'a', 'b', 'c']);
    const first = env.manager.shelve('a', AUTOMATION);
    const second = env.manager.shelve('b', AUTOMATION);
    const third = await env.manager.archive('c', AUTOMATION);
    if (first.outcome !== 'moved' || second.outcome !== 'moved' || third.outcome !== 'moved') {
      throw new Error('a move did not happen');
    }
    // The user picks `a` (it comes back to the strip) and `c` (it leaves the Archive).
    env.manager.select('a');
    expect(env.manager.restoreArchived('c', { select: false })).toBe('c');
    env.manager.setPinned('c', true);

    const undone = env.manager.undoMoves([first.move, second.move, third.move]);

    // Only `b`, still Sleeping, goes back.
    expect(undone).toEqual([second.move]);
    expect(env.sleeping()).toEqual([]);
    expect(env.strip()).toContain('b');
    // `a` and the pinned `c` are where the user left them.
    expect(env.manager.selectedTabId()).toBe('a');
    expect(env.manager.get('c').pinned).toBe(true);
    expect(env.strip()[0]).toBe('c');
  });

  it('ignores a tab that was closed meanwhile', async () => {
    const env = savedStrip(['h', 'a', 'b']);
    const shelved = env.manager.shelve('a', AUTOMATION);
    const archived = await env.manager.archive('b', AUTOMATION);
    if (shelved.outcome !== 'moved' || archived.outcome !== 'moved') {
      throw new Error('a move did not happen');
    }
    env.manager.close('a');

    const undone = env.manager.undoMoves([shelved.move, archived.move]);

    expect(undone).toEqual([archived.move]);
    expect(env.strip()).toEqual(['h', 'b']);
    expect(env.manager.has('a')).toBe(false);
  });

  it('reports the new id of an archived tab whose own id is taken', async () => {
    const env = setupEmpty({ newIds: ['x', 'fresh'] });
    env.manager.restoreSession(
      session({ tabs: [savedTab('x'), savedTab('h')], selectedTabId: 'h' }),
    );
    const archived = await env.manager.archive('x', AUTOMATION);
    if (archived.outcome !== 'moved') {
      throw new Error('could not archive x');
    }
    // Something else took the id while it was away.
    expect(env.manager.create({ select: false })).toBe('x');

    const undone = env.manager.undoMoves([archived.move]);

    expect(undone).toEqual([{ ...archived.move, tabId: 'fresh' }]);
    expect(env.strip()).toContain('fresh');
  });

  it('answers with nothing for an empty list, and notifies nobody', () => {
    const env = setup();
    const changes = env.changes();

    expect(env.manager.undoMoves([])).toEqual([]);

    expect(env.changes()).toBe(changes);
  });

  it('counts as using every tab it brings back, so automation does not move it straight back', async () => {
    const env = savedStrip(['h', 'a', 'b', 'c']);
    const shelved = env.manager.shelve('a', AUTOMATION);
    const archived = await env.manager.archive('c', AUTOMATION);
    if (shelved.outcome !== 'moved' || archived.outcome !== 'moved') {
      throw new Error('a move did not happen');
    }
    const lastUse = (tabId: TabId) => {
      const facts = pick(
        env.manager.lifecycleTabs().filter((tab) => tab.id === tabId),
        0,
        'tab facts',
      );
      return [facts.lastUsedAt, facts.lastUsedEngaged, facts.lastUsedActiveDay];
    };
    // What they were last used at when the session was saved, and a day later by every clock.
    expect(lastUse('a')).toEqual([2000, 0, 1]);
    env.clock.now += 86_400_000;
    env.clock.engaged = 7_200_000;
    env.clock.activeDay = 3;
    const now = env.clock.now;
    // What a listener reads at each notification: the last one must already see the stamps.
    const seen: Record<string, number[]>[] = [];
    env.changeHooks.push(() => {
      seen.push(
        Object.fromEntries(
          ['a', 'c'].flatMap((id) => (env.manager.has(id) ? [[id, lastUse(id)]] : [])),
        ),
      );
    });

    const undone = env.manager.undoMoves([shelved.move, archived.move]);

    expect(undone).toEqual([shelved.move, archived.move]);
    // Last use is now, by the wall clock, the engaged time and the active day: the policy sees
    // a tab in use, not one that sat there since the session was saved.
    expect(lastUse('a')).toEqual([now, 7_200_000, 3]);
    expect(lastUse('c')).toEqual([now, 7_200_000, 3]);
    expect(lastUse('b')).toEqual([2000, 0, 1]);
    // The session persists the same stamps.
    for (const id of ['a', 'c']) {
      expect(env.sessionTab(id)).toMatchObject({
        lastUsedAt: now,
        lastUsedEngaged: 7_200_000,
        lastUsedActiveDay: 3,
      });
    }
    expect(env.sessionTab('b')).toMatchObject({ lastUsedAt: 2000, lastUsedEngaged: 0 });
    expect(pick(seen, seen.length - 1, 'notification')).toEqual({
      a: [now, 7_200_000, 3],
      c: [now, 7_200_000, 3],
    });
    // Undo brings the tabs back without taking the user to them.
    expect(env.manager.selectedTabId()).toBe('h');
  });

  it('notifies when something was undone, but not when every tab was left alone', async () => {
    const env = savedStrip(['h', 'a', 'b']);
    const shelved = env.manager.shelve('a', AUTOMATION);
    const archived = await env.manager.archive('b', AUTOMATION);
    if (shelved.outcome !== 'moved' || archived.outcome !== 'moved') {
      throw new Error('a move did not happen');
    }
    const before = env.changes();

    expect(env.manager.undoMoves([shelved.move, archived.move])).toHaveLength(2);
    const after = env.changes();
    expect(after).toBeGreaterThan(before);

    // Both are back in the strip now: a second Undo finds nothing to put back.
    expect(env.manager.undoMoves([shelved.move, archived.move])).toEqual([]);
    expect(env.changes()).toBe(after);
  });

  it('does not count as using a tab it leaves alone', () => {
    const env = savedStrip(['h', 'a']);
    const shelved = env.manager.shelve('a', AUTOMATION);
    if (shelved.outcome !== 'moved') {
      throw new Error('could not shelve a');
    }
    // The user brings it back themselves (without selecting it), then a day passes.
    env.manager.restoreToStrip('a', { select: false });
    env.clock.now += 86_400_000;
    env.clock.engaged = 7_200_000;
    env.clock.activeDay = 3;

    expect(env.manager.undoMoves([shelved.move])).toEqual([]);

    expect(env.sessionTab('a')).toMatchObject({
      lastUsedAt: 2000,
      lastUsedEngaged: 0,
      lastUsedActiveDay: 1,
    });
  });

  it('stamps a tab that came back under a new id under that id', async () => {
    const env = setupEmpty({ newIds: ['x', 'fresh'] });
    env.manager.restoreSession(
      session({ tabs: [savedTab('x'), savedTab('h')], selectedTabId: 'h' }),
    );
    const archived = await env.manager.archive('x', AUTOMATION);
    if (archived.outcome !== 'moved') {
      throw new Error('could not archive x');
    }
    expect(env.manager.create({ select: false })).toBe('x');
    env.clock.now += 86_400_000;
    env.clock.engaged = 7_200_000;
    env.clock.activeDay = 3;

    env.manager.undoMoves([archived.move]);

    expect(env.sessionTab('fresh')).toMatchObject({
      lastUsedAt: env.clock.now,
      lastUsedEngaged: 7_200_000,
      lastUsedActiveDay: 3,
    });
  });
});

describe('TabManager placement: protecting a tab', () => {
  it('shows in the state, the session and the lifecycle facts, and goes away when switched off', () => {
    const env = setup();
    const a = env.webTab(A);
    const b = env.webTab(B);
    env.manager.shelve(b, USER);
    const changes = env.changes();

    env.manager.setProtected(a, true);
    env.manager.setProtected(b, true);

    expect(env.changes()).toBeGreaterThan(changes);
    expect(env.manager.get(a).userProtected).toBe(true);
    expect(env.sessionTab(a)?.userProtected).toBe(true);
    expect(env.manager.shelfSessionTabs().map((tab) => tab.userProtected)).toEqual([true]);
    // The policy sees it as a hard protection that blocks everything automation does.
    const facts = env.manager.lifecycleTabs();
    for (const id of [a, b]) {
      const protections = pick(
        facts.filter((tab) => tab.id === id),
        0,
        'tab facts',
      ).protections;
      expect(protections).toContainEqual(protectionFor('user-protected'));
    }
    expect(
      pick(
        facts.filter((tab) => tab.id === env.home),
        0,
        'tab facts',
      ).protections,
    ).toEqual([]);

    const settled = env.changes();
    env.manager.setProtected(a, true); // Already so: nothing changes.
    expect(env.changes()).toBe(settled);

    env.manager.setProtected(a, false);
    expect(env.manager.get(a).userProtected).toBe(false);
    expect(env.sessionTab(a)?.userProtected).toBe(false);
    const after = env.manager.lifecycleTabs().filter((tab) => tab.id === a);
    expect(pick(after, 0, 'tab facts').protections).toEqual([]);
  });

  it('stops automation from shelving, archiving, discarding or freezing it', async () => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);
    env.manager.setProtected(id, true);

    expect(env.manager.shelve(id, AUTOMATION)).toEqual(blockedBy('user-protected'));
    expect(await env.manager.archive(id, AUTOMATION)).toEqual(blockedBy('user-protected'));
    for (const origin of ['automation', 'pressure'] as const) {
      expect(await env.manager.discard(id, { origin })).toEqual({
        outcome: 'blocked',
        reason: 'user-protected',
      });
    }
    expect(await env.manager.freeze(id)).toEqual({ outcome: 'blocked', reason: 'user-protected' });

    // Soft protections give way under critical pressure; this one is hard.
    expect(await env.manager.discard(id, { origin: 'pressure', overrideSoft: true })).toEqual({
      outcome: 'blocked',
      reason: 'user-protected',
    });
    expect(runtime.probes).toHaveLength(0);
    expect(env.manager.get(id)).toMatchObject({ placement: 'strip', runtime: 'live' });
  });

  it('does not stop the user from shelving it', () => {
    const env = setup();
    const id = env.webTab(A);
    env.manager.setProtected(id, true);

    expect(env.manager.shelve(id, USER).outcome).toBe('moved');
    expect(env.manager.get(id).userProtected).toBe(true);
  });

  it('does not stop the user from archiving it when it has no web contents to discard', async () => {
    const env = savedStrip(['h', 'x']);
    env.manager.setProtected('x', true);

    // The user's own request is not automation: protections stop only automation (placement.ts).
    expect(await env.manager.archive('x', USER)).toEqual(
      moved({ tabId: 'x', from: 'strip', to: 'archive', index: 1 }),
    );
    // The protection goes with it and comes back with it.
    expect(pick(env.manager.archivedTabs(), 0, 'archived tab').userProtected).toBe(true);
    expect(env.manager.restoreArchived('x', { select: false })).toBe('x');
    expect(env.manager.get('x').userProtected).toBe(true);
  });

  // Found by this file: `#protected()` added 'user-protected' for every origin, so the user's own
  // archive or discard of a live protected tab was blocked before the probe.
  it('does not stop the user from archiving a live protected tab', async () => {
    const env = setup();
    const id = env.webTab(A);
    env.webTab(B);
    env.manager.setProtected(id, true);

    expect((await archiveLive(env, id, USER)).outcome).toBe('moved');
    expect(pick(env.manager.archivedTabs(), 0, 'archived tab')).toMatchObject({
      id,
      userProtected: true,
    });
  });

  it('does not stop the user from discarding a live protected tab, but stops automation', async () => {
    const env = setup();
    const id = env.webTab(A);
    env.webTab(B);
    const runtime = env.runtimeOf(id);
    env.manager.setProtected(id, true);

    expect(await env.manager.discard(id, { origin: 'automation' })).toEqual(
      blockedBy('user-protected'),
    );
    expect(runtime.probes).toHaveLength(0);

    const discard = env.track(env.manager.discard(id, { origin: 'user' }));
    await flush();
    runtime.answerProbe(reading());
    await flush();
    runtime.contentsDestroyed();
    await flush();
    expect(discard.value).toEqual({ outcome: 'discarded' });
    expect(env.manager.get(id)).toMatchObject({ runtime: 'unloaded', unloadedBy: 'user' });
  });
});

describe('TabManager placement: the user closes a tab ("Leave page?")', () => {
  /** A live page the user has touched, so it may object to unloading. */
  function activatedTab(env: Env, url = A, options: WebTabOptions = {}) {
    const id = env.webTab(url, options);
    const runtime = env.runtimeOf(id);
    runtime.activate();
    return { id, runtime };
  }

  it('closes a page the user never activated at once, without asking the page', () => {
    const env = setup();
    const id = env.webTab(A, { title: 'Alpha' });
    const runtime = env.runtimeOf(id);
    const onClosed = vi.fn();

    env.manager.requestClose(id, { onClosed });

    // Synchronously: no round trip that would let an untouched page object (S3).
    expect(env.manager.has(id)).toBe(false);
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(runtime.closes).toEqual([]);
    expect(runtime.calls).not.toContain('closeForDiscard:beforeunload');
    expect(runtime.alive).toBe(false);
    expect(pick(env.manager.closedTabs(), 0, 'closed tab')).toMatchObject({
      id,
      url: A,
      title: 'Alpha',
    });
  });

  it('closes a new-tab page and an error page at once, even if the page was activated before', () => {
    const env = setup();
    const fresh = env.manager.create({ select: false });
    const failed = env.webTab(A);
    const runtime = env.runtimeOf(failed);
    runtime.activate();
    runtime.events.loadFailed({ code: -105, name: 'ERR_NAME_NOT_RESOLVED', url: A });
    const onClosed = vi.fn();

    env.manager.requestClose(fresh, { onClosed });
    env.manager.requestClose(failed, { onClosed });

    expect(env.manager.has(fresh)).toBe(false);
    expect(env.manager.has(failed)).toBe(false);
    expect(onClosed).toHaveBeenCalledTimes(2);
    expect(runtime.closes).toEqual([]);
  });

  it('asks an activated page with beforeunload, and closes the tab when the page lets go', async () => {
    const env = setup();
    const stack = [
      { url: A, title: 'First' },
      { url: B, title: 'Second' },
    ];
    const { id, runtime } = activatedTab(env, B, { stack, title: 'Second' });
    const onClosed = vi.fn();

    env.manager.requestClose(id, { onClosed });
    await flush();

    expect(runtime.closes.map((close) => close.mode)).toEqual(['beforeunload']);
    expect(env.manager.has(id)).toBe(true);
    expect(onClosed).not.toHaveBeenCalled();
    expect(env.leaveQuestions).toEqual([]);

    runtime.contentsDestroyed();
    // The web contents went, and the runtime said so (`gone`); it is the user's own close, so the
    // tab is not marked unloaded or crashed on the way.
    expect(env.manager.get(id).runtime).toBe('live');
    await flush();

    expect(env.manager.has(id)).toBe(false);
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(env.leaveQuestions).toEqual([]);
    expect(env.transitions.filter((t) => t.tabId === id).map((t) => t.event)).not.toContain('gone');
    // It is in Recently closed with the stack it had before the close.
    expect(pick(env.manager.closedTabs(), 0, 'closed tab')).toMatchObject({
      id,
      url: B,
      title: 'Second',
      history: {
        index: 1,
        entries: [
          { url: A, title: 'First' },
          { url: B, title: 'Second' },
        ],
      },
    });
    expect(env.pageGone).toContain(id);
    expect(env.memory).toContain(`closed:${id}`);
  });

  it('selects the neighbour when the closed tab was the selected one', async () => {
    const env = setup();
    const { id: a, runtime } = activatedTab(env, A);
    const b = env.webTab(B);
    env.manager.select(a);

    env.manager.requestClose(a);
    await flush();
    runtime.contentsDestroyed();
    await flush();

    expect(env.manager.has(a)).toBe(false);
    expect(env.manager.selectedTabId()).toBe(b);
    expect(env.runtimeOf(b).shown).toBe(true);
  });

  it('selects the tab and asks "Leave page?" when the page objects', async () => {
    const env = setup();
    const { id, runtime } = activatedTab(env, A);
    const onClosed = vi.fn();
    expect(env.manager.selectedTabId()).toBe(env.home);

    env.manager.requestClose(id, { onClosed });
    await flush();
    runtime.prevent();
    await flush();

    expect(env.manager.selectedTabId()).toBe(id);
    expect(env.leaveQuestions.map((question) => question.tabId)).toEqual([id]);
    // The user is looking at the tab when the question comes.
    expect(pick(env.leaveQuestions, 0, 'question').selected).toBe(id);
    expect(runtime.shown).toBe(true);
    expect(env.manager.has(id)).toBe(true);
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('closes the tab with a plain close when the user chooses to leave', async () => {
    const env = setup();
    const { id, runtime } = activatedTab(env, A);
    const onClosed = vi.fn();
    env.manager.requestClose(id, { onClosed });
    await flush();
    runtime.prevent();
    await flush();

    pick(env.leaveQuestions, 0, 'question').answer.resolve(true);
    await flush();

    expect(env.manager.has(id)).toBe(false);
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(runtime.alive).toBe(false);
    // A plain close: the page isn't asked a second time.
    expect(runtime.closes).toHaveLength(1);
    expect(env.manager.closedTabs()[0]?.id).toBe(id);
    expect(env.manager.selectedTabId()).not.toBe(id);
  });

  it('keeps the tab when the user chooses to stay, and asks the page again next time', async () => {
    const env = setup();
    const { id, runtime } = activatedTab(env, A);
    const onClosed = vi.fn();
    env.manager.requestClose(id, { onClosed });
    await flush();
    runtime.prevent();
    await flush();

    pick(env.leaveQuestions, 0, 'question').answer.resolve(false);
    await flush();

    expect(env.manager.has(id)).toBe(true);
    expect(env.manager.selectedTabId()).toBe(id);
    expect(onClosed).not.toHaveBeenCalled();
    expect(runtime.alive).toBe(true);

    env.manager.requestClose(id, { onClosed });
    await flush();
    expect(runtime.closes).toHaveLength(2);
    runtime.prevent();
    await flush();
    expect(env.leaveQuestions).toHaveLength(2);
  });

  it('keeps the tab when the question fails', async () => {
    const env = setup();
    const { id, runtime } = activatedTab(env, A);
    env.manager.requestClose(id);
    await flush();
    runtime.prevent();
    await flush();

    pick(env.leaveQuestions, 0, 'question').answer.reject(new Error('the dialog was dismissed'));
    await flush();

    expect(env.manager.has(id)).toBe(true);
    expect(runtime.alive).toBe(true);
  });

  it('keeps the tab, with no question, when nothing can ask the user', async () => {
    const env = setup({ confirmLeave: false });
    const { id, runtime } = activatedTab(env, A);
    const onClosed = vi.fn();

    env.manager.requestClose(id, { onClosed });
    await flush();
    runtime.prevent();
    await flush();

    expect(env.manager.has(id)).toBe(true);
    expect(onClosed).not.toHaveBeenCalled();
    expect(env.manager.selectedTabId()).toBe(id);
  });

  it('does not ask the page again while it is being asked', async () => {
    const env = setup();
    const { id, runtime } = activatedTab(env, A);
    const onClosed = vi.fn();

    env.manager.requestClose(id, { onClosed });
    await flush();
    env.manager.requestClose(id, { onClosed });
    await flush();
    expect(runtime.closes).toHaveLength(1);

    runtime.contentsDestroyed();
    await flush();
    expect(env.manager.has(id)).toBe(false);
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it('does not ask the page again while "Leave page?" waits, and shows the tab if it is not shown', async () => {
    const env = setup();
    const { id, runtime } = activatedTab(env, A);
    env.manager.requestClose(id);
    await flush();
    runtime.prevent();
    await flush();
    env.manager.select(env.home);
    expect(env.manager.selectedTabId()).toBe(env.home);

    env.manager.requestClose(id);
    await flush();

    expect(runtime.closes).toHaveLength(1);
    expect(env.leaveQuestions).toHaveLength(1);
    expect(env.manager.selectedTabId()).toBe(id);
  });

  it('closes the tab for good if it is closed some other way while the question waits', async () => {
    const env = setup();
    const { id, runtime } = activatedTab(env, A);
    const onClosed = vi.fn();
    env.manager.requestClose(id, { onClosed });
    await flush();
    runtime.prevent();
    await flush();

    env.manager.close(id);
    pick(env.leaveQuestions, 0, 'question').answer.resolve(true);
    await flush();

    expect(env.manager.has(id)).toBe(false);
    expect(onClosed).not.toHaveBeenCalled();
    expect(env.manager.closedTabs().filter((tab) => tab.id === id)).toHaveLength(1);
  });

  it('treats a page stuck past CLOSE_TIMEOUT_MS as objecting', async () => {
    const env = setup();
    const { id, runtime } = activatedTab(env, A);
    const onClosed = vi.fn();
    env.manager.requestClose(id, { onClosed });
    await flush();
    expect(env.leaveQuestions).toEqual([]);

    env.timers.fire(CLOSE_TIMEOUT_MS);
    await flush();

    expect(env.manager.selectedTabId()).toBe(id);
    expect(env.leaveQuestions.map((question) => question.tabId)).toEqual([id]);
    expect(env.manager.has(id)).toBe(true);
    expect(onClosed).not.toHaveBeenCalled();

    // If the page closes at last on its own, the tab is restored, still waiting for the answer.
    runtime.contentsDestroyed();
    await flush();
    expect(env.manager.has(id)).toBe(true);
    expect(env.manager.get(id).runtime).toBe('creating');
    const replacement = env.runtimeOf(id);
    expect(replacement).not.toBe(runtime);
    pick(env.leaveQuestions, 0, 'question').answer.resolve(true);
    await flush();
    expect(env.manager.has(id)).toBe(false);
    expect(replacement.alive).toBe(false);
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it('thaws a frozen page before it asks', async () => {
    const env = setup();
    const { id, runtime } = activatedTab(env, A);
    const freeze = env.track(env.manager.freeze(id));
    await flush();
    runtime.finishFreeze();
    await flush();
    expect(freeze.value).toEqual({ outcome: 'frozen' });
    expect(env.manager.get(id).runtime).toBe('frozen');

    env.manager.requestClose(id);
    await flush();

    const calls = runtime.calls;
    expect(calls.indexOf('thaw')).toBeGreaterThan(-1);
    expect(calls.indexOf('thaw')).toBeLessThan(calls.indexOf('closeForDiscard:beforeunload'));
    expect(env.manager.get(id).runtime).toBe('live');
  });

  it('forgets that the user touched a page when a new document commits', () => {
    const env = setup();
    const { id, runtime } = activatedTab(env, A);
    commit(runtime, B);

    env.manager.requestClose(id);

    // A fresh document hasn't been activated: it closes at once.
    expect(env.manager.has(id)).toBe(false);
    expect(runtime.closes).toEqual([]);
  });

  it('keeps that the user touched a page across a same-document change', async () => {
    const env = setup();
    const { id, runtime } = activatedTab(env, A);
    commit(runtime, `${A}#section`, { sameDocument: true });

    env.manager.requestClose(id);
    await flush();

    expect(runtime.closes.map((close) => close.mode)).toEqual(['beforeunload']);
    expect(env.manager.has(id)).toBe(true);
  });

  // Found by this file: the objection selected a Sleeping tab where it was, so the selected tab
  // was not in the strip (I1) and the question was asked out of sight.
  it('brings a Sleeping tab back to the strip, selected, when its page objects to a user close', async () => {
    const env = setup();
    const { id, runtime } = activatedTab(env, A);
    env.manager.shelve(id, USER);

    env.manager.requestClose(id);
    await flush();
    runtime.prevent();
    await flush();

    expect(env.manager.get(id).placement).toBe('strip');
    expect(env.strip()).toContain(id);
    expect(env.sleeping()).toEqual([]);
    expect(env.manager.selectedTabId()).toBe(id);
    expect(pick(env.leaveQuestions, 0, 'question')).toMatchObject({ tabId: id, selected: id });
  });

  it('closes at once when an operation queued before it already unloaded the page', async () => {
    const env = setup();
    const { id, runtime } = activatedTab(env, A);
    const onClosed = vi.fn();
    // A discard is queued first; the user's close waits behind it on the tab's queue.
    const discard = env.track(env.manager.discard(id, { origin: 'user' }));
    env.manager.requestClose(id, { onClosed });
    await flush();
    runtime.answerProbe(reading({ hasBeenActive: true }));
    await flush();
    // The discard's own close (beforeunload: the page was activated) goes through.
    runtime.contentsDestroyed();
    await flush();
    expect(discard.value).toEqual({ outcome: 'discarded' });

    // Nothing is left to object: the tab closes without asking a dead page.
    expect(env.manager.has(id)).toBe(false);
    expect(env.leaveQuestions).toEqual([]);
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(runtime.closes.map((close) => close.mode)).toEqual(['beforeunload']);
  });

  it('closes a Sleeping tab the user never touched at once', () => {
    const env = setup();
    const id = env.webTab(A);
    env.manager.shelve(id, USER);
    const onClosed = vi.fn();

    env.manager.requestClose(id, { onClosed });

    expect(env.manager.has(id)).toBe(false);
    expect(env.sleeping()).toEqual([]);
    expect(onClosed).toHaveBeenCalledTimes(1);
  });
});

describe('TabManager placement: closing a Sleeping tab', () => {
  it('destroys its web contents, leaves the selection alone and keeps it in Recently closed', () => {
    const env = setup();
    const a = env.webTab(A, { title: 'Alpha' });
    env.webTab(B);
    const runtime = env.runtimeOf(a);
    env.manager.shelve(a, USER);
    env.pageGone.length = 0;

    env.manager.close(a);

    expect(env.sleeping()).toEqual([]);
    expect(runtime.alive).toBe(false);
    expect(env.manager.selectedTabId()).toBe(env.home);
    expect(env.pageGone).toEqual([a]);
    expect(env.memory).toContain(`closed:${a}`);
    expect(pick(env.manager.closedTabs(), 0, 'closed tab')).toMatchObject({
      id: a,
      url: A,
      title: 'Alpha',
    });
  });

  it('reopens at the end of the strip', () => {
    const env = setup();
    const a = env.webTab(A);
    const b = env.webTab(B);
    const c = env.webTab(C);
    env.manager.shelve(a, USER);
    env.manager.close(a);

    expect(pick(env.manager.closedTabs(), 0, 'closed tab').index).toBe(3);
    expect(env.manager.reopenClosed()).toBe(a);

    expect(env.strip()).toEqual([env.home, b, c, a]);
    expect(env.manager.get(a)).toMatchObject({ placement: 'strip', pinned: false });
    expect(env.manager.selectedTabId()).toBe(a);
  });
});

describe('TabManager placement: lifecycle facts', () => {
  it('lists the strip, then Sleeping, with the placement of each', () => {
    const env = setup();
    const a = env.webTab(A);
    const b = env.webTab(B);
    env.manager.shelve(a, USER);

    const facts = env.manager.lifecycleTabs();

    expect(facts.map((tab) => [tab.id, tab.placement])).toEqual([
      [env.home, 'strip'],
      [b, 'strip'],
      [a, 'shelf'],
    ]);
    expect(pick(facts, 0, 'tab facts').selected).toBe(true);
    const sleeper = pick(facts, 2, 'tab facts');
    expect(sleeper).toMatchObject({ runtime: 'live', selected: false, pinned: false });
  });
});

describe('TabManager placement: the session', () => {
  it('stores Sleeping tabs newest first, but never an ephemeral one (I6)', () => {
    const env = setup();
    const a = env.webTab(A);
    const b = env.webTab(B);
    const private1 = env.manager.create({ ephemeral: true, select: false });
    env.manager.shelve(a, USER);
    env.manager.shelve(private1, USER);
    env.manager.shelve(b, USER);

    expect(env.sleeping()).toEqual([b, private1, a]);
    expect(env.manager.shelfSessionTabs().map((tab) => tab.id)).toEqual([b, a]);
    expect(env.manager.sessionTabs().map((tab) => tab.id)).toEqual([env.home]);
  });

  it('carries userProtected and placementChangedAt, which move with the tab', () => {
    const env = setup();
    const a = env.webTab(A);
    expect(env.sessionTab(a)).toMatchObject({
      userProtected: false,
      placementChangedAt: 1_000_000,
    });

    env.clock.now += 5000;
    env.manager.setProtected(a, true);
    expect(env.sessionTab(a)).toMatchObject({ userProtected: true, placementChangedAt: 1_000_000 });

    env.manager.shelve(a, USER);
    expect(pick(env.manager.shelfSessionTabs(), 0, 'Sleeping tab')).toMatchObject({
      id: a,
      userProtected: true,
      placementChangedAt: 1_005_000,
    });

    env.clock.now += 7000;
    env.manager.restoreToStrip(a, { select: false });
    expect(env.sessionTab(a)).toMatchObject({ userProtected: true, placementChangedAt: 1_012_000 });
  });

  it('rebuilds Sleeping and the Archive with their count, and never pins a Sleeping tab (I8)', () => {
    const env = setupEmpty();

    env.manager.restoreSession(
      session({
        tabs: [savedTab('a'), savedTab('b', { pinned: true })],
        selectedTabId: 'a',
        shelf: [
          savedTab('s1', { userProtected: true, placementChangedAt: 4242 }),
          savedTab('s2', { pinned: true }),
        ],
        archived: [archivedTab('y2'), archivedTab('y1')],
        archivedCount: 7,
      }),
    );

    expect(env.strip()).toEqual(['b', 'a']);
    expect(env.sleeping()).toEqual(['s1', 's2']);
    expect(env.manager.get('s1')).toMatchObject({
      placement: 'shelf',
      runtime: 'unloaded',
      pinned: false,
      userProtected: true,
    });
    expect(env.manager.get('s2')).toMatchObject({ placement: 'shelf', pinned: false });
    expect(env.manager.shelfSessionTabs().map((tab) => tab.placementChangedAt)).toEqual([
      4242, 1000,
    ]);
    expect(env.archived()).toEqual(['y2', 'y1']);
    expect(env.manager.archivedCount()).toBe(7);
    expect(pick(env.manager.archivedTabs(), 0, 'archived tab')).toMatchObject({
      reason: 'auto',
      archivedAt: 5000,
    });
    // Nothing was loaded for them: they are data.
    expect(env.runtimes).toHaveLength(0);
  });

  it('counts at least the archived tabs it holds, whatever count was saved', () => {
    const env = setupEmpty();

    env.manager.restoreSession(
      session({
        tabs: [savedTab('a')],
        selectedTabId: 'a',
        archived: [archivedTab('y1'), archivedTab('y2')],
        archivedCount: 1,
      }),
    );

    expect(env.manager.archivedCount()).toBe(2);
  });

  it('keeps the newest archived tabs in memory when more are saved than it holds', () => {
    const ids = Array.from({ length: MAX_ARCHIVED_IN_MEMORY + 5 }, (_, n) => `y${String(n)}`);
    const env = setupEmpty();

    // Newest first, as the session store reads them.
    env.manager.restoreSession(
      session({
        tabs: [savedTab('a')],
        selectedTabId: 'a',
        archived: ids.map((id) => archivedTab(id)),
        archivedCount: 1000,
      }),
    );

    expect(env.archived()).toEqual(ids.slice(0, MAX_ARCHIVED_IN_MEMORY));
    expect(env.manager.archivedCount()).toBe(1000);
  });

  it('skips a Sleeping or archived tab whose id is a live tab, and an archived one with nothing to load', () => {
    const env = setupEmpty();

    env.manager.restoreSession(
      session({
        tabs: [savedTab('a')],
        selectedTabId: 'a',
        shelf: [savedTab('a'), savedTab('s')],
        archived: [
          archivedTab('a'),
          archivedTab('bad', { url: 'javascript:alert(1)', history: null }),
          archivedTab('ok'),
        ],
      }),
    );

    expect(env.strip()).toEqual(['a']);
    expect(env.sleeping()).toEqual(['s']);
    expect(env.archived()).toEqual(['ok']);
  });

  it('checks a saved address like any input: the new-tab address stays a new-tab page', () => {
    const env = setupEmpty();

    env.manager.restoreSession(
      session({
        tabs: [savedTab('a')],
        selectedTabId: 'a',
        shelf: [savedTab('n', { url: SESSION_NEW_TAB_URL, title: '', history: null })],
      }),
    );

    expect(env.manager.get('n')).toMatchObject({
      placement: 'shelf',
      page: { kind: 'internal', name: 'new-tab' },
      url: '',
    });
  });
});
