// EngagementSampler (assessment §4.6): what feeds the engagement clock from the system. The system
// (powerMonitor), both clocks, the timers and the writer are fakes, so a test decides what the
// user is doing, how much time passes, and when the 30 s timer fires.
//
// Time in these tests has two sources, as in the app: the monotonic clock (what the sampler adds)
// and the wall clock (which only names the calendar day). `pass` moves both; `time.wall` is moved
// alone to model a clock that was set or a daylight-saving change.
import { describe, expect, it } from 'vitest';

import type { Timers } from '../../core/lifecycle/discard';
import {
  ACTIVE_DAY_THRESHOLD_MS,
  IDLE_THRESHOLD_S,
  MAX_SAMPLE_STEP_MS,
  SAMPLE_INTERVAL_MS,
} from '../../core/lifecycle/engagement-clock';
import type { EngagementState } from '../../core/lifecycle/engagement-clock';
import { DataClientError } from '../persistence/data-client';
import type { DataClient } from '../persistence/data-client';
import type { Logger } from '../platform/logger';
import {
  ENGAGEMENT_DOCUMENT,
  ENGAGEMENT_READ_TIMEOUT_MS,
  EngagementSampler,
  engagementWriter,
  PERSIST_INTERVAL_MS,
  readStoredEngagement,
} from './engagement-sampler';
import type { SystemActivity } from './engagement-sampler';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Noon UTC, in a zone with offset 0: the local day is 2026-10-21. */
const NOON = Date.UTC(2026, 9, 21, 12, 0, 0);
const TODAY = '2026-10-21';
const TOMORROW = '2026-10-22';
const YESTERDAY = '2026-10-20';

type IdleState = ReturnType<SystemActivity['idleState']>;
type PowerEvent = Parameters<SystemActivity['on']>[0];

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

  /** The callback of a pending timer with this delay, without firing or removing it. */
  peek(ms: number): () => void {
    const timer = [...this.#pending.values()].find((candidate) => candidate.ms === ms);
    if (timer === undefined) {
      throw new Error(`no ${String(ms)} ms timer is pending (pending: ${this.pending.join(', ')})`);
    }
    return timer.callback;
  }

  /** Fires every pending timer with this delay. Throws if there is none: a missing timer is a bug. */
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

/** powerMonitor: the idle state is whatever the test sets; the power events fire on demand. */
class FakeSystem implements SystemActivity {
  /** The thresholds `idleState` was asked with, one per call. */
  readonly asked: number[] = [];
  throws = false;
  readonly #listeners = new Map<PowerEvent, (() => void)[]>();

  constructor(public state: IdleState) {}

  idleState(thresholdSeconds: number): IdleState {
    this.asked.push(thresholdSeconds);
    if (this.throws) {
      throw new Error('powerMonitor is not ready');
    }
    return this.state;
  }

  on(event: PowerEvent, listener: () => void): void {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
  }

  listenerCount(event: PowerEvent): number {
    return this.#listeners.get(event)?.length ?? 0;
  }

  emit(event: PowerEvent): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      listener();
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

interface BuildOptions {
  readonly stored?: EngagementState | null;
  readonly idle?: IdleState;
  /** The wall clock at the start (noon UTC by default). */
  readonly wall?: number;
  /** Minutes the local zone is behind UTC at the start. */
  readonly offset?: number;
  /** False leaves the sampler unstarted. */
  readonly started?: boolean;
}

function build(options: BuildOptions = {}) {
  const system = new FakeSystem(options.idle ?? 'active');
  const timers = new ManualTimers();
  const time = { mono: 5_000, wall: options.wall ?? NOON, offset: options.offset ?? 0 };
  /** What `persist` was asked to write, oldest first. */
  const written: EngagementState[] = [];
  const write = { mode: 'ok' as 'ok' | 'reject' | 'throw' };
  /** How often `idleState` had been asked at each `onResume` call. */
  const resumedAfter: number[] = [];
  const { logger, events } = recordingLogger();
  const sampler = new EngagementSampler({
    system,
    monotonic: () => time.mono,
    wall: () => time.wall,
    timezoneOffset: () => time.offset,
    timers,
    stored: options.stored ?? null,
    persist: (state) => {
      written.push(state);
      if (write.mode === 'throw') {
        throw new Error('persist threw at once');
      }
      return write.mode === 'reject' ? Promise.reject(new Error('disk full')) : Promise.resolve();
    },
    onResume: () => {
      resumedAfter.push(system.asked.length);
    },
    logger,
  });
  if (options.started !== false) {
    sampler.start();
  }
  /** Time passes on both clocks, with no sample. */
  const pass = (ms: number): void => {
    time.mono += ms;
    time.wall += ms;
  };
  /** Time passes and the sample timer fires. */
  const tick = (ms = SAMPLE_INTERVAL_MS): void => {
    pass(ms);
    timers.fire(SAMPLE_INTERVAL_MS);
  };
  return {
    sampler,
    system,
    timers,
    time,
    written,
    write,
    resumedAfter,
    events,
    pass,
    tick,
    engaged: (): number => sampler.now().engagedMs,
  };
}

const START: EngagementState = { engagedMs: 0, activeDay: 1, dayKey: TODAY, dayEngagedMs: 0 };

describe('EngagementSampler: starting', () => {
  it('does nothing until start(): no sample, no timer, no listeners', () => {
    const h = build({ started: false });
    expect(h.system.asked).toEqual([]);
    expect(h.timers.pending).toEqual([]);
    expect(h.system.listenerCount('suspend')).toBe(0);
    expect(h.sampler.now()).toEqual(START);
  });

  it('starts a new profile at day 1 with the local calendar day, and samples once with the idle threshold', () => {
    const h = build();
    expect(h.sampler.now()).toEqual(START);
    expect(h.system.asked).toEqual([IDLE_THRESHOLD_S]);
    expect(h.timers.pending).toEqual([SAMPLE_INTERVAL_MS]);
    for (const event of ['suspend', 'resume', 'lock-screen', 'unlock-screen'] as const) {
      expect(h.system.listenerCount(event)).toBe(1);
    }
  });

  it('names the day in the local zone: the same instant is one day in one zone and the next in another', () => {
    // 2026-10-21 23:30 UTC: still the 21st in New York (UTC-4, offset 240), the 22nd in Tokyo (UTC+9).
    const lateEvening = Date.UTC(2026, 9, 21, 23, 30, 0);
    expect(build({ wall: lateEvening, offset: 240 }).sampler.now().dayKey).toBe(TODAY);
    expect(build({ wall: lateEvening, offset: -540 }).sampler.now().dayKey).toBe(TOMORROW);
  });

  it('counts nothing at the first sample, however active the user is', () => {
    const h = build();
    expect(h.engaged()).toBe(0);
  });
});

describe('EngagementSampler: what counts', () => {
  it('counts an interval only if the previous sample said active', () => {
    const h = build({ idle: 'idle' });

    h.tick();
    expect(h.engaged()).toBe(0); // idle at the previous sample
    h.system.state = 'active';
    h.tick();
    expect(h.engaged()).toBe(0); // still idle at the previous sample; this one says active
    h.tick();
    expect(h.engaged()).toBe(SAMPLE_INTERVAL_MS); // active at the previous sample: counts
    h.tick();
    expect(h.engaged()).toBe(2 * SAMPLE_INTERVAL_MS);
    h.system.state = 'idle';
    h.tick();
    expect(h.engaged()).toBe(3 * SAMPLE_INTERVAL_MS); // the previous sample said active
    h.tick();
    expect(h.engaged()).toBe(3 * SAMPLE_INTERVAL_MS); // now idle: nothing
    expect(h.sampler.now().dayEngagedMs).toBe(3 * SAMPLE_INTERVAL_MS);
  });

  it.each(['idle', 'locked', 'unknown'] as const)(
    'counts nothing while the system says %s',
    (state) => {
      const h = build({ idle: state });
      for (let i = 0; i < 5; i += 1) {
        h.tick();
      }
      expect(h.sampler.now()).toEqual(START);
    },
  );

  it.each(['idle', 'locked', 'unknown'] as const)(
    'counts the interval in which the user stopped being active (%s), and no later one',
    (state) => {
      const h = build();
      h.tick();
      h.system.state = state;
      h.tick();
      expect(h.engaged()).toBe(2 * SAMPLE_INTERVAL_MS);
      h.tick();
      h.tick();
      expect(h.engaged()).toBe(2 * SAMPLE_INTERVAL_MS);
    },
  );

  it('counts nothing when idleState throws, and reads a later answer normally', () => {
    const h = build({ started: false });
    h.system.throws = true;
    h.sampler.start();
    h.tick();
    h.tick();
    expect(h.engaged()).toBe(0);

    h.system.throws = false;
    h.tick(); // the previous sample could not tell
    expect(h.engaged()).toBe(0);
    h.tick(); // the previous sample said active
    expect(h.engaged()).toBe(SAMPLE_INTERVAL_MS);
  });

  it('counts the interval before idleState starts to throw, and none after', () => {
    const h = build();
    h.tick();
    h.system.throws = true;
    h.tick(); // the previous sample said active; this one cannot tell
    expect(h.engaged()).toBe(2 * SAMPLE_INTERVAL_MS);
    h.tick();
    expect(h.engaged()).toBe(2 * SAMPLE_INTERVAL_MS);
  });

  it('adds nothing when the monotonic clock stands still or goes back', () => {
    const h = build();
    h.tick(0);
    expect(h.engaged()).toBe(0);
    h.tick(SAMPLE_INTERVAL_MS);
    expect(h.engaged()).toBe(SAMPLE_INTERVAL_MS);
    h.time.mono -= 10_000; // not a real clock, but nothing may be removed or added
    h.timers.fire(SAMPLE_INTERVAL_MS);
    expect(h.engaged()).toBe(SAMPLE_INTERVAL_MS);
  });
});

describe('EngagementSampler: suspend, lock and resume', () => {
  const pairs = [
    ['suspend', 'resume'],
    ['lock-screen', 'unlock-screen'],
  ] as const;

  it.each(pairs)(
    '%s ends the interval (the part before counts), nothing counts while away, %s counts again',
    (leave, back) => {
      const h = build();
      h.tick();
      h.pass(10_000);
      h.system.emit(leave);
      expect(h.engaged()).toBe(SAMPLE_INTERVAL_MS + 10_000); // the user was active until then

      // Away for hours; the app keeps its timer (a locked screen), or fires it late (a sleep).
      h.pass(3 * HOUR);
      expect(h.engaged()).toBe(SAMPLE_INTERVAL_MS + 10_000);
      h.tick();
      h.tick();
      expect(h.engaged()).toBe(SAMPLE_INTERVAL_MS + 10_000);

      h.system.emit(back);
      expect(h.engaged()).toBe(SAMPLE_INTERVAL_MS + 10_000); // away time never counts
      h.pass(10_000);
      expect(h.engaged()).toBe(SAMPLE_INTERVAL_MS + 20_000); // counting again from the return
      h.tick(20_000);
      expect(h.engaged()).toBe(SAMPLE_INTERVAL_MS + 40_000);
    },
  );

  it.each(pairs)(
    '%s counts nothing of an interval that was not active, and the user may still be idle on return (%s)',
    (leave, back) => {
      const h = build({ idle: 'idle' });
      h.pass(10_000);
      h.system.emit(leave);
      expect(h.engaged()).toBe(0);

      h.pass(HOUR);
      h.system.emit(back);
      h.tick();
      h.tick();
      expect(h.engaged()).toBe(0); // idle on return too
      h.system.state = 'active';
      h.tick(); // the previous sample said idle
      h.tick();
      expect(h.engaged()).toBe(SAMPLE_INTERVAL_MS);
    },
  );

  it.each(pairs)(
    'the return from %s re-samples before it calls onResume, and calls it once (%s)',
    (leave, back) => {
      const h = build();
      h.tick();
      h.system.emit(leave);
      const askedBefore = h.system.asked.length;
      h.pass(HOUR);

      h.system.emit(back);
      // The state from now on was read, and only then was the scheduler told.
      expect(h.system.asked.length).toBe(askedBefore + 1);
      expect(h.resumedAfter).toEqual([askedBefore + 1]);

      // A second return, with no departure in between, is nothing.
      h.system.emit(back);
      expect(h.resumedAfter).toHaveLength(1);
    },
  );

  it('a resume or unlock without a suspend or lock does nothing', () => {
    const h = build();
    h.tick();
    const asked = h.system.asked.length;
    const written = h.written.length;

    h.pass(10_000);
    h.system.emit('resume');
    h.system.emit('unlock-screen');

    expect(h.resumedAfter).toEqual([]);
    expect(h.system.asked).toHaveLength(asked);
    expect(h.written).toHaveLength(written);
    expect(h.engaged()).toBe(SAMPLE_INTERVAL_MS + 10_000); // the interval under way is untouched
  });

  it('a lock followed by a suspend is still one absence, ended by the first return', () => {
    const h = build();
    h.tick();
    h.system.emit('lock-screen');
    h.pass(MINUTE);
    h.system.emit('suspend'); // away already: the interval it falls in counts nothing
    expect(h.engaged()).toBe(SAMPLE_INTERVAL_MS);

    h.system.emit('resume');
    expect(h.resumedAfter).toHaveLength(1);
    h.pass(5_000);
    expect(h.engaged()).toBe(SAMPLE_INTERVAL_MS + 5_000);
  });

  it('sleep without a suspend event: the gap adds only the cap, not the hours', () => {
    const h = build();
    h.tick(8 * HOUR);
    expect(h.engaged()).toBe(MAX_SAMPLE_STEP_MS);
    h.tick();
    expect(h.engaged()).toBe(MAX_SAMPLE_STEP_MS + SAMPLE_INTERVAL_MS);
  });
});

describe('EngagementSampler: the cap on a sample, and the two clocks', () => {
  it('adds at most MAX_SAMPLE_STEP_MS for one interval, and exactly the interval below it', () => {
    expect(MAX_SAMPLE_STEP_MS).toBe(2 * SAMPLE_INTERVAL_MS);
    const h = build();
    h.tick(MAX_SAMPLE_STEP_MS);
    expect(h.engaged()).toBe(MAX_SAMPLE_STEP_MS);
    h.tick(MAX_SAMPLE_STEP_MS + 1);
    expect(h.engaged()).toBe(2 * MAX_SAMPLE_STEP_MS);
    h.tick(10 * MINUTE);
    expect(h.engaged()).toBe(3 * MAX_SAMPLE_STEP_MS);
  });

  it('a wall clock set forward within the day adds nothing by itself', () => {
    const h = build();
    h.time.wall += 5 * HOUR; // noon to 17:00, the same day
    h.tick();
    expect(h.sampler.now()).toEqual({
      engagedMs: SAMPLE_INTERVAL_MS,
      activeDay: 1,
      dayKey: TODAY,
      dayEngagedMs: SAMPLE_INTERVAL_MS,
    });
  });

  it('a wall clock set back within the day adds nothing and removes nothing', () => {
    const h = build();
    h.tick();
    h.time.wall -= 3 * HOUR;
    h.tick();
    expect(h.sampler.now()).toEqual({
      engagedMs: 2 * SAMPLE_INTERVAL_MS,
      activeDay: 1,
      dayKey: TODAY,
      dayEngagedMs: 2 * SAMPLE_INTERVAL_MS,
    });
  });

  it('a wall clock set across midnight changes the day, and the day that ended counts only if it reached 10 minutes', () => {
    const short = build({
      stored: {
        engagedMs: HOUR,
        activeDay: 3,
        dayKey: TODAY,
        dayEngagedMs: ACTIVE_DAY_THRESHOLD_MS - 1,
      },
    });
    short.time.wall += 13 * HOUR; // 01:00 the next day
    short.tick();
    expect(short.sampler.now()).toEqual({
      engagedMs: HOUR + SAMPLE_INTERVAL_MS,
      activeDay: 3,
      dayKey: TOMORROW,
      dayEngagedMs: SAMPLE_INTERVAL_MS, // the 30 s are today's: they follow the new day
    });

    const full = build({
      stored: {
        engagedMs: HOUR,
        activeDay: 3,
        dayKey: TODAY,
        dayEngagedMs: ACTIVE_DAY_THRESHOLD_MS,
      },
    });
    full.time.wall += 13 * HOUR;
    full.tick();
    expect(full.sampler.now()).toEqual({
      engagedMs: HOUR + SAMPLE_INTERVAL_MS,
      activeDay: 4,
      dayKey: TOMORROW,
      dayEngagedMs: SAMPLE_INTERVAL_MS,
    });
  });

  it('a wall clock set back to an earlier day is a new day, and the active day never goes back', () => {
    const h = build({
      stored: { engagedMs: HOUR, activeDay: 3, dayKey: TODAY, dayEngagedMs: 2 * MINUTE },
    });
    h.time.wall -= 48 * HOUR;
    h.tick();
    expect(h.sampler.now()).toMatchObject({ activeDay: 3, dayKey: '2026-10-19' });

    const counted = build({
      stored: { engagedMs: HOUR, activeDay: 3, dayKey: TODAY, dayEngagedMs: 20 * MINUTE },
    });
    counted.time.wall -= 48 * HOUR;
    counted.tick();
    expect(counted.sampler.now()).toMatchObject({ activeDay: 4, dayKey: '2026-10-19' });
  });

  it('a daylight-saving change that moves local time past midnight changes the day and adds nothing', () => {
    // 2026-03-08 07:50 UTC is 23:50 on the 7th at UTC-8; an hour later the zone is at UTC-7.
    const h = build({ wall: Date.UTC(2026, 2, 8, 7, 50, 0), offset: 480 });
    expect(h.sampler.now().dayKey).toBe('2026-03-07');
    h.time.offset = 420;
    h.tick();
    expect(h.sampler.now()).toEqual({
      engagedMs: SAMPLE_INTERVAL_MS,
      activeDay: 1,
      dayKey: '2026-03-08',
      dayEngagedMs: SAMPLE_INTERVAL_MS,
    });
  });
});

describe('EngagementSampler: now()', () => {
  it('counts the engaged part of the interval under way, without moving the sampler', () => {
    const h = build();
    h.pass(10_000);
    expect(h.sampler.now()).toEqual({
      engagedMs: 10_000,
      activeDay: 1,
      dayKey: TODAY,
      dayEngagedMs: 10_000,
    });
    expect(h.sampler.now().engagedMs).toBe(10_000); // reading it twice does not count it twice

    h.tick(20_000);
    expect(h.engaged()).toBe(30_000); // the sample counts the whole interval once
  });

  it('caps the part under way at MAX_SAMPLE_STEP_MS, as the sample will', () => {
    const h = build();
    h.pass(5 * MINUTE);
    expect(h.engaged()).toBe(MAX_SAMPLE_STEP_MS);
    expect(h.sampler.now().dayEngagedMs).toBe(MAX_SAMPLE_STEP_MS);
  });

  it('counts nothing for an interval that is not engaged', () => {
    const h = build({ idle: 'idle' });
    h.pass(30_000);
    expect(h.sampler.now()).toEqual(START);
  });

  it('counts nothing while away', () => {
    const h = build();
    h.tick();
    h.system.emit('lock-screen');
    h.pass(5_000);
    expect(h.engaged()).toBe(SAMPLE_INTERVAL_MS);
  });

  it('does not go below the last sample if the monotonic clock steps back', () => {
    const h = build();
    h.tick();
    h.time.mono -= 10_000;
    expect(h.engaged()).toBe(SAMPLE_INTERVAL_MS);
  });
});

describe('EngagementSampler: the timer', () => {
  it('re-arms a SAMPLE_INTERVAL_MS timer after every sample, one at a time', () => {
    const h = build();
    expect(h.timers.pending).toEqual([SAMPLE_INTERVAL_MS]);
    for (let i = 1; i <= 4; i += 1) {
      h.tick();
      expect(h.timers.pending).toEqual([SAMPLE_INTERVAL_MS]);
      expect(h.system.asked).toHaveLength(1 + i); // the start's sample, then one per tick
    }
  });

  it('stop() cancels the timer, and nothing samples by itself afterwards', () => {
    const h = build();
    h.tick();
    h.sampler.stop();
    expect(h.timers.pending).toEqual([]);
    expect(() => {
      h.timers.fire(SAMPLE_INTERVAL_MS);
    }).toThrow(/no 30000 ms timer is pending/);
    h.sampler.stop(); // twice is fine
    expect(h.timers.pending).toEqual([]);
  });

  it('a timer callback already on its way when stop() is called does not re-arm', () => {
    const h = build();
    const callback = h.timers.peek(SAMPLE_INTERVAL_MS);
    h.sampler.stop();
    h.pass(SAMPLE_INTERVAL_MS);
    callback();
    expect(h.timers.pending).toEqual([]);
  });

  it('keeps the state readable after stop(), and the power events still end intervals', () => {
    const h = build();
    h.tick();
    h.sampler.stop();
    h.pass(5_000);
    h.system.emit('suspend');
    expect(h.engaged()).toBe(SAMPLE_INTERVAL_MS + 5_000);
    expect(h.timers.pending).toEqual([]);
  });
});

describe('EngagementSampler: persistence', () => {
  it('writes the clock once PERSIST_INTERVAL_MS has passed, and then every PERSIST_INTERVAL_MS', () => {
    const h = build();
    const ticks = PERSIST_INTERVAL_MS / SAMPLE_INTERVAL_MS;
    for (let i = 1; i < ticks; i += 1) {
      h.tick();
    }
    expect(h.written).toEqual([]); // one sample short of 5 minutes

    h.tick();
    expect(h.written).toEqual([
      {
        engagedMs: PERSIST_INTERVAL_MS,
        activeDay: 1,
        dayKey: TODAY,
        dayEngagedMs: PERSIST_INTERVAL_MS,
      },
    ]);

    for (let i = 1; i < ticks; i += 1) {
      h.tick();
    }
    expect(h.written).toHaveLength(1);
    h.tick();
    expect(h.written).toHaveLength(2);
    expect(pick(h.written, 1, 'write').engagedMs).toBe(2 * PERSIST_INTERVAL_MS);
  });

  it('writes at once when the calendar day changes, and not again on the same day', () => {
    const h = build();
    h.tick();
    expect(h.written).toEqual([]);

    h.time.wall += 13 * HOUR;
    h.tick();
    expect(h.written).toEqual([
      {
        engagedMs: 2 * SAMPLE_INTERVAL_MS,
        activeDay: 1,
        dayKey: TOMORROW,
        dayEngagedMs: SAMPLE_INTERVAL_MS,
      },
    ]);
    h.tick();
    expect(h.written).toHaveLength(1);
  });

  it('writes the new day at start when the stored clock is from an earlier day', () => {
    const h = build({
      stored: { engagedMs: 3 * HOUR, activeDay: 4, dayKey: YESTERDAY, dayEngagedMs: 20 * MINUTE },
    });
    expect(h.written).toEqual([
      { engagedMs: 3 * HOUR, activeDay: 5, dayKey: TODAY, dayEngagedMs: 0 },
    ]);
  });

  it('flush() writes the clock now, including the part of the interval under way', async () => {
    const h = build();
    h.pass(10_000);
    await h.sampler.flush();
    expect(h.written).toEqual([
      { engagedMs: 10_000, activeDay: 1, dayKey: TODAY, dayEngagedMs: 10_000 },
    ]);
  });

  it('flush() restarts the PERSIST_INTERVAL_MS count', async () => {
    const h = build();
    for (let i = 0; i < 5; i += 1) {
      h.tick();
    }
    await h.sampler.flush(); // 150 s in
    expect(h.written).toHaveLength(1);

    for (let i = 0; i < 5; i += 1) {
      h.tick(); // 300 s since the start, 150 s since the flush
    }
    expect(h.written).toHaveLength(1);
    for (let i = 0; i < 5; i += 1) {
      h.tick();
    }
    expect(h.written).toHaveLength(2); // 300 s since the flush
  });

  it('flush() still writes after stop() (the quit)', async () => {
    const h = build();
    h.tick();
    h.sampler.stop();
    await h.sampler.flush();
    expect(h.written).toEqual([
      {
        engagedMs: SAMPLE_INTERVAL_MS,
        activeDay: 1,
        dayKey: TODAY,
        dayEngagedMs: SAMPLE_INTERVAL_MS,
      },
    ]);
  });

  it('a rejecting persist is logged by code and never throws', async () => {
    const h = build();
    h.write.mode = 'reject';
    await expect(h.sampler.flush()).resolves.toBeUndefined();
    expect(h.events).toEqual([{ level: 'warn', event: 'engagement.saveFailed' }]);
  });

  it('a persist that throws at once is logged by code and never throws', async () => {
    const h = build();
    h.write.mode = 'throw';
    await expect(h.sampler.flush()).resolves.toBeUndefined();
    expect(h.events).toEqual([{ level: 'warn', event: 'engagement.saveFailed' }]);
  });

  it('a write that fails during a sample does not escape the timer, and is not retried at the next sample', async () => {
    const h = build();
    h.write.mode = 'reject';
    const ticks = PERSIST_INTERVAL_MS / SAMPLE_INTERVAL_MS;
    for (let i = 0; i < ticks; i += 1) {
      h.tick();
    }
    await flush();
    expect(h.written).toHaveLength(1);
    expect(h.events).toEqual([{ level: 'warn', event: 'engagement.saveFailed' }]);

    h.tick();
    await flush();
    expect(h.written).toHaveLength(1); // the next try is a whole interval away
    expect(h.timers.pending).toEqual([SAMPLE_INTERVAL_MS]);
  });

  it('resumes the stored clock: counting continues from it', () => {
    const h = build({
      stored: {
        engagedMs: 5 * HOUR,
        activeDay: 7,
        dayKey: TODAY,
        dayEngagedMs: 40 * MINUTE,
      },
    });
    expect(h.written).toEqual([]); // the same day: nothing to write yet
    expect(h.sampler.now()).toEqual({
      engagedMs: 5 * HOUR,
      activeDay: 7,
      dayKey: TODAY,
      dayEngagedMs: 40 * MINUTE,
    });

    h.tick();
    h.tick();
    expect(h.sampler.now()).toEqual({
      engagedMs: 5 * HOUR + 2 * SAMPLE_INTERVAL_MS,
      activeDay: 7,
      dayKey: TODAY,
      dayEngagedMs: 40 * MINUTE + 2 * SAMPLE_INTERVAL_MS,
    });
  });

  it('writes through engagementWriter as the engagement document', async () => {
    const calls: { method: string; input: unknown }[] = [];
    const data = {
      call: (method: string, input: unknown) => {
        calls.push({ method, input });
        return Promise.resolve({});
      },
    } as unknown as Pick<DataClient, 'call'>;
    const { logger } = recordingLogger();
    const sampler = new EngagementSampler({
      system: new FakeSystem('active'),
      monotonic: () => 1,
      wall: () => NOON,
      timezoneOffset: () => 0,
      timers: new ManualTimers(),
      stored: null,
      persist: engagementWriter(data),
      logger,
    });

    await sampler.flush();
    expect(calls).toEqual([
      { method: 'appState.set', input: { key: ENGAGEMENT_DOCUMENT, value: START } },
    ]);
  });
});

/** The data client's `call`, recording each one; `answer` decides what it returns. */
function fakeData(answer: () => Promise<unknown>) {
  const calls: { method: string; input: unknown; options: unknown }[] = [];
  const data = {
    call: (method: string, input: unknown, options?: unknown) => {
      calls.push({ method, input, options });
      return answer();
    },
  } as unknown as Pick<DataClient, 'call'>;
  return { data, calls };
}

describe('readStoredEngagement', () => {
  const stored: EngagementState = {
    engagedMs: 90 * MINUTE,
    activeDay: 3,
    dayKey: YESTERDAY,
    dayEngagedMs: 45 * MINUTE,
  };

  it('reads the engagement document within ENGAGEMENT_READ_TIMEOUT_MS', async () => {
    expect(ENGAGEMENT_DOCUMENT).toBe('engagement');
    const { data, calls } = fakeData(() => Promise.resolve({ value: { ...stored } }));
    const { logger, events } = recordingLogger();

    await expect(readStoredEngagement(data, logger)).resolves.toEqual(stored);
    expect(calls).toEqual([
      {
        method: 'appState.get',
        input: { key: 'engagement' },
        options: { timeoutMs: ENGAGEMENT_READ_TIMEOUT_MS },
      },
    ]);
    expect(events).toEqual([]);
  });

  it('keeps only the clock fields of a good document, and a day no larger than the total', async () => {
    const { data } = fakeData(() =>
      Promise.resolve({ value: { ...stored, dayEngagedMs: 5 * HOUR, extra: 'ignored' } }),
    );
    const { logger } = recordingLogger();
    await expect(readStoredEngagement(data, logger)).resolves.toEqual({
      ...stored,
      dayEngagedMs: stored.engagedMs,
    });
  });

  it('is null for a profile with no document, without a warning', async () => {
    const { data } = fakeData(() => Promise.resolve({ value: null }));
    const { logger, events } = recordingLogger();
    await expect(readStoredEngagement(data, logger)).resolves.toBeNull();
    expect(events).toEqual([]);
  });

  it.each([
    ['a string', 'engaged'],
    ['a number', 42],
    ['an array', [stored]],
    ['an empty object', {}],
    ['a negative total', { ...stored, engagedMs: -1 }],
    ['a total that is a string', { ...stored, engagedMs: '5400000' }],
    ['a negative day total', { ...stored, dayEngagedMs: -1 }],
    ['an active day below 1', { ...stored, activeDay: 0 }],
    ['an active day that is not whole', { ...stored, activeDay: 1.5 }],
    ['a day that is not a date', { ...stored, dayKey: 'yesterday' }],
    ['a day without zero padding', { ...stored, dayKey: '2026-1-5' }],
    ['a document missing its day', { engagedMs: 1, activeDay: 1, dayEngagedMs: 0 }],
  ])('is null for garbage: %s', async (_name, value) => {
    const { data } = fakeData(() => Promise.resolve({ value }));
    const { logger } = recordingLogger();
    await expect(readStoredEngagement(data, logger)).resolves.toBeNull();
  });

  it('is null, and logged by code, when the read times out', async () => {
    const { data } = fakeData(() => Promise.reject(new DataClientError('timeout', 'appState.get')));
    const { logger, events } = recordingLogger();
    await expect(readStoredEngagement(data, logger)).resolves.toBeNull();
    expect(events).toEqual([{ level: 'warn', event: 'engagement.readFailed' }]);
  });

  it('is null, and logged by code, when the read is rejected for another reason', async () => {
    const { data } = fakeData(() => Promise.reject(new DataClientError('worker_gone', 'exit 1')));
    const { logger, events } = recordingLogger();
    await expect(readStoredEngagement(data, logger)).resolves.toBeNull();
    expect(events).toEqual([{ level: 'warn', event: 'engagement.readFailed' }]);
  });

  it('is null, and logged by code, when the call throws at once', async () => {
    const { data } = fakeData(() => {
      throw new Error('the client is closed');
    });
    const { logger, events } = recordingLogger();
    await expect(readStoredEngagement(data, logger)).resolves.toBeNull();
    expect(events).toEqual([{ level: 'warn', event: 'engagement.readFailed' }]);
  });
});

describe('engagementWriter', () => {
  const state: EngagementState = {
    engagedMs: 123_456,
    activeDay: 2,
    dayKey: TODAY,
    dayEngagedMs: 7_000,
  };

  it('writes the state as the engagement document, as a copy', async () => {
    const { data, calls } = fakeData(() => Promise.resolve({}));
    await engagementWriter(data)(state);

    expect(calls).toHaveLength(1);
    const call = pick(calls, 0, 'call');
    expect(call.method).toBe('appState.set');
    expect(call.input).toEqual({ key: 'engagement', value: state });
    expect((call.input as { value: unknown }).value).not.toBe(state);
  });

  it('lets a failed write reject, for the sampler to log', async () => {
    const { data } = fakeData(() => Promise.reject(new DataClientError('timeout', 'appState.set')));
    await expect(engagementWriter(data)(state)).rejects.toBeInstanceOf(DataClientError);
  });
});
