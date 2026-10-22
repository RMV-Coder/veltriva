// TabManager's lifecycle, driven by hand (M3.1: assessment §4.3, §4.5, §4.9–§4.11, ADR-0003 items
// 5 and 6). tab-manager-model.test.ts throws random sequences at it; these tests walk each path
// once, in a fixed order, so a failure names the scenario. The fake runtime hands out deferred
// promises for `ping`, `probe`, `closeForDiscard` and `freeze` (the ping answers at once unless a
// test says otherwise), and the timers are manual: a test decides when the page answers, when it
// objects, and when a deadline passes.
//
// The fake follows the Electron runtime's contract (./tab-runtime.ts):
//   - `closeForDiscard` settles `closed` when the web contents is destroyed, and the runtime then
//     reports `gone()` synchronously (TabManager ignores that one while its own close is in flight);
//   - `destroy()` settles pending closes as `closed`, without `gone`;
//   - `restore()` only into a brand-new runtime that is attached first (spike S2).
// Anything else the fake notices (a call into a gone web contents, a restore into a detached view)
// is recorded, and the invariants checked after every test (I1–I4, I6, I7) fail on it.
import { afterEach, describe, expect, it } from 'vitest';

import {
  CLOSE_TIMEOUT_MS,
  FREEZE_TIMEOUT_MS,
  LEARNED_RECHECK_MS,
} from '../../core/lifecycle/discard';
import type {
  DiscardBlock,
  DiscardOutcome,
  DiscardRequest,
  DiscardSkip,
  Timers,
} from '../../core/lifecycle/discard';
import { PING_TIMEOUT_MS, PROBE_TIMEOUT_MS } from '../../core/lifecycle/probe';
import type { CloseMode, ProbeReading } from '../../core/lifecycle/probe';
import { protectionFor } from '../../core/lifecycle/protections';
import type { Protection, ProtectionReason } from '../../core/lifecycle/protections';
import type { NavigationSnapshot } from '../../core/lifecycle/snapshot';
import type { TabHistory } from '../../core/session/history';
import { SESSION_NEW_TAB_URL, TabManager } from './tab-manager';
import type {
  CloseResult,
  FreezeOutcome,
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

const AUTOMATION: DiscardRequest = { origin: 'automation' };
const USER: DiscardRequest = { origin: 'user' };

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

  /** The delays of the timers still pending, oldest first. */
  get pending(): number[] {
    return [...this.#pending.values()].map((timer) => timer.ms);
  }

  /** Fires every pending timer with this delay. Throws if there is none: a missing deadline is a bug. */
  fire(ms: number): void {
    const due = [...this.#pending].filter(([, timer]) => timer.ms === ms);
    if (due.length === 0) {
      throw new Error(`no ${String(ms)} ms timer is pending (pending: ${this.pending.join(', ')})`);
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
  /** One deferred per `ping()` call. They answer at once unless `pingAnswersAtOnce` is false. */
  readonly pings: PromiseWithResolvers<unknown>[] = [];
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
  /** The renderer is awake at once; false leaves each ping for the test to answer or fail. */
  pingAnswersAtOnce = true;
  /** `ping()` throws at once instead of returning a promise. */
  pingThrows = false;
  /** Pings answered so far, and probes asked so far (a probe needs an answered ping each). */
  pingsAnswered = 0;
  probeCalls = 0;
  /** `probe()` throws at once instead of returning a promise. */
  probeThrows = false;
  /** `snapshot()` reports nothing (a web contents that can't be read any more). */
  snapshotUnreadable = false;
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
  reload(options: { readonly ignoreCache?: boolean } = {}): void {
    this.#use(options.ignoreCache === true ? 'reload:ignoreCache' : 'reload');
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
      // The web contents goes with it: pending closes settle as `closed`, and no `gone` follows.
      for (const close of this.closes) {
        close.settle.resolve('closed');
      }
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
    if (this.frozen) {
      this.failures.push(`ping() of a frozen page in ${this.tabId}`);
    }
    if (this.pingThrows) {
      throw new Error('ping threw at once');
    }
    const ping = Promise.withResolvers<unknown>();
    this.pings.push(ping);
    if (this.pingAnswersAtOnce) {
      this.answerPing(undefined);
    }
    return ping.promise;
  }
  probe(): Promise<unknown> {
    this.#use('probe');
    if (this.frozen) {
      this.failures.push(`probe() of a frozen page in ${this.tabId}`);
    }
    // The contract: a probe follows a ping that was answered (the renderer is awake), one each.
    this.probeCalls += 1;
    if (this.pingsAnswered < this.probeCalls) {
      this.failures.push(`probe() of ${this.tabId} before its ping was answered`);
    }
    if (this.probeThrows) {
      throw new Error('probe threw at once');
    }
    const probe = Promise.withResolvers<unknown>();
    this.probes.push(probe);
    return probe.promise;
  }
  snapshot(): { readonly index: number; readonly entries: readonly unknown[] } | null {
    this.calls.push('snapshot');
    if (!this.alive || this.snapshotUnreadable || this.entries.length === 0) {
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

  /** The renderer answers the ping: it is awake. Whatever it returns is not inspected. */
  answerPing(value?: unknown, nth = this.pings.length - 1): void {
    pick(this.pings, nth, 'ping').resolve(value);
    this.pingsAnswered += 1;
  }
  /** The ping's script fails (the page is gone, or the world is torn down). */
  failPing(nth = this.pings.length - 1): void {
    pick(this.pings, nth, 'ping').reject(new Error('the ping failed'));
  }
  /** The probe answers. */
  answerProbe(value: unknown, nth = this.probes.length - 1): void {
    pick(this.probes, nth, 'probe').resolve(value);
  }
  /** The probe's script fails (the page is gone, or the world is torn down). */
  failProbe(nth = this.probes.length - 1): void {
    pick(this.probes, nth, 'probe').reject(new Error('the probe failed'));
  }
  /** The page's beforeunload handler objects: the close settles `prevented` and the page lives. */
  prevent(nth = this.closes.length - 1): void {
    pick(this.closes, nth, 'close').settle.resolve('prevented');
  }
  /** The freeze command succeeds. */
  finishFreeze(nth = this.freezes.length - 1): void {
    pick(this.freezes, nth, 'freeze').resolve(undefined);
  }
  /** The freeze command fails (no debugger). */
  failFreeze(nth = this.freezes.length - 1): void {
    pick(this.freezes, nth, 'freeze').reject(new Error('no debugger'));
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
    for (const close of this.closes) {
      close.settle.resolve('closed');
    }
    this.events.gone();
  }

  #use(call: string): void {
    this.calls.push(call);
    if (!this.alive) {
      this.failures.push(`${call}() on a runtime of ${this.tabId} whose web contents is gone`);
    }
  }
}

/** What a runtime was asked about the lifecycle (the calls these tests care about, in order). */
const LIFECYCLE_CALLS: ReadonlySet<string> = new Set([
  'probe',
  'snapshot',
  'closeForDiscard:plain',
  'closeForDiscard:beforeunload',
  'freeze',
  'thaw',
  'destroy',
]);
const lifecycle = (runtime: FakeRuntime): string[] =>
  runtime.calls.filter((call) => LIFECYCLE_CALLS.has(call));
/** The wake-up and the probe it precedes, in order (`lifecycle` leaves the ping out). */
const wakeAndProbe = (runtime: FakeRuntime): string[] =>
  runtime.calls.filter((call) => call === 'ping' || call === 'probe');

/** An operation's result, once it settles. A rejection is recorded as a failure. */
class Tracked<T> {
  value: T | undefined;
  settled = false;

  constructor(promise: Promise<T>, failures: string[]) {
    void promise.then(
      (value) => {
        this.value = value;
        this.settled = true;
      },
      (error: unknown) => {
        this.settled = true;
        failures.push(`an operation rejected: ${String(error)}`);
      },
    );
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

/** A page that committed and stopped loading. */
function finishLoad(runtime: FakeRuntime, url: string): void {
  commit(runtime, url);
  runtime.events.loadingChanged(false);
}

interface WebTabOptions {
  readonly select?: boolean;
  readonly title?: string;
  /** The runtime's back/forward stack. The default is one entry at the URL. */
  readonly stack?: readonly { readonly url: string; readonly title: string }[];
  /** The active entry of the stack; the last one by default. */
  readonly index?: number;
}

function build() {
  const timers = new ManualTimers();
  const clock = { now: 1_000_000 };
  const runtimes: FakeRuntime[] = [];
  const failures: string[] = [];
  const transitions: RuntimeTransition[] = [];
  const pageGone: TabId[] = [];
  const memory: string[] = [];
  const protections = new Map<TabId, Protection[]>();
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
    newId: () => `tab-${String((nextId += 1))}`,
    onChange: () => {
      changes += 1;
    },
    onPageGone: (tabId) => {
      pageGone.push(tabId);
    },
    history: observer,
    now: () => clock.now,
    timers,
    protections: (tabId) => protections.get(tabId) ?? [],
    onTransition: (transition) => {
      transitions.push(transition);
    },
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
  const webTab = (url: string, options: WebTabOptions = {}): TabId => {
    const id = manager.create({ select: options.select ?? false });
    manager.navigate(id, url);
    const runtime = runtimeOf(id);
    const title = options.title ?? 'Page';
    const stack = options.stack ?? [{ url, title }];
    runtime.entries = stack.map((entry) => ({ ...entry, pageState: `ps:${entry.url}` }));
    runtime.index = options.index ?? stack.length - 1;
    commit(runtime, url, { canGoBack: runtime.index > 0 });
    runtime.events.titleChanged(title);
    runtime.events.loadingChanged(false);
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
    changes: () => changes,
    runtimesOf,
    runtimeOf,
    webTab,
    track,
    discard: (tabId: TabId, request: DiscardRequest = AUTOMATION): Tracked<DiscardOutcome> =>
      track(manager.discard(tabId, request)),
    freeze: (tabId: TabId): Tracked<FreezeOutcome> => track(manager.freeze(tabId)),
    sessionTab: (tabId: TabId): SessionTab | undefined =>
      manager.sessionTabs().find((tab) => tab.id === tabId),
    /** The runtime transitions of a tab, as `from>to:event`. */
    stepsOf: (tabId: TabId): string[] =>
      transitions
        .filter((transition) => transition.tabId === tabId)
        .map((transition) => `${transition.from}>${transition.to}:${transition.event}`),
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

/** Invariants I1–I4, I6 and I7 (tab-manager.ts), plus whatever the fakes noticed. */
function checkInvariants(env: Base): void {
  const { manager } = env;
  const problems = [...env.failures];
  const tabs = manager.tabs();
  const ids = new Set(tabs.map((tab) => tab.id));
  const selected = manager.selectedTabId();
  if (tabs.length > 0 && (selected === null || !ids.has(selected))) {
    problems.push(`I1: ${String(selected)} is not one of the tabs`);
  }
  if (selected !== null && ids.has(selected)) {
    const tab = manager.get(selected);
    const held = manager.lifecycleFacts(selected).heldUnloaded;
    const unloadedOk = tab.runtime === 'unloaded' && (tab.page.kind === 'internal' || held);
    if (!['creating', 'live', 'crashed'].includes(tab.runtime) && !unloadedOk) {
      problems.push(`I2: the selected tab ${selected} is ${tab.runtime}`);
    }
  }
  // I3 and I4: a tab holds a web contents exactly when it isn't unloaded; a closed tab holds none.
  const alive = new Map<TabId, number>();
  for (const runtime of env.runtimes.filter((candidate) => candidate.alive)) {
    alive.set(runtime.tabId, (alive.get(runtime.tabId) ?? 0) + 1);
  }
  for (const [tabId, count] of alive) {
    if (!ids.has(tabId)) {
      problems.push(`I3/I4: a zombie runtime for ${tabId}, which is closed`);
    }
    if (count > 1) {
      problems.push(`I4: ${tabId} has ${String(count)} live runtimes`);
    }
  }
  for (const tab of tabs) {
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
  // I6
  const ephemeral = new Set(tabs.filter((tab) => tab.ephemeral).map((tab) => tab.id));
  for (const tab of manager.sessionTabs()) {
    if (ephemeral.has(tab.id)) {
      problems.push(`I6: ephemeral ${tab.id} reached the session`);
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

/** A background tab whose discard has probed clean and sent its close: the page decides now. */
async function closingTab(env: Env, options: WebTabOptions = {}) {
  const id = env.webTab(A, options);
  const runtime = env.runtimeOf(id);
  const discard = env.discard(id);
  await flush();
  runtime.answerProbe(reading({ hasBeenActive: true }));
  await flush();
  expect(runtime.closes.map((close) => close.mode)).toEqual(['beforeunload']);
  expect(env.manager.get(id).runtime).toBe('discarding');
  return { id, runtime, discard };
}

/** Discards a background tab all the way: a clean probe, a plain close that goes through. */
async function discardCompletely(env: Base, id: TabId): Promise<void> {
  const runtime = env.runtimeOf(id);
  const discard = env.discard(id);
  await flush();
  runtime.answerProbe(reading());
  await flush();
  runtime.contentsDestroyed();
  await flush();
  expect(discard.value).toEqual(DISCARDED);
  expect(env.manager.get(id).runtime).toBe('unloaded');
}

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
  };
}

describe('TabManager lifecycle: a discard that goes through', () => {
  it('wakes, probes, snapshots and closes plainly, then leaves an unloaded tab with its stack and no page state', async () => {
    const env = setup();
    const id = env.webTab(A, { title: 'Alpha' });
    const runtime = env.runtimeOf(id);
    env.pageGone.length = 0;
    const changesBefore = env.changes();

    const discard = env.discard(id);
    expect(discard.settled).toBe(false);
    await flush();
    // The renderer answered the ping and the probe is out: the tab is discarding, and its one
    // operation is running. Only the probe's deadline is pending (the ping's was cleared).
    expect(env.manager.get(id).runtime).toBe('discarding');
    expect(env.manager.lifecycleFacts(id)).toMatchObject({ running: 1, queued: 1 });
    expect(wakeAndProbe(runtime)).toEqual(['ping', 'probe']);
    expect(lifecycle(runtime)).toEqual(['probe']);
    expect(env.timers.pending).toEqual([PROBE_TIMEOUT_MS]);

    runtime.answerProbe(reading());
    await flush();
    // Clean and never activated: snapshot, then a plain close (no beforeunload round-trip, S3).
    expect(lifecycle(runtime)).toEqual(['probe', 'snapshot', 'closeForDiscard:plain']);
    expect(env.manager.get(id).runtime).toBe('discarding');
    expect(discard.settled).toBe(false);

    runtime.contentsDestroyed();
    await flush();
    expect(discard.value).toEqual(DISCARDED);
    expect(env.manager.get(id)).toMatchObject({
      runtime: 'unloaded',
      page: { kind: 'web' },
      url: A,
      title: 'Alpha',
      loading: false,
      canGoBack: false,
      canGoForward: false,
    });
    expect(lifecycle(runtime)).toEqual(['probe', 'snapshot', 'closeForDiscard:plain', 'destroy']);
    expect(runtime.alive).toBe(false);
    // The session persists the stack without Chromium's page state.
    expect(env.sessionTab(id)?.history).toStrictEqual({
      index: 0,
      entries: [{ url: A, title: 'Alpha' }],
    });
    expect(env.manager.lifecycleFacts(id)).toMatchObject({
      running: 0,
      queued: 0,
      learned: [],
      pageStateInMemory: true,
    });
    expect(env.pageGone).toEqual([id]);
    expect(env.changes()).toBeGreaterThan(changesBefore);
    expect(env.stepsOf(id)).toEqual([
      'unloaded>creating:load',
      'creating>live:ready',
      'live>discarding:discard',
      'discarding>unloaded:discarded',
    ]);
  });
});

describe('TabManager lifecycle: beforeunload and what a discard learns', () => {
  it('asks an activated page with beforeunload; an objection keeps the tab and teaches a protection', async () => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);
    const activated = reading({ hasBeenActive: true });

    // 1. The page objects.
    const first = env.discard(id);
    await flush();
    runtime.answerProbe(activated);
    await flush();
    expect(lifecycle(runtime)).toEqual(['probe', 'snapshot', 'closeForDiscard:beforeunload']);
    runtime.prevent();
    await flush();
    expect(first.value).toEqual(blockedBy('page-unsaved-changes'));
    expect(env.manager.get(id).runtime).toBe('live');
    expect(runtime.alive).toBe(true);
    expect(runtime.shown).toBe(false);
    expect(env.manager.lifecycleFacts(id)).toMatchObject({
      learned: ['page-unsaved-changes'],
      pageStateInMemory: false,
      running: 0,
    });
    expect(env.stepsOf(id).slice(-2)).toEqual([
      'live>discarding:discard',
      'discarding>live:discardBlocked',
    ]);
  });

  it('blocks automation from the learned protection without probing, but a user request asks again', async () => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);
    const activated = reading({ hasBeenActive: true });
    const learn = env.discard(id);
    await flush();
    runtime.answerProbe(activated);
    await flush();
    runtime.prevent();
    await flush();
    expect(learn.value).toEqual(blockedBy('page-unsaved-changes'));
    const epoch = env.manager.lifecycleFacts(id).epoch;

    // Automation and pressure are blocked from the cache: no probe, no transition.
    for (const origin of ['automation', 'pressure'] as const) {
      const cached = env.discard(id, { origin });
      await flush();
      expect(cached.value).toEqual(blockedBy('page-unsaved-changes'));
    }
    expect(runtime.probes).toHaveLength(1);
    expect(runtime.pings).toHaveLength(1);
    expect(env.manager.lifecycleFacts(id).epoch).toBe(epoch);

    // The user asks the page again.
    const user = env.discard(id, USER);
    await flush();
    expect(runtime.probes).toHaveLength(2);
    runtime.answerProbe(activated);
    await flush();
    expect(runtime.closes).toHaveLength(2);
    runtime.prevent();
    await flush();
    expect(user.value).toEqual(blockedBy('page-unsaved-changes'));
    expect(env.manager.get(id).runtime).toBe('live');
  });

  it('lets automation probe again once LEARNED_RECHECK_MS has passed', async () => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);
    const activated = reading({ hasBeenActive: true });
    const learn = env.discard(id);
    await flush();
    runtime.answerProbe(activated);
    await flush();
    runtime.prevent();
    await flush();
    expect(learn.value).toEqual(blockedBy('page-unsaved-changes'));

    // One millisecond short: still fresh, still blocked without a probe.
    env.clock.now += LEARNED_RECHECK_MS - 1;
    expect(env.manager.lifecycleFacts(id).learned).toEqual(['page-unsaved-changes']);
    const cached = env.discard(id);
    await flush();
    expect(cached.value).toEqual(blockedBy('page-unsaved-changes'));
    expect(runtime.probes).toHaveLength(1);

    // Then it expires, and automation asks the page again.
    env.clock.now += 1;
    expect(env.manager.lifecycleFacts(id).learned).toEqual([]);
    const again = env.discard(id);
    await flush();
    expect(runtime.probes).toHaveLength(2);
    runtime.answerProbe(activated);
    await flush();
    runtime.prevent();
    await flush();
    expect(again.value).toEqual(blockedBy('page-unsaved-changes'));
    expect(env.manager.lifecycleFacts(id).learned).toEqual(['page-unsaved-changes']);
  });

  it('forgets what it learned when a new document commits, but not for a same-document commit', async () => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);
    const learn = env.discard(id);
    await flush();
    runtime.answerProbe(reading({ hasBeenActive: true }));
    await flush();
    runtime.prevent();
    await flush();
    expect(learn.value).toEqual(blockedBy('page-unsaved-changes'));

    // A fragment change or history.pushState is the same document, with the same unsaved changes.
    commit(runtime, `${A}#section`, { sameDocument: true });
    expect(env.manager.lifecycleFacts(id).learned).toEqual(['page-unsaved-changes']);

    commit(runtime, B);
    expect(env.manager.lifecycleFacts(id).learned).toEqual([]);
    // Automation is no longer blocked from the cache: the page is probed.
    const probesBefore = runtime.probes.length;
    const again = env.discard(id);
    await flush();
    expect(runtime.probes).toHaveLength(probesBefore + 1);
    runtime.answerProbe(null);
    await flush();
    expect(again.value).toEqual(blockedBy('probe-unanswered'));
  });
});

describe('TabManager lifecycle: a close that never settles', () => {
  it("is blocked after CLOSE_TIMEOUT_MS, and a late close unloads the tab with the attempt's snapshot", async () => {
    const env = setup();
    const id = env.webTab(A, { title: 'Alpha' });
    const runtime = env.runtimeOf(id);
    const discard = env.discard(id);
    await flush();
    runtime.answerProbe(reading({ hasBeenActive: true }));
    await flush();
    expect(runtime.closes.map((close) => close.mode)).toEqual(['beforeunload']);
    // The probe's deadline was cleared by its answer; the close's is the one pending.
    expect(env.timers.pending).toEqual([CLOSE_TIMEOUT_MS]);
    expect(discard.settled).toBe(false);

    env.timers.fire(CLOSE_TIMEOUT_MS);
    await flush();
    expect(discard.value).toEqual(blockedBy('page-unsaved-changes'));
    expect(env.manager.get(id).runtime).toBe('live');
    expect(runtime.alive).toBe(true);
    expect(env.manager.lifecycleFacts(id)).toMatchObject({
      learned: ['page-unsaved-changes'],
      running: 0,
    });

    // The page closes late, on its own.
    runtime.contentsDestroyed();
    await flush();
    expect(env.manager.get(id)).toMatchObject({
      runtime: 'unloaded',
      page: { kind: 'web' },
      url: A,
      loading: false,
    });
    expect(env.manager.lifecycleFacts(id).pageStateInMemory).toBe(true);
    expect(env.sessionTab(id)?.history).toStrictEqual({
      index: 0,
      entries: [{ url: A, title: 'Alpha' }],
    });
    expect(env.stepsOf(id).slice(-3)).toEqual([
      'live>discarding:discard',
      'discarding>live:discardBlocked',
      'live>unloaded:gone',
    ]);

    // Selecting it restores the page with the page state of the attempt's snapshot.
    env.manager.select(id);
    const restored = env.runtimeOf(id);
    expect(restored).not.toBe(runtime);
    expect(restored.restores).toHaveLength(1);
    expect(pick(restored.restores, 0, 'restore')).toMatchObject({ shownFirst: true });
    expect(pick(restored.restores, 0, 'restore').history).toStrictEqual({
      index: 0,
      entries: [{ url: A, title: 'Alpha', pageState: `ps:${A}` }],
    });
  });
});

describe('TabManager lifecycle: a probe that gives no answer', () => {
  it('keeps the tab after PROBE_TIMEOUT_MS, learns nothing, and ignores the late answer', async () => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);
    const discard = env.discard(id);
    await flush();
    expect(env.timers.pending).toEqual([PROBE_TIMEOUT_MS]);
    expect(env.manager.get(id).runtime).toBe('discarding');

    env.timers.fire(PROBE_TIMEOUT_MS);
    await flush();
    expect(discard.value).toEqual(blockedBy('probe-unanswered'));
    expect(env.manager.get(id).runtime).toBe('live');
    expect(env.manager.lifecycleFacts(id).learned).toEqual([]);
    expect(lifecycle(runtime)).toEqual(['probe']);
    const steps = env.stepsOf(id);

    // The busy page answers at last (S3: 680 ms): it changes nothing.
    runtime.answerProbe(reading());
    await flush();
    expect(env.manager.get(id).runtime).toBe('live');
    expect(lifecycle(runtime)).toEqual(['probe']);
    expect(env.stepsOf(id)).toEqual(steps);
  });

  it('keeps the tab when the probe rejects', async () => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);
    const discard = env.discard(id);
    await flush();
    runtime.failProbe();
    await flush();
    expect(discard.value).toEqual(blockedBy('probe-unanswered'));
    expect(env.manager.get(id).runtime).toBe('live');
    expect(env.manager.lifecycleFacts(id).learned).toEqual([]);
    expect(lifecycle(runtime)).toEqual(['probe']);
    expect(env.timers.pending).toEqual([]);
  });

  it('keeps the tab when the probe throws synchronously', async () => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);
    runtime.probeThrows = true;
    const discard = env.discard(id);
    await flush();
    expect(discard.value).toEqual(blockedBy('probe-unanswered'));
    expect(env.manager.get(id).runtime).toBe('live');
    expect(env.manager.lifecycleFacts(id).learned).toEqual([]);
    expect(lifecycle(runtime)).toEqual(['probe']);
    expect(env.timers.pending).toEqual([]);
  });

  it.each([
    ['null', null],
    ['a string', 'clean'],
    ['an array', []],
    ['an empty object', {}],
    ['a negative count', { ...reading(), changedFields: -1 }],
    ['a fractional count', { ...reading(), editedFields: 0.5 }],
    ['a count that is a string', { ...reading(), changedFields: '0' }],
    ['a flag that is a number', { ...reading(), sensitive: 0 }],
    ['a missing flag', { changedFields: 0, editedFields: 0, focusedEditable: false }],
  ])('keeps the tab when the probe answers %s', async (_name, answer) => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);
    const discard = env.discard(id);
    await flush();
    runtime.answerProbe(answer);
    await flush();
    expect(discard.value).toEqual(blockedBy('probe-unanswered'));
    expect(env.manager.get(id).runtime).toBe('live');
    expect(env.manager.lifecycleFacts(id).learned).toEqual([]);
    expect(lifecycle(runtime)).toEqual(['probe']);
  });
});

describe('TabManager lifecycle: waking the renderer before the probe', () => {
  /** A background tab whose discard is waiting for the renderer's answer to the ping. */
  async function pinging() {
    const env = setup();
    const id = env.webTab(A, { title: 'Alpha' });
    const runtime = env.runtimeOf(id);
    runtime.pingAnswersAtOnce = false;
    const discard = env.discard(id);
    await flush();
    expect(env.manager.get(id).runtime).toBe('discarding');
    expect(wakeAndProbe(runtime)).toEqual(['ping']);
    expect(env.timers.pending).toEqual([PING_TIMEOUT_MS]);
    return { env, id, runtime, discard };
  }

  it('gives the probe its own full budget, however long the wake-up took', async () => {
    // The point of the ping: a just-hidden renderer may take seconds to run its first script.
    expect(PING_TIMEOUT_MS).toBeGreaterThan(PROBE_TIMEOUT_MS);
    const { env, id, runtime, discard } = await pinging();

    // The renderer wakes up late. What the no-op returns is not inspected.
    runtime.answerPing({ anything: 'at all' });
    await flush();
    expect(wakeAndProbe(runtime)).toEqual(['ping', 'probe']);
    // The wake-up's deadline is gone, and the probe has a fresh one.
    expect(env.timers.pending).toEqual([PROBE_TIMEOUT_MS]);

    runtime.answerProbe(reading());
    await flush();
    runtime.contentsDestroyed();
    await flush();
    expect(discard.value).toEqual(DISCARDED);
    expect(env.manager.get(id).runtime).toBe('unloaded');
  });

  it('keeps the tab, without probing, when the ping gets no answer within PING_TIMEOUT_MS', async () => {
    const { env, id, runtime, discard } = await pinging();

    env.timers.fire(PING_TIMEOUT_MS);
    await flush();
    expect(discard.value).toEqual(blockedBy('probe-unanswered'));
    expect(env.manager.get(id).runtime).toBe('live');
    expect(env.manager.lifecycleFacts(id)).toMatchObject({ learned: [], running: 0, queued: 0 });
    expect(wakeAndProbe(runtime)).toEqual(['ping']);
    expect(lifecycle(runtime)).toEqual([]);
    expect(env.timers.pending).toEqual([]);
    expect(env.stepsOf(id).slice(-2)).toEqual([
      'live>discarding:discard',
      'discarding>live:discardBlocked',
    ]);

    // The renderer wakes up after all: nothing follows.
    runtime.answerPing();
    await flush();
    expect(wakeAndProbe(runtime)).toEqual(['ping']);
    expect(env.manager.get(id).runtime).toBe('live');
    expect(env.timers.pending).toEqual([]);
  });

  it('keeps the tab, without probing, when the ping rejects', async () => {
    const { env, id, runtime, discard } = await pinging();

    runtime.failPing();
    await flush();
    expect(discard.value).toEqual(blockedBy('probe-unanswered'));
    expect(env.manager.get(id).runtime).toBe('live');
    expect(env.manager.lifecycleFacts(id).learned).toEqual([]);
    expect(wakeAndProbe(runtime)).toEqual(['ping']);
    expect(lifecycle(runtime)).toEqual([]);
    expect(env.timers.pending).toEqual([]);
  });

  it('keeps the tab, without probing, when the ping throws synchronously', async () => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);
    runtime.pingThrows = true;
    const discard = env.discard(id);
    await flush();
    expect(discard.value).toEqual(blockedBy('probe-unanswered'));
    expect(env.manager.get(id).runtime).toBe('live');
    expect(env.manager.lifecycleFacts(id).learned).toEqual([]);
    expect(wakeAndProbe(runtime)).toEqual(['ping']);
    expect(lifecycle(runtime)).toEqual([]);
    expect(env.timers.pending).toEqual([]);
  });

  it('can be asked again: a later discard wakes the renderer and probes', async () => {
    const { env, id, runtime, discard } = await pinging();
    runtime.failPing();
    await flush();
    expect(discard.value).toEqual(blockedBy('probe-unanswered'));

    runtime.pingAnswersAtOnce = true;
    const again = env.discard(id);
    await flush();
    expect(wakeAndProbe(runtime)).toEqual(['ping', 'ping', 'probe']);
    runtime.answerProbe(reading());
    await flush();
    runtime.contentsDestroyed();
    await flush();
    expect(again.value).toEqual(DISCARDED);
  });

  it('stops when the tab is selected while the ping is out: cancelled, live and shown, and no probe follows', async () => {
    const { env, id, runtime, discard } = await pinging();

    env.manager.select(id);
    expect(env.manager.get(id).runtime).toBe('live');
    expect(runtime.shown).toBe(true);
    // The operation waits for the ping's answer or deadline.
    expect(discard.settled).toBe(false);

    runtime.answerPing();
    await flush();
    expect(discard.value).toEqual(skippedAs('cancelled'));
    expect(env.manager.get(id).runtime).toBe('live');
    expect(runtime.shown).toBe(true);
    expect(wakeAndProbe(runtime)).toEqual(['ping']);
    expect(lifecycle(runtime)).toEqual([]);
    expect(env.timers.pending).toEqual([]);
    expect(env.manager.lifecycleFacts(id)).toMatchObject({ learned: [], running: 0, queued: 0 });
    expect(env.stepsOf(id).slice(-2)).toEqual([
      'live>discarding:discard',
      'discarding>live:discardBlocked',
    ]);
  });

  it('settles as cancelled at the ping deadline when the tab was selected and the renderer never wakes', async () => {
    const { env, id, runtime, discard } = await pinging();
    env.manager.select(id);
    env.timers.fire(PING_TIMEOUT_MS);
    await flush();
    expect(discard.value).toEqual(skippedAs('cancelled'));
    expect(env.manager.get(id).runtime).toBe('live');
    expect(wakeAndProbe(runtime)).toEqual(['ping']);
  });

  it('is ended by closing the tab while the ping is out: the runtime goes at once and nothing follows', async () => {
    const { env, id, runtime, discard } = await pinging();

    env.manager.close(id);
    expect(env.manager.has(id)).toBe(false);
    expect(runtime.alive).toBe(false);
    runtime.answerPing();
    await flush();
    expect(discard.value).toEqual(skippedAs('closed'));
    expect(wakeAndProbe(runtime)).toEqual(['ping']);
    expect(lifecycle(runtime)).toEqual(['destroy']);
    expect(env.runtimes.filter((candidate) => candidate.alive)).toEqual([]);
  });

  it('counts a renderer that dies while the ping is out as discarded, with the entries Chromium still has', async () => {
    const { env, id, runtime, discard } = await pinging();

    runtime.events.crashed({ code: 9, name: 'crashed' });
    expect(env.manager.get(id)).toMatchObject({ runtime: 'unloaded', page: { kind: 'web' } });
    expect(env.sessionTab(id)?.history).toStrictEqual({
      index: 0,
      entries: [{ url: A, title: 'Alpha' }],
    });
    expect(env.manager.lifecycleFacts(id).pageStateInMemory).toBe(true);

    // The ping's script dies with the renderer.
    runtime.failPing();
    await flush();
    expect(discard.value).toEqual(DISCARDED);
    expect(wakeAndProbe(runtime)).toEqual(['ping']);
    expect(env.timers.pending).toEqual([]);
  });

  it('counts a web contents that is gone while the ping is out as discarded, with the last reported stack', async () => {
    const { env, id, runtime, discard } = await pinging();

    runtime.contentsDestroyed();
    expect(env.manager.get(id).runtime).toBe('unloaded');
    expect(env.sessionTab(id)?.history).toStrictEqual({
      index: 0,
      entries: [{ url: A, title: 'Alpha' }],
    });
    expect(env.manager.lifecycleFacts(id).pageStateInMemory).toBe(false);

    runtime.failPing();
    await flush();
    expect(discard.value).toEqual(DISCARDED);
    expect(wakeAndProbe(runtime)).toEqual(['ping']);
  });
});

describe('TabManager lifecycle: what the probe reads', () => {
  const blockedCases: readonly {
    readonly name: string;
    readonly reading: Partial<ProbeReading>;
    readonly request?: DiscardRequest;
    readonly reason: ProtectionReason;
  }[] = [
    {
      name: 'changed fields on a page the user activated are unsaved input',
      reading: { changedFields: 2, hasBeenActive: true },
      reason: 'unsaved-input',
    },
    {
      name: 'unsaved input is hard: critical memory pressure does not override it',
      reading: { changedFields: 2, hasBeenActive: true },
      request: { origin: 'pressure', overrideSoft: true },
      reason: 'unsaved-input',
    },
    {
      name: 'fields the tracker saw typed into are unsaved input, even on a page never activated',
      reading: { editedFields: 1 },
      reason: 'unsaved-input',
    },
    {
      name: 'edited fields on an activated page are unsaved input',
      reading: { editedFields: 3, hasBeenActive: true },
      reason: 'unsaved-input',
    },
    {
      name: 'a focused contenteditable means editing',
      reading: { focusedEditable: true },
      reason: 'editing',
    },
    {
      name: 'password or payment fields mean a sensitive page',
      reading: { sensitive: true },
      reason: 'sensitive-page',
    },
    {
      name: 'editing is reported before a sensitive page',
      reading: { focusedEditable: true, sensitive: true },
      reason: 'editing',
    },
  ];

  it.each(blockedCases)('$name', async ({ reading: partial, request = AUTOMATION, reason }) => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);
    const discard = env.discard(id, request);
    await flush();
    runtime.answerProbe(reading(partial));
    await flush();
    expect(discard.value).toEqual(blockedBy(reason));
    expect(env.manager.get(id).runtime).toBe('live');
    // Nothing was snapshotted or closed.
    expect(lifecycle(runtime)).toEqual(['probe']);
    expect(env.manager.lifecycleFacts(id).learned).toEqual([reason]);

    // What was learned blocks the next automation request without asking the page again.
    const repeat = env.discard(id);
    await flush();
    expect(repeat.value).toEqual(blockedBy(reason));
    expect(runtime.probes).toHaveLength(1);
    expect(runtime.pings).toHaveLength(1);
  });

  const discardedCases: readonly {
    readonly name: string;
    readonly reading: Partial<ProbeReading>;
    readonly request?: DiscardRequest;
    readonly mode: CloseMode;
  }[] = [
    {
      // judgeProbe: on a page nobody touched, values come from the page's own script (a prefilled
      // search box) or from a restore of its page state, which the next snapshot keeps again.
      name: 'changed fields without activation come from the page itself: discarded, closed plainly',
      reading: { changedFields: 2 },
      mode: 'plain',
    },
    {
      name: 'a focused contenteditable is soft: critical pressure discards anyway',
      reading: { focusedEditable: true },
      request: { origin: 'pressure', overrideSoft: true },
      mode: 'plain',
    },
    {
      name: 'a sensitive page is soft: critical pressure discards anyway',
      reading: { sensitive: true },
      request: { origin: 'pressure', overrideSoft: true },
      mode: 'plain',
    },
    {
      name: 'an activated page still gets beforeunload when a soft protection is overridden',
      reading: { focusedEditable: true, sensitive: true, hasBeenActive: true },
      request: { origin: 'pressure', overrideSoft: true },
      mode: 'beforeunload',
    },
  ];

  it.each(discardedCases)('$name', async ({ reading: partial, request = AUTOMATION, mode }) => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);
    const discard = env.discard(id, request);
    await flush();
    runtime.answerProbe(reading(partial));
    await flush();
    expect(runtime.closes.map((close) => close.mode)).toEqual([mode]);
    runtime.contentsDestroyed();
    await flush();
    expect(discard.value).toEqual(DISCARDED);
    expect(env.manager.get(id).runtime).toBe('unloaded');
    expect(env.manager.lifecycleFacts(id).learned).toEqual([]);
  });

  it('a soft protection that was learned does not hold under critical memory pressure', async () => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);
    const editing = env.discard(id);
    await flush();
    runtime.answerProbe(reading({ focusedEditable: true }));
    await flush();
    expect(editing.value).toEqual(blockedBy('editing'));

    const pressure = env.discard(id, { origin: 'pressure', overrideSoft: true });
    await flush();
    // Not blocked from the cache: the page is probed again.
    expect(runtime.probes).toHaveLength(2);
    runtime.answerProbe(reading({ focusedEditable: true }));
    await flush();
    expect(runtime.closes.map((close) => close.mode)).toEqual(['plain']);
    runtime.contentsDestroyed();
    await flush();
    expect(pressure.value).toEqual(DISCARDED);
  });
});

describe('TabManager lifecycle: refusals before anything happens', () => {
  /** Nothing was asked of the page, and the runtime did not move. */
  function expectUntouched(env: Base, id: TabId, steps: readonly string[]): void {
    for (const runtime of env.runtimesOf(id)) {
      // Not even woken: the renderer is not asked anything for a discard that is refused.
      expect(runtime.calls).not.toContain('ping');
      expect(lifecycle(runtime)).not.toContain('probe');
      expect(lifecycle(runtime)).not.toContain('snapshot');
    }
    expect(env.stepsOf(id)).toEqual(steps);
  }

  it('skips the selected tab', async () => {
    const env = setup();
    const id = env.webTab(A, { select: true });
    const steps = env.stepsOf(id);
    const discard = env.discard(id, USER);
    await flush();
    expect(discard.value).toEqual(skippedAs('selected'));
    expectUntouched(env, id, steps);
    expect(env.manager.get(id).runtime).toBe('live');
  });

  it('skips a loading tab', async () => {
    const env = setup();
    const id = env.webTab(A);
    env.runtimeOf(id).events.loadingChanged(true);
    const steps = env.stepsOf(id);
    const discard = env.discard(id);
    await flush();
    expect(discard.value).toEqual(skippedAs('loading'));
    expectUntouched(env, id, steps);
  });

  it('skips an unloaded tab', async () => {
    const env = setup();
    const id = env.webTab(A);
    await discardCompletely(env, id);
    const steps = env.stepsOf(id);
    const runtimes = env.runtimes.length;
    const discard = env.discard(id);
    await flush();
    expect(discard.value).toEqual(skippedAs('not-live'));
    expect(env.stepsOf(id)).toEqual(steps);
    expect(env.runtimes).toHaveLength(runtimes);
  });

  it('skips a tab that is still creating its page', async () => {
    const env = setup();
    const id = env.manager.create({ select: false });
    env.manager.navigate(id, A);
    expect(env.manager.get(id).runtime).toBe('creating');
    const steps = env.stepsOf(id);
    const discard = env.discard(id);
    await flush();
    expect(discard.value).toEqual(skippedAs('not-live'));
    expectUntouched(env, id, steps);
  });

  it('skips a crashed tab', async () => {
    const env = setup();
    const id = env.webTab(A);
    env.runtimeOf(id).events.crashed({ code: 9, name: 'crashed' });
    expect(env.manager.get(id).runtime).toBe('crashed');
    const steps = env.stepsOf(id);
    const discard = env.discard(id);
    await flush();
    expect(discard.value).toEqual(skippedAs('not-live'));
    expectUntouched(env, id, steps);
  });

  it('skips a tab on an error page', async () => {
    const env = setup();
    const id = env.webTab(A);
    env.runtimeOf(id).events.loadFailed({ code: -105, name: 'ERR_NAME_NOT_RESOLVED', url: A });
    expect(env.manager.get(id)).toMatchObject({ runtime: 'live', page: { kind: 'internal' } });
    const steps = env.stepsOf(id);
    const discard = env.discard(id);
    await flush();
    expect(discard.value).toEqual(skippedAs('not-web'));
    expectUntouched(env, id, steps);
  });

  it('skips a decision made before the runtime last changed (stale epoch), and honours a fresh one', async () => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);
    const decidedAt = env.manager.lifecycleFacts(id).epoch;
    // The runtime changes after the decision: the tab freezes.
    const freezing = env.freeze(id);
    await flush();
    runtime.finishFreeze();
    await flush();
    expect(freezing.value).toEqual({ outcome: 'frozen' });
    expect(env.manager.lifecycleFacts(id).epoch).toBeGreaterThan(decidedAt);

    const stale = env.discard(id, { origin: 'automation', epoch: decidedAt });
    await flush();
    expect(stale.value).toEqual(skippedAs('stale'));
    // Not even thawed: nothing happened.
    expect(lifecycle(runtime)).toEqual(['freeze']);
    expect(env.manager.get(id).runtime).toBe('frozen');

    // The same request with the current epoch goes ahead (thaw, then probe).
    const fresh = env.discard(id, {
      origin: 'automation',
      epoch: env.manager.lifecycleFacts(id).epoch,
    });
    await flush();
    expect(lifecycle(runtime)).toEqual(['freeze', 'thaw', 'probe']);
    runtime.failProbe();
    await flush();
    expect(fresh.value).toEqual(blockedBy('probe-unanswered'));
  });

  it('skips a closed tab, and a tab that never existed', async () => {
    const env = setup();
    const id = env.webTab(A);
    env.manager.close(id);
    const discard = env.discard(id);
    const unknown = env.discard('no-such-tab');
    await flush();
    expect(discard.value).toEqual(skippedAs('closed'));
    expect(unknown.value).toEqual(skippedAs('closed'));
    expect(env.runtimes.every((runtime) => !runtime.alive)).toBe(true);
  });

  it('blocks on a hard protection from outside, whoever asks and whatever the pressure', async () => {
    const env = setup();
    const id = env.webTab(A);
    env.protections.set(id, [protectionFor('unsaved-input')]);
    const steps = env.stepsOf(id);
    for (const request of [
      AUTOMATION,
      USER,
      { origin: 'pressure', overrideSoft: true } satisfies DiscardRequest,
    ]) {
      const discard = env.discard(id, request);
      await flush();
      expect(discard.value).toEqual(blockedBy('unsaved-input'));
    }
    expectUntouched(env, id, steps);
  });

  it('blocks on a soft protection from outside unless critical pressure overrides it', async () => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);
    env.protections.set(id, [protectionFor('editing')]);
    const blocked = env.discard(id, USER);
    await flush();
    expect(blocked.value).toEqual(blockedBy('editing'));
    expect(runtime.probes).toHaveLength(0);

    const overridden = env.discard(id, { origin: 'pressure', overrideSoft: true });
    await flush();
    // Past the protection: the page is probed.
    expect(runtime.probes).toHaveLength(1);
    runtime.answerProbe(reading());
    await flush();
    runtime.contentsDestroyed();
    await flush();
    expect(overridden.value).toEqual(DISCARDED);
  });
});

describe('TabManager lifecycle: selecting the tab while its discard probes', () => {
  it('stops the discard: the tab is live and shown at once, nothing is closed, and the late answer changes nothing', async () => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);
    const discard = env.discard(id);
    await flush();
    expect(env.manager.get(id).runtime).toBe('discarding');

    env.manager.select(id);
    expect(env.manager.selectedTabId()).toBe(id);
    expect(env.manager.get(id).runtime).toBe('live');
    expect(runtime.shown).toBe(true);
    // The operation itself still waits for the probe's answer or deadline.
    expect(discard.settled).toBe(false);
    expect(env.manager.lifecycleFacts(id).running).toBe(1);

    // The page answers late, with something that would have kept the tab: it changes nothing.
    runtime.answerProbe(reading({ changedFields: 3, hasBeenActive: true }));
    await flush();
    expect(discard.value).toEqual(skippedAs('cancelled'));
    expect(env.manager.get(id).runtime).toBe('live');
    expect(runtime.shown).toBe(true);
    expect(lifecycle(runtime)).toEqual(['probe']);
    expect(env.manager.lifecycleFacts(id)).toMatchObject({ learned: [], running: 0, queued: 0 });
    expect(env.stepsOf(id).slice(-2)).toEqual([
      'live>discarding:discard',
      'discarding>live:discardBlocked',
    ]);
  });

  it('settles as cancelled at the probe deadline when the page never answers', async () => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);
    const discard = env.discard(id);
    await flush();
    env.manager.select(id);
    env.timers.fire(PROBE_TIMEOUT_MS);
    await flush();
    expect(discard.value).toEqual(skippedAs('cancelled'));
    expect(env.manager.get(id).runtime).toBe('live');
    expect(runtime.shown).toBe(true);
    expect(lifecycle(runtime)).toEqual(['probe']);
  });
});

describe('TabManager lifecycle: selecting the tab while its page closes', () => {
  it('makes it creating at once (I2), then restores it into a new runtime, attached first, with the page state', async () => {
    const env = setup();
    const { id, runtime, discard } = await closingTab(env, { title: 'Alpha' });

    env.manager.select(id);
    expect(env.manager.get(id)).toMatchObject({ runtime: 'creating', loading: true });
    expect(env.manager.selectedTabId()).toBe(id);
    expect(env.stepsOf(id).at(-1)).toBe('discarding>creating:revive');
    // The closing page is not shown, and the new web contents waits for the old one to go.
    expect(runtime.shown).toBe(false);
    expect(env.runtimesOf(id)).toHaveLength(1);
    expect(discard.settled).toBe(false);

    runtime.contentsDestroyed();
    await flush();
    expect(discard.value).toEqual(DISCARDED);
    expect(env.runtimesOf(id)).toHaveLength(2);
    const fresh = pick(env.runtimesOf(id), 1, 'runtime');
    expect(runtime.alive).toBe(false);
    expect(runtime.calls).toContain('destroy');
    // S2: attached before restore(), shown because the tab is selected.
    expect(fresh.calls).toContain('show');
    expect(fresh.calls.indexOf('show')).toBeLessThan(fresh.calls.indexOf('restore'));
    expect(fresh.restores).toHaveLength(1);
    expect(pick(fresh.restores, 0, 'restore')).toMatchObject({
      shownFirst: true,
      hiddenFirst: false,
    });
    expect(pick(fresh.restores, 0, 'restore').history).toStrictEqual({
      index: 0,
      entries: [{ url: A, title: 'Alpha', pageState: `ps:${A}` }],
    });
    expect(fresh.shown).toBe(true);
    expect(env.manager.get(id).runtime).toBe('creating');
    expect(env.manager.lifecycleFacts(id).pageStateInMemory).toBe(false);

    finishLoad(fresh, A);
    expect(env.manager.get(id)).toMatchObject({ runtime: 'live', loading: false });
    expect(env.stepsOf(id).slice(-4)).toEqual([
      'live>discarding:discard',
      'discarding>creating:revive',
      'creating>creating:load',
      'creating>live:ready',
    ]);
  });

  it('goes back to live on the old runtime, shown, if the page objects to the close', async () => {
    const env = setup();
    const { id, runtime, discard } = await closingTab(env);
    env.manager.select(id);
    expect(env.manager.get(id).runtime).toBe('creating');
    expect(runtime.shown).toBe(false);

    runtime.prevent();
    await flush();
    expect(discard.value).toEqual(blockedBy('page-unsaved-changes'));
    expect(env.manager.get(id)).toMatchObject({ runtime: 'live', loading: false });
    expect(runtime.alive).toBe(true);
    expect(runtime.shown).toBe(true);
    expect(env.runtimesOf(id)).toHaveLength(1);
    expect(env.stepsOf(id).slice(-2)).toEqual([
      'discarding>creating:revive',
      'creating>live:ready',
    ]);
    expect(env.manager.lifecycleFacts(id).learned).toEqual(['page-unsaved-changes']);
  });

  it('goes back to live too when the close times out, and restores from the attempt if the page closes late', async () => {
    const env = setup();
    const { id, runtime, discard } = await closingTab(env, { title: 'Alpha' });
    env.manager.select(id);
    env.timers.fire(CLOSE_TIMEOUT_MS);
    await flush();
    expect(discard.value).toEqual(blockedBy('page-unsaved-changes'));
    expect(env.manager.get(id).runtime).toBe('live');
    expect(runtime.shown).toBe(true);

    // The page closes after all, while its tab is selected: I2 restores it at once.
    runtime.contentsDestroyed();
    await flush();
    expect(env.manager.get(id).runtime).toBe('creating');
    const fresh = pick(env.runtimesOf(id), 1, 'runtime');
    expect(fresh.shown).toBe(true);
    expect(pick(fresh.restores, 0, 'restore').history).toStrictEqual({
      index: 0,
      entries: [{ url: A, title: 'Alpha', pageState: `ps:${A}` }],
    });
  });
});

describe('TabManager lifecycle: what the user does while the page closes', () => {
  it('defers a reload: the closing runtime is never told, and the unloaded tab is restored afterwards', async () => {
    const env = setup();
    const { id, runtime, discard } = await closingTab(env, { title: 'Alpha' });

    env.manager.reload(id);
    expect(runtime.calls).not.toContain('reload');
    expect(env.manager.get(id).runtime).toBe('discarding');
    expect(env.runtimesOf(id)).toHaveLength(1);

    runtime.contentsDestroyed();
    await flush();
    expect(discard.value).toEqual(DISCARDED);
    expect(runtime.calls).not.toContain('reload');
    // Reload of an unloaded tab restores it (not selected: attached invisibly first).
    expect(env.manager.get(id)).toMatchObject({ runtime: 'creating', loading: true });
    const fresh = pick(env.runtimesOf(id), 1, 'runtime');
    expect(fresh.calls).toContain('showHidden');
    expect(fresh.calls.indexOf('showHidden')).toBeLessThan(fresh.calls.indexOf('restore'));
    expect(pick(fresh.restores, 0, 'restore').history).toStrictEqual({
      index: 0,
      entries: [{ url: A, title: 'Alpha', pageState: `ps:${A}` }],
    });
    expect(env.stepsOf(id).slice(-2)).toEqual([
      'discarding>unloaded:discarded',
      'unloaded>creating:ensureLive',
    ]);
  });

  it('defers a navigation: it creates a runtime and loads once the close has settled', async () => {
    const env = setup();
    const { id, runtime, discard } = await closingTab(env);

    env.manager.navigate(id, C);
    // Only the load that made the page (A) ever reached the closing runtime.
    expect(runtime.loads).toEqual([A]);
    expect(env.manager.get(id).runtime).toBe('discarding');
    expect(env.runtimesOf(id)).toHaveLength(1);

    runtime.contentsDestroyed();
    await flush();
    expect(discard.value).toEqual(DISCARDED);
    expect(runtime.loads).toEqual([A]);
    const fresh = pick(env.runtimesOf(id), 1, 'runtime');
    expect(fresh.loads).toEqual([C]);
    // A navigation, not a restore: the discard's page state is dropped.
    expect(fresh.restores).toEqual([]);
    expect(env.manager.lifecycleFacts(id).pageStateInMemory).toBe(false);
    expect(env.manager.get(id)).toMatchObject({ runtime: 'creating', loading: true });
    expect(env.stepsOf(id).slice(-2)).toEqual([
      'discarding>unloaded:discarded',
      'unloaded>creating:load',
    ]);
  });

  it('defers going back: the closing runtime is never told, and the unloaded tab has nothing to go back to', async () => {
    const env = setup();
    const { id, runtime, discard } = await closingTab(env, {
      stack: [
        { url: C, title: 'C' },
        { url: A, title: 'A' },
      ],
    });
    expect(env.manager.get(id).canGoBack).toBe(true);

    env.manager.goBack(id);
    expect(runtime.calls).not.toContain('goBack');

    runtime.contentsDestroyed();
    await flush();
    expect(discard.value).toEqual(DISCARDED);
    expect(runtime.calls).not.toContain('goBack');
    expect(env.manager.get(id)).toMatchObject({ runtime: 'unloaded', canGoBack: false });
    expect(env.runtimesOf(id)).toHaveLength(1);
  });

  it('defers showing an internal page: the discard finishes first, then the tab shows the new-tab page', async () => {
    const env = setup();
    const { id, runtime, discard } = await closingTab(env);

    env.manager.showInternal(id, 'new-tab');
    expect(env.manager.get(id)).toMatchObject({ runtime: 'discarding', page: { kind: 'web' } });
    expect(runtime.calls).not.toContain('destroy');

    runtime.contentsDestroyed();
    await flush();
    expect(discard.value).toEqual(DISCARDED);
    expect(env.manager.get(id)).toMatchObject({
      runtime: 'unloaded',
      page: { kind: 'internal', name: 'new-tab' },
      url: '',
    });
    expect(env.manager.lifecycleFacts(id).pageStateInMemory).toBe(false);
    expect(env.sessionTab(id)).toMatchObject({ url: SESSION_NEW_TAB_URL, history: null });
    expect(env.runtimesOf(id)).toHaveLength(1);
    expect(runtime.calls.filter((call) => call === 'destroy')).toHaveLength(1);
  });
});

describe('TabManager lifecycle: the user closes the tab mid-discard', () => {
  it('while the probe is out: the runtime is destroyed at once and the late answer is ignored', async () => {
    const env = setup();
    const id = env.webTab(A, { title: 'Alpha' });
    const runtime = env.runtimeOf(id);
    const discard = env.discard(id);
    await flush();
    expect(env.manager.get(id).runtime).toBe('discarding');
    env.pageGone.length = 0;

    expect(() => {
      env.manager.close(id);
    }).not.toThrow();
    expect(env.manager.has(id)).toBe(false);
    expect(runtime.alive).toBe(false);
    expect(runtime.calls).toContain('destroy');
    expect(env.pageGone).toEqual([id]);
    expect(env.manager.closedTabs().map((tab) => tab.id)).toEqual([id]);
    expect(env.manager.closedTabs()[0]?.history).toStrictEqual({
      index: 0,
      entries: [{ url: A, title: 'Alpha' }],
    });

    // The probe answers late, with a clean page: nothing is snapshotted or closed.
    runtime.answerProbe(reading());
    await flush();
    expect(discard.value).toEqual(skippedAs('closed'));
    expect(lifecycle(runtime)).toEqual(['probe', 'destroy']);
    expect(env.runtimes.filter((candidate) => candidate.alive)).toEqual([]);
    expect(env.pageGone).toEqual([id]);
    expect(env.memory.filter((entry) => entry === `closed:${id}`)).toHaveLength(1);
  });

  it('while the page closes: the runtime is destroyed, the pending close settles and nothing else happens', async () => {
    const env = setup();
    const { id, runtime, discard } = await closingTab(env, { title: 'Alpha' });
    env.pageGone.length = 0;

    expect(() => {
      env.manager.close(id);
    }).not.toThrow();
    expect(env.manager.has(id)).toBe(false);
    expect(runtime.alive).toBe(false);
    await flush();
    // The close settled as `closed` (destroy() settles it), but the tab is gone: no completion.
    expect(discard.value).toEqual(skippedAs('closed'));
    expect(env.pageGone).toEqual([id]);
    expect(env.runtimes.filter((candidate) => candidate.alive)).toEqual([]);
    expect(env.runtimes).toHaveLength(1);
    expect(env.manager.closedTabs().map((tab) => tab.id)).toEqual([id]);
    expect(env.memory.filter((entry) => entry === `closed:${id}`)).toHaveLength(1);
  });
});

describe('TabManager lifecycle: the renderer dies mid-discard', () => {
  it('while the probe is out: counts as discarded, with the entries Chromium still has', async () => {
    const env = setup();
    const id = env.webTab(A, { title: 'Alpha' });
    const runtime = env.runtimeOf(id);
    const discard = env.discard(id);
    await flush();
    // The user went on in the page after the last commit; only snapshot() knows.
    runtime.entries = [...runtime.entries, { url: C, title: 'C', pageState: `ps:${C}` }];
    runtime.index = 1;

    runtime.events.crashed({ code: 9, name: 'crashed' });
    expect(env.manager.get(id)).toMatchObject({ runtime: 'unloaded', page: { kind: 'web' } });
    expect(runtime.alive).toBe(false);
    expect(env.sessionTab(id)?.history).toStrictEqual({
      index: 1,
      entries: [
        { url: A, title: 'Alpha' },
        { url: C, title: 'C' },
      ],
    });
    expect(env.manager.lifecycleFacts(id).pageStateInMemory).toBe(true);

    // The probe's script dies with the renderer.
    runtime.failProbe();
    await flush();
    expect(discard.value).toEqual(DISCARDED);
    expect(env.stepsOf(id).slice(-2)).toEqual([
      'live>discarding:discard',
      'discarding>unloaded:discarded',
    ]);
  });

  it('while the probe is out and nothing can be read: the last reported stack is kept', async () => {
    const env = setup();
    const id = env.webTab(A, {
      stack: [
        { url: B, title: 'B' },
        { url: A, title: 'A' },
      ],
    });
    const runtime = env.runtimeOf(id);
    const discard = env.discard(id);
    await flush();
    runtime.snapshotUnreadable = true;

    runtime.events.crashed({ code: 9, name: 'crashed' });
    expect(env.manager.get(id).runtime).toBe('unloaded');
    expect(env.sessionTab(id)?.history).toStrictEqual({
      index: 1,
      entries: [
        { url: B, title: 'B' },
        { url: A, title: 'A' },
      ],
    });
    expect(env.manager.lifecycleFacts(id).pageStateInMemory).toBe(false);

    env.timers.fire(PROBE_TIMEOUT_MS);
    await flush();
    expect(discard.value).toEqual(DISCARDED);
  });

  it('while the page closes: counts as discarded with the entries from the crash, and the pending close is dropped', async () => {
    const env = setup();
    const { id, runtime, discard } = await closingTab(env, { title: 'Alpha' });
    env.pageGone.length = 0;

    runtime.events.crashed({ code: 9, name: 'crashed' });
    await flush();
    expect(discard.value).toEqual(DISCARDED);
    expect(env.manager.get(id)).toMatchObject({ runtime: 'unloaded', page: { kind: 'web' } });
    expect(runtime.alive).toBe(false);
    expect(runtime.calls.filter((call) => call === 'destroy')).toHaveLength(1);
    expect(env.sessionTab(id)?.history).toStrictEqual({
      index: 0,
      entries: [{ url: A, title: 'Alpha' }],
    });
    expect(env.pageGone).toEqual([id]);
    expect(env.runtimes).toHaveLength(1);
    expect(env.manager.lifecycleFacts(id)).toMatchObject({ running: 0, queued: 0 });
  });

  it('while the page closes and the tab was selected: the discard ends, and the tab restores at once', async () => {
    const env = setup();
    const { id, runtime, discard } = await closingTab(env, { title: 'Alpha' });
    env.manager.select(id);

    runtime.events.crashed({ code: 9, name: 'crashed' });
    await flush();
    expect(discard.value).toEqual(DISCARDED);
    // Still creating: a new web contents takes over, with the page state of the snapshot.
    expect(env.manager.get(id).runtime).toBe('creating');
    const fresh = pick(env.runtimesOf(id), 1, 'runtime');
    expect(fresh.shown).toBe(true);
    expect(pick(fresh.restores, 0, 'restore').history).toStrictEqual({
      index: 0,
      entries: [{ url: A, title: 'Alpha', pageState: `ps:${A}` }],
    });
  });

  it('gone while the probe is out: counts as discarded with the last reported stack', async () => {
    const env = setup();
    const id = env.webTab(A, {
      stack: [
        { url: B, title: 'B' },
        { url: A, title: 'A' },
      ],
    });
    const runtime = env.runtimeOf(id);
    const discard = env.discard(id);
    await flush();
    expect(env.manager.get(id).runtime).toBe('discarding');

    runtime.contentsDestroyed();
    expect(env.manager.get(id)).toMatchObject({ runtime: 'unloaded', page: { kind: 'web' } });
    // No snapshot is taken from a web contents that is gone: the last reported stack stands.
    expect(env.sessionTab(id)?.history).toStrictEqual({
      index: 1,
      entries: [
        { url: B, title: 'B' },
        { url: A, title: 'A' },
      ],
    });
    expect(env.manager.lifecycleFacts(id).pageStateInMemory).toBe(false);

    runtime.failProbe();
    await flush();
    expect(discard.value).toEqual(DISCARDED);
    expect(lifecycle(runtime)).toEqual(['probe', 'destroy']);
    expect(env.stepsOf(id).slice(-2)).toEqual([
      'live>discarding:discard',
      'discarding>unloaded:discarded',
    ]);
  });
});

describe('TabManager lifecycle: queued discards', () => {
  it('runs a second discard after the first and re-validates it; never more than one runs (I7)', async () => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);
    let mostRunning = 0;
    const sample = (): void => {
      mostRunning = Math.max(mostRunning, env.manager.lifecycleFacts(id).running);
    };

    const first = env.discard(id);
    const second = env.discard(id, { origin: 'pressure' });
    sample();
    expect(env.manager.lifecycleFacts(id)).toMatchObject({ running: 0, queued: 2 });
    await flush();
    sample();
    // The first is probing; the second waits its turn.
    expect(env.manager.lifecycleFacts(id)).toMatchObject({ running: 1, queued: 2 });
    expect(runtime.probes).toHaveLength(1);
    expect(second.settled).toBe(false);

    runtime.answerProbe(reading());
    await flush();
    sample();
    // The first is closing; the second still waits.
    expect(env.manager.lifecycleFacts(id)).toMatchObject({ running: 1, queued: 2 });
    expect(first.settled).toBe(false);
    expect(second.settled).toBe(false);

    runtime.contentsDestroyed();
    await flush();
    sample();
    expect(first.value).toEqual(DISCARDED);
    // The second re-validated when its turn came: the tab is unloaded now.
    expect(second.value).toEqual(skippedAs('not-live'));
    expect(runtime.probes).toHaveLength(1);
    expect(env.runtimes).toHaveLength(1);
    expect(env.manager.lifecycleFacts(id)).toMatchObject({ running: 0, queued: 0 });
    expect(mostRunning).toBe(1);
  });

  it('runs a freeze queued behind a discard only after it, and skips it once the tab is unloaded', async () => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);
    const discard = env.discard(id);
    const freeze = env.freeze(id);
    await flush();
    runtime.answerProbe(reading());
    await flush();
    expect(freeze.settled).toBe(false);
    runtime.contentsDestroyed();
    await flush();
    expect(discard.value).toEqual(DISCARDED);
    expect(freeze.value).toEqual({ outcome: 'skipped', why: 'not-live' });
    expect(lifecycle(runtime)).not.toContain('freeze');
  });
});

describe('TabManager lifecycle: frozen tabs', () => {
  it('freezes a background tab when the command succeeds', async () => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);
    const freezing = env.freeze(id);
    await flush();
    expect(env.manager.get(id).runtime).toBe('frozen');
    expect(runtime.freezes).toHaveLength(1);
    expect(freezing.settled).toBe(false);

    runtime.finishFreeze();
    await flush();
    expect(freezing.value).toEqual({ outcome: 'frozen' });
    expect(env.manager.get(id).runtime).toBe('frozen');
    expect(lifecycle(runtime)).toEqual(['freeze']);
    expect(env.stepsOf(id).slice(-1)).toEqual(['live>frozen:freeze']);
  });

  it('thaws a frozen tab when it is selected', async () => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);
    const freezing = env.freeze(id);
    await flush();
    runtime.finishFreeze();
    await flush();
    expect(freezing.value).toEqual({ outcome: 'frozen' });

    env.manager.select(id);
    expect(lifecycle(runtime)).toEqual(['freeze', 'thaw']);
    expect(runtime.frozen).toBe(false);
    expect(env.manager.get(id).runtime).toBe('live');
    expect(runtime.shown).toBe(true);
    expect(env.stepsOf(id).slice(-2)).toEqual(['live>frozen:freeze', 'frozen>live:thaw']);
  });

  it('thaws a frozen tab before the discard probes it', async () => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);
    const freezing = env.freeze(id);
    await flush();
    runtime.finishFreeze();
    await flush();
    expect(freezing.value).toEqual({ outcome: 'frozen' });

    const discard = env.discard(id);
    await flush();
    // Unload handlers need a running page: thaw() comes first, then the wake-up, then the probe.
    expect(lifecycle(runtime)).toEqual(['freeze', 'thaw', 'probe']);
    expect(runtime.calls.filter((call) => ['thaw', 'ping', 'probe'].includes(call))).toEqual([
      'thaw',
      'ping',
      'probe',
    ]);
    expect(env.manager.get(id).runtime).toBe('discarding');
    expect(env.stepsOf(id).slice(-1)).toEqual(['frozen>discarding:discard']);

    runtime.answerProbe(reading());
    await flush();
    runtime.contentsDestroyed();
    await flush();
    expect(discard.value).toEqual(DISCARDED);
    expect(env.manager.get(id).runtime).toBe('unloaded');
  });

  it('thaws the tab and reports `failed` when the freeze command rejects', async () => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);
    const freezing = env.freeze(id);
    await flush();
    expect(env.manager.get(id).runtime).toBe('frozen');

    runtime.failFreeze();
    await flush();
    expect(freezing.value).toEqual({ outcome: 'failed' });
    expect(env.manager.get(id).runtime).toBe('live');
    expect(lifecycle(runtime)).toEqual(['freeze', 'thaw']);
    expect(runtime.frozen).toBe(false);
    expect(env.stepsOf(id).slice(-2)).toEqual(['live>frozen:freeze', 'frozen>live:thaw']);
  });

  it('thaws the tab and reports `failed` after FREEZE_TIMEOUT_MS, and a late success changes nothing', async () => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);
    const freezing = env.freeze(id);
    await flush();
    expect(env.timers.pending).toEqual([FREEZE_TIMEOUT_MS]);

    env.timers.fire(FREEZE_TIMEOUT_MS);
    await flush();
    expect(freezing.value).toEqual({ outcome: 'failed' });
    expect(env.manager.get(id).runtime).toBe('live');
    expect(lifecycle(runtime)).toEqual(['freeze', 'thaw']);

    runtime.finishFreeze();
    await flush();
    expect(env.manager.get(id).runtime).toBe('live');
    expect(lifecycle(runtime)).toEqual(['freeze', 'thaw']);
  });

  it('goes back to live when the runtime thaws by itself (its debugger detached)', async () => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);
    const freezing = env.freeze(id);
    await flush();
    runtime.finishFreeze();
    await flush();
    expect(freezing.value).toEqual({ outcome: 'frozen' });

    runtime.events.thawed();
    expect(env.manager.get(id).runtime).toBe('live');
    // TabManager did not ask: it only follows.
    expect(lifecycle(runtime)).toEqual(['freeze']);
    const steps = env.stepsOf(id);
    // A thaw nobody is waiting for changes nothing.
    runtime.events.thawed();
    expect(env.stepsOf(id)).toEqual(steps);
  });

  it('reports a freeze as cancelled when the runtime thawed by itself before the command finished', async () => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);
    const freezing = env.freeze(id);
    await flush();
    expect(env.manager.get(id).runtime).toBe('frozen');

    runtime.events.thawed();
    expect(env.manager.get(id).runtime).toBe('live');
    runtime.finishFreeze();
    await flush();
    expect(freezing.value).toEqual({ outcome: 'skipped', why: 'cancelled' });
    expect(env.manager.get(id).runtime).toBe('live');
    expect(lifecycle(runtime)).toEqual(['freeze']);
  });

  it('releases the freeze of a frozen tab whose renderer crashes, and shows it as crashed', async () => {
    const env = setup();
    const id = env.webTab(A);
    const runtime = env.runtimeOf(id);
    const freezing = env.freeze(id);
    await flush();
    runtime.finishFreeze();
    await flush();
    expect(freezing.value).toEqual({ outcome: 'frozen' });

    runtime.events.crashed({ code: 9, name: 'oom' });
    expect(lifecycle(runtime)).toEqual(['freeze', 'thaw']);
    expect(runtime.frozen).toBe(false);
    expect(env.manager.get(id)).toMatchObject({
      runtime: 'crashed',
      page: { kind: 'internal', name: 'crashed', error: { code: 9, name: 'oom' } },
    });
    expect(env.stepsOf(id).slice(-2)).toEqual([
      'live>frozen:freeze',
      'frozen>crashed:rendererGone',
    ]);
  });

  it('does not freeze the selected tab or a loading one', async () => {
    const env = setup();
    const selected = env.webTab(A, { select: true });
    const loading = env.webTab(B);
    env.runtimeOf(loading).events.loadingChanged(true);
    const first = env.freeze(selected);
    const second = env.freeze(loading);
    await flush();
    expect(first.value).toEqual({ outcome: 'skipped', why: 'selected' });
    expect(second.value).toEqual({ outcome: 'skipped', why: 'loading' });
    expect(env.runtimeOf(selected).calls).not.toContain('freeze');
    expect(env.runtimeOf(loading).calls).not.toContain('freeze');
  });
});

describe('TabManager lifecycle: restoring a tab in the background', () => {
  function sessionWithBackgroundTab() {
    const env = setupEmpty();
    env.manager.restoreSession({
      tabs: [savedTab('a'), savedTab('b')],
      selectedTabId: 'a',
      closed: [],
      loadSelected: true,
    });
    return env;
  }

  it('attaches the view invisibly before restore(), and detaches it once the page stops loading', () => {
    const env = sessionWithBackgroundTab();
    expect(env.manager.get('b').runtime).toBe('unloaded');
    expect(env.runtimesOf('b')).toHaveLength(0);

    env.manager.reload('b');
    expect(env.manager.get('b')).toMatchObject({ runtime: 'creating', loading: true });
    const runtime = env.runtimeOf('b');
    expect(runtime.calls).toContain('showHidden');
    expect(runtime.calls.indexOf('showHidden')).toBeLessThan(runtime.calls.indexOf('restore'));
    expect(pick(runtime.restores, 0, 'restore')).toMatchObject({
      shownFirst: false,
      hiddenFirst: true,
    });
    expect(pick(runtime.restores, 0, 'restore').history).toStrictEqual({
      index: 1,
      entries: [
        { url: 'https://b.example/old', title: 'Old b' },
        { url: 'https://b.example/', title: 'Title b' },
      ],
    });
    expect(runtime.hiddenAttached).toBe(true);
    expect(runtime.shown).toBe(false);

    // A commit alone does not detach it: the page is still loading (a wrong scroll position
    // would follow, S2).
    commit(runtime, 'https://b.example/');
    expect(env.manager.get('b').runtime).toBe('live');
    expect(runtime.hiddenAttached).toBe(true);

    runtime.events.loadingChanged(false);
    expect(runtime.hiddenAttached).toBe(false);
    expect(runtime.shown).toBe(false);
    expect(runtime.calls.at(-1)).toBe('hide');
    expect(env.manager.get('b').loading).toBe(false);
  });

  it('detaches it too when the restored page fails to load', () => {
    const env = sessionWithBackgroundTab();
    env.manager.reload('b');
    const runtime = env.runtimeOf('b');
    expect(runtime.hiddenAttached).toBe(true);

    runtime.events.loadFailed({
      code: -105,
      name: 'ERR_NAME_NOT_RESOLVED',
      url: 'https://b.example/',
    });
    expect(runtime.hiddenAttached).toBe(false);
    expect(runtime.shown).toBe(false);
    expect(env.manager.get('b')).toMatchObject({ runtime: 'live', page: { kind: 'internal' } });
  });

  it('shows it instead if the user picks the tab while it restores', () => {
    const env = sessionWithBackgroundTab();
    env.manager.reload('b');
    const runtime = env.runtimeOf('b');
    expect(runtime.hiddenAttached).toBe(true);

    env.manager.select('b');
    expect(runtime.shown).toBe(true);
    expect(runtime.hiddenAttached).toBe(false);
    // The restore that was under way carries on: it was never restarted.
    expect(runtime.restores).toHaveLength(1);
    expect(env.runtimesOf('b')).toHaveLength(1);
  });
});

describe("TabManager lifecycle: the discard's page state in memory", () => {
  it('is used by one restore only', async () => {
    const env = setup();
    const id = env.webTab(A, { title: 'Alpha' });
    await discardCompletely(env, id);
    expect(env.manager.lifecycleFacts(id).pageStateInMemory).toBe(true);

    env.manager.select(id);
    const second = env.runtimeOf(id);
    expect(pick(second.restores, 0, 'restore').history).toStrictEqual({
      index: 0,
      entries: [{ url: A, title: 'Alpha', pageState: `ps:${A}` }],
    });
    expect(env.manager.lifecycleFacts(id).pageStateInMemory).toBe(false);

    // The page loads, is left, and discarded again; this time Chromium reports no page state.
    finishLoad(second, A);
    second.entries = [{ url: A, title: 'Alpha' }];
    env.manager.select(env.home);
    await discardCompletely(env, id);
    env.manager.select(id);
    const third = env.runtimeOf(id);
    expect(third).not.toBe(second);
    expect(pick(third.restores, 0, 'restore').history).toStrictEqual({
      index: 0,
      entries: [{ url: A, title: 'Alpha' }],
    });
  });

  it('is dropped by a navigation of the unloaded tab', async () => {
    const env = setup();
    const id = env.webTab(A, { title: 'Alpha' });
    await discardCompletely(env, id);
    expect(env.manager.lifecycleFacts(id).pageStateInMemory).toBe(true);

    env.manager.navigate(id, B);
    expect(env.manager.lifecycleFacts(id).pageStateInMemory).toBe(false);
    const second = env.runtimeOf(id);
    expect(second.loads).toEqual([B]);
    expect(second.restores).toEqual([]);

    // Discarded again with no page state: nothing of the first discard comes back.
    finishLoad(second, B);
    second.entries = [{ url: B, title: 'B' }];
    await discardCompletely(env, id);
    env.manager.select(id);
    const third = env.runtimeOf(id);
    expect(pick(third.restores, 0, 'restore').history).toStrictEqual({
      index: 0,
      entries: [{ url: B, title: 'B' }],
    });
  });

  it('is not used again when the restore fails and the address loads instead', async () => {
    const env = setup();
    const id = env.webTab(A, { title: 'Alpha' });
    await discardCompletely(env, id);

    env.manager.select(id);
    const second = env.runtimeOf(id);
    expect(second.restores).toHaveLength(1);
    // S2's creation failure: the web contents can't be used for another restore.
    second.events.restoreFailed();
    expect(second.alive).toBe(false);
    expect(second.calls).toContain('destroy');
    const third = env.runtimeOf(id);
    expect(third).not.toBe(second);
    expect(third.loads).toEqual([A]);
    expect(third.restores).toEqual([]);
    expect(env.manager.lifecycleFacts(id).pageStateInMemory).toBe(false);
    expect(env.manager.get(id)).toMatchObject({ runtime: 'creating', loading: true });
    expect(third.shown).toBe(true);
    expect(env.stepsOf(id).slice(-3)).toEqual([
      'unloaded>creating:ensureLive',
      'creating>unloaded:creationFailed',
      'unloaded>creating:load',
    ]);
  });

  it('is dropped by the next commit', async () => {
    const env = setup();
    const id = env.webTab(A, { title: 'Alpha' });
    await discardCompletely(env, id);
    env.manager.select(id);
    expect(env.manager.lifecycleFacts(id).pageStateInMemory).toBe(false);

    // A second tab: discarded, then the page that was kept alive navigates before the restore.
    const other = env.webTab(C, { title: 'C' });
    await discardCompletely(env, other);
    expect(env.manager.lifecycleFacts(other).pageStateInMemory).toBe(true);
    env.manager.select(other);
    const restored = env.runtimeOf(other);
    expect(env.manager.lifecycleFacts(other).pageStateInMemory).toBe(false);
    finishLoad(restored, C);
    expect(env.manager.lifecycleFacts(other).pageStateInMemory).toBe(false);
  });

  it('is not kept from an attempt whose document changed before the page closed late', async () => {
    const env = setup();
    const id = env.webTab(A, { title: 'Alpha' });
    const runtime = env.runtimeOf(id);
    const discard = env.discard(id);
    await flush();
    runtime.answerProbe(reading({ hasBeenActive: true }));
    await flush();
    env.timers.fire(CLOSE_TIMEOUT_MS);
    await flush();
    expect(discard.value).toEqual(blockedBy('page-unsaved-changes'));

    // The page lives on and navigates to a new document: the attempt's snapshot is out of date.
    runtime.entries = [
      { url: A, title: 'Alpha' },
      { url: B, title: 'B' },
    ];
    runtime.index = 1;
    commit(runtime, B, { canGoBack: true });
    runtime.contentsDestroyed();
    await flush();
    expect(env.manager.get(id).runtime).toBe('unloaded');
    expect(env.manager.lifecycleFacts(id).pageStateInMemory).toBe(false);
    expect(env.sessionTab(id)?.history).toStrictEqual({
      index: 1,
      entries: [
        { url: A, title: 'Alpha' },
        { url: B, title: 'B' },
      ],
    });

    env.manager.select(id);
    const restored = env.runtimeOf(id);
    expect(pick(restored.restores, 0, 'restore').history).toStrictEqual({
      index: 1,
      entries: [
        { url: A, title: 'Alpha' },
        { url: B, title: 'B' },
      ],
    });
  });
});

describe('TabManager lifecycle: ephemeral tabs never reach persistence or the memory (I6)', () => {
  it('stay out of the session, Recently closed and the history observer, and a tab opened after one inherits it', async () => {
    const env = setup();
    const ephemeral = env.manager.create({ ephemeral: true, select: false });
    env.manager.navigate(ephemeral, A);
    const first = env.runtimeOf(ephemeral);
    first.entries = [{ url: A, title: 'Private' }];
    commit(first, A);
    first.events.titleChanged('Private');
    first.events.faviconChanged('data:image/png;base64,AAAA');
    first.events.loadingChanged(false);

    const child = env.manager.create({ afterTabId: ephemeral, select: false });
    expect(env.manager.get(ephemeral).ephemeral).toBe(true);
    expect(env.manager.get(child).ephemeral).toBe(true);
    env.manager.navigate(child, B);
    const second = env.runtimeOf(child);
    second.entries = [{ url: B, title: 'Child' }];
    finishLoad(second, B);
    second.events.titleChanged('Child');
    second.events.faviconChanged('data:image/png;base64,BBBB');

    // A normal tab, as the control: it is remembered and persisted.
    const normal = env.webTab(C, { title: 'Normal' });
    const normalRuntime = env.runtimeOf(normal);
    normalRuntime.events.faviconChanged('data:image/png;base64,CCCC');
    expect(env.manager.get(normal).ephemeral).toBe(false);
    expect(env.memory).toEqual(
      expect.arrayContaining([
        `committed:${normal}`,
        `titleChanged:${normal}`,
        `faviconChanged:${normal}`,
      ]),
    );
    expect(env.memory.filter((entry) => entry.endsWith(ephemeral))).toEqual([]);
    expect(env.memory.filter((entry) => entry.endsWith(child))).toEqual([]);
    expect(env.manager.sessionTabs().map((tab) => tab.id)).toEqual([env.home, normal]);

    // Discarded, an ephemeral tab is still not persisted.
    await discardCompletely(env, ephemeral);
    expect(env.manager.sessionTabs().map((tab) => tab.id)).toEqual([env.home, normal]);

    // Closed, neither goes to Recently closed, and the observer is not told.
    env.manager.close(ephemeral);
    env.manager.close(child);
    expect(env.manager.closedTabs()).toEqual([]);
    expect(env.manager.canReopenClosed()).toBe(false);
    expect(env.manager.reopenClosed()).toBeNull();
    expect(env.memory.filter((entry) => entry.endsWith(ephemeral))).toEqual([]);
    expect(env.memory.filter((entry) => entry.endsWith(child))).toEqual([]);
    expect(env.manager.sessionTabs().map((tab) => tab.id)).toEqual([env.home, normal]);

    // The control: closing the normal tab is recorded.
    env.manager.close(normal);
    expect(env.manager.closedTabs().map((tab) => tab.id)).toEqual([normal]);
    expect(env.memory).toContain(`closed:${normal}`);
  });
});

describe('TabManager lifecycle: safe mode', () => {
  it('leaves the selected tab unloaded, held, until it is selected again', () => {
    const env = setupEmpty();
    env.manager.restoreSession({
      tabs: [savedTab('a'), savedTab('b')],
      selectedTabId: 'a',
      closed: [],
      loadSelected: false,
    });
    expect(env.manager.selectedTabId()).toBe('a');
    expect(env.manager.get('a')).toMatchObject({ runtime: 'unloaded', page: { kind: 'web' } });
    expect(env.manager.lifecycleFacts('a').heldUnloaded).toBe(true);
    expect(env.manager.lifecycleFacts('b').heldUnloaded).toBe(false);
    expect(env.runtimes).toHaveLength(0);

    const epoch = env.manager.lifecycleFacts('a').epoch;
    const changes = env.changes();
    env.manager.select('a');
    expect(env.manager.lifecycleFacts('a').heldUnloaded).toBe(false);
    expect(env.manager.lifecycleFacts('a').epoch).toBeGreaterThan(epoch);
    expect(env.manager.get('a')).toMatchObject({ runtime: 'creating', loading: true });
    expect(env.changes()).toBeGreaterThan(changes);
    const runtime = env.runtimeOf('a');
    expect(pick(runtime.restores, 0, 'restore')).toMatchObject({ shownFirst: true });
    expect(pick(runtime.restores, 0, 'restore').history).toStrictEqual(savedTab('a').history);
    expect(env.runtimes).toHaveLength(1);
  });

  it('keeps it held while another tab is picked, and loads it when the user comes back', () => {
    const env = setupEmpty();
    env.manager.restoreSession({
      tabs: [savedTab('a'), savedTab('b')],
      selectedTabId: 'a',
      closed: [],
      loadSelected: false,
    });
    env.manager.select('b');
    expect(env.manager.get('b').runtime).toBe('creating');
    expect(env.manager.get('a').runtime).toBe('unloaded');
    expect(env.manager.lifecycleFacts('a').heldUnloaded).toBe(true);

    env.manager.select('a');
    expect(env.manager.get('a').runtime).toBe('creating');
    expect(env.manager.lifecycleFacts('a').heldUnloaded).toBe(false);
    expect(env.runtimesOf('a')).toHaveLength(1);
  });

  it('is cleared by Reload and by a navigation as well', () => {
    for (const act of ['reload', 'navigate'] as const) {
      const env = setupEmpty();
      env.manager.restoreSession({
        tabs: [savedTab('a')],
        selectedTabId: 'a',
        closed: [],
        loadSelected: false,
      });
      expect(env.manager.lifecycleFacts('a').heldUnloaded).toBe(true);
      if (act === 'reload') {
        env.manager.reload('a');
      } else {
        env.manager.navigate('a', B);
      }
      expect(env.manager.lifecycleFacts('a').heldUnloaded).toBe(false);
      expect(env.manager.get('a').runtime).toBe('creating');
      checkInvariants(env);
    }
  });

  it('does not hold a selected tab that shows a new-tab page', () => {
    const env = setupEmpty();
    env.manager.restoreSession({
      tabs: [{ ...savedTab('a'), url: SESSION_NEW_TAB_URL, title: '', history: null }],
      selectedTabId: 'a',
      closed: [],
      loadSelected: false,
    });
    expect(env.manager.lifecycleFacts('a').heldUnloaded).toBe(false);
    expect(env.manager.get('a')).toMatchObject({
      runtime: 'unloaded',
      page: { kind: 'internal', name: 'new-tab' },
    });
  });
});
