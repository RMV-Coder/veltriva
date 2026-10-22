// The regret metric (assessment §4.13): a tab brought back within one engaged hour of automation
// moving or unloading it. The clock gives wall time and engaged time apart, the timers are a clock
// a test moves, `persist` is a fake whose writes a test can hold, fail or let through, and the
// data client is a fake `call`.
//
// Nothing here waits on real time: `advance` moves the manual clock and `settled` lets the promise
// continuations a write sets off run, so "after 10 s one write has started" can be checked exactly.
import { describe, expect, it } from 'vitest';

import type { Timers } from '../../core/lifecycle/discard';
import { LIFECYCLE_RULES } from '../../core/lifecycle/policy';
import { DataClientError } from '../persistence/data-client';
import type { DataClient } from '../persistence/data-client';
import type { Logger } from '../platform/logger';
import {
  MAX_REGRET_EVENTS,
  parseRegret,
  readStoredRegret,
  REGRET_DOCUMENT,
  REGRET_WINDOW_ENGAGED_MS,
  REGRET_WRITE_DELAY_MS,
  regretWriter,
  RegretTracker,
} from './regret';
import type { RegretEvent, RegretState } from './regret';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** Lets every pending microtask run. */
const settled = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/** Timers on a clock a test moves. */
class ManualTimers implements Timers {
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

  /** Moves time forward by `ms`, firing the timers that fall due, in order, each at its own time. */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      await settled();
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
    await settled();
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

interface Write {
  /** The state `persist` was given. */
  readonly state: RegretState;
  readonly settle: PromiseWithResolvers<undefined>;
}

interface BuildOptions {
  readonly stored?: RegretState | null;
  /** True leaves each write for the test to settle. */
  readonly hold?: boolean;
}

/** The wall clock and the engaged clock start apart, as they do in a real run. */
const WALL_START = Date.UTC(2026, 9, 22, 9, 0, 0);
const ENGAGED_START = 5 * HOUR;

function build(options: BuildOptions = {}) {
  const timers = new ManualTimers();
  const { logger, events } = recordingLogger();
  const writes: Write[] = [];
  const clock = { wallNow: WALL_START, engagedNow: ENGAGED_START };
  const state = {
    hold: options.hold ?? false,
    /** How the next writes fail: by rejecting or by throwing at once (a count of each). */
    rejects: 0,
    throws: 0,
  };
  const tracker = new RegretTracker({
    stored: options.stored === undefined ? null : options.stored,
    persist: (next) => {
      const settle = Promise.withResolvers<undefined>();
      writes.push({ state: next, settle });
      if (state.throws > 0) {
        state.throws -= 1;
        throw new Error('persist threw at once');
      }
      if (state.rejects > 0) {
        state.rejects -= 1;
        return Promise.reject(new Error('the disk is full'));
      }
      if (!state.hold) {
        settle.resolve(undefined);
      }
      return settle.promise;
    },
    clock: () => ({ wallNow: clock.wallNow, engagedNow: clock.engagedNow }),
    timers,
    logger,
  });
  return { tracker, timers, writes, state, events, clock };
}

/** A regret event, newest-first lists being what the state and the stored document hold. */
function event(overrides: Partial<RegretEvent> = {}): RegretEvent {
  return {
    at: WALL_START - HOUR,
    how: 'restore',
    action: 'shelve',
    rule: 'shelve-beyond-cap',
    afterEngagedMs: 5 * MINUTE,
    ...overrides,
  };
}

/** The object without one of its keys. */
function withoutKey(object: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(object).filter(([name]) => name !== key));
}

const COUNTS = { moves: 0, moveRegrets: 0, unloads: 0, unloadRegrets: 0 };

/** A stored state with some history, as an earlier run left it. */
function storedState(overrides: Partial<RegretState> = {}): RegretState {
  return {
    since: WALL_START - 7 * 24 * HOUR,
    counts: { moves: 10, moveRegrets: 2, unloads: 30, unloadRegrets: 3 },
    events: [event({ at: WALL_START - 2 * HOUR }), event({ at: WALL_START - 3 * HOUR })],
    ...overrides,
  };
}

describe('the constants', () => {
  it('count a restore within one engaged hour, and write counts in bursts every 10 s', () => {
    expect(REGRET_WINDOW_ENGAGED_MS).toBe(HOUR);
    expect(REGRET_WRITE_DELAY_MS).toBe(10_000);
    expect(MAX_REGRET_EVENTS).toBe(200);
    expect(REGRET_DOCUMENT).toBe('regret');
  });
});

describe('RegretTracker: counting', () => {
  it('starts at zero, from the moment it was created, when nothing is stored', () => {
    const h = build();
    expect(h.tracker.state()).toEqual({ since: WALL_START, counts: COUNTS, events: [] });
  });

  it('carries on from what is stored', () => {
    const stored = storedState();
    const h = build({ stored });
    expect(h.tracker.state()).toEqual(stored);
  });

  it('counts a shelve or an archive as a move', () => {
    const h = build();
    h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
    h.tracker.automated('b', 'archive', 'archive-dormant');
    expect(h.tracker.state().counts).toEqual({ ...COUNTS, moves: 2 });
  });

  it('counts a discard as an unload, by either rule', () => {
    const h = build();
    h.tracker.automated('a', 'discard', 'discard-hidden');
    h.tracker.automated('b', 'discard', 'pressure-discard');
    expect(h.tracker.state().counts).toEqual({ ...COUNTS, unloads: 2 });
  });

  it('adds to the stored counts', () => {
    const h = build({ stored: storedState() });
    h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
    h.tracker.automated('b', 'discard', 'discard-hidden');
    expect(h.tracker.state().counts).toEqual({
      moves: 11,
      moveRegrets: 2,
      unloads: 31,
      unloadRegrets: 3,
    });
  });

  it('counts every action, also two on the same tab', () => {
    const h = build();
    h.tracker.automated('a', 'discard', 'discard-hidden');
    h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
    expect(h.tracker.state().counts).toEqual({ ...COUNTS, moves: 1, unloads: 1 });
  });

  it('gives a state that later counts do not change', () => {
    const h = build();
    const before = h.tracker.state();
    h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
    h.tracker.restored('a', 'restore');
    expect(before).toEqual({ since: WALL_START, counts: COUNTS, events: [] });
    expect(h.tracker.state().counts).toEqual({ ...COUNTS, moves: 1, moveRegrets: 1 });
  });

  it('does not let a caller change the events it keeps', () => {
    const h = build();
    h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
    h.tracker.restored('a', 'restore');
    const first = h.tracker.state();
    (first.events as RegretEvent[]).length = 0;
    expect(h.tracker.state().events).toHaveLength(1);
  });
});

describe('RegretTracker: a restore or an Undo of a move', () => {
  it.each([
    ['shelve', 'shelve-beyond-cap'],
    ['archive', 'archive-dormant'],
  ] as const)('is a regret for a tab automation %s-d within the hour', (action, rule) => {
    const h = build();
    h.tracker.automated('a', action, rule);
    h.clock.engagedNow += 10 * MINUTE;
    h.clock.wallNow += 25 * MINUTE;
    h.tracker.restored('a', 'restore');

    expect(h.tracker.state().counts).toEqual({ ...COUNTS, moves: 1, moveRegrets: 1 });
    expect(h.tracker.state().events).toEqual([
      {
        at: h.clock.wallNow,
        how: 'restore',
        action,
        rule,
        afterEngagedMs: 10 * MINUTE,
      },
    ]);
  });

  it('records an Undo as an event of its own kind, counted as a move regret', () => {
    const h = build();
    h.tracker.automated('a', 'archive', 'archive-dormant');
    h.clock.engagedNow += MINUTE;
    h.tracker.restored('a', 'undo');
    expect(h.tracker.state().events).toEqual([
      expect.objectContaining({ how: 'undo', action: 'archive', rule: 'archive-dormant' }),
    ]);
    expect(h.tracker.state().counts.moveRegrets).toBe(1);
  });

  it('measures the window on the engaged clock, from the engaged time of the move', () => {
    const h = build();
    h.clock.engagedNow = 100 * HOUR;
    h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
    h.clock.engagedNow += 12 * MINUTE + 345;
    h.tracker.restored('a', 'restore');
    expect(h.tracker.state().events[0]?.afterEngagedMs).toBe(12 * MINUTE + 345);
  });

  describe('the window of one engaged hour', () => {
    it('counts a restore just inside it', () => {
      const h = build();
      h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
      h.clock.engagedNow += REGRET_WINDOW_ENGAGED_MS - 1;
      h.tracker.restored('a', 'restore');
      expect(h.tracker.state().counts.moveRegrets).toBe(1);
      expect(h.tracker.state().events[0]?.afterEngagedMs).toBe(REGRET_WINDOW_ENGAGED_MS - 1);
    });

    it('counts a restore exactly at it', () => {
      const h = build();
      h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
      h.clock.engagedNow += REGRET_WINDOW_ENGAGED_MS;
      h.tracker.restored('a', 'restore');
      expect(h.tracker.state().counts.moveRegrets).toBe(1);
      expect(h.tracker.state().events[0]?.afterEngagedMs).toBe(REGRET_WINDOW_ENGAGED_MS);
    });

    it('does not count a restore a millisecond beyond it: the user just came back to it', () => {
      const h = build();
      h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
      h.clock.engagedNow += REGRET_WINDOW_ENGAGED_MS + 1;
      h.tracker.restored('a', 'restore');
      expect(h.tracker.state().counts).toEqual({ ...COUNTS, moves: 1 });
      expect(h.tracker.state().events).toEqual([]);
    });

    it('forgets the move after a restore beyond it: a second restore is no regret either', () => {
      const h = build();
      h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
      h.clock.engagedNow += 2 * HOUR;
      h.tracker.restored('a', 'restore');
      h.clock.engagedNow -= 2 * HOUR; // even if time were to look recent again
      h.tracker.restored('a', 'undo');
      expect(h.tracker.state().counts.moveRegrets).toBe(0);
      expect(h.tracker.state().events).toEqual([]);
    });

    it('does not use wall-clock time: days away change nothing while no engaged time passes', () => {
      const h = build();
      h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
      h.clock.wallNow += 14 * 24 * HOUR; // a holiday
      h.clock.engagedNow += 3 * MINUTE;
      h.tracker.restored('a', 'restore');
      expect(h.tracker.state().counts.moveRegrets).toBe(1);
      expect(h.tracker.state().events[0]).toMatchObject({
        at: h.clock.wallNow,
        afterEngagedMs: 3 * MINUTE,
      });
    });

    it('does not count engaged time beyond the hour as recent because little wall time passed', () => {
      const h = build();
      h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
      h.clock.wallNow += MINUTE;
      h.clock.engagedNow += 90 * MINUTE;
      h.tracker.restored('a', 'restore');
      expect(h.tracker.state().counts.moveRegrets).toBe(0);
    });

    it('takes an engaged clock that went backwards as no time at all', () => {
      const h = build();
      h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
      h.clock.engagedNow -= 5 * MINUTE;
      h.tracker.restored('a', 'restore');
      expect(h.tracker.state().events).toEqual([expect.objectContaining({ afterEngagedMs: 0 })]);
    });

    it('records whole milliseconds, rounded', () => {
      const h = build();
      h.clock.engagedNow = 1000.25;
      h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
      h.clock.engagedNow = 1000.25 + 500.6;
      h.tracker.restored('a', 'restore');
      expect(h.tracker.state().events[0]?.afterEngagedMs).toBe(501);
      expect(Number.isInteger(h.tracker.state().events[0]?.afterEngagedMs)).toBe(true);
    });
  });

  it('counts a tab once: a second restore after a regret does nothing', () => {
    const h = build();
    h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
    h.tracker.restored('a', 'restore');
    h.tracker.restored('a', 'restore');
    h.tracker.restored('a', 'undo');
    expect(h.tracker.state().counts).toEqual({ ...COUNTS, moves: 1, moveRegrets: 1 });
    expect(h.tracker.state().events).toHaveLength(1);
  });

  it('counts the tab again when automation moves it again', () => {
    const h = build();
    h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
    h.tracker.restored('a', 'restore');
    h.clock.engagedNow += 5 * HOUR;
    h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
    h.clock.engagedNow += MINUTE;
    h.tracker.restored('a', 'restore');
    expect(h.tracker.state().counts).toEqual({ ...COUNTS, moves: 2, moveRegrets: 2 });
    expect(h.tracker.state().events).toHaveLength(2);
  });

  it('ignores a tab automation has not moved', () => {
    const h = build();
    h.tracker.restored('unknown', 'restore');
    h.tracker.restored('unknown', 'undo');
    expect(h.tracker.state()).toEqual({ since: WALL_START, counts: COUNTS, events: [] });
  });

  it('ignores a tab it moved before the app started: a restart forgets what it did', () => {
    const h = build({ stored: storedState() });
    h.tracker.restored('moved-last-run', 'restore');
    expect(h.tracker.state()).toEqual(storedState());
  });

  it('watches each tab on its own', () => {
    const h = build();
    h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
    h.tracker.automated('b', 'archive', 'archive-dormant');
    h.tracker.restored('b', 'restore');
    expect(h.tracker.state().counts).toEqual({ ...COUNTS, moves: 2, moveRegrets: 1 });
    h.tracker.restored('a', 'restore');
    expect(h.tracker.state().counts.moveRegrets).toBe(2);
  });

  it('judges the latest thing automation did to a tab', () => {
    const h = build();
    h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
    h.clock.engagedNow += 2 * HOUR; // too long ago to count
    h.tracker.automated('a', 'archive', 'archive-dormant');
    h.clock.engagedNow += MINUTE;
    h.tracker.restored('a', 'restore');
    expect(h.tracker.state().events).toEqual([
      expect.objectContaining({
        action: 'archive',
        rule: 'archive-dormant',
        afterEngagedMs: MINUTE,
      }),
    ]);
  });

  it.each(LIFECYCLE_RULES)('records the rule %s that moved the tab', (rule) => {
    const h = build();
    h.tracker.automated('a', 'shelve', rule);
    h.tracker.restored('a', 'restore');
    expect(h.tracker.state().events[0]?.rule).toBe(rule);
  });
});

describe('RegretTracker: a reload of an unloaded tab', () => {
  it.each(['discard-hidden', 'pressure-discard'] as const)(
    'is a regret for a tab the rule %s unloaded within the hour',
    (rule) => {
      const h = build();
      h.tracker.automated('a', 'discard', rule);
      h.clock.engagedNow += 20 * MINUTE;
      h.clock.wallNow += 40 * MINUTE;
      h.tracker.reloaded('a');

      expect(h.tracker.state().counts).toEqual({ ...COUNTS, unloads: 1, unloadRegrets: 1 });
      expect(h.tracker.state().events).toEqual([
        {
          at: h.clock.wallNow,
          how: 'reload',
          action: 'discard',
          rule,
          afterEngagedMs: 20 * MINUTE,
        },
      ]);
    },
  );

  it('uses the same engaged hour: inside and exactly at it counts, beyond does not', () => {
    for (const [after, regretted] of [
      [REGRET_WINDOW_ENGAGED_MS - 1, 1],
      [REGRET_WINDOW_ENGAGED_MS, 1],
      [REGRET_WINDOW_ENGAGED_MS + 1, 0],
    ] as const) {
      const h = build();
      h.tracker.automated('a', 'discard', 'discard-hidden');
      h.clock.engagedNow += after;
      h.tracker.reloaded('a');
      expect(h.tracker.state().counts.unloadRegrets, String(after)).toBe(regretted);
      expect(h.tracker.state().events, String(after)).toHaveLength(regretted);
    }
  });

  it('forgets the unload after a reload beyond the hour', () => {
    const h = build();
    h.tracker.automated('a', 'discard', 'discard-hidden');
    h.clock.engagedNow += 2 * HOUR;
    h.tracker.reloaded('a');
    h.clock.engagedNow -= 2 * HOUR;
    h.tracker.reloaded('a');
    expect(h.tracker.state().counts.unloadRegrets).toBe(0);
  });

  it('counts a tab once: a second reload does nothing', () => {
    const h = build();
    h.tracker.automated('a', 'discard', 'discard-hidden');
    h.tracker.reloaded('a');
    h.tracker.reloaded('a');
    expect(h.tracker.state().counts).toEqual({ ...COUNTS, unloads: 1, unloadRegrets: 1 });
  });

  it('ignores a tab automation has not unloaded', () => {
    const h = build();
    h.tracker.reloaded('unknown');
    expect(h.tracker.state()).toEqual({ since: WALL_START, counts: COUNTS, events: [] });
  });
});

describe('RegretTracker: a discard is never regretted by a restore, and a move never by a reload', () => {
  it.each(['restore', 'undo'] as const)('ignores a %s of a tab that was only unloaded', (how) => {
    const h = build();
    h.tracker.automated('a', 'discard', 'discard-hidden');
    h.tracker.restored('a', how);
    expect(h.tracker.state().counts).toEqual({ ...COUNTS, unloads: 1 });
    expect(h.tracker.state().events).toEqual([]);
  });

  it('keeps watching the unload after a restore it ignored: a reload still counts', () => {
    const h = build();
    h.tracker.automated('a', 'discard', 'discard-hidden');
    h.tracker.restored('a', 'restore');
    h.tracker.reloaded('a');
    expect(h.tracker.state().counts).toEqual({ ...COUNTS, unloads: 1, unloadRegrets: 1 });
  });

  it('ignores a reload of a tab that was only moved', () => {
    const h = build();
    h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
    h.tracker.reloaded('a');
    expect(h.tracker.state().counts).toEqual({ ...COUNTS, moves: 1 });
    expect(h.tracker.state().events).toEqual([]);
  });

  it('keeps watching the move after a reload it ignored: a restore still counts', () => {
    const h = build();
    h.tracker.automated('a', 'archive', 'archive-dormant');
    h.tracker.reloaded('a');
    h.tracker.restored('a', 'restore');
    expect(h.tracker.state().counts).toEqual({ ...COUNTS, moves: 1, moveRegrets: 1 });
  });

  it('counts unloads and moves apart', () => {
    const h = build();
    h.tracker.automated('a', 'discard', 'discard-hidden');
    h.tracker.automated('b', 'shelve', 'shelve-beyond-cap');
    h.tracker.reloaded('a');
    h.tracker.restored('b', 'undo');
    expect(h.tracker.state().counts).toEqual({
      moves: 1,
      moveRegrets: 1,
      unloads: 1,
      unloadRegrets: 1,
    });
    expect(h.tracker.state().events.map((kept) => kept.how)).toEqual(['undo', 'reload']);
  });

  it('judges a tab by the last thing automation did: shelving an unloaded tab ends the unload watch', () => {
    const h = build();
    h.tracker.automated('a', 'discard', 'discard-hidden');
    h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
    h.tracker.reloaded('a');
    expect(h.tracker.state().counts.unloadRegrets).toBe(0);
    h.tracker.restored('a', 'restore');
    expect(h.tracker.state().counts.moveRegrets).toBe(1);
  });
});

describe('RegretTracker: the events', () => {
  it('lists the newest first', () => {
    const h = build();
    for (const [index, id] of ['a', 'b', 'c'].entries()) {
      h.tracker.automated(id, 'shelve', 'shelve-beyond-cap');
      h.clock.wallNow += 1000;
      h.clock.engagedNow += (index + 1) * MINUTE;
      h.tracker.restored(id, 'restore');
    }
    expect(h.tracker.state().events.map((kept) => kept.afterEngagedMs)).toEqual([
      3 * MINUTE,
      2 * MINUTE,
      MINUTE,
    ]);
    const times = h.tracker.state().events.map((kept) => kept.at);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('puts a new event ahead of the stored ones', () => {
    const stored = storedState();
    const h = build({ stored });
    h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
    h.tracker.restored('a', 'restore');
    const events = h.tracker.state().events;
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ at: WALL_START, action: 'shelve' });
    expect(events.slice(1)).toEqual(stored.events);
  });

  it('keeps no more than MAX_REGRET_EVENTS, the newest, though every regret is counted', () => {
    const h = build();
    const total = MAX_REGRET_EVENTS + 5;
    for (let index = 0; index < total; index += 1) {
      const id = `tab-${String(index)}`;
      h.tracker.automated(id, 'shelve', 'shelve-beyond-cap');
      h.clock.wallNow += 1;
      h.tracker.restored(id, 'restore');
    }
    const { counts, events } = h.tracker.state();
    expect(counts.moveRegrets).toBe(total);
    expect(events).toHaveLength(MAX_REGRET_EVENTS);
    expect(events[0]?.at).toBe(WALL_START + total);
    expect(events.at(-1)?.at).toBe(WALL_START + total - MAX_REGRET_EVENTS + 1);
  });

  it('keeps no more than MAX_REGRET_EVENTS of a stored list that is longer, the newest', () => {
    const stored = storedState({
      events: Array.from({ length: MAX_REGRET_EVENTS + 20 }, (_, index) =>
        event({ at: 10_000_000 - index }),
      ),
    });
    const h = build({ stored });
    const events = h.tracker.state().events;
    expect(events).toHaveLength(MAX_REGRET_EVENTS);
    expect(events[0]?.at).toBe(10_000_000);
    expect(events.at(-1)?.at).toBe(10_000_000 - (MAX_REGRET_EVENTS - 1));
  });

  it('drops the oldest stored event when a new regret comes at the cap', () => {
    const stored = storedState({
      events: Array.from({ length: MAX_REGRET_EVENTS }, (_, index) =>
        event({ at: 10_000_000 - index }),
      ),
    });
    const h = build({ stored });
    h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
    h.tracker.restored('a', 'restore');
    const events = h.tracker.state().events;
    expect(events).toHaveLength(MAX_REGRET_EVENTS);
    expect(events[0]?.at).toBe(WALL_START);
    expect(events.at(-1)?.at).toBe(10_000_000 - (MAX_REGRET_EVENTS - 2));
  });
});

describe('RegretTracker: writing', () => {
  it('writes nothing when it has no news: a tracker with stored state needs no write', async () => {
    const h = build({ stored: storedState() });
    await h.tracker.flush();
    await h.timers.advance(10 * REGRET_WRITE_DELAY_MS);
    expect(h.writes).toEqual([]);
    expect(h.timers.pending).toEqual([]);
  });

  describe('a fresh tracker, with nothing stored', () => {
    it('writes the start of counting on the first flush', async () => {
      const h = build();
      await h.tracker.flush();
      expect(h.writes.map((write) => write.state)).toEqual([
        { since: WALL_START, counts: COUNTS, events: [] },
      ]);
    });

    it('writes it once: a second flush has nothing new', async () => {
      const h = build();
      await h.tracker.flush();
      await h.tracker.flush();
      expect(h.writes).toHaveLength(1);
    });

    it('starts no timer on its own: the start waits for news or a flush', async () => {
      const h = build();
      expect(h.timers.pending).toEqual([]);
      await h.timers.advance(HOUR);
      expect(h.writes).toEqual([]);
    });

    it('writes the start along with the first count', async () => {
      const h = build();
      h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
      await h.timers.advance(REGRET_WRITE_DELAY_MS);
      expect(h.writes.map((write) => write.state)).toEqual([
        { since: WALL_START, counts: { ...COUNTS, moves: 1 }, events: [] },
      ]);
    });
  });

  describe('debounced', () => {
    it('starts a write 10 s after the first change, not before', async () => {
      const h = build({ stored: storedState() });
      h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
      expect(h.timers.pending).toEqual([REGRET_WRITE_DELAY_MS]);

      await h.timers.advance(REGRET_WRITE_DELAY_MS - 1);
      expect(h.writes).toEqual([]);
      await h.timers.advance(1);
      expect(h.writes).toHaveLength(1);
    });

    it('covers a whole burst with one write, of the state at its end', async () => {
      const h = build({ stored: storedState() });
      for (let index = 0; index < 20; index += 1) {
        h.tracker.automated(`tab-${String(index)}`, 'shelve', 'shelve-beyond-cap');
        await h.timers.advance(100); // 2 s in all: well inside the delay
      }
      expect(h.timers.pending).toHaveLength(1);
      await h.timers.advance(REGRET_WRITE_DELAY_MS);
      expect(h.writes).toHaveLength(1);
      expect(h.writes[0]?.state.counts.moves).toBe(30);
    });

    it('does not move the write later with each change', async () => {
      const h = build({ stored: storedState() });
      h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
      await h.timers.advance(REGRET_WRITE_DELAY_MS - 1);
      h.tracker.automated('b', 'shelve', 'shelve-beyond-cap');
      await h.timers.advance(1);
      expect(h.writes).toHaveLength(1);
    });

    it('counts a regret as news, and writes it with the event', async () => {
      const h = build({ stored: storedState() });
      h.tracker.automated('a', 'archive', 'archive-dormant');
      h.tracker.restored('a', 'undo');
      await h.timers.advance(REGRET_WRITE_DELAY_MS);
      expect(h.writes).toHaveLength(1);
      expect(h.writes[0]?.state.events[0]).toMatchObject({ how: 'undo', action: 'archive' });
      expect(h.writes[0]?.state.counts.moveRegrets).toBe(3);
    });

    it('starts a new timer for the next change after a write', async () => {
      const h = build({ stored: storedState() });
      h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
      await h.timers.advance(REGRET_WRITE_DELAY_MS);
      expect(h.timers.pending).toEqual([]);

      h.tracker.automated('b', 'shelve', 'shelve-beyond-cap');
      expect(h.timers.pending).toEqual([REGRET_WRITE_DELAY_MS]);
      await h.timers.advance(REGRET_WRITE_DELAY_MS);
      expect(h.writes.map((write) => write.state.counts.moves)).toEqual([11, 12]);
    });

    it('does not start a timer for a restore nobody counts', () => {
      const h = build({ stored: storedState() });
      h.tracker.restored('unknown', 'restore');
      h.tracker.reloaded('unknown');
      expect(h.timers.pending).toEqual([]);
    });

    it('does not start a timer for a restore beyond the hour, which only forgets', async () => {
      const h = build({ stored: storedState() });
      h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
      await h.timers.advance(REGRET_WRITE_DELAY_MS);
      h.clock.engagedNow += 2 * HOUR;
      h.tracker.restored('a', 'restore');
      expect(h.timers.pending).toEqual([]);
    });
  });

  describe('flush', () => {
    it('writes at once what changed, and cancels the timer', async () => {
      const h = build({ stored: storedState() });
      h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
      await h.tracker.flush();
      expect(h.writes).toHaveLength(1);
      expect(h.timers.pending).toEqual([]);

      await h.timers.advance(10 * REGRET_WRITE_DELAY_MS);
      expect(h.writes).toHaveLength(1);
    });

    it('resolves after the write has finished', async () => {
      const h = build({ stored: storedState(), hold: true });
      h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
      let done = false;
      const flushing = h.tracker.flush().then(() => {
        done = true;
      });
      await settled();
      expect(h.writes).toHaveLength(1);
      expect(done).toBe(false);

      h.writes[0]?.settle.resolve(undefined);
      await flushing;
      expect(done).toBe(true);
    });

    it('writes nothing more when nothing changed since the last write', async () => {
      const h = build({ stored: storedState() });
      h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
      await h.tracker.flush();
      await h.tracker.flush();
      await h.tracker.flush();
      expect(h.writes).toHaveLength(1);
    });

    it('waits for a write already under way when there is nothing new to write', async () => {
      const h = build({ stored: storedState(), hold: true });
      h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
      void h.tracker.flush();
      await settled();
      let done = false;
      const second = h.tracker.flush().then(() => {
        done = true;
      });
      await settled();
      expect(done).toBe(false);
      h.writes[0]?.settle.resolve(undefined);
      await second;
      expect(h.writes).toHaveLength(1);
    });

    it('writes the state of the moment it was called', async () => {
      const h = build({ stored: storedState(), hold: true });
      h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
      void h.tracker.flush();
      await settled();
      h.tracker.automated('b', 'shelve', 'shelve-beyond-cap');
      expect(h.writes[0]?.state.counts.moves).toBe(11);
    });

    it('waits its turn behind a write in progress, then writes the news', async () => {
      const h = build({ stored: storedState(), hold: true });
      h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
      void h.tracker.flush();
      await settled();
      h.tracker.automated('b', 'shelve', 'shelve-beyond-cap');
      const second = h.tracker.flush();
      await settled();
      expect(h.writes).toHaveLength(1); // the second write has not started

      h.writes[0]?.settle.resolve(undefined);
      await settled();
      expect(h.writes).toHaveLength(2);
      h.writes[1]?.settle.resolve(undefined);
      await second;
      expect(h.writes.map((write) => write.state.counts.moves)).toEqual([11, 12]);
    });
  });

  describe('stop', () => {
    it('cancels the pending write timer without writing', async () => {
      const h = build({ stored: storedState() });
      h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
      h.tracker.stop();
      expect(h.timers.pending).toEqual([]);
      await h.timers.advance(10 * REGRET_WRITE_DELAY_MS);
      expect(h.writes).toEqual([]);
    });

    it('leaves the news to a flush, which still writes it', async () => {
      const h = build({ stored: storedState() });
      h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
      h.tracker.stop();
      await h.tracker.flush();
      expect(h.writes).toHaveLength(1);
    });

    it('can be called with nothing pending, and twice', () => {
      const h = build();
      expect(() => {
        h.tracker.stop();
        h.tracker.stop();
      }).not.toThrow();
    });

    it('starts a timer again for a change after it', () => {
      const h = build({ stored: storedState() });
      h.tracker.stop();
      h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
      expect(h.timers.pending).toEqual([REGRET_WRITE_DELAY_MS]);
    });
  });

  describe('when a write fails', () => {
    it('logs regret.writeFailed, with no detail of the error, and flush still resolves', async () => {
      const h = build({ stored: storedState() });
      h.state.rejects = 1;
      h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
      await expect(h.tracker.flush()).resolves.toBeUndefined();
      expect(h.events).toEqual([{ level: 'warn', event: 'regret.writeFailed' }]);
    });

    it('logs it too when persist throws at once', async () => {
      const h = build({ stored: storedState() });
      h.state.throws = 1;
      h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
      await expect(h.tracker.flush()).resolves.toBeUndefined();
      expect(h.events).toEqual([{ level: 'warn', event: 'regret.writeFailed' }]);
    });

    it('logs it for a write the timer started, and the app goes on', async () => {
      const h = build({ stored: storedState() });
      h.state.rejects = 1;
      h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
      await h.timers.advance(REGRET_WRITE_DELAY_MS);
      expect(h.events).toEqual([{ level: 'warn', event: 'regret.writeFailed' }]);
    });

    it('does not break the next write: the news that follows is written', async () => {
      const h = build({ stored: storedState() });
      h.state.rejects = 1;
      h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
      await h.tracker.flush();

      h.tracker.automated('b', 'shelve', 'shelve-beyond-cap');
      await h.tracker.flush();
      expect(h.writes.map((write) => write.state.counts.moves)).toEqual([11, 12]);
      expect(h.events).toHaveLength(1);
    });

    it('does not retry on its own: the state is written again with the next change', async () => {
      const h = build({ stored: storedState() });
      h.state.rejects = 1;
      h.tracker.automated('a', 'shelve', 'shelve-beyond-cap');
      await h.tracker.flush();
      await h.timers.advance(10 * REGRET_WRITE_DELAY_MS);
      expect(h.writes).toHaveLength(1);
    });

    it('never rejects, however often it fails', async () => {
      const h = build({ stored: storedState() });
      h.state.rejects = 3;
      for (let index = 0; index < 3; index += 1) {
        h.tracker.automated(`tab-${String(index)}`, 'discard', 'discard-hidden');
        await expect(h.tracker.flush()).resolves.toBeUndefined();
      }
      expect(h.events.map((logged) => logged.event)).toEqual([
        'regret.writeFailed',
        'regret.writeFailed',
        'regret.writeFailed',
      ]);
    });
  });
});

describe('parseRegret', () => {
  const document = (overrides: Record<string, unknown> = {}) => ({
    since: 1_700_000_000_000,
    counts: { moves: 4, moveRegrets: 1, unloads: 9, unloadRegrets: 2 },
    events: [event()],
    ...overrides,
  });

  it('reads a good document', () => {
    expect(parseRegret(document())).toEqual({
      since: 1_700_000_000_000,
      counts: { moves: 4, moveRegrets: 1, unloads: 9, unloadRegrets: 2 },
      events: [event()],
    });
  });

  it('reads a document with no events', () => {
    expect(parseRegret(document({ events: [] }))?.events).toEqual([]);
  });

  it('keeps the order of the events, newest first as they were written', () => {
    const events = [event({ at: 3 }), event({ at: 2 }), event({ at: 1 })];
    expect(parseRegret(document({ events }))?.events.map((kept) => kept.at)).toEqual([3, 2, 1]);
  });

  it('accepts every how, action and rule the tracker writes', () => {
    const events = LIFECYCLE_RULES.flatMap((rule) =>
      (['restore', 'undo', 'reload'] as const).flatMap((how) =>
        (['shelve', 'archive', 'discard'] as const).map((action) => event({ rule, how, action })),
      ),
    );
    expect(parseRegret(document({ events }))?.events).toHaveLength(
      Math.min(events.length, MAX_REGRET_EVENTS),
    );
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'regret'],
    ['a JSON string', JSON.stringify(document())],
    ['a number', 42],
    ['true', true],
    ['an array', [document()]],
    ['an empty array', []],
    ['an empty object', {}],
    ['an object of nothing it knows', { rate: 0.1 }],
  ])('is null for %s', (_what, raw) => {
    expect(parseRegret(raw)).toBeNull();
  });

  describe('is null when the shape is wrong', () => {
    it.each(['since', 'counts', 'events'])('without %s', (key) => {
      expect(parseRegret(withoutKey(document(), key))).toBeNull();
    });

    it.each([
      ['negative', -1],
      ['a fraction', 1.5],
      ['NaN', Number.NaN],
      ['infinite', Infinity],
      ['a string', '1700000000000'],
      ['null', null],
    ])('with a start that is %s', (_what, since) => {
      expect(parseRegret(document({ since }))).toBeNull();
    });

    it('accepts a start of zero', () => {
      expect(parseRegret(document({ since: 0 }))?.since).toBe(0);
    });

    it.each(['moves', 'moveRegrets', 'unloads', 'unloadRegrets'])('with %s missing', (key) => {
      const counts = withoutKey({ moves: 1, moveRegrets: 0, unloads: 1, unloadRegrets: 0 }, key);
      expect(parseRegret(document({ counts }))).toBeNull();
    });

    it.each(['moves', 'moveRegrets', 'unloads', 'unloadRegrets'])(
      'with %s negative, fractional or not a number',
      (key) => {
        const good = { moves: 1, moveRegrets: 0, unloads: 1, unloadRegrets: 0 };
        for (const value of [-1, 0.5, Number.NaN, '3', null]) {
          expect(
            parseRegret(document({ counts: { ...good, [key]: value } })),
            String(value),
          ).toBeNull();
        }
      },
    );

    it.each([
      ['an object', {}],
      ['a string', 'many'],
      ['null', null],
    ])('with events that are %s', (_what, events) => {
      expect(parseRegret(document({ events }))).toBeNull();
    });

    it.each([
      ['null', null],
      ['a number', 3],
      ['an array', []],
    ])('with counts that are %s', (_what, counts) => {
      expect(parseRegret(document({ counts }))).toBeNull();
    });
  });

  describe('drops an invalid event alone, keeping the rest in order', () => {
    const good = (at: number) => event({ at });
    const mixed = (bad: unknown) =>
      parseRegret(document({ events: [good(3), bad, good(1)] }))?.events.map((kept) => kept.at);

    it.each([
      ['null', null],
      ['a string', 'event'],
      ['a number', 7],
      ['an array', []],
      ['an empty object', {}],
      ['an event with an unknown kind of how', { ...event(), how: 'click' }],
      ['an event with an unknown action', { ...event(), action: 'freeze' }],
      ['an event with an unknown rule', { ...event(), rule: 'whim' }],
      ['an event with a negative time', { ...event(), at: -1 }],
      ['an event with a fractional time', { ...event(), at: 1.5 }],
      ['an event with a time that is a string', { ...event(), at: '1' }],
      ['an event with a negative delay', { ...event(), afterEngagedMs: -1 }],
      ['an event with a fractional delay', { ...event(), afterEngagedMs: 0.5 }],
      ['an event missing its rule', { ...event(), rule: undefined }],
      ['an event missing its time', { ...event(), at: undefined }],
    ])('%s', (_what, bad) => {
      expect(mixed(bad)).toEqual([3, 1]);
    });

    it('drops every event when none is valid, keeping the counts', () => {
      const parsed = parseRegret(document({ events: [null, {}, 3] }));
      expect(parsed?.events).toEqual([]);
      expect(parsed?.counts).toEqual({ moves: 4, moveRegrets: 1, unloads: 9, unloadRegrets: 2 });
    });
  });

  it('reads at most the first MAX_REGRET_EVENTS events, which are the newest', () => {
    const events = Array.from({ length: MAX_REGRET_EVENTS + 50 }, (_, index) =>
      event({ at: 1_000_000 - index }),
    );
    const parsed = parseRegret(document({ events }));
    expect(parsed?.events).toHaveLength(MAX_REGRET_EVENTS);
    expect(parsed?.events[0]?.at).toBe(1_000_000);
    expect(parsed?.events.at(-1)?.at).toBe(1_000_000 - (MAX_REGRET_EVENTS - 1));
  });

  it('looks only at the first MAX_REGRET_EVENTS candidates: invalid ones among them are not made up for', () => {
    const events = [
      ...Array.from({ length: MAX_REGRET_EVENTS - 1 }, () => null),
      event({ at: 5 }),
      event({ at: 4 }),
    ];
    expect(parseRegret(document({ events }))?.events.map((kept) => kept.at)).toEqual([5]);
  });

  it('drops keys it does not know, in the document, the counts and the events', () => {
    const parsed = parseRegret(
      document({
        rate: 0.5,
        counts: { moves: 1, moveRegrets: 0, unloads: 1, unloadRegrets: 0, extra: 9 },
        events: [{ ...event(), tab: 'tab-1', title: 'A page' }],
      }),
    );
    expect(parsed).toEqual({
      since: 1_700_000_000_000,
      counts: { moves: 1, moveRegrets: 0, unloads: 1, unloadRegrets: 0 },
      events: [event()],
    });
    expect(parsed).not.toHaveProperty('rate');
    expect(parsed?.events[0]).not.toHaveProperty('tab');
  });

  it('does not change the document it is given', () => {
    const raw = document({ events: [event(), null] });
    const copy = structuredClone(raw);
    parseRegret(raw);
    expect(raw).toEqual(copy);
  });

  it('gives a state a tracker can carry on from', () => {
    const parsed = parseRegret(document());
    const h = build({ stored: parsed });
    expect(h.tracker.state()).toEqual(parsed);
  });
});

/** The data client's `call`, recording each one; `answer` decides what it returns. */
function fakeData(answer: (method: string, input: unknown) => unknown) {
  const calls: { method: string; input: unknown; options: unknown }[] = [];
  const data = {
    call: (method: string, input: unknown, options?: unknown) => {
      calls.push({ method, input, options });
      return Promise.resolve(answer(method, input));
    },
  } as unknown as Pick<DataClient, 'call'>;
  return { data, calls };
}

describe('readStoredRegret', () => {
  it('reads the regret document within a short timeout', async () => {
    const { data, calls } = fakeData(() => ({ value: storedState() }));
    const { logger, events } = recordingLogger();

    await expect(readStoredRegret(data, logger)).resolves.toEqual(storedState());
    expect(calls).toEqual([
      // REGRET_READ_TIMEOUT_MS: reading the metric must not hold the window back.
      { method: 'appState.get', input: { key: 'regret' }, options: { timeoutMs: 2000 } },
    ]);
    expect(events).toEqual([]);
  });

  it('is null, without a warning, for a profile with no document', async () => {
    const { data } = fakeData(() => ({ value: null }));
    const { logger, events } = recordingLogger();
    await expect(readStoredRegret(data, logger)).resolves.toBeNull();
    expect(events).toEqual([]);
  });

  it.each([
    ['an array', ['not', 'a', 'document']],
    ['a string', 'regret'],
    ['a number', 12],
    ['an object of the wrong shape', { since: 'yesterday' }],
    ['a document with bad counts', { since: 1, counts: { moves: -1 }, events: [] }],
  ])('is null, without a warning, for %s: counting starts again', async (_what, value) => {
    const { data } = fakeData(() => ({ value }));
    const { logger, events } = recordingLogger();
    await expect(readStoredRegret(data, logger)).resolves.toBeNull();
    expect(events).toEqual([]);
  });

  it('drops an invalid event and keeps the rest', async () => {
    const { data } = fakeData(() => ({
      value: { ...storedState(), events: [event({ at: 9 }), { how: 'x' }, event({ at: 7 })] },
    }));
    const { logger } = recordingLogger();
    const read = await readStoredRegret(data, logger);
    expect(read?.events.map((kept) => kept.at)).toEqual([9, 7]);
  });

  it.each<[string, Error]>([
    ['a timeout', new DataClientError('timeout', 'appState.get')],
    ['the worker gone', new DataClientError('worker_gone')],
    ['an error of any other kind', new Error('something with a title in it')],
  ])('is null, with a warning by code, when the call rejects: %s', async (_name, error) => {
    const data = { call: () => Promise.reject(error) } as unknown as Pick<DataClient, 'call'>;
    const { logger, events } = recordingLogger();

    await expect(readStoredRegret(data, logger)).resolves.toBeNull();
    expect(events).toEqual([{ level: 'warn', event: 'regret.readFailed' }]);
  });

  it('is null, with a warning, when the call throws at once', async () => {
    const data = {
      call: () => {
        throw new Error('the client is closed');
      },
    } as unknown as Pick<DataClient, 'call'>;
    const { logger, events } = recordingLogger();
    await expect(readStoredRegret(data, logger)).resolves.toBeNull();
    expect(events).toEqual([{ level: 'warn', event: 'regret.readFailed' }]);
  });
});

describe('regretWriter', () => {
  it('sets the regret document to the state', async () => {
    const { data, calls } = fakeData(() => ({}));
    const state = storedState();

    await expect(regretWriter(data)(state)).resolves.toBeUndefined();
    expect(calls).toEqual([
      {
        method: 'appState.set',
        input: {
          key: 'regret',
          value: { since: state.since, counts: state.counts, events: state.events },
        },
        options: undefined,
      },
    ]);
  });

  it('writes copies of the counts and the events, so a later change cannot reach the call', async () => {
    const { data, calls } = fakeData(() => ({}));
    const state = storedState();
    await regretWriter(data)(state);

    const sent = calls[0]?.input as {
      value: { counts: RegretState['counts']; events: RegretEvent[] };
    };
    expect(sent.value.counts).toEqual(state.counts);
    expect(sent.value.counts).not.toBe(state.counts);
    expect(sent.value.events[0]).toEqual(state.events[0]);
    expect(sent.value.events[0]).not.toBe(state.events[0]);
    expect(sent.value.events).not.toBe(state.events);
  });

  it('writes a state with no events as a document with an empty list', async () => {
    const { data, calls } = fakeData(() => ({}));
    await regretWriter(data)({ since: 5, counts: COUNTS, events: [] });
    expect(calls[0]?.input).toEqual({
      key: 'regret',
      value: { since: 5, counts: COUNTS, events: [] },
    });
  });

  it('rejects when the call does, so the tracker can report the failed write', async () => {
    const data = {
      call: () => Promise.reject(new DataClientError('sqlite', 'SQLITE_FULL')),
    } as unknown as Pick<DataClient, 'call'>;
    await expect(regretWriter(data)(storedState())).rejects.toBeInstanceOf(DataClientError);
  });

  it('writes what readStoredRegret reads back, through the tracker and a restart', async () => {
    const documents = new Map<string, unknown>();
    const data = {
      call: (method: string, input: { key: string; value?: unknown }) => {
        if (method === 'appState.set') {
          documents.set(input.key, JSON.parse(JSON.stringify(input.value)));
          return Promise.resolve({});
        }
        return Promise.resolve({ value: documents.get(input.key) ?? null });
      },
    } as unknown as Pick<DataClient, 'call'>;
    const { logger, events } = recordingLogger();
    const timers = new ManualTimers();
    const clock = { wallNow: WALL_START, engagedNow: ENGAGED_START };
    const make = (stored: RegretState | null) =>
      new RegretTracker({
        stored,
        persist: regretWriter(data),
        clock: () => ({ ...clock }),
        timers,
        logger,
      });

    expect(await readStoredRegret(data, logger)).toBeNull();
    const first = make(null);
    first.automated('a', 'shelve', 'shelve-beyond-cap');
    first.automated('b', 'discard', 'pressure-discard');
    clock.wallNow += 5000;
    clock.engagedNow += 7 * MINUTE;
    first.restored('a', 'undo');
    first.reloaded('b');
    await first.flush();

    const read = await readStoredRegret(data, logger);
    expect(read).toEqual(first.state());
    expect(read?.counts).toEqual({ moves: 1, moveRegrets: 1, unloads: 1, unloadRegrets: 1 });
    expect(read?.events.map((kept) => [kept.how, kept.action, kept.rule])).toEqual([
      ['reload', 'discard', 'pressure-discard'],
      ['undo', 'shelve', 'shelve-beyond-cap'],
    ]);

    // A restarted tracker carries on: the start, the counts and the events are the stored ones.
    clock.wallNow += HOUR;
    const second = make(read);
    expect(second.state()).toEqual(read);
    second.automated('c', 'archive', 'archive-dormant');
    second.restored('c', 'restore');
    expect(second.state().since).toBe(WALL_START);
    expect(second.state().counts).toEqual({
      moves: 2,
      moveRegrets: 2,
      unloads: 1,
      unloadRegrets: 1,
    });
    expect(second.state().events.map((kept) => kept.how)).toEqual(['restore', 'reload', 'undo']);
    await second.flush();
    expect(events).toEqual([]);
    expect((await readStoredRegret(data, logger))?.counts.moves).toBe(2);
  });

  it('writes the start of a fresh tracker, which reads back as the same start', async () => {
    const documents = new Map<string, unknown>();
    const data = {
      call: (method: string, input: { key: string; value?: unknown }) => {
        if (method === 'appState.set') {
          documents.set(input.key, JSON.parse(JSON.stringify(input.value)));
          return Promise.resolve({});
        }
        return Promise.resolve({ value: documents.get(input.key) ?? null });
      },
    } as unknown as Pick<DataClient, 'call'>;
    const { logger } = recordingLogger();
    const tracker = new RegretTracker({
      stored: null,
      persist: regretWriter(data),
      clock: () => ({ wallNow: WALL_START, engagedNow: ENGAGED_START }),
      timers: new ManualTimers(),
      logger,
    });
    await tracker.flush();
    expect(await readStoredRegret(data, logger)).toEqual({
      since: WALL_START,
      counts: COUNTS,
      events: [],
    });
  });
});
