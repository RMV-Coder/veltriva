// The lifecycle scheduler (assessment §4.8): when it evaluates, how many actions it starts and how
// fast, and what it logs. The policy is the real one (core/lifecycle/policy.ts); everything the
// scheduler touches is a fake: tabs whose facts a test sets and whose `discard` and `freeze` hand
// out promises the test settles, a clock whose timers a test moves, settings and pressure.
//
// Time is a manual clock in milliseconds from the start of the test; the wall clock the policy sees
// is WALL0 plus it, so "hidden for 2 hours" is a fact written relative to WALL0 and stays true as
// the test advances. `advance` fires the timers that fall due, in order, and lets the promise
// continuations they cause run in between, so a test can say "at 1,000 ms the second discard is
// called" and check it.
import { describe, expect, it } from 'vitest';

import type { DiscardOutcome, DiscardRequest, Timers } from '../../core/lifecycle/discard';
import { DEFAULT_LIFECYCLE_SETTINGS } from '../../core/lifecycle/policy';
import type { LifecycleSettings, MemoryPressure, TabFacts } from '../../core/lifecycle/policy';
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
import type { ActionRecord, SchedulerTabs } from './scheduler';

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

/** TabManager as the scheduler sees it. */
class FakeTabs implements SchedulerTabs {
  facts: TabFacts[] = [];
  /** How often `lifecycleTabs()` was asked: one per evaluation. */
  reads = 0;
  readError: Error | null = null;
  readonly discards: DiscardCall[] = [];
  readonly freezes: FreezeCall[] = [];
  /** True leaves each operation for the test to settle; false settles it at once with an outcome. */
  hold = false;
  discardOutcome: DiscardOutcome = DISCARDED;
  freezeOutcome: FreezeOutcome = FROZEN;
  /** How `discard` and `freeze` fail: not at all, by rejecting, or by throwing at once. */
  failure: 'none' | 'reject' | 'throw' = 'none';

  constructor(private readonly time: ManualClock) {}

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

  /** Settles every operation still held, with the default outcomes. */
  settleAll(): void {
    for (const call of this.discards) {
      call.settle.resolve(this.discardOutcome);
    }
    for (const call of this.freezes) {
      call.settle.resolve(this.freezeOutcome);
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

const outline = (records: readonly ActionRecord[]): string[] =>
  records.map((record) => `${record.kind}:${record.tabId}:${record.result.outcome}`);

interface BuildOptions {
  readonly tabs?: readonly TabFacts[];
  readonly settings?: Partial<LifecycleSettings>;
  readonly pressure?: MemoryPressure;
  readonly onAction?: (record: ActionRecord) => void;
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
  });
  return {
    scheduler,
    time,
    tabs,
    state,
    actions,
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

  it('sends TabManager only discards and freezes, even when a shelve is planned beside them', async () => {
    const h = build({
      tabs: [...longHidden(1), tab('keep'), tab('old', { lastUsedAt: WALL0 - HOUR })],
    });
    h.setSettings({ stripCap: 1 });
    h.state.engagedNow = 3 * HOUR;
    h.update('keep', { lastUsedEngaged: 3 * HOUR, lastUsedAt: WALL0 });
    await h.evaluateFully();

    expect(h.tabs.discards.map((call) => call.tabId)).toEqual(['a']);
    expect(outline(h.scheduler.log()).sort()).toEqual([
      'discard:a:discarded',
      'shelve:old:planned',
    ]);
  });
});

describe('LifecycleScheduler: shelves and archives are only planned', () => {
  /** A strip tab beyond the cap and stale (shelve), and a Sleeping tab unused for days (archive). */
  function shelveAndArchive(): Harness {
    const h = build({
      tabs: [
        tab('keep', { lastUsedAt: WALL0, lastUsedEngaged: 3 * HOUR }),
        tab('old', { lastUsedAt: WALL0 - HOUR, lastUsedEngaged: 0, epoch: 5 }),
        tab('dormant', {
          placement: 'shelf',
          runtime: 'unloaded',
          lastUsedActiveDay: 1,
          lastUsedAt: WALL0 - 5 * HOUR,
        }),
      ],
      settings: { stripCap: 1 },
    });
    h.state.engagedNow = 3 * HOUR;
    h.state.activeDay = 10;
    return h;
  }

  it('logs each once as planned, and never sends it to TabManager', async () => {
    const h = shelveAndArchive();
    await h.evaluateFully();

    expect(h.scheduler.log()).toEqual([
      {
        tabId: 'old',
        kind: 'shelve',
        rule: 'shelve-beyond-cap',
        epoch: 5,
        overrideSoft: false,
        at: WALL0,
        result: { outcome: 'planned' },
      },
      {
        tabId: 'dormant',
        kind: 'archive',
        rule: 'archive-dormant',
        epoch: 1,
        overrideSoft: false,
        at: WALL0,
        result: { outcome: 'planned' },
      },
    ]);
    expect(h.tabs.discards).toEqual([]);
    expect(h.tabs.freezes).toEqual([]);
    expect(h.time.pending).toEqual([]); // nothing was started, so nothing waited
  });

  it('does not log them again while they stay planned', async () => {
    const h = shelveAndArchive();
    for (let i = 0; i < 4; i += 1) {
      await h.evaluateFully();
    }
    expect(outline(h.scheduler.log())).toEqual(['shelve:old:planned', 'archive:dormant:planned']);
    expect(h.actions).toHaveLength(2);
  });

  it('logs them again after they drop out of the plan and come back', async () => {
    const h = shelveAndArchive();
    await h.evaluateFully();
    expect(h.scheduler.log()).toHaveLength(2);

    // The user used the old tab and the Sleeping one was woken: nothing is planned.
    h.update('old', { lastUsedEngaged: 3 * HOUR });
    h.update('dormant', { lastUsedActiveDay: 10 });
    await h.evaluateFully();
    expect(h.scheduler.log()).toHaveLength(2);

    h.update('old', { lastUsedEngaged: 0 });
    h.update('dormant', { lastUsedActiveDay: 1 });
    await h.evaluateFully();
    expect(outline(h.scheduler.log())).toEqual([
      'shelve:old:planned',
      'archive:dormant:planned',
      'shelve:old:planned',
      'archive:dormant:planned',
    ]);
  });

  it('keeps one planned and logs the other again when only that one dropped out', async () => {
    const h = shelveAndArchive();
    await h.evaluateFully();
    h.update('old', { lastUsedEngaged: 3 * HOUR });
    await h.evaluateFully(); // the shelve dropped out; the archive is planned still
    h.update('old', { lastUsedEngaged: 0 });
    await h.evaluateFully();
    expect(outline(h.scheduler.log())).toEqual([
      'shelve:old:planned',
      'archive:dormant:planned',
      'shelve:old:planned',
    ]);
  });

  it('plans them alongside discards without delaying the discards or counting against their limit', async () => {
    const h = shelveAndArchive();
    for (const tabFacts of longHidden(3)) {
      h.tabs.facts = [...h.tabs.facts, tabFacts];
    }
    await h.evaluateFully();
    expect(h.tabs.discards.map((call) => call.at)).toEqual([0, STAGGER_MS, 2 * STAGGER_MS]);
    expect(
      outline(h.scheduler.log())
        .filter((line) => line.endsWith(':planned'))
        .sort(),
    ).toEqual(['archive:dormant:planned', 'shelve:old:planned']);
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

  it('has the extra evaluation read the facts afresh, and the first caller wait for it', async () => {
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
    expect(second.settled).toBe(true); // it only asked for an evaluation
    expect(first.settled).toBe(false); // the extra one is still out

    pick(h.tabs.discards, 1, 'discard').settle.resolve(DISCARDED);
    await flush();
    expect(first.settled).toBe(true);
    expect(outline(h.scheduler.log())).toEqual(['discard:a:discarded', 'discard:b:discarded']);
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
