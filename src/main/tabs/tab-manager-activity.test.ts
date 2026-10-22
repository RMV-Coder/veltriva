// TabManager's activity (assessment §4.2, §4.6, §4.10): what the lifecycle policy reads about each
// tab: when it was last used (by the wall clock, the engagement clock and the active day), since
// when it has been hidden, when the user last gave it input, whether an operation is under way on
// it, and its protections. The runtime is a minimal fake (tab-manager-lifecycle.test.ts has the
// full one, for the discard procedure itself) and the clocks are a plain object the test moves.
import { describe, expect, it } from 'vitest';

import { LEARNED_RECHECK_MS } from '../../core/lifecycle/discard';
import type { DiscardOutcome, Timers } from '../../core/lifecycle/discard';
import type { TabFacts } from '../../core/lifecycle/policy';
import type { ProbeReading } from '../../core/lifecycle/probe';
import { protectionFor } from '../../core/lifecycle/protections';
import type { Protection } from '../../core/lifecycle/protections';
import type { TabHistory } from '../../core/session/history';
import { SESSION_NEW_TAB_URL, TabManager } from './tab-manager';
import type { CloseResult, SessionTab, TabId, TabRuntime, TabRuntimeEvents } from './tab-manager';

const A = 'https://a.example/';
const B = 'https://b.example/';

/** Lets every pending microtask run. */
const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/** Timers whose deadlines never pass: a discard that is waiting stays waiting. */
class InertTimers implements Timers {
  #next = 1;

  setTimeout(): number {
    const handle = this.#next;
    this.#next += 1;
    return handle;
  }

  clearTimeout(): void {
    // Nothing is ever scheduled for real.
  }
}

/** A web contents that does only what the activity tests ask of it. */
class FakeRuntime implements TabRuntime {
  /** Everything TabManager asked of it, in order. */
  readonly calls: string[] = [];
  readonly pings: PromiseWithResolvers<unknown>[] = [];
  readonly probes: PromiseWithResolvers<unknown>[] = [];
  alive = true;
  /** The renderer answers the ping at once; false leaves each ping for the test to answer. */
  pingAnswersAtOnce = true;

  constructor(
    readonly tabId: TabId,
    readonly events: TabRuntimeEvents,
  ) {}

  load(): void {
    this.calls.push('load');
  }
  goBack(): void {
    this.calls.push('goBack');
  }
  goForward(): void {
    this.calls.push('goForward');
  }
  reload(): void {
    this.calls.push('reload');
  }
  stop(): void {
    this.calls.push('stop');
  }
  find(): number {
    this.calls.push('find');
    return 1;
  }
  stopFind(): void {
    this.calls.push('stopFind');
  }
  zoomFactor(): number {
    return 1;
  }
  setZoomFactor(): void {
    this.calls.push('setZoomFactor');
  }
  toggleDevTools(): void {
    this.calls.push('toggleDevTools');
  }
  exitFullscreen(): void {
    this.calls.push('exitFullscreen');
  }
  show(): void {
    this.calls.push('show');
  }
  showHidden(): void {
    this.calls.push('showHidden');
  }
  hide(): void {
    this.calls.push('hide');
  }
  focus(): void {
    this.calls.push('focus');
  }
  destroy(): void {
    this.calls.push('destroy');
    this.alive = false;
  }
  restore(): void {
    this.calls.push('restore');
  }
  history(): TabHistory | null {
    return null;
  }
  ping(): Promise<unknown> {
    const ping = Promise.withResolvers<unknown>();
    this.pings.push(ping);
    if (this.pingAnswersAtOnce) {
      ping.resolve(undefined);
    }
    return ping.promise;
  }
  probe(): Promise<unknown> {
    const probe = Promise.withResolvers<unknown>();
    this.probes.push(probe);
    return probe.promise;
  }
  snapshot(): { readonly index: number; readonly entries: readonly unknown[] } | null {
    return null;
  }
  closeForDiscard(): Promise<CloseResult> {
    return new Promise<CloseResult>(() => undefined);
  }
  freeze(): Promise<void> {
    return Promise.resolve();
  }
  thaw(): void {
    this.calls.push('thaw');
  }

  /** The renderer answers the latest ping. */
  answerPing(): void {
    pick(this.pings, this.pings.length - 1, 'ping').resolve(undefined);
  }
  /** The probe answers. */
  answerProbe(value: unknown): void {
    pick(this.probes, this.probes.length - 1, 'probe').resolve(value);
  }
}

/** The item at `index`, or a failure that says what was missing. */
function pick<T>(list: readonly T[], index: number, what: string): T {
  const item = list[index];
  if (item === undefined) {
    throw new Error(`no ${what} at ${String(index)} (there are ${String(list.length)})`);
  }
  return item;
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

/** An operation's result, once it settles. */
class Tracked<T> {
  value: T | undefined;
  settled = false;

  constructor(promise: Promise<T>) {
    void promise.then((value) => {
      this.value = value;
      this.settled = true;
    });
  }
}

interface Clock {
  wallNow: number;
  engagedNow: number;
  activeDay: number;
}

const START: Clock = { wallNow: 1_000_000, engagedNow: 10_000, activeDay: 3 };

interface BuildOptions {
  /** False builds a manager without an activity clock (wall clock only). */
  readonly activity?: boolean;
  readonly clock?: Partial<Clock>;
}

function build(options: BuildOptions = {}) {
  const clock: Clock = { ...START, ...options.clock };
  const runtimes: FakeRuntime[] = [];
  /** What the protection monitor (the `protections` option) reports, by tab. */
  const external = new Map<TabId, Protection[]>();
  let changes = 0;
  let nextId = 0;
  const manager = new TabManager({
    createRuntime: (tabId, events) => {
      const runtime = new FakeRuntime(tabId, events);
      runtimes.push(runtime);
      return runtime;
    },
    newId: () => `tab-${String((nextId += 1))}`,
    onChange: () => {
      changes += 1;
    },
    now: () => clock.wallNow,
    timers: new InertTimers(),
    protections: (tabId) => external.get(tabId) ?? [],
    ...(options.activity === false ? {} : { activityClock: () => ({ ...clock }) }),
  });

  const runtimeOf = (tabId: TabId): FakeRuntime => {
    const alive = runtimes.filter((runtime) => runtime.tabId === tabId && runtime.alive);
    const [runtime] = alive;
    if (alive.length !== 1 || runtime === undefined) {
      throw new Error(`expected one live runtime for ${tabId}, found ${String(alive.length)}`);
    }
    return runtime;
  };
  /** A tab showing a committed page that stopped loading. */
  const webTab = (url: string, tabOptions: { readonly select?: boolean } = {}): TabId => {
    const id = manager.create({ select: tabOptions.select ?? false });
    manager.navigate(id, url);
    const runtime = runtimeOf(id);
    runtime.events.committed({ url, sameDocument: false, canGoBack: false, canGoForward: false });
    runtime.events.loadingChanged(false);
    return id;
  };
  const facts = (tabId: TabId): TabFacts => {
    const found = manager.lifecycleTabs().find((candidate) => candidate.id === tabId);
    if (found === undefined) {
      throw new Error(`no facts for ${tabId}`);
    }
    return found;
  };
  const stamped = (tabId: TabId): SessionTab => {
    const found = manager.sessionTabs().find((candidate) => candidate.id === tabId);
    if (found === undefined) {
      throw new Error(`no session tab ${tabId}`);
    }
    return found;
  };
  return {
    manager,
    clock,
    external,
    runtimes,
    runtimeOf,
    webTab,
    facts,
    stamped,
    changes: () => changes,
    /** Moves the clocks. */
    at: (patch: Partial<Clock>): void => {
      Object.assign(clock, patch);
    },
  };
}

type Harness = ReturnType<typeof build>;

/** A saved web tab; the engagement stamps are whatever `extra` says (absent unless it does). */
function saved(id: string, extra: Partial<SessionTab> = {}): SessionTab {
  return {
    id,
    pinned: false,
    url: `https://${id}.example/`,
    title: `Title ${id}`,
    history: null,
    createdAt: 1000,
    lastUsedAt: 2000,
    ...extra,
  };
}

/** A saved new-tab page: a way to have a selected tab that is none of the ones under test. */
const savedHome = (id = 'home'): SessionTab => ({
  id,
  pinned: false,
  url: SESSION_NEW_TAB_URL,
  title: '',
  history: null,
  createdAt: 1000,
  lastUsedAt: 2000,
});

function restore(h: Harness, tabs: readonly SessionTab[], selectedTabId: TabId | null): void {
  h.manager.restoreSession({ tabs, selectedTabId, closed: [], loadSelected: false });
}

describe('TabManager activity: stamping a tab as used', () => {
  it('stamps a tab created selected by every clock, and it is not hidden', () => {
    const h = build();
    const id = h.manager.create();
    expect(h.stamped(id)).toMatchObject({
      lastUsedAt: START.wallNow,
      lastUsedEngaged: START.engagedNow,
      lastUsedActiveDay: START.activeDay,
    });
    expect(h.facts(id)).toMatchObject({ selected: true, hiddenSince: null });
  });

  it('stamps the tab selected, and the tab left, by every clock, and hides the one left from then', () => {
    const h = build();
    const home = h.manager.create(); // selected at the start
    h.at({ wallNow: 1_100_000, engagedNow: 12_000, activeDay: 3 });
    const other = h.manager.create({ select: false });

    h.at({ wallNow: 1_160_000, engagedNow: 16_000, activeDay: 4 });
    h.manager.select(other);

    const second = { lastUsedAt: 1_160_000, lastUsedEngaged: 16_000, lastUsedActiveDay: 4 };
    expect(h.stamped(other)).toMatchObject(second); // used now: it was selected
    expect(h.stamped(home)).toMatchObject(second); // used until now: it was left
    expect(h.facts(other)).toMatchObject({ selected: true, hiddenSince: null });
    expect(h.facts(home)).toMatchObject({ selected: false, hiddenSince: 1_160_000 });

    // And back: the hiddenSince of the one left is the time it was left, not the earlier one.
    h.at({ wallNow: 1_170_000, engagedNow: 17_000, activeDay: 4 });
    h.manager.select(home);
    const third = { lastUsedAt: 1_170_000, lastUsedEngaged: 17_000, lastUsedActiveDay: 4 };
    expect(h.stamped(home)).toMatchObject(third);
    expect(h.stamped(other)).toMatchObject(third);
    expect(h.facts(home)).toMatchObject({ selected: true, hiddenSince: null });
    expect(h.facts(other)).toMatchObject({ selected: false, hiddenSince: 1_170_000 });
  });

  it('stamps nothing for a selection that changes nothing', () => {
    const h = build();
    const id = h.manager.create();
    const before = h.stamped(id);
    h.at({ wallNow: 2_000_000, engagedNow: 99_000, activeDay: 9 });
    h.manager.select(id);
    expect(h.stamped(id)).toStrictEqual(before);
  });

  it('stamps the tab that takes over when the selected one is closed', () => {
    const h = build();
    const home = h.manager.create();
    const other = h.manager.create(); // selects it, and leaves home at the start
    h.at({ wallNow: 1_500_000, engagedNow: 15_000, activeDay: 5 });
    h.manager.close(other);

    expect(h.manager.selectedTabId()).toBe(home);
    expect(h.stamped(home)).toMatchObject({
      lastUsedAt: 1_500_000,
      lastUsedEngaged: 15_000,
      lastUsedActiveDay: 5,
    });
    expect(h.facts(home).hiddenSince).toBeNull();
  });

  it('hides a tab created unselected since its creation, and its last use is then too', () => {
    const h = build();
    h.manager.create();
    h.at({ wallNow: 1_234_000, engagedNow: 11_500, activeDay: 4 });
    const id = h.manager.create({ select: false });

    const expected = {
      hiddenSince: 1_234_000,
      lastUsedAt: 1_234_000,
      lastUsedEngaged: 11_500,
      lastUsedActiveDay: 4,
    };
    expect(h.facts(id)).toMatchObject({ selected: false, ...expected });
    h.at({ wallNow: 9_000_000, engagedNow: 90_000, activeDay: 8 });
    expect(h.facts(id)).toMatchObject(expected); // time passing changes none of it
  });

  it('hides restored tabs since the restore, whenever they were last used', () => {
    const h = build({ clock: { wallNow: 5_000_000 } });
    restore(
      h,
      [savedHome(), saved('a', { lastUsedAt: 1000 }), saved('b', { lastUsedAt: 2000 })],
      'home',
    );

    expect(h.facts('a')).toMatchObject({ hiddenSince: 5_000_000, lastUsedAt: 1000 });
    expect(h.facts('b')).toMatchObject({ hiddenSince: 5_000_000, lastUsedAt: 2000 });
    expect(h.facts('home')).toMatchObject({ selected: true, hiddenSince: null });
  });

  it('leaves the restored selected tab as stored until it is left, and then stamps and hides it', () => {
    const h = build({ clock: { wallNow: 5_000_000 } });
    restore(h, [saved('a', { lastUsedAt: 1000 }), saved('b')], 'a');
    expect(h.stamped('a').lastUsedAt).toBe(1000);

    h.at({ wallNow: 5_300_000, engagedNow: 14_000, activeDay: 3 });
    h.manager.select('b');
    expect(h.stamped('a')).toMatchObject({
      lastUsedAt: 5_300_000,
      lastUsedEngaged: 14_000,
      lastUsedActiveDay: 3,
    });
    expect(h.facts('a').hiddenSince).toBe(5_300_000);
  });
});

describe('TabManager activity: stamps read from the session', () => {
  // The engagement clock reads engaged 10,000 on active day 5 in these.
  const clock = { wallNow: 5_000_000, engagedNow: 10_000, activeDay: 5 };

  const cases: readonly {
    readonly name: string;
    readonly stored: Partial<SessionTab>;
    readonly engaged: number;
    readonly day: number;
  }[] = [
    {
      name: 'plausible values are kept',
      stored: { lastUsedEngaged: 4000, lastUsedActiveDay: 3 },
      engaged: 4000,
      day: 3,
    },
    {
      name: 'values equal to now are kept',
      stored: { lastUsedEngaged: 10_000, lastUsedActiveDay: 5 },
      engaged: 10_000,
      day: 5,
    },
    { name: 'absent values read as now', stored: {}, engaged: 10_000, day: 5 },
    {
      name: 'only an absent day reads as today',
      stored: { lastUsedEngaged: 4000 },
      engaged: 4000,
      day: 5,
    },
    {
      name: 'only an absent engaged value reads as now',
      stored: { lastUsedActiveDay: 2 },
      engaged: 10_000,
      day: 2,
    },
    {
      name: 'an engaged value from the future reads as now',
      stored: { lastUsedEngaged: 99_999 },
      engaged: 10_000,
      day: 5,
    },
    {
      name: 'an active day from the future reads as today',
      stored: { lastUsedActiveDay: 9 },
      engaged: 10_000,
      day: 5,
    },
    {
      name: 'an active day of 0 reads as today',
      stored: { lastUsedActiveDay: 0 },
      engaged: 10_000,
      day: 5,
    },
    {
      name: 'a negative active day reads as today',
      stored: { lastUsedActiveDay: -2 },
      engaged: 10_000,
      day: 5,
    },
    {
      name: 'an active day below 1 reads as today',
      stored: { lastUsedActiveDay: 0.5 },
      engaged: 10_000,
      day: 5,
    },
    // The session loader turns Phase 2's 0 (unknown) into an absent value; an engaged stamp of 0
    // that reaches TabManager is a real one, from the start of the profile.
    {
      name: 'an engaged value of 0 is kept: a tab last used at the start of the profile',
      stored: { lastUsedEngaged: 0 },
      engaged: 0,
      day: 5,
    },
  ];

  it.each(cases)('$name', ({ stored, engaged, day }) => {
    const h = build({ clock });
    restore(h, [savedHome(), saved('a', stored)], 'home');
    expect(h.facts('a')).toMatchObject({ lastUsedEngaged: engaged, lastUsedActiveDay: day });
    expect(h.stamped('a')).toMatchObject({ lastUsedEngaged: engaged, lastUsedActiveDay: day });
  });

  it('keeps a stored last-used time as it is', () => {
    const h = build({ clock });
    restore(h, [savedHome(), saved('a', { lastUsedAt: 123_456 })], 'home');
    expect(h.facts('a').lastUsedAt).toBe(123_456);
    expect(h.stamped('a').lastUsedAt).toBe(123_456);
  });

  it('keeps a closed tab’s stamps in Recently closed, and reopening it counts as a use', () => {
    const h = build({ clock });
    h.manager.restoreSession({
      tabs: [savedHome()],
      selectedTabId: 'home',
      closed: [
        {
          ...saved('c', { lastUsedEngaged: 3000, lastUsedActiveDay: 2 }),
          closedAt: 4000,
          index: 1,
        },
      ],
      loadSelected: false,
    });
    expect(h.manager.closedTabs().map((tab) => tab.lastUsedEngaged)).toEqual([3000]);

    h.manager.reopenClosed();
    // Reopening selects it: it is in use now.
    expect(h.stamped('c')).toMatchObject({
      lastUsedAt: clock.wallNow,
      lastUsedEngaged: clock.engagedNow,
      lastUsedActiveDay: clock.activeDay,
    });
  });

  it('without an activity clock last use is wall-clock only: engaged 0 on day 1', () => {
    const h = build({ activity: false, clock: { wallNow: 7_000_000 } });
    const first = h.manager.create();
    const second = h.manager.create({ select: false });
    expect(h.facts(first)).toMatchObject({
      lastUsedAt: 7_000_000,
      lastUsedEngaged: 0,
      lastUsedActiveDay: 1,
    });
    expect(h.facts(second)).toMatchObject({
      hiddenSince: 7_000_000,
      lastUsedEngaged: 0,
      lastUsedActiveDay: 1,
    });

    // Stored stamps from a profile that had a clock are cut down to it, never kept from "the future".
    const other = build({ activity: false });
    restore(
      other,
      [savedHome(), saved('a', { lastUsedEngaged: 4000, lastUsedActiveDay: 3 })],
      'home',
    );
    expect(other.facts('a')).toMatchObject({ lastUsedEngaged: 0, lastUsedActiveDay: 1 });
  });
});

describe('TabManager activity: interactions', () => {
  it('stamps the wall time of the user’s input in a page, and nothing else', () => {
    const h = build();
    h.manager.create();
    const id = h.webTab(A);
    expect(h.facts(id).lastInteractionAt).toBeNull();
    const used = h.stamped(id);

    h.at({ wallNow: 1_042_000 });
    h.runtimeOf(id).events.interacted?.();
    expect(h.facts(id).lastInteractionAt).toBe(1_042_000);
    h.at({ wallNow: 1_050_000 });
    h.runtimeOf(id).events.interacted?.();
    expect(h.facts(id).lastInteractionAt).toBe(1_050_000);
    expect(h.stamped(id)).toStrictEqual(used); // an input is not a use: only selection is
    expect(h.facts(id).hiddenSince).toBe(START.wallNow);
  });

  it('causes no change notification: no view shows it', () => {
    const h = build();
    h.manager.create();
    const id = h.webTab(A);
    const before = h.changes();
    h.runtimeOf(id).events.interacted?.();
    h.runtimeOf(id).events.interacted?.();
    expect(h.changes()).toBe(before);
  });

  it('stamps the selected tab too', () => {
    const h = build();
    const id = h.webTab(A, { select: true });
    h.at({ wallNow: 1_001_000 });
    h.runtimeOf(id).events.interacted?.();
    expect(h.facts(id)).toMatchObject({ selected: true, lastInteractionAt: 1_001_000 });
  });

  it('keeps each tab’s own input time', () => {
    const h = build();
    h.manager.create();
    const first = h.webTab(A);
    const second = h.webTab(B);
    h.at({ wallNow: 1_001_000 });
    h.runtimeOf(first).events.interacted?.();
    expect(h.facts(first).lastInteractionAt).toBe(1_001_000);
    expect(h.facts(second).lastInteractionAt).toBeNull();
  });

  it('ignores input reported by a web contents the tab no longer has', () => {
    const h = build();
    h.manager.create();
    const id = h.webTab(A);
    const old = h.runtimeOf(id);

    h.manager.showInternal(id, 'new-tab'); // its web contents goes
    h.at({ wallNow: 1_001_000 });
    old.events.interacted?.();
    expect(h.facts(id).lastInteractionAt).toBeNull();
  });

  it('ignores input from a tab that was closed', () => {
    const h = build();
    h.manager.create();
    const id = h.webTab(A);
    const old = h.runtimeOf(id);
    h.manager.close(id);
    expect(() => {
      old.events.interacted?.();
    }).not.toThrow();
    expect(h.manager.has(id)).toBe(false);
  });
});

describe('TabManager activity: lifecycleTabs()', () => {
  it('lists every tab in strip order with every field', () => {
    const h = build();
    const home = h.manager.create();
    h.at({ wallNow: 1_100_000, engagedNow: 11_000, activeDay: 3 });
    const page = h.manager.create({ select: false });
    h.manager.navigate(page, A);
    // A load in progress: the runtime is being created and the new-tab page is still on display.
    expect(h.facts(page)).toMatchObject({ runtime: 'creating', loading: true, webPage: false });
    const runtime = h.runtimeOf(page);
    runtime.events.committed({
      url: A,
      sameDocument: false,
      canGoBack: false,
      canGoForward: false,
    });
    runtime.events.loadingChanged(false);
    const pinned = h.manager.create({ select: false });
    h.manager.setPinned(pinned, true);

    h.at({ wallNow: 1_200_000, engagedNow: 12_000, activeDay: 4 });
    const tabs = h.manager.lifecycleTabs();
    expect(tabs.map((tab) => tab.id)).toEqual([pinned, home, page]); // pinned first

    expect(tabs).toEqual([
      {
        id: pinned,
        placement: 'strip',
        runtime: 'unloaded',
        pinned: true,
        selected: false,
        webPage: false,
        loading: false,
        busy: false,
        epoch: 0,
        hiddenSince: 1_100_000,
        lastUsedAt: 1_100_000,
        lastUsedEngaged: 11_000,
        lastUsedActiveDay: 3,
        lastInteractionAt: null,
        protections: [],
      },
      {
        // Selected: used now, and not hidden, though nothing has stamped it since the start.
        id: home,
        placement: 'strip',
        runtime: 'unloaded',
        pinned: false,
        selected: true,
        webPage: false,
        loading: false,
        busy: false,
        epoch: 0,
        hiddenSince: null,
        lastUsedAt: 1_200_000,
        lastUsedEngaged: 12_000,
        lastUsedActiveDay: 4,
        lastInteractionAt: null,
        protections: [],
      },
      {
        id: page,
        placement: 'strip',
        runtime: 'live',
        pinned: false,
        selected: false,
        webPage: true,
        loading: false,
        busy: false,
        epoch: h.manager.lifecycleFacts(page).epoch,
        hiddenSince: 1_100_000,
        lastUsedAt: 1_100_000,
        lastUsedEngaged: 11_000,
        lastUsedActiveDay: 3,
        lastInteractionAt: null,
        protections: [],
      },
    ]);
    expect(pick(tabs, 2, 'tab').epoch).toBe(2); // load, then ready
  });

  it('reports the selected tab as used now and not hidden, while the session keeps its stamp', () => {
    const h = build();
    const id = h.manager.create();
    h.at({ wallNow: 3_000_000, engagedNow: 30_000, activeDay: 6 });
    expect(h.facts(id)).toMatchObject({
      selected: true,
      hiddenSince: null,
      lastUsedAt: 3_000_000,
      lastUsedEngaged: 30_000,
      lastUsedActiveDay: 6,
    });
    expect(h.stamped(id)).toMatchObject({
      lastUsedAt: START.wallNow,
      lastUsedEngaged: START.engagedNow,
      lastUsedActiveDay: START.activeDay,
    });
  });

  it('reports the epoch, which every runtime transition bumps and nothing else does', () => {
    const h = build();
    const home = h.manager.create();
    const id = h.webTab(A);
    expect(h.facts(id).epoch).toBe(2); // load, ready
    expect(h.facts(id).epoch).toBe(h.manager.lifecycleFacts(id).epoch);

    // Selecting it and leaving it again moves no runtime state.
    h.manager.select(id);
    h.manager.select(home);
    h.runtimeOf(id).events.interacted?.();
    expect(h.facts(id).epoch).toBe(2);

    h.runtimeOf(id).events.crashed({ code: 9, name: 'crashed' });
    expect(h.facts(id)).toMatchObject({ epoch: 3, runtime: 'crashed' });
    expect(h.facts(id).epoch).toBe(h.manager.lifecycleFacts(id).epoch);
  });

  describe('busy', () => {
    const AUTOMATION = { origin: 'automation' } as const;

    it('is true while a discard is queued or running, and until its operation has finished', async () => {
      const h = build();
      h.manager.create();
      const id = h.webTab(A);
      const runtime = h.runtimeOf(id);
      runtime.pingAnswersAtOnce = false;
      expect(h.facts(id).busy).toBe(false);

      const discard = new Tracked<DiscardOutcome>(h.manager.discard(id, AUTOMATION));
      expect(h.facts(id).busy).toBe(true); // queued
      await flush();
      expect(h.manager.get(id).runtime).toBe('discarding');
      expect(h.facts(id).busy).toBe(true); // running

      const second = new Tracked<DiscardOutcome>(h.manager.discard(id, AUTOMATION));
      expect(h.facts(id).busy).toBe(true);

      // The user picks the tab: the discard stops, but its operation is still in the queue.
      h.manager.select(id);
      expect(h.manager.get(id).runtime).toBe('live');
      expect(h.facts(id)).toMatchObject({ busy: true, selected: true });

      runtime.answerPing();
      await flush();
      expect(discard.value).toEqual({ outcome: 'skipped', why: 'cancelled' });
      expect(second.settled).toBe(true);
      expect(h.facts(id).busy).toBe(false);
    });

    it('is false for a tab that was never asked anything, and for the others while one is busy', async () => {
      const h = build();
      h.manager.create();
      const first = h.webTab(A);
      const second = h.webTab(B);
      h.runtimeOf(first).pingAnswersAtOnce = false;
      const discard = new Tracked<DiscardOutcome>(h.manager.discard(first, AUTOMATION));
      await flush();

      expect(h.facts(first).busy).toBe(true);
      expect(h.facts(second).busy).toBe(false);
      expect(discard.settled).toBe(false);
    });
  });

  describe('protections', () => {
    const AUTOMATION = { origin: 'automation' } as const;
    const USER = { origin: 'user' } as const;

    /** A background tab whose discard learns a protection from a probe. */
    async function learn(
      h: Harness,
      id: TabId,
      request: typeof AUTOMATION | typeof USER,
      answer: Partial<ProbeReading>,
    ) {
      const outcome = new Tracked<DiscardOutcome>(h.manager.discard(id, request));
      await flush();
      h.runtimeOf(id).answerProbe(reading(answer));
      await flush();
      return outcome;
    }

    it('are the protection monitor’s, read afresh on every call', () => {
      const h = build();
      h.manager.create();
      const id = h.webTab(A);
      const other = h.webTab(B);
      expect(h.facts(id).protections).toEqual([]);

      h.external.set(id, [protectionFor('audio'), protectionFor('devtools')]);
      expect(h.facts(id).protections).toEqual([protectionFor('audio'), protectionFor('devtools')]);
      expect(h.facts(other).protections).toEqual([]);

      h.external.delete(id);
      expect(h.facts(id).protections).toEqual([]);
    });

    it('add what a discard learned, newest first, after the monitor’s', async () => {
      const h = build();
      h.manager.create();
      const id = h.webTab(A);

      // (Any protection the monitor reports blocks a discard before it probes, so the tab learns
      // first and the monitor reports afterwards.)
      const first = await learn(h, id, AUTOMATION, { changedFields: 2, hasBeenActive: true });
      expect(first.value).toEqual({ outcome: 'blocked', reason: 'unsaved-input' });
      expect(h.facts(id).protections).toEqual([protectionFor('unsaved-input')]);

      h.at({ wallNow: START.wallNow + 1000 });
      const second = await learn(h, id, USER, { focusedEditable: true });
      expect(second.value).toEqual({ outcome: 'blocked', reason: 'editing' });
      expect(h.facts(id).protections).toEqual([
        protectionFor('editing'),
        protectionFor('unsaved-input'),
      ]);

      h.external.set(id, [protectionFor('audio')]);
      expect(h.facts(id).protections).toEqual([
        protectionFor('audio'),
        protectionFor('editing'),
        protectionFor('unsaved-input'),
      ]);
      expect(h.facts(id).busy).toBe(false);
    });

    it('drop what a discard learned once LEARNED_RECHECK_MS has passed, each at its own time', async () => {
      const h = build();
      h.manager.create();
      const id = h.webTab(A);
      await learn(h, id, AUTOMATION, { changedFields: 2, hasBeenActive: true });
      h.at({ wallNow: START.wallNow + 1000 });
      await learn(h, id, USER, { focusedEditable: true });

      h.at({ wallNow: START.wallNow + LEARNED_RECHECK_MS - 1 });
      expect(h.facts(id).protections).toEqual([
        protectionFor('editing'),
        protectionFor('unsaved-input'),
      ]);
      h.at({ wallNow: START.wallNow + LEARNED_RECHECK_MS });
      expect(h.facts(id).protections).toEqual([protectionFor('editing')]);
      h.at({ wallNow: START.wallNow + 1000 + LEARNED_RECHECK_MS });
      expect(h.facts(id).protections).toEqual([]);
    });

    it('do not count what was learned at a time after now (a clock set back)', async () => {
      const h = build();
      h.manager.create();
      const id = h.webTab(A);
      await learn(h, id, AUTOMATION, { changedFields: 2, hasBeenActive: true });
      h.at({ wallNow: START.wallNow - 5000 });
      expect(h.facts(id).protections).toEqual([]);
    });

    it('are forgotten when a new document commits, and not for a same-document commit', async () => {
      const h = build();
      h.manager.create();
      const id = h.webTab(A);
      await learn(h, id, AUTOMATION, { changedFields: 2, hasBeenActive: true });

      h.runtimeOf(id).events.committed({
        url: `${A}#x`,
        sameDocument: true,
        canGoBack: false,
        canGoForward: false,
      });
      expect(h.facts(id).protections).toEqual([protectionFor('unsaved-input')]);
      h.runtimeOf(id).events.committed({
        url: B,
        sameDocument: false,
        canGoBack: false,
        canGoForward: false,
      });
      expect(h.facts(id).protections).toEqual([]);
    });
  });
});

describe('TabManager activity: sessionTabs()', () => {
  it('carries the stamped values, whatever the clocks say now', () => {
    const h = build();
    const home = h.manager.create();
    const id = h.webTab(A);
    h.at({ wallNow: 1_100_000, engagedNow: 11_000, activeDay: 3 });
    h.manager.select(id);
    h.at({ wallNow: 1_200_000, engagedNow: 12_000, activeDay: 4 });
    h.manager.select(home); // id is left, and stamped

    expect(h.stamped(id)).toMatchObject({
      url: A,
      lastUsedAt: 1_200_000,
      lastUsedEngaged: 12_000,
      lastUsedActiveDay: 4,
    });
    h.at({ wallNow: 8_000_000, engagedNow: 80_000, activeDay: 9 });
    expect(h.stamped(id)).toMatchObject({
      lastUsedAt: 1_200_000,
      lastUsedEngaged: 12_000,
      lastUsedActiveDay: 4,
    });
  });

  it('does not report "now" for the selected tab: a flush would rewrite its row every time', () => {
    const h = build();
    const id = h.webTab(A, { select: true });
    const first = h.manager.sessionTabs();
    h.at({ wallNow: 2_000_000, engagedNow: 20_000, activeDay: 5 });
    const second = h.manager.sessionTabs();
    h.at({ wallNow: 3_000_000, engagedNow: 30_000, activeDay: 7 });
    const third = h.manager.sessionTabs();

    expect(second).toStrictEqual(first);
    expect(third).toStrictEqual(first);
    expect(h.facts(id).lastUsedAt).toBe(3_000_000); // the policy does see it as used now
  });

  it('carries the stamps of a new-tab page too', () => {
    const h = build();
    const id = h.manager.create();
    expect(h.stamped(id)).toStrictEqual({
      id,
      pinned: false,
      url: SESSION_NEW_TAB_URL,
      title: '',
      history: null,
      createdAt: START.wallNow,
      lastUsedAt: START.wallNow,
      lastUsedEngaged: START.engagedNow,
      lastUsedActiveDay: START.activeDay,
      // M3.3: the user's protection and the last move between Tabs, Sleeping and Archive.
      userProtected: false,
      placementChangedAt: START.wallNow,
    });
  });

  it('gives a closed tab the stamps it had, not the time it was closed', () => {
    const h = build();
    const home = h.manager.create();
    const id = h.webTab(A);
    h.at({ wallNow: 1_100_000, engagedNow: 11_000, activeDay: 3 });
    h.manager.select(id);
    h.at({ wallNow: 1_200_000, engagedNow: 12_000, activeDay: 4 });
    h.manager.select(home); // leaves id: stamped at 1,200,000
    h.at({ wallNow: 1_900_000, engagedNow: 19_000, activeDay: 5 });
    h.manager.close(id);

    const [closed] = h.manager.closedTabs();
    expect(closed).toMatchObject({
      id,
      lastUsedAt: 1_200_000,
      lastUsedEngaged: 12_000,
      lastUsedActiveDay: 4,
      closedAt: 1_900_000,
    });
  });
});
