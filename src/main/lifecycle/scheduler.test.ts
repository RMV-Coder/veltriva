// The lifecycle scheduler (assessment §4.8): when it evaluates, how many actions it starts and how
// fast, what it logs, and which tabs it moved (the batch Undo offers, M3.3). The policy is the real
// one (core/lifecycle/policy.ts); everything the scheduler touches is a fake: tabs whose facts a
// test sets and whose `discard`, `freeze` and `archive` hand out promises the test settles (`shelve`
// answers at once, as TabManager's does), a clock whose timers a test moves, settings and pressure.
//
// Time is a manual clock in milliseconds from the start of the test; the wall clock the policy sees
// is WALL0 plus it, so "hidden for 2 hours" is a fact written relative to WALL0 and stays true as
// the test advances. `advance` fires the timers that fall due, in order, and lets the promise
// continuations they cause run in between, so a test can say "at 1,000 ms the second discard is
// called" and check it.
import { describe, expect, it } from 'vitest';

import type { DiscardOutcome, DiscardRequest, Timers } from '../../core/lifecycle/discard';
import type { MoveOutcome, MoveRequest, PlacementMove } from '../../core/lifecycle/placement';
import { DEFAULT_LIFECYCLE_SETTINGS } from '../../core/lifecycle/policy';
import type { LifecycleSettings, MemoryPressure, TabFacts } from '../../core/lifecycle/policy';
import type { RuntimeState } from '../../core/lifecycle/runtime-machine';
import type { Logger } from '../platform/logger';
import type { FreezeOutcome, TabId } from '../tabs/tab-manager';
import {
  LifecycleScheduler,
  LOG_SIZE,
  MAX_DISCARDS_PER_EVALUATION,
  MAX_FREEZES_PER_EVALUATION,
  QUIET_START_MS,
  STAGGER_MS,
  TICK_MS,
  TRIGGER_DELAY_MS,
} from './scheduler';
import type { ActionRecord, MoveBatch, SchedulerTabs } from './scheduler';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const WALL0 = Date.UTC(2026, 9, 21, 12, 0, 0);

const DISCARDED: DiscardOutcome = { outcome: 'discarded' };
const FROZEN: FreezeOutcome = { outcome: 'frozen' };

/** Lets every pending microtask run. */
const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/** The item at `index`, or a failure that says what was missing. */
function pick<T>(list: readonly T[], index: number, what: string): T {
  const item = list[index];
  if (item === undefined) {
    throw new Error(`no ${what} at ${String(index)} (there are ${String(list.length)})`);
  }
  return item;
}

/** Whether facts are the tab's. */
const isTab =
  (id: TabId) =>
  (facts: TabFacts): boolean =>
    facts.id === id;

/** A promise's state, once it settles. */
class Tracked<T> {
  settled = false;
  rejected = false;
  value: T | undefined;

  constructor(promise: Promise<T>) {
    void promise.then(
      (value) => {
        this.value = value;
        this.settled = true;
      },
      () => {
        this.rejected = true;
        this.settled = true;
      },
    );
  }
}

/** Timers on a clock a test moves. */
class ManualClock implements Timers {
  /** Milliseconds since the test began. */
  now = 0;
  #next = 1;
  readonly #pending = new Map<
    number,
    { readonly callback: () => void; readonly ms: number; readonly due: number }
  >();

  setTimeout(callback: () => void, ms: number): number {
    const handle = this.#next;
    this.#next += 1;
    this.#pending.set(handle, { callback, ms, due: this.now + ms });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') {
      this.#pending.delete(handle);
    }
  }

  /** The delays of the timers still pending, the soonest first. */
  get pending(): number[] {
    return [...this.#pending.values()].sort((a, b) => a.due - b.due).map((timer) => timer.ms);
  }

  /**
   * Moves time forward by `ms`. Timers that fall due fire in order, each at its own time, and the
   * promise continuations they set off run before the next one fires.
   */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      await flush();
      const next = [...this.#pending]
        .filter(([, timer]) => timer.due <= target)
        .sort(([handleA, a], [handleB, b]) => a.due - b.due || handleA - handleB)[0];
      if (next === undefined) {
        break;
      }
      const [handle, timer] = next;
      this.#pending.delete(handle);
      this.now = Math.max(this.now, timer.due);
      timer.callback();
    }
    this.now = target;
    await flush();
  }
}

interface DiscardCall {
  readonly tabId: TabId;
  readonly request: DiscardRequest;
  /** The manual clock when it was called. */
  readonly at: number;
  readonly settle: PromiseWithResolvers<DiscardOutcome>;
}

interface FreezeCall {
  readonly tabId: TabId;
  readonly at: number;
  readonly settle: PromiseWithResolvers<FreezeOutcome>;
}

/** A shelve: it answers at once, so there is nothing to settle. */
interface ShelveCall {
  readonly tabId: TabId;
  readonly request: MoveRequest;
  readonly at: number;
}

interface ArchiveCall extends ShelveCall {
  /** What `settleAll` settles it with: the outcome this call was given when it was made. */
  readonly outcome: MoveOutcome;
  readonly settle: PromiseWithResolvers<MoveOutcome>;
}

/** TabManager as the scheduler sees it. */
class FakeTabs implements SchedulerTabs {
  facts: TabFacts[] = [];
  /** How often `lifecycleTabs()` was asked: one per evaluation. */
  reads = 0;
  readError: Error | null = null;
  readonly discards: DiscardCall[] = [];
  readonly freezes: FreezeCall[] = [];
  readonly shelves: ShelveCall[] = [];
  readonly archives: ArchiveCall[] = [];
  /** True leaves each async operation for the test to settle; false settles it at once. */
  hold = false;
  discardOutcome: DiscardOutcome = DISCARDED;
  freezeOutcome: FreezeOutcome = FROZEN;
  /** What a shelve and an archive answer; null is a move from where the tab is, as TabManager does. */
  shelveOutcome: MoveOutcome | null = null;
  archiveOutcome: MoveOutcome | null = null;
  /**
   * How the operations fail: not at all, by rejecting, or by throwing at once. `shelve` answers
   * synchronously, so it can only throw: it ignores 'reject'.
   */
  failure: 'none' | 'reject' | 'throw' = 'none';

  constructor(private readonly time: ManualClock) {}

  /** A successful move of this tab, at its position among the tabs of `from`. */
  moved(tabId: TabId, from: PlacementMove['from'], to: PlacementMove['to']): MoveOutcome {
    const index = this.facts.filter((facts) => facts.placement === from).findIndex(isTab(tabId));
    return { outcome: 'moved', move: { tabId, from, to, index: Math.max(0, index) } };
  }

  lifecycleTabs(): TabFacts[] {
    this.reads += 1;
    if (this.readError !== null) {
      throw this.readError;
    }
    return [...this.facts];
  }

  discard(tabId: TabId, request: DiscardRequest): Promise<DiscardOutcome> {
    const settle = Promise.withResolvers<DiscardOutcome>();
    this.discards.push({ tabId, request, at: this.time.now, settle });
    if (this.failure === 'throw') {
      throw new Error('discard threw at once');
    }
    if (this.failure === 'reject') {
      return Promise.reject(new Error('discard rejected'));
    }
    if (!this.hold) {
      settle.resolve(this.discardOutcome);
    }
    return settle.promise;
  }

  freeze(tabId: TabId): Promise<FreezeOutcome> {
    const settle = Promise.withResolvers<FreezeOutcome>();
    this.freezes.push({ tabId, at: this.time.now, settle });
    if (this.failure === 'throw') {
      throw new Error('freeze threw at once');
    }
    if (this.failure === 'reject') {
      return Promise.reject(new Error('freeze rejected'));
    }
    if (!this.hold) {
      settle.resolve(this.freezeOutcome);
    }
    return settle.promise;
  }

  shelve(tabId: TabId, request: MoveRequest): MoveOutcome {
    this.shelves.push({ tabId, request, at: this.time.now });
    if (this.failure === 'throw') {
      throw new Error('shelve threw at once');
    }
    return this.shelveOutcome ?? this.moved(tabId, 'strip', 'shelf');
  }

  archive(tabId: TabId, request: MoveRequest): Promise<MoveOutcome> {
    const settle = Promise.withResolvers<MoveOutcome>();
    const from = this.facts.find(isTab(tabId))?.placement ?? 'shelf';
    const outcome = this.archiveOutcome ?? this.moved(tabId, from, 'archive');
    this.archives.push({ tabId, request, at: this.time.now, outcome, settle });
    if (this.failure === 'throw') {
      throw new Error('archive threw at once');
    }
    if (this.failure === 'reject') {
      return Promise.reject(new Error('archive rejected'));
    }
    if (!this.hold) {
      settle.resolve(outcome);
    }
    return settle.promise;
  }

  /** Settles every operation still held, with the default outcomes. */
  settleAll(): void {
    for (const call of this.discards) {
      call.settle.resolve(this.discardOutcome);
    }
    for (const call of this.freezes) {
      call.settle.resolve(this.freezeOutcome);
    }
    for (const call of this.archives) {
      call.settle.resolve(call.outcome);
    }
  }
}

function recordingLogger() {
  const events: { level: 'warn' | 'error'; event: string; fields?: unknown }[] = [];
  const logger: Logger = {
    warn: (event, fields) => {
      events.push({ level: 'warn', event, fields });
    },
    error: (event, fields) => {
      events.push({ level: 'error', event, fields });
    },
  };
  return { logger, events };
}

/** A live strip tab hidden for 5 minutes: nothing in the Balanced preset applies to it. */
function tab(id: TabId, overrides: Partial<TabFacts> = {}): TabFacts {
  return {
    id,
    placement: 'strip',
    runtime: 'live',
    pinned: false,
    selected: false,
    webPage: true,
    loading: false,
    busy: false,
    epoch: 1,
    hiddenSince: WALL0 - 5 * MINUTE,
    lastUsedAt: WALL0 - 6 * MINUTE,
    lastUsedEngaged: 0,
    lastUsedActiveDay: 1,
    lastInteractionAt: null,
    protections: [],
    ...overrides,
  };
}

/** A live tab hidden for `ms` when the test begins. Longer hidden is discarded first. */
const hiddenFor = (id: TabId, ms: number, overrides: Partial<TabFacts> = {}): TabFacts =>
  tab(id, { hiddenSince: WALL0 - ms, lastUsedAt: WALL0 - ms - MINUTE, ...overrides });

/** Tabs a, b, c… hidden for hours (discard-hidden applies), a the longest. */
const longHidden = (count: number): TabFacts[] =>
  'abcdefgh'
    .slice(0, count)
    .split('')
    .map((id, index) => hiddenFor(id, (10 - index) * HOUR));

/**
 * A Sleeping tab (not loaded) unused for 5 hours, since active day 1: with the active day at 10, or
 * anything three or more days on, archive-dormant applies to it. Pass a `runtime` for a loaded one.
 */
const dormant = (id: TabId, overrides: Partial<TabFacts> = {}): TabFacts =>
  tab(id, {
    placement: 'shelf',
    runtime: 'unloaded',
    lastUsedActiveDay: 1,
    lastUsedAt: WALL0 - 5 * HOUR,
    ...overrides,
  });

/**
 * A live strip tab unused for 3 engaged hours: with a cap of 1 and `keep` the tab within it (see
 * `shelving`), shelve-beyond-cap applies to it. The larger `age` (ms), the longer unused, so the
 * sooner it is shelved.
 */
const stale = (id: TabId, age = 0, overrides: Partial<TabFacts> = {}): TabFacts =>
  tab(id, { lastUsedAt: WALL0 - HOUR - age, lastUsedEngaged: 0, ...overrides });

/** The one tab inside a strip cap of 1: used just now, so nothing is planned for it. */
const keep = (): TabFacts => tab('keep', { lastUsedAt: WALL0, lastUsedEngaged: 3 * HOUR });

const outline = (records: readonly ActionRecord[]): string[] =>
  records.map((record) => `${record.kind}:${record.tabId}:${record.result.outcome}`);

interface BuildOptions {
  readonly tabs?: readonly TabFacts[];
  readonly settings?: Partial<LifecycleSettings>;
  readonly pressure?: MemoryPressure;
  readonly onAction?: (record: ActionRecord) => void;
  readonly onBatch?: (batch: MoveBatch) => void;
}

function build(options: BuildOptions = {}) {
  const time = new ManualClock();
  const tabs = new FakeTabs(time);
  tabs.facts = [...(options.tabs ?? [])];
  const state = {
    settings: { ...DEFAULT_LIFECYCLE_SETTINGS, ...options.settings },
    pressure: options.pressure ?? 'none',
    engagedNow: 0,
    activeDay: 1,
  };
  const actions: ActionRecord[] = [];
  const batches: MoveBatch[] = [];
  const { logger, events } = recordingLogger();
  const scheduler = new LifecycleScheduler({
    tabs,
    settings: () => state.settings,
    clock: () => ({
      wallNow: WALL0 + time.now,
      engagedNow: state.engagedNow,
      activeDay: state.activeDay,
    }),
    pressure: () => state.pressure,
    timers: time,
    logger,
    onAction: (record) => {
      actions.push(record);
      options.onAction?.(record);
    },
    onBatch: (batch) => {
      batches.push(batch);
      options.onBatch?.(batch);
    },
  });
  return {
    scheduler,
    time,
    tabs,
    state,
    actions,
    batches,
    events,
    setSettings: (patch: Partial<LifecycleSettings>): void => {
      state.settings = { ...state.settings, ...patch };
    },
    /** Changes what a tab's facts say, as TabManager would after acting on it. */
    update: (id: TabId, patch: Partial<TabFacts>): void => {
      tabs.facts = tabs.facts.map((facts) => (facts.id === id ? { ...facts, ...patch } : facts));
    },
    /** Evaluates, with time moving so staggered operations come due, and waits for it to settle. */
    evaluateFully: async (ms = 60_000): Promise<void> => {
      // allSettled keeps a rejection from being "unhandled" while time moves; it is rethrown below.
      const settled = Promise.allSettled([scheduler.evaluate()]);
      await time.advance(ms);
      const [result] = await settled;
      if (result.status === 'rejected') {
        throw new Error(`evaluate() rejected: ${String(result.reason)}`);
      }
    },
  };
}

type Harness = ReturnType<typeof build>;

/**
 * A harness where shelving and archiving apply to `stale` and `dormant` tabs: a strip cap of 1
 * (held by `keep`), 3 engaged hours in, on the 10th active day.
 */
function shelving(tabs: readonly TabFacts[], options: BuildOptions = {}): Harness {
  const h = build({
    ...options,
    tabs: [keep(), ...tabs],
    settings: { stripCap: 1, ...options.settings },
  });
  h.state.engagedNow = 3 * HOUR;
  h.state.activeDay = 10;
  return h;
}

describe('LifecycleScheduler: the quiet start and the tick', () => {
  it('does nothing until QUIET_START_MS, then evaluates', async () => {
    const h = build({ tabs: longHidden(1) });
    h.scheduler.start();
    expect(h.time.pending).toEqual([QUIET_START_MS]);

    await h.time.advance(QUIET_START_MS - 1);
    expect(h.tabs.reads).toBe(0);
    expect(h.tabs.discards).toEqual([]);
    expect(h.scheduler.log()).toEqual([]);

    await h.time.advance(1);
    expect(h.tabs.reads).toBe(1);
    expect(h.tabs.discards.map((call) => call.tabId)).toEqual(['a']);
  });

  it('does not evaluate by itself before start()', async () => {
    const h = build({ tabs: longHidden(1) });
    await h.time.advance(10 * QUIET_START_MS);
    expect(h.tabs.reads).toBe(0);
  });

  it('ignores triggers during the quiet start', async () => {
    const h = build({ tabs: longHidden(1) });
    h.scheduler.trigger(); // not even started
    h.scheduler.start();
    h.scheduler.trigger();
    await h.time.advance(QUIET_START_MS - 500);
    h.scheduler.trigger();
    expect(h.time.pending).toEqual([QUIET_START_MS]); // only the quiet start's own timer
    expect(h.tabs.reads).toBe(0);

    await h.time.advance(500); // the quiet start ends: one evaluation
    expect(h.tabs.reads).toBe(1);
    await h.time.advance(TRIGGER_DELAY_MS); // where the ignored trigger would have fired
    expect(h.tabs.reads).toBe(1);
  });

  it('then evaluates every TICK_MS after the previous evaluation', async () => {
    const h = build();
    h.scheduler.start();
    await h.time.advance(QUIET_START_MS);
    expect(h.tabs.reads).toBe(1);
    expect(h.time.pending).toEqual([TICK_MS]);

    await h.time.advance(TICK_MS - 1);
    expect(h.tabs.reads).toBe(1);
    await h.time.advance(1);
    expect(h.tabs.reads).toBe(2);
    await h.time.advance(TICK_MS);
    expect(h.tabs.reads).toBe(3);
    await h.time.advance(5 * TICK_MS);
    expect(h.tabs.reads).toBe(8);
  });

  it('counts the tick from when the evaluation settled, which includes its staggered operations', async () => {
    const h = build({ tabs: longHidden(2) });
    h.scheduler.start();
    await h.time.advance(QUIET_START_MS + STAGGER_MS); // a at 0 s, b one stagger later: settled
    expect(h.tabs.discards.map((call) => call.at)).toEqual([
      QUIET_START_MS,
      QUIET_START_MS + STAGGER_MS,
    ]);
    expect(h.time.pending).toEqual([TICK_MS]);
    h.tabs.facts = [];

    await h.time.advance(TICK_MS - 1);
    expect(h.tabs.reads).toBe(1);
    await h.time.advance(1);
    expect(h.tabs.reads).toBe(2);
  });

  it('waits for an operation that has not settled before it schedules the next tick', async () => {
    const h = build({ tabs: longHidden(1) });
    h.tabs.hold = true;
    h.scheduler.start();
    await h.time.advance(QUIET_START_MS);
    expect(h.tabs.discards).toHaveLength(1);
    expect(h.time.pending).toEqual([]); // no tick while the discard is out

    await h.time.advance(5 * TICK_MS);
    expect(h.tabs.reads).toBe(1);

    h.tabs.facts = [];
    h.tabs.settleAll();
    await flush();
    expect(h.time.pending).toEqual([TICK_MS]);
    await h.time.advance(TICK_MS - 1);
    expect(h.tabs.reads).toBe(1);
    await h.time.advance(1);
    expect(h.tabs.reads).toBe(2);
  });

  it('keeps ticking after an evaluation whose plan failed', async () => {
    const h = build({ tabs: longHidden(1) });
    h.tabs.readError = new Error('TabManager bug');
    h.scheduler.start();
    await h.time.advance(QUIET_START_MS);
    expect(h.tabs.reads).toBe(1);
    expect(h.time.pending).toEqual([TICK_MS]);

    h.tabs.readError = null;
    await h.time.advance(TICK_MS);
    expect(h.tabs.discards.map((call) => call.tabId)).toEqual(['a']);
  });
});

describe('LifecycleScheduler: triggers', () => {
  /** A started scheduler whose quiet start is over and whose first evaluation has settled. */
  async function afterQuietStart(options: BuildOptions = {}): Promise<Harness> {
    const h = build(options);
    h.scheduler.start();
    await h.time.advance(QUIET_START_MS);
    return h;
  }

  it('evaluates once after TRIGGER_DELAY_MS, however many triggers arrive meanwhile', async () => {
    const h = await afterQuietStart();
    const baseline = h.tabs.reads;

    for (let i = 0; i < 5; i += 1) {
      h.scheduler.trigger();
      await h.time.advance(100);
    }
    expect(h.time.pending.filter((ms) => ms === TRIGGER_DELAY_MS)).toHaveLength(1);

    await h.time.advance(TRIGGER_DELAY_MS - 500 - 1); // one ms before the first trigger's delay is up
    expect(h.tabs.reads).toBe(baseline);
    await h.time.advance(1);
    expect(h.tabs.reads).toBe(baseline + 1);
    await h.time.advance(5 * TRIGGER_DELAY_MS);
    expect(h.tabs.reads).toBe(baseline + 1);
  });

  it('evaluates again for a trigger that comes after the last evaluation', async () => {
    const h = await afterQuietStart();
    const baseline = h.tabs.reads;
    h.scheduler.trigger();
    await h.time.advance(TRIGGER_DELAY_MS);
    h.scheduler.trigger();
    await h.time.advance(TRIGGER_DELAY_MS);
    expect(h.tabs.reads).toBe(baseline + 2);
  });

  it('acts on what the trigger found, without waiting for the tick', async () => {
    const h = await afterQuietStart();
    h.tabs.facts = longHidden(1);
    h.scheduler.trigger();
    await h.time.advance(TRIGGER_DELAY_MS - 1);
    expect(h.tabs.discards).toEqual([]);
    await h.time.advance(1);
    expect(h.tabs.discards.map((call) => call.tabId)).toEqual(['a']);
  });
});

describe('LifecycleScheduler: limits and stagger', () => {
  it('starts at most MAX_DISCARDS_PER_EVALUATION discards, STAGGER_MS apart, and logs the rest as rate-limited', async () => {
    expect(MAX_DISCARDS_PER_EVALUATION).toBe(3);
    const h = build({ tabs: longHidden(5) });
    await h.evaluateFully();

    // The longest hidden first, the first at once, the others a stagger after each other.
    expect(h.tabs.discards.map((call) => [call.tabId, call.at])).toEqual([
      ['a', 0],
      ['b', STAGGER_MS],
      ['c', 2 * STAGGER_MS],
    ]);
    const log = h.scheduler.log();
    const withOutcome = (name: string): string[] =>
      log.filter((record) => record.result.outcome === name).map((record) => record.tabId);
    expect(withOutcome('discarded').sort()).toEqual(['a', 'b', 'c']);
    expect(withOutcome('rate-limited')).toEqual(['d', 'e']);
    for (const record of log.filter((entry) => entry.result.outcome === 'rate-limited')) {
      expect(record).toMatchObject({ kind: 'discard', rule: 'discard-hidden' });
    }
  });

  it('does not wait for the actions it will not start: the evaluation ends with the last started one', async () => {
    const h = build({ tabs: longHidden(5) });
    const done = new Tracked(h.scheduler.evaluate());
    await h.time.advance(2 * STAGGER_MS);
    expect(done.settled).toBe(true);
  });

  it('plans the rate-limited ones again at the next evaluation, if they still apply', async () => {
    const h = build({ tabs: longHidden(5) });
    await h.evaluateFully();
    for (const id of ['a', 'b', 'c']) {
      h.update(id, { runtime: 'unloaded' }); // what TabManager did
    }
    await h.evaluateFully();

    expect(h.tabs.discards.map((call) => call.tabId)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(
      outline(h.scheduler.log())
        .filter((line) => line.endsWith(':discarded'))
        .sort(),
    ).toEqual([
      'discard:a:discarded',
      'discard:b:discarded',
      'discard:c:discarded',
      'discard:d:discarded',
      'discard:e:discarded',
    ]);
  });

  it('starts at most MAX_FREEZES_PER_EVALUATION freezes, STAGGER_MS apart, and logs the rest as rate-limited', async () => {
    expect(MAX_FREEZES_PER_EVALUATION).toBe(3);
    const tabs = ['a', 'b', 'c', 'd', 'e'].map(
      (id, index) => hiddenFor(id, (50 - index) * MINUTE), // 50 down to 46 minutes: frozen, not yet discarded
    );
    const h = build({ tabs, settings: { freeze: true } });
    await h.evaluateFully();

    expect(h.tabs.discards).toEqual([]);
    expect(h.tabs.freezes.map((call) => [call.tabId, call.at])).toEqual([
      ['a', 0],
      ['b', STAGGER_MS],
      ['c', 2 * STAGGER_MS],
    ]);
    const log = h.scheduler.log();
    expect(log.filter((record) => record.result.outcome === 'frozen')).toHaveLength(3);
    expect(
      log
        .filter((record) => record.result.outcome === 'rate-limited')
        .map((record) => record.tabId),
    ).toEqual(['d', 'e']);
    expect(log.every((record) => record.kind === 'freeze' && record.rule === 'freeze-hidden')).toBe(
      true,
    );
  });

  it('limits discards and freezes separately, and staggers them together', async () => {
    const discarded = ['a', 'b', 'c', 'd'].map((id, index) => hiddenFor(id, (10 - index) * HOUR));
    const frozen = ['e', 'f', 'g', 'h'].map((id, index) => hiddenFor(id, (50 - index) * MINUTE));
    const h = build({ tabs: [...discarded, ...frozen], settings: { freeze: true } });
    await h.evaluateFully();

    expect(h.tabs.discards.map((call) => [call.tabId, call.at])).toEqual([
      ['a', 0],
      ['b', STAGGER_MS],
      ['c', 2 * STAGGER_MS],
    ]);
    expect(h.tabs.freezes.map((call) => [call.tabId, call.at])).toEqual([
      ['e', 3 * STAGGER_MS],
      ['f', 4 * STAGGER_MS],
      ['g', 5 * STAGGER_MS],
    ]);
    expect(
      h.scheduler
        .log()
        .filter((record) => record.result.outcome === 'rate-limited')
        .map((record) => `${record.kind}:${record.tabId}`),
    ).toEqual(['discard:d', 'freeze:h']);
  });

  it('starts nothing for a plan with nothing in it', async () => {
    const h = build({ tabs: [tab('a'), tab('b', { selected: true })] });
    await h.evaluateFully();
    expect(h.tabs.discards).toEqual([]);
    expect(h.tabs.freezes).toEqual([]);
    expect(h.scheduler.log()).toEqual([]);
    expect(h.time.pending).toEqual([]);
  });
});

describe('LifecycleScheduler: what a request carries and what is logged', () => {
  const scenarios: readonly {
    readonly name: string;
    readonly pressure: MemoryPressure;
    readonly hiddenMs: number;
    readonly rule: string;
    readonly origin: DiscardRequest['origin'];
    readonly overrideSoft: boolean;
  }[] = [
    {
      name: 'a tab hidden long enough is an automation discard that overrides nothing',
      pressure: 'none',
      hiddenMs: 2 * HOUR,
      rule: 'discard-hidden',
      origin: 'automation',
      overrideSoft: false,
    },
    {
      name: 'moderate pressure is a pressure discard that overrides nothing',
      pressure: 'moderate',
      hiddenMs: 20 * MINUTE,
      rule: 'pressure-discard',
      origin: 'pressure',
      overrideSoft: false,
    },
    {
      name: 'critical pressure is a pressure discard that overrides soft protections',
      pressure: 'critical',
      hiddenMs: 5 * MINUTE,
      rule: 'pressure-discard',
      origin: 'pressure',
      overrideSoft: true,
    },
    {
      name: 'under pressure a long-hidden tab is still a pressure discard',
      pressure: 'critical',
      hiddenMs: 2 * HOUR,
      rule: 'pressure-discard',
      origin: 'pressure',
      overrideSoft: true,
    },
  ];

  it.each(scenarios)('$name', async ({ pressure, hiddenMs, rule, origin, overrideSoft }) => {
    const h = build({ tabs: [hiddenFor('a', hiddenMs, { epoch: 7 })], pressure });
    await h.evaluateFully();

    const call = pick(h.tabs.discards, 0, 'discard');
    expect(call.tabId).toBe('a');
    expect(call.request).toStrictEqual({ origin, epoch: 7, overrideSoft });
    expect(h.scheduler.log()).toEqual([
      {
        tabId: 'a',
        kind: 'discard',
        rule,
        epoch: 7,
        overrideSoft,
        at: WALL0,
        batchId: 'batch-1',
        pressure, // the "why" of a pressure discard names it (M3.4)
        result: DISCARDED,
      },
    ]);
  });

  it.each<[string, DiscardOutcome]>([
    ['discarded', DISCARDED],
    ['skipped as stale', { outcome: 'skipped', why: 'stale' }],
    ['skipped as selected', { outcome: 'skipped', why: 'selected' }],
    ['blocked by audio', { outcome: 'blocked', reason: 'audio' }],
    ['blocked by an unanswered probe', { outcome: 'blocked', reason: 'probe-unanswered' }],
  ])('logs the outcome TabManager gave for a discard: %s', async (_name, outcome) => {
    const h = build({ tabs: longHidden(1) });
    h.tabs.discardOutcome = outcome;
    await h.evaluateFully();
    expect(pick(h.scheduler.log(), 0, 'record').result).toBe(outcome);
  });

  it.each<[string, FreezeOutcome]>([
    ['frozen', FROZEN],
    ['failed', { outcome: 'failed' }],
    ['skipped', { outcome: 'skipped', why: 'cancelled' }],
    ['blocked', { outcome: 'blocked', reason: 'capture' }],
  ])('logs the outcome TabManager gave for a freeze: %s', async (_name, outcome) => {
    const h = build({
      tabs: [hiddenFor('a', 30 * MINUTE, { epoch: 4 })],
      settings: { freeze: true },
    });
    h.tabs.freezeOutcome = outcome;
    await h.evaluateFully();

    expect(h.tabs.freezes.map((call) => call.tabId)).toEqual(['a']);
    expect(h.scheduler.log()).toEqual([
      {
        tabId: 'a',
        kind: 'freeze',
        rule: 'freeze-hidden',
        epoch: 4,
        overrideSoft: false,
        at: WALL0,
        batchId: 'batch-1',
        pressure: 'none',
        result: outcome,
      },
    ]);
  });

  it('stamps every record of an evaluation with the wall time at which it began', async () => {
    const h = build({ tabs: longHidden(5) });
    await h.time.advance(7_000);
    await h.evaluateFully();

    expect(h.tabs.discards.map((call) => call.at)).toEqual([7_000, 8_000, 9_000]);
    expect(h.scheduler.log().map((record) => record.at)).toEqual(Array(5).fill(WALL0 + 7_000));
  });

  it('gives onAction each record, as it is logged', async () => {
    const h = build({ tabs: longHidden(5) });
    await h.evaluateFully();
    expect(h.actions).toHaveLength(5);
    expect(h.actions).toEqual(h.scheduler.log());
    for (const record of h.scheduler.log()) {
      expect(h.actions).toContain(record);
    }
  });

  it('gives every record the batch of its evaluation: batch-1, batch-2…, one per evaluation', async () => {
    const h = build({ tabs: longHidden(5) });
    await h.evaluateFully(); // a, b, c discarded; d and e left over the limit
    for (const id of ['a', 'b', 'c']) {
      h.update(id, { runtime: 'unloaded' });
    }
    await h.evaluateFully(); // d and e
    for (const id of ['d', 'e']) {
      h.update(id, { runtime: 'unloaded' });
    }
    await h.evaluateFully(); // nothing to do, but an evaluation all the same
    h.update('a', { runtime: 'live' });
    await h.evaluateFully();

    expect(
      h.scheduler
        .log()
        .map((record) => `${record.batchId}:${record.tabId}:${record.result.outcome}`)
        .sort(),
    ).toEqual([
      'batch-1:a:discarded',
      'batch-1:b:discarded',
      'batch-1:c:discarded',
      'batch-1:d:rate-limited',
      'batch-1:e:rate-limited',
      'batch-2:d:discarded',
      'batch-2:e:discarded',
      'batch-4:a:discarded',
    ]);
  });

  it('stamps every record with the pressure as it was when its evaluation began', async () => {
    const h = build({ tabs: longHidden(3), pressure: 'moderate' });
    const done = new Tracked(h.scheduler.evaluate());
    await h.time.advance(STAGGER_MS / 2);
    h.state.pressure = 'critical'; // b and c are still waiting their turn
    await h.time.advance(5 * STAGGER_MS);
    expect(done.settled).toBe(true);
    expect(h.scheduler.log().map((record) => record.pressure)).toEqual([
      'moderate',
      'moderate',
      'moderate',
    ]);

    for (const id of ['a', 'b', 'c']) {
      h.update(id, { runtime: 'unloaded' });
    }
    h.tabs.facts = [...h.tabs.facts, hiddenFor('d', 9 * HOUR)];
    await h.evaluateFully();
    expect(pick(h.scheduler.log(), 3, 'record')).toMatchObject({
      tabId: 'd',
      rule: 'pressure-discard',
      pressure: 'critical',
    });
  });

  it('sends each action to its own TabManager operation: a discard beside a shelve', async () => {
    const h = shelving([...longHidden(1), stale('old')]);
    await h.evaluateFully();

    expect(h.tabs.discards.map((call) => call.tabId)).toEqual(['a']);
    expect(h.tabs.shelves.map((call) => call.tabId)).toEqual(['old']);
    expect(h.tabs.freezes).toEqual([]);
    expect(h.tabs.archives).toEqual([]);
    expect(outline(h.scheduler.log()).sort()).toEqual(['discard:a:discarded', 'shelve:old:moved']);
  });
});

/** What a shelve or an archive was asked, without the means to settle it. */
const asked = (calls: readonly ShelveCall[]) =>
  calls.map(({ tabId, request, at }) => ({ tabId, request, at }));

describe('LifecycleScheduler: shelves and archives', () => {
  /** A strip tab beyond the cap and stale (shelve), and a Sleeping tab unused for days (archive). */
  const shelveAndArchive = (): Harness =>
    shelving([stale('old', 0, { epoch: 5 }), dormant('dormant')]);

  it('carries each out as an automation move with the epoch the decision saw, and logs where it went', async () => {
    const h = shelveAndArchive();
    await h.evaluateFully();

    // toStrictEqual: a move request carries nothing else (only a discard has overrideSoft).
    expect(asked(h.tabs.shelves)).toStrictEqual([
      { tabId: 'old', request: { origin: 'automation', epoch: 5 }, at: 0 },
    ]);
    expect(asked(h.tabs.archives)).toStrictEqual([
      { tabId: 'dormant', request: { origin: 'automation', epoch: 1 }, at: 0 },
    ]);
    expect(h.tabs.discards).toEqual([]);
    expect(h.tabs.freezes).toEqual([]);
    expect(h.scheduler.log()).toEqual([
      {
        tabId: 'old',
        kind: 'shelve',
        rule: 'shelve-beyond-cap',
        epoch: 5,
        overrideSoft: false,
        at: WALL0,
        batchId: 'batch-1',
        pressure: 'none',
        result: { outcome: 'moved', move: { tabId: 'old', from: 'strip', to: 'shelf', index: 1 } },
      },
      {
        tabId: 'dormant',
        kind: 'archive',
        rule: 'archive-dormant',
        epoch: 1,
        overrideSoft: false,
        at: WALL0,
        batchId: 'batch-1',
        pressure: 'none',
        result: {
          outcome: 'moved',
          move: { tabId: 'dormant', from: 'shelf', to: 'archive', index: 0 },
        },
      },
    ]);
    expect(h.time.pending).toEqual([]); // nothing waited
  });

  it('archives a tab from the strip as from the strip', async () => {
    // Not reachable through the policy (it archives Sleeping tabs only), but the move reports
    // where the tab was, which is what TabManager's answer says: the scheduler passes it on.
    const h = shelveAndArchive();
    h.tabs.archiveOutcome = {
      outcome: 'moved',
      move: { tabId: 'dormant', from: 'strip', to: 'archive', index: 4 },
    };
    await h.evaluateFully();
    expect(pick(h.scheduler.log(), 1, 'record').result).toBe(h.tabs.archiveOutcome);
  });

  it.each<[string, MoveOutcome]>([
    ['moved', { outcome: 'moved', move: { tabId: 'x', from: 'strip', to: 'shelf', index: 3 } }],
    ['skipped as stale', { outcome: 'skipped', why: 'stale' }],
    ['skipped as pinned', { outcome: 'skipped', why: 'pinned' }],
    ['skipped as in the wrong placement', { outcome: 'skipped', why: 'wrong-placement' }],
    ['blocked by capture', { outcome: 'blocked', reason: 'capture' }],
    ['blocked by an unanswered probe', { outcome: 'blocked', reason: 'probe-unanswered' }],
  ])(
    'logs the outcome TabManager gave for a shelve and for an archive: %s',
    async (_name, outcome) => {
      const h = shelveAndArchive();
      h.tabs.shelveOutcome = outcome;
      h.tabs.archiveOutcome = outcome;
      await h.evaluateFully();

      expect(h.scheduler.log().map((record) => record.kind)).toEqual(['shelve', 'archive']);
      for (const record of h.scheduler.log()) {
        expect(record.result).toBe(outcome);
      }
    },
  );

  it('stamps them with the pressure too, though pressure itself never moves a tab', async () => {
    const h = shelving([stale('old'), dormant('dormant')], { pressure: 'moderate' });
    await h.evaluateFully();
    expect(h.scheduler.log().map((record) => [record.kind, record.pressure])).toEqual([
      ['shelve', 'moderate'],
      ['archive', 'moderate'],
    ]);
  });

  it('does not log a move as planned: it is carried out, or it is not planned', async () => {
    const h = shelveAndArchive();
    await h.evaluateFully();
    h.update('old', { lastUsedEngaged: 3 * HOUR }); // used meanwhile: out of the plan
    h.update('dormant', { lastUsedActiveDay: 10 });
    await h.evaluateFully();
    expect(outline(h.scheduler.log())).toEqual(['shelve:old:moved', 'archive:dormant:moved']);
  });
});

describe('LifecycleScheduler: what a shelve or an archive costs', () => {
  /** Three discards that spend the budget, then a live and an unloaded Sleeping tab due for the Archive. */
  const budgetSpent = (): Harness =>
    shelving([
      ...longHidden(3),
      dormant('liveSleeper', { runtime: 'live' }), // unused longest: archived first
      dormant('sleeper', { lastUsedAt: WALL0 - 4 * HOUR }),
    ]);

  it('limits and staggers nothing for shelves, nor for archives of tabs that are not loaded', async () => {
    // More of each than MAX_DISCARDS_PER_EVALUATION, which would have limited them as discards.
    const shelved = [1, 2, 3, 4, 5].map((n) => stale(`s${String(n)}`, 10 - n)); // s1 is stalest
    const archived = [1, 2, 3, 4].map((n) =>
      dormant(`d${String(n)}`, { lastUsedAt: WALL0 - 5 * HOUR + n }),
    );
    const h = shelving([...shelved, ...archived]);
    await h.evaluateFully();

    expect(h.tabs.shelves.map((call) => [call.tabId, call.at])).toEqual(
      ['s1', 's2', 's3', 's4', 's5'].map((id) => [id, 0]),
    );
    expect(h.tabs.archives.map((call) => [call.tabId, call.at])).toEqual(
      ['d1', 'd2', 'd3', 'd4'].map((id) => [id, 0]),
    );
    expect(h.scheduler.log()).toHaveLength(9);
    expect(h.scheduler.log().every((record) => record.result.outcome === 'moved')).toBe(true);
    expect(h.time.pending).toEqual([]); // nothing waited
  });

  it('does not count them against the discard limit or add to the stagger', async () => {
    const h = shelving([...longHidden(5), stale('old'), dormant('dormant')]);
    await h.evaluateFully();

    expect(h.tabs.discards.map((call) => [call.tabId, call.at])).toEqual([
      ['a', 0],
      ['b', STAGGER_MS],
      ['c', 2 * STAGGER_MS],
    ]);
    // They follow the discards in the plan, so they start once the last discard has: with no
    // stagger of their own (that would be 3 s) and not held back by the two left over the limit.
    expect(h.tabs.shelves.map((call) => [call.tabId, call.at])).toEqual([['old', 2 * STAGGER_MS]]);
    expect(h.tabs.archives.map((call) => [call.tabId, call.at])).toEqual([
      ['dormant', 2 * STAGGER_MS],
    ]);
    expect(outline(h.scheduler.log()).sort()).toEqual([
      'archive:dormant:moved',
      'discard:a:discarded',
      'discard:b:discarded',
      'discard:c:discarded',
      'discard:d:rate-limited',
      'discard:e:rate-limited',
      'shelve:old:moved',
    ]);
  });

  it.each<RuntimeState>(['live', 'frozen'])(
    'staggers archives of %s tabs like discards, and limits them to MAX_DISCARDS_PER_EVALUATION',
    async (runtime) => {
      const sleepers = [1, 2, 3, 4].map((n) =>
        dormant(`d${String(n)}`, { runtime, lastUsedAt: WALL0 - 5 * HOUR + n }),
      );
      const h = shelving(sleepers);
      await h.evaluateFully();

      expect(h.tabs.archives.map((call) => [call.tabId, call.at])).toEqual([
        ['d1', 0],
        ['d2', STAGGER_MS],
        ['d3', 2 * STAGGER_MS],
      ]);
      expect(outline(h.scheduler.log()).sort()).toEqual([
        'archive:d1:moved',
        'archive:d2:moved',
        'archive:d3:moved',
        'archive:d4:rate-limited',
      ]);
      expect(pick(h.batches, 0, 'batch').moves.map((move) => move.tabId)).toEqual([
        'd1',
        'd2',
        'd3',
      ]);
    },
  );

  it.each<RuntimeState>(['unloaded', 'crashed', 'creating'])(
    'treats an archive of a %s tab as free even when the discards have spent the budget',
    async (runtime) => {
      const h = shelving([...longHidden(3), dormant('sleeper', { runtime })]);
      await h.evaluateFully();
      expect(h.tabs.archives.map((call) => call.tabId)).toEqual(['sleeper']);
      expect(pick(h.scheduler.log().slice(-1), 0, 'record').result.outcome).toBe('moved');
    },
  );

  it('rate-limits an archive of a live tab once three discards have spent the budget, and still archives an unloaded one', async () => {
    const h = budgetSpent();
    await h.evaluateFully();

    expect(h.tabs.discards.map((call) => [call.tabId, call.at])).toEqual([
      ['a', 0],
      ['b', STAGGER_MS],
      ['c', 2 * STAGGER_MS],
    ]);
    expect(h.tabs.archives.map((call) => [call.tabId, call.at])).toEqual([
      ['sleeper', 2 * STAGGER_MS],
    ]);
    expect(outline(h.scheduler.log()).sort()).toEqual([
      'archive:liveSleeper:rate-limited',
      'archive:sleeper:moved',
      'discard:a:discarded',
      'discard:b:discarded',
      'discard:c:discarded',
    ]);
    expect(
      h.scheduler.log().find((record) => record.result.outcome === 'rate-limited'),
    ).toMatchObject({ kind: 'archive', rule: 'archive-dormant', batchId: 'batch-1' });
    // Only what moved is in the batch; the live Sleeping tab waits for a later evaluation.
    expect(pick(h.batches, 0, 'batch').moves.map((move) => move.tabId)).toEqual(['sleeper']);
  });

  it('logs the rate-limited archive once while it stays limited, and carries it out when the budget is free again', async () => {
    const h = budgetSpent();
    await h.evaluateFully();
    await h.evaluateFully(); // a, b and c still look live to the policy: the budget is spent again

    const limited = (): string[] =>
      outline(h.scheduler.log()).filter((line) => line === 'archive:liveSleeper:rate-limited');
    expect(limited()).toHaveLength(1);
    expect(h.tabs.archives.map((call) => call.tabId)).not.toContain('liveSleeper');

    for (const id of ['a', 'b', 'c']) {
      h.update(id, { runtime: 'unloaded' }); // what TabManager did
    }
    await h.evaluateFully();
    expect(limited()).toHaveLength(1);
    expect(
      h.tabs.archives.filter((call) => call.tabId === 'liveSleeper').map((call) => call.at),
    ).toEqual([2 * 60_000]); // the third evaluation, with the budget unspent: at once
  });

  it('staggers only the archives that cost: an unloaded one between two live ones adds no wait', async () => {
    const h = shelving([
      dormant('live1', { runtime: 'live', lastUsedAt: WALL0 - 6 * HOUR }),
      dormant('asleep', { lastUsedAt: WALL0 - 5 * HOUR }),
      dormant('live2', { runtime: 'live', lastUsedAt: WALL0 - 4 * HOUR }),
    ]);
    await h.evaluateFully();
    expect(h.tabs.archives.map((call) => [call.tabId, call.at])).toEqual([
      ['live1', 0],
      ['asleep', 0],
      ['live2', STAGGER_MS],
    ]);
  });

  it('staggers an archive of a live tab after the discard before it', async () => {
    const h = shelving([hiddenFor('a', 10 * HOUR), dormant('sleeper', { runtime: 'live' })]);
    await h.evaluateFully();
    expect(h.tabs.discards.map((call) => [call.tabId, call.at])).toEqual([['a', 0]]);
    expect(h.tabs.archives.map((call) => [call.tabId, call.at])).toEqual([['sleeper', STAGGER_MS]]);
  });

  it('staggers it after freezes too, but freezes do not use up its budget', async () => {
    const frozen = [50, 49, 48].map((minutes, index) =>
      hiddenFor(`f${String(index)}`, minutes * MINUTE),
    );
    const h = shelving([...frozen, dormant('sleeper', { runtime: 'live' })], {
      settings: { freeze: true },
    });
    await h.evaluateFully();

    expect(h.tabs.freezes.map((call) => [call.tabId, call.at])).toEqual([
      ['f0', 0],
      ['f1', STAGGER_MS],
      ['f2', 2 * STAGGER_MS],
    ]);
    expect(h.tabs.archives.map((call) => [call.tabId, call.at])).toEqual([
      ['sleeper', 3 * STAGGER_MS],
    ]);
    expect(pick(h.scheduler.log().slice(-1), 0, 'record').result.outcome).toBe('moved');
  });
});

describe('LifecycleScheduler: the batch of moves', () => {
  /** The moves of `shelving([stale('old'), dormant('d1', older), dormant('d2')])`, in plan order. */
  const OLD = { tabId: 'old', from: 'strip', to: 'shelf', index: 1 } as const;
  const D1 = { tabId: 'd1', from: 'shelf', to: 'archive', index: 0 } as const;
  const D2 = { tabId: 'd2', from: 'shelf', to: 'archive', index: 1 } as const;
  const threeMoves = (): Harness =>
    shelving([stale('old'), dormant('d1', { lastUsedAt: WALL0 - 6 * HOUR }), dormant('d2')]);

  it('is delivered once, when every action has settled, with the moves in the order their results arrived', async () => {
    const h = threeMoves();
    h.tabs.hold = true;
    const done = new Tracked(h.scheduler.evaluate());
    await flush();
    expect(h.tabs.archives.map((call) => call.tabId)).toEqual(['d1', 'd2']);
    expect(h.actions.map((record) => record.tabId)).toEqual(['old']); // a shelve answers at once

    const [first, second] = [
      pick(h.tabs.archives, 0, 'archive'),
      pick(h.tabs.archives, 1, 'archive'),
    ];
    second.settle.resolve(second.outcome); // d2 before d1
    await flush();
    expect(h.batches).toEqual([]); // d1 is still out
    expect(done.settled).toBe(false);

    first.settle.resolve(first.outcome);
    await flush();
    expect(done.settled).toBe(true);
    expect(h.actions.map((record) => record.tabId)).toEqual(['old', 'd2', 'd1']);
    expect(h.batches).toEqual([{ id: 'batch-1', at: WALL0, moves: [OLD, D2, D1] }]);
  });

  it('is not delivered when the scheduler stopped while an archive was settling (shutdown)', async () => {
    const h = threeMoves();
    h.tabs.hold = true;
    const done = new Tracked(h.scheduler.evaluate());
    await flush();
    h.scheduler.stop();
    h.tabs.settleAll();
    await flush();
    expect(done.settled).toBe(true);
    expect(h.actions.map((record) => record.tabId)).toEqual(['old', 'd1', 'd2']);
    expect(h.batches).toEqual([]);
  });

  it('has been delivered by the time evaluate() resolves', async () => {
    const h = threeMoves();
    await h.scheduler.evaluate();
    expect(h.batches.map((batch) => batch.id)).toEqual(['batch-1']);
  });

  it('waits for a discard still out, though the moves are done', async () => {
    const h = shelving([...longHidden(1), stale('old')]);
    h.tabs.hold = true;
    const done = new Tracked(h.scheduler.evaluate());
    await flush();
    expect(h.actions.map((record) => record.tabId)).toEqual(['old']);
    expect(h.batches).toEqual([]);

    pick(h.tabs.discards, 0, 'discard').settle.resolve(DISCARDED);
    await flush();
    expect(done.settled).toBe(true);
    // old is the third strip tab here: keep, a, old.
    expect(h.batches).toEqual([{ id: 'batch-1', at: WALL0, moves: [{ ...OLD, index: 2 }] }]);
  });

  it('holds only the moves that happened', async () => {
    const skipped = threeMoves();
    skipped.tabs.shelveOutcome = { outcome: 'skipped', why: 'stale' };
    await skipped.evaluateFully();
    expect(skipped.batches).toEqual([{ id: 'batch-1', at: WALL0, moves: [D1, D2] }]);

    const blocked = threeMoves();
    blocked.tabs.archiveOutcome = { outcome: 'blocked', reason: 'capture' };
    await blocked.evaluateFully();
    expect(blocked.batches).toEqual([{ id: 'batch-1', at: WALL0, moves: [OLD] }]);
  });

  it('leaves out the move of an action that failed, and goes on with the others', async () => {
    const h = threeMoves();
    h.tabs.failure = 'reject'; // the archives reject; the shelve answers
    await h.evaluateFully();
    expect(h.batches).toEqual([{ id: 'batch-1', at: WALL0, moves: [OLD] }]);
  });

  it.each<[string, MoveOutcome]>([
    ['skipped', { outcome: 'skipped', why: 'stale' }],
    ['blocked', { outcome: 'blocked', reason: 'capture' }],
  ])('is not delivered when every move was %s', async (_name, outcome) => {
    const h = threeMoves();
    h.tabs.shelveOutcome = outcome;
    h.tabs.archiveOutcome = outcome;
    await h.evaluateFully();
    expect(h.scheduler.log()).toHaveLength(3);
    expect(h.batches).toEqual([]);
  });

  it('is not delivered when every action failed', async () => {
    const h = threeMoves();
    h.tabs.failure = 'throw';
    await h.evaluateFully();
    expect(h.scheduler.log()).toEqual([]);
    expect(h.batches).toEqual([]);
  });

  it('is not delivered for an evaluation that only discarded (some left over the limit) or planned nothing', async () => {
    const h = build({ tabs: longHidden(5) });
    await h.evaluateFully();
    expect(h.scheduler.log()).toHaveLength(5);
    expect(h.batches).toEqual([]);

    const idle = build({ tabs: [tab('a')] });
    await idle.evaluateFully();
    expect(idle.batches).toEqual([]);
  });

  it('is not delivered for moves that were paused before their turn', async () => {
    const h = shelving([...longHidden(2), stale('old'), dormant('sleeper')]);
    const done = new Tracked(h.scheduler.evaluate());
    await h.time.advance(STAGGER_MS / 2); // a is discarded; b waits its stagger, the moves behind it
    h.setSettings({ paused: true });
    await h.time.advance(5 * STAGGER_MS);
    expect(done.settled).toBe(true);
    expect(outline(h.scheduler.log())).toEqual([
      'discard:a:discarded',
      'discard:b:paused',
      'shelve:old:paused',
      'archive:sleeper:paused',
    ]);
    expect(h.batches).toEqual([]);
  });

  it('is one per evaluation, numbered with the evaluation even when an earlier one moved nothing', async () => {
    const h = shelving([stale('old')]);
    await h.evaluateFully();
    h.update('old', { lastUsedEngaged: 3 * HOUR }); // used meanwhile: nothing to shelve
    await h.evaluateFully();
    h.update('old', { lastUsedEngaged: 0 });
    await h.evaluateFully();

    expect(h.batches.map((batch) => [batch.id, batch.at, batch.moves.length])).toEqual([
      ['batch-1', WALL0, 1],
      ['batch-3', WALL0 + 2 * 60_000, 1],
    ]);
  });

  it('carries the wall time at which the evaluation began, as every record does, and the id of its records', async () => {
    const h = shelving([...longHidden(2), stale('old'), dormant('sleeper')]);
    await h.time.advance(7_000);
    await h.evaluateFully();

    // The shelve ran a stagger after the evaluation began (it follows the second discard).
    expect(pick(h.tabs.shelves, 0, 'shelve').at).toBe(8_000);
    const batch = pick(h.batches, 0, 'batch');
    expect(batch.at).toBe(WALL0 + 7_000);
    expect(batch.moves.map((move) => move.tabId)).toEqual(['old', 'sleeper']);
    for (const record of h.scheduler.log()) {
      expect(record.batchId).toBe(batch.id);
      expect(record.at).toBe(batch.at);
    }
  });

  it('comes after the last onAction of its evaluation', async () => {
    const order: string[] = [];
    const h = shelving([stale('old'), dormant('sleeper')], {
      onAction: (record) => order.push(`action:${record.tabId}`),
      onBatch: (batch) => order.push(`batch:${batch.id}`),
    });
    await h.evaluateFully();
    expect(order).toEqual(['action:old', 'action:sleeper', 'batch:batch-1']);
  });

  it('is logged and swallowed when onBatch throws: evaluate() resolves and the tick goes on', async () => {
    const h = shelving([stale('old')], {
      onBatch: () => {
        throw new Error('the undo offer is broken');
      },
    });
    h.scheduler.start();
    await h.time.advance(QUIET_START_MS);

    expect(h.events).toEqual([{ level: 'error', event: 'lifecycle.onBatchFailed' }]);
    expect(outline(h.scheduler.log())).toEqual(['shelve:old:moved']); // the move itself stands
    expect(h.time.pending).toEqual([TICK_MS]);
    await expect(h.scheduler.evaluate()).resolves.toBeUndefined();
  });

  it('gives each evaluation its own batch, also for the one queued behind the one under way', async () => {
    const h = shelving([stale('old'), hiddenFor('a', 10 * HOUR)]);
    h.tabs.hold = true; // the discard of a is held, so the evaluation is under way; the shelve is not
    const first = new Tracked(h.scheduler.evaluate());
    await flush();
    const second = new Tracked(h.scheduler.evaluate());
    await flush();
    expect(h.batches).toEqual([]);

    h.update('a', { runtime: 'unloaded' });
    h.tabs.settleAll();
    await flush();
    expect(first.settled && second.settled).toBe(true);
    expect(h.batches.map((batch) => batch.id)).toEqual(['batch-1', 'batch-2']);
  });
});

describe('LifecycleScheduler: pausing', () => {
  it('logs paused for the discards still waiting their turn when automation is paused', async () => {
    const h = build({ tabs: longHidden(3) });
    const done = new Tracked(h.scheduler.evaluate());
    await h.time.advance(STAGGER_MS / 2);
    expect(h.tabs.discards.map((call) => call.tabId)).toEqual(['a']);

    h.setSettings({ paused: true });
    await h.time.advance(5 * STAGGER_MS);
    expect(done.settled).toBe(true);
    expect(h.tabs.discards.map((call) => call.tabId)).toEqual(['a']);
    expect(outline(h.scheduler.log())).toEqual([
      'discard:a:discarded',
      'discard:b:paused',
      'discard:c:paused',
    ]);
    expect(pick(h.scheduler.log(), 1, 'record')).toMatchObject({
      rule: 'discard-hidden',
      epoch: 1,
    });
  });

  it('checks again when each action’s turn comes: pausing and resuming within a stagger changes nothing', async () => {
    const h = build({ tabs: longHidden(3) });
    const done = new Tracked(h.scheduler.evaluate());
    await h.time.advance(STAGGER_MS / 4);
    h.setSettings({ paused: true });
    await h.time.advance(STAGGER_MS / 4);
    h.setSettings({ paused: false });
    await h.time.advance(5 * STAGGER_MS);

    expect(done.settled).toBe(true);
    expect(h.tabs.discards.map((call) => call.tabId)).toEqual(['a', 'b', 'c']);
  });

  it('logs paused for the shelves and archives still to come, and carries out none of them', async () => {
    const h = shelving([...longHidden(2), stale('old'), dormant('sleeper')]);
    const done = new Tracked(h.scheduler.evaluate());
    await h.time.advance(STAGGER_MS / 2);
    expect(h.tabs.discards.map((call) => call.tabId)).toEqual(['a']);

    // b waits its stagger and the free moves are behind it in the plan: all reach their turn paused.
    h.setSettings({ paused: true });
    await h.time.advance(5 * STAGGER_MS);
    expect(done.settled).toBe(true);
    expect(outline(h.scheduler.log())).toEqual([
      'discard:a:discarded',
      'discard:b:paused',
      'shelve:old:paused',
      'archive:sleeper:paused',
    ]);
    expect(pick(h.scheduler.log(), 2, 'record')).toMatchObject({
      rule: 'shelve-beyond-cap',
      batchId: 'batch-1',
      pressure: 'none',
    });
    expect(h.tabs.shelves).toEqual([]);
    expect(h.tabs.archives).toEqual([]);
  });

  it('plans nothing at all while paused', async () => {
    const h = build({ tabs: longHidden(3), settings: { paused: true } });
    await h.evaluateFully();
    expect(h.tabs.reads).toBe(1);
    expect(h.tabs.discards).toEqual([]);
    expect(h.scheduler.log()).toEqual([]);
  });

  it('stops pausing once automation is on again', async () => {
    const h = build({ tabs: longHidden(1), settings: { paused: true } });
    await h.evaluateFully();
    h.setSettings({ paused: false });
    await h.evaluateFully();
    expect(h.tabs.discards.map((call) => call.tabId)).toEqual(['a']);
  });
});

describe('LifecycleScheduler: one evaluation at a time', () => {
  it('runs one more evaluation right after the one under way, not two at once and not one per request', async () => {
    const h = build({ tabs: longHidden(1) });
    h.tabs.hold = true;
    const first = new Tracked(h.scheduler.evaluate());
    await flush();
    expect(h.tabs.reads).toBe(1);
    expect(h.tabs.discards).toHaveLength(1);

    const second = new Tracked(h.scheduler.evaluate());
    const third = new Tracked(h.scheduler.evaluate());
    await flush();
    expect(h.tabs.reads).toBe(1); // none of them started: one runs at a time
    expect(second.settled).toBe(false);

    h.update('a', { runtime: 'unloaded' }); // TabManager discarded it
    h.tabs.settleAll();
    await flush();
    expect(h.tabs.reads).toBe(2); // exactly one more, started as soon as the first settled
    expect(first.settled && second.settled && third.settled).toBe(true);
    expect(h.tabs.discards).toHaveLength(1);

    await h.time.advance(10 * TICK_MS); // and nothing else is queued
    expect(h.tabs.reads).toBe(2);
  });

  it('has the extra evaluation read the facts afresh, and both callers wait for it', async () => {
    const h = build({ tabs: longHidden(1) });
    h.tabs.hold = true;
    const first = new Tracked(h.scheduler.evaluate());
    await flush();
    const second = new Tracked(h.scheduler.evaluate());

    // Meanwhile TabManager discarded a, and another tab became due.
    h.tabs.facts = [tab('a', { runtime: 'unloaded' }), hiddenFor('b', 9 * HOUR)];
    pick(h.tabs.discards, 0, 'discard').settle.resolve(DISCARDED);
    await flush();
    expect(h.tabs.reads).toBe(2);
    expect(h.tabs.discards.map((call) => call.tabId)).toEqual(['a', 'b']);
    // The second caller asked for an evaluation that starts after its request: it waits for it,
    // like the first (found by E2E: a test hook resolved before its evaluation had run).
    expect(second.settled).toBe(false);
    expect(first.settled).toBe(false);

    pick(h.tabs.discards, 1, 'discard').settle.resolve(DISCARDED);
    await flush();
    expect(first.settled).toBe(true);
    expect(second.settled).toBe(true);
    expect(outline(h.scheduler.log())).toEqual(['discard:a:discarded', 'discard:b:discarded']);
    // Each evaluation is a batch of its own.
    expect(h.scheduler.log().map((record) => record.batchId)).toEqual(['batch-1', 'batch-2']);
  });

  it('does not resolve evaluate() until the operations it started have settled', async () => {
    const h = build({ tabs: longHidden(2) });
    h.tabs.hold = true;
    const done = new Tracked(h.scheduler.evaluate());
    await h.time.advance(5 * STAGGER_MS);
    expect(h.tabs.discards).toHaveLength(2);
    expect(done.settled).toBe(false);

    pick(h.tabs.discards, 0, 'discard').settle.resolve(DISCARDED);
    await flush();
    expect(done.settled).toBe(false);
    pick(h.tabs.discards, 1, 'discard').settle.resolve({ outcome: 'blocked', reason: 'editing' });
    await flush();
    expect(done.settled).toBe(true);
    expect(done.rejected).toBe(false);
    expect(outline(h.scheduler.log())).toEqual(['discard:a:discarded', 'discard:b:blocked']);
  });

  it('shares an evaluation between a trigger that fires while the tick’s evaluation is out', async () => {
    const h = build({ tabs: longHidden(1) });
    h.tabs.hold = true;
    h.scheduler.start();
    await h.time.advance(QUIET_START_MS);
    expect(h.tabs.reads).toBe(1);

    h.scheduler.trigger();
    await h.time.advance(TRIGGER_DELAY_MS);
    expect(h.tabs.reads).toBe(1); // asked for, but one is under way

    h.tabs.facts = [];
    h.tabs.settleAll();
    await flush();
    expect(h.tabs.reads).toBe(2);
    expect(h.time.pending).toEqual([TICK_MS]); // the tick follows the extra evaluation
  });
});

describe('LifecycleScheduler: failures', () => {
  it('never rejects when TabManager’s facts cannot be read, and logs it by code', async () => {
    const h = build({ tabs: longHidden(1) });
    h.tabs.readError = new Error('something with a tab title in it');
    await expect(h.scheduler.evaluate()).resolves.toBeUndefined();
    expect(h.events).toEqual([{ level: 'error', event: 'lifecycle.planFailed' }]);
    expect(h.tabs.discards).toEqual([]);
    expect(h.scheduler.log()).toEqual([]);
  });

  it('never rejects when a discard rejects: it logs the failure, and the other actions go on', async () => {
    const h = build({ tabs: longHidden(2) });
    h.tabs.failure = 'reject';
    const done = h.evaluateFully();
    await expect(done).resolves.toBeUndefined();

    expect(h.tabs.discards.map((call) => call.tabId)).toEqual(['a', 'b']);
    expect(h.events).toEqual([
      { level: 'error', event: 'lifecycle.actionFailed', fields: { kind: 'discard' } },
      { level: 'error', event: 'lifecycle.actionFailed', fields: { kind: 'discard' } },
    ]);
    expect(h.scheduler.log()).toEqual([]); // no result to record
  });

  it('never rejects when a discard throws at once', async () => {
    const h = build({ tabs: longHidden(1) });
    h.tabs.failure = 'throw';
    await expect(h.evaluateFully()).resolves.toBeUndefined();
    expect(h.events).toEqual([
      { level: 'error', event: 'lifecycle.actionFailed', fields: { kind: 'discard' } },
    ]);
  });

  it.each(['reject', 'throw'] as const)(
    'logs a freeze that %ss, with its kind',
    async (failure) => {
      const h = build({ tabs: [hiddenFor('a', 30 * MINUTE)], settings: { freeze: true } });
      h.tabs.failure = failure;
      await expect(h.evaluateFully()).resolves.toBeUndefined();
      expect(h.events).toEqual([
        { level: 'error', event: 'lifecycle.actionFailed', fields: { kind: 'freeze' } },
      ]);
    },
  );

  it('logs a shelve that throws at once, with its kind, and goes on to the archive', async () => {
    const h = shelving([stale('old'), dormant('sleeper')]);
    h.tabs.failure = 'throw';
    await expect(h.evaluateFully()).resolves.toBeUndefined();

    expect(h.tabs.shelves.map((call) => call.tabId)).toEqual(['old']);
    expect(h.tabs.archives.map((call) => call.tabId)).toEqual(['sleeper']); // tried all the same
    expect(h.events).toEqual([
      { level: 'error', event: 'lifecycle.actionFailed', fields: { kind: 'shelve' } },
      { level: 'error', event: 'lifecycle.actionFailed', fields: { kind: 'archive' } },
    ]);
    expect(h.scheduler.log()).toEqual([]); // no result to record
  });

  it('logs an archive that rejects, with its kind, and keeps what the shelve before it got', async () => {
    const h = shelving([stale('old'), dormant('sleeper')]);
    h.tabs.failure = 'reject'; // a shelve answers synchronously: it cannot reject
    await expect(h.evaluateFully()).resolves.toBeUndefined();

    expect(h.events).toEqual([
      { level: 'error', event: 'lifecycle.actionFailed', fields: { kind: 'archive' } },
    ]);
    expect(outline(h.scheduler.log())).toEqual(['shelve:old:moved']);
  });

  it('records what the others got when one action fails', async () => {
    const h = build({ tabs: longHidden(3) });
    h.tabs.hold = true;
    const done = new Tracked(h.scheduler.evaluate());
    await h.time.advance(5 * STAGGER_MS);
    pick(h.tabs.discards, 0, 'discard').settle.reject(new Error('boom'));
    pick(h.tabs.discards, 1, 'discard').settle.resolve(DISCARDED);
    pick(h.tabs.discards, 2, 'discard').settle.resolve({ outcome: 'skipped', why: 'loading' });
    await flush();

    expect(done.settled).toBe(true);
    expect(done.rejected).toBe(false);
    expect(outline(h.scheduler.log())).toEqual(['discard:b:discarded', 'discard:c:skipped']);
    expect(h.events).toEqual([
      { level: 'error', event: 'lifecycle.actionFailed', fields: { kind: 'discard' } },
    ]);
  });

  // Found by this test and fixed: #record called onAction outside any try, so a callback that
  // threw (the activity log, M3.3) rejected the evaluation, an unhandled rejection from #tick.
  // The evaluation resolves and the failure is logged by code.
  it('never rejects when onAction throws', async () => {
    const h = build({
      tabs: longHidden(1),
      onAction: () => {
        throw new Error('the activity log is broken');
      },
    });
    await expect(h.evaluateFully()).resolves.toBeUndefined();
  });
});

describe('LifecycleScheduler: stop()', () => {
  it('cancels the quiet start', async () => {
    const h = build({ tabs: longHidden(1) });
    h.scheduler.start();
    h.scheduler.stop();
    expect(h.time.pending).toEqual([]);
    await h.time.advance(10 * QUIET_START_MS);
    expect(h.tabs.reads).toBe(0);
  });

  it('cancels the next tick and a pending trigger', async () => {
    const h = build();
    h.scheduler.start();
    await h.time.advance(QUIET_START_MS);
    h.scheduler.trigger();
    expect(h.time.pending).toEqual([TRIGGER_DELAY_MS, TICK_MS]);

    h.scheduler.stop();
    expect(h.time.pending).toEqual([]);
    await h.time.advance(10 * TICK_MS);
    expect(h.tabs.reads).toBe(1);
  });

  it('starts nothing afterwards: triggers and evaluations are ignored', async () => {
    const h = build({ tabs: longHidden(1) });
    h.scheduler.start();
    await h.time.advance(QUIET_START_MS);
    const reads = h.tabs.reads;
    h.scheduler.stop();

    h.scheduler.trigger();
    expect(h.time.pending).toEqual([]);
    await expect(h.scheduler.evaluate()).resolves.toBeUndefined();
    expect(h.tabs.reads).toBe(reads);
    expect(h.tabs.discards).toHaveLength(1); // only the one before the stop
  });

  it('lets an operation already handed to TabManager settle, logs it, and schedules nothing more', async () => {
    const h = build({ tabs: longHidden(1) });
    h.tabs.hold = true;
    const done = new Tracked(h.scheduler.evaluate());
    await flush();
    expect(h.tabs.discards).toHaveLength(1);

    h.scheduler.stop();
    expect(done.settled).toBe(false);
    pick(h.tabs.discards, 0, 'discard').settle.resolve(DISCARDED);
    await flush();
    expect(done.settled).toBe(true);
    expect(done.rejected).toBe(false);
    expect(outline(h.scheduler.log())).toEqual(['discard:a:discarded']);
    expect(h.time.pending).toEqual([]);
  });

  it('does not re-arm the tick when the evaluation it was waiting for settles after stop()', async () => {
    const h = build({ tabs: longHidden(1) });
    h.tabs.hold = true;
    h.scheduler.start();
    await h.time.advance(QUIET_START_MS);
    expect(h.tabs.discards).toHaveLength(1);

    h.scheduler.stop();
    h.tabs.facts = [];
    h.tabs.settleAll();
    await flush();
    expect(h.time.pending).toEqual([]);
    await h.time.advance(5 * TICK_MS);
    expect(h.tabs.reads).toBe(1);
  });

  it('drops the evaluation that was queued behind the one under way', async () => {
    const h = build({ tabs: longHidden(1) });
    h.tabs.hold = true;
    const first = new Tracked(h.scheduler.evaluate());
    await flush();
    const second = new Tracked(h.scheduler.evaluate());
    await flush();

    h.scheduler.stop();
    h.tabs.facts = [];
    h.tabs.settleAll();
    await flush();
    expect(first.settled && second.settled).toBe(true);
    expect(h.tabs.reads).toBe(1);
  });

  it('starts none of the actions after the one whose turn comes next, once stopped', async () => {
    const h = build({ tabs: longHidden(4) });
    const done = new Tracked(h.scheduler.evaluate());
    await h.time.advance(STAGGER_MS / 2);
    h.scheduler.stop();
    await h.time.advance(10 * STAGGER_MS);

    expect(done.settled).toBe(true);
    expect(h.tabs.discards.map((call) => call.tabId)).not.toContain('c');
    expect(h.tabs.discards.map((call) => call.tabId)).not.toContain('d');
  });

  it('carries out no shelve or archive that was waiting behind a staggered discard when stop() was called', async () => {
    const h = shelving([...longHidden(2), stale('old'), dormant('sleeper')]);
    const done = new Tracked(h.scheduler.evaluate());
    await h.time.advance(STAGGER_MS / 2);
    h.scheduler.stop();
    await h.time.advance(5 * STAGGER_MS);

    expect(done.settled).toBe(true);
    expect(h.tabs.discards.map((call) => call.tabId)).toEqual(['a']);
    expect(h.tabs.shelves).toEqual([]);
    expect(h.tabs.archives).toEqual([]);
    expect(h.batches).toEqual([]);
  });

  // Found by this test and fixed: stop() while the second discard waited out its STAGGER_MS did
  // not keep it from starting, against "stops everything" and §4.11 item 5. #run now checks again
  // after the wait.
  it('starts nothing that was waiting for its stagger when stop() was called', async () => {
    const h = build({ tabs: longHidden(3) });
    const done = new Tracked(h.scheduler.evaluate());
    await h.time.advance(STAGGER_MS / 2);
    expect(h.tabs.discards.map((call) => call.tabId)).toEqual(['a']);

    h.scheduler.stop();
    await h.time.advance(5 * STAGGER_MS);
    expect(done.settled).toBe(true);
    expect(h.tabs.discards.map((call) => call.tabId)).toEqual(['a']);
  });
});

describe('LifecycleScheduler: the log and plan()', () => {
  it('keeps the newest LOG_SIZE entries, oldest first', async () => {
    const count = LOG_SIZE + 100;
    const sleeping = Array.from({ length: count }, (_, index) =>
      tab(`t${String(index).padStart(3, '0')}`, {
        placement: 'shelf',
        runtime: 'unloaded',
        lastUsedActiveDay: 1,
        lastUsedAt: WALL0 - 10 * HOUR + index, // archived oldest first
      }),
    );
    const h = build({ tabs: sleeping });
    h.state.activeDay = 10;
    await h.evaluateFully();

    expect(h.actions).toHaveLength(count); // every record reached onAction
    const log = h.scheduler.log();
    expect(log).toHaveLength(LOG_SIZE);
    expect(pick(log, 0, 'record').tabId).toBe('t100');
    expect(pick(log, LOG_SIZE - 1, 'record').tabId).toBe(`t${String(count - 1)}`);
  });

  it('log() answers with a copy', async () => {
    const h = build({ tabs: longHidden(1) });
    await h.evaluateFully();
    const first = h.scheduler.log();
    expect(first).not.toBe(h.scheduler.log());
    (first as ActionRecord[]).length = 0;
    expect(h.scheduler.log()).toHaveLength(1);
  });

  it('plan() returns what the policy calls for now, without carrying any of it out', () => {
    const h = build({ tabs: [...longHidden(2), tab('recent')] });
    expect(h.scheduler.plan()).toEqual([
      { tabId: 'a', kind: 'discard', rule: 'discard-hidden', epoch: 1, overrideSoft: false },
      { tabId: 'b', kind: 'discard', rule: 'discard-hidden', epoch: 1, overrideSoft: false },
    ]);
    expect(h.tabs.reads).toBe(1);
    expect(h.tabs.discards).toEqual([]);
    expect(h.scheduler.log()).toEqual([]);
    expect(h.actions).toEqual([]);
    expect(h.time.pending).toEqual([]);
  });

  it('plan() follows the settings and the pressure of the moment', () => {
    const h = build({ tabs: [tab('recent')] });
    expect(h.scheduler.plan()).toEqual([]);

    h.state.pressure = 'critical';
    expect(h.scheduler.plan()).toEqual([
      { tabId: 'recent', kind: 'discard', rule: 'pressure-discard', epoch: 1, overrideSoft: true },
    ]);

    h.setSettings({ paused: true });
    expect(h.scheduler.plan()).toEqual([]);
  });
});
