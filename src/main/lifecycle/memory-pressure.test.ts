// Memory pressure (assessment §4.7): the level a reading calls for, and the monitor that polls it.
// The reader, the clock and the timers are fakes, so a test decides what the system reports and
// when the 10 s poll timer fires.
//
// Readings here are fractions of a 1,000,000 kB total, so `reading(0.04)` is exactly 4% available.
// The thresholds are the documented ones (critical under 4%, moderate under 10%, released 2 points
// higher); the first test pins them, so a retuned constant fails there and not obscurely below.
import { describe, expect, it } from 'vitest';

import type { Timers } from '../../core/lifecycle/discard';
import type { MemoryPressure } from '../../core/lifecycle/policy';
import {
  CRITICAL_FRACTION,
  DEFAULT_THRESHOLDS,
  ENTER_POLLS,
  levelFor,
  MemoryPressureMonitor,
  MODERATE_FRACTION,
  OOM_CRITICAL_MS,
  POLL_INTERVAL_MS,
  RELEASE_MARGIN,
} from './memory-pressure';
import type { MemoryInfo, PressureThresholds } from './memory-pressure';

const TOTAL = 1_000_000;
const reading = (available: number): MemoryInfo => ({
  total: TOTAL,
  free: Math.round(TOTAL * available),
});

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

describe('levelFor', () => {
  it('uses the documented thresholds', () => {
    expect(CRITICAL_FRACTION).toBe(0.04);
    expect(MODERATE_FRACTION).toBe(0.1);
    expect(RELEASE_MARGIN).toBe(0.02);
    expect(ENTER_POLLS).toBe(2);
  });

  // [the level now, the share of memory available, the level the reading calls for]
  const cases: readonly (readonly [MemoryPressure, number, MemoryPressure])[] = [
    // From none: critical under 4%, moderate under 10%, and the thresholds themselves are not under.
    ['none', 1, 'none'],
    ['none', 0.5, 'none'],
    ['none', 0.1001, 'none'],
    ['none', 0.1, 'none'],
    ['none', 0.0999, 'moderate'],
    ['none', 0.0401, 'moderate'],
    ['none', 0.04, 'moderate'],
    ['none', 0.0399, 'critical'],
    ['none', 0, 'critical'],
    // From moderate: it ends only above 12%, so 10% is not enough; critical begins at 4% as before.
    ['moderate', 0.5, 'none'],
    ['moderate', 0.1201, 'none'],
    ['moderate', 0.1199, 'moderate'],
    ['moderate', 0.1, 'moderate'],
    ['moderate', 0.0999, 'moderate'],
    ['moderate', 0.04, 'moderate'],
    ['moderate', 0.0399, 'critical'],
    // From critical: it ends only at 6% or more, and then it is moderate until 12%.
    ['critical', 0.5, 'none'],
    ['critical', 0.1201, 'none'],
    ['critical', 0.1199, 'moderate'],
    ['critical', 0.07, 'moderate'],
    ['critical', 0.0601, 'moderate'],
    ['critical', 0.06, 'moderate'],
    ['critical', 0.0599, 'critical'],
    ['critical', 0.05, 'critical'],
    ['critical', 0.0399, 'critical'],
    ['critical', 0, 'critical'],
  ];

  it.each(cases)('from %s, %s available calls for %s', (current, available, expected) => {
    expect(levelFor(reading(available), current)).toBe(expected);
  });

  it('works on any total: it is a fraction, not a size', () => {
    expect(levelFor({ total: 8_000_000, free: 316_000 }, 'none')).toBe('critical'); // 3.95% of 8 GB
    expect(levelFor({ total: 8_000_000, free: 790_000 }, 'none')).toBe('moderate'); // 9.9%
    expect(levelFor({ total: 8_000_000, free: 800_000 }, 'none')).toBe('none'); // 10%
    expect(levelFor({ total: 100, free: 3 }, 'none')).toBe('critical');
  });

  const nonsense: readonly (readonly [string, MemoryInfo])[] = [
    ['a total of 0', { total: 0, free: 0 }],
    ['a total of 0 and free memory', { total: 0, free: 500 }],
    ['a negative total', { total: -1000, free: 500 }],
    ['a total that is not a number', { total: Number.NaN, free: 500 }],
    ['negative free memory', { total: 1000, free: -1 }],
    ['free memory that is not a number', { total: 1000, free: Number.NaN }],
  ];

  it.each(['none', 'moderate', 'critical'] as const)(
    'keeps %s for a reading that makes no sense',
    (current) => {
      for (const [, info] of nonsense) {
        expect(levelFor(info, current)).toBe(current);
      }
    },
  );
});

function build(thresholds?: () => PressureThresholds) {
  const timers = new ManualTimers();
  const clock = { now: 10_000 };
  const system = { info: reading(0.5), throws: false, reads: 0 };
  const changes: MemoryPressure[] = [];
  const monitor = new MemoryPressureMonitor({
    ...(thresholds === undefined ? {} : { thresholds }),
    read: () => {
      system.reads += 1;
      if (system.throws) {
        throw new Error('no memory info');
      }
      return system.info;
    },
    timers,
    monotonic: () => clock.now,
    onChange: (level) => {
      changes.push(level);
    },
  });
  return {
    monitor,
    timers,
    clock,
    system,
    changes,
    /** Time passes, with no poll. */
    pass: (ms: number): void => {
      clock.now += ms;
    },
    /** The system reports this share available, and the monitor polls. */
    poll: (available: number, afterMs = 0): void => {
      clock.now += afterMs;
      system.info = reading(available);
      monitor.poll();
    },
  };
}

describe('MemoryPressureMonitor: levels', () => {
  it('starts at none, with no reading and no timer', () => {
    const h = build();
    expect(h.monitor.level()).toBe('none');
    expect(h.monitor.lastReading()).toBeNull();
    expect(h.timers.pending).toEqual([]);
    expect(h.system.reads).toBe(0);
  });

  it('needs ENTER_POLLS readings in a row to rise, and says so once', () => {
    const h = build();
    for (let i = 1; i < ENTER_POLLS; i += 1) {
      h.poll(0.03);
      expect(h.monitor.level()).toBe('none');
    }
    expect(h.changes).toEqual([]);

    h.poll(0.03);
    expect(h.monitor.level()).toBe('critical');
    expect(h.changes).toEqual(['critical']);
  });

  it('rises to moderate the same way', () => {
    const h = build();
    h.poll(0.08);
    expect(h.monitor.level()).toBe('none');
    h.poll(0.08);
    expect(h.monitor.level()).toBe('moderate');
    expect(h.changes).toEqual(['moderate']);
  });

  it('rises from moderate to critical with ENTER_POLLS critical readings, not before', () => {
    const h = build();
    h.poll(0.08);
    h.poll(0.08);
    h.poll(0.03);
    expect(h.monitor.level()).toBe('moderate');
    h.poll(0.03);
    expect(h.monitor.level()).toBe('critical');
    expect(h.changes).toEqual(['moderate', 'critical']);
  });

  it('a single dip does not move it, however often it comes', () => {
    const h = build();
    for (let i = 0; i < 4; i += 1) {
      h.poll(0.03);
      h.poll(0.5);
    }
    expect(h.monitor.level()).toBe('none');
    expect(h.changes).toEqual([]);
  });

  it('readings that call for different levels do not add up: the count starts again', () => {
    const h = build();
    h.poll(0.03); // critical, once
    h.poll(0.08); // moderate, once: the critical reading is forgotten
    expect(h.monitor.level()).toBe('none');
    h.poll(0.03); // critical, once again
    expect(h.monitor.level()).toBe('none');
    h.poll(0.08);
    h.poll(0.08);
    expect(h.monitor.level()).toBe('moderate');
    expect(h.changes).toEqual(['moderate']);
  });

  it('falls on one reading past the margin, and only past it', () => {
    const h = build();
    h.poll(0.03);
    h.poll(0.03);
    expect(h.changes).toEqual(['critical']);

    h.poll(0.05); // above 4% but under 6%: still critical
    h.poll(0.0599);
    expect(h.monitor.level()).toBe('critical');
    expect(h.changes).toEqual(['critical']);

    h.poll(0.07); // past the margin: moderate at once
    expect(h.monitor.level()).toBe('moderate');
    h.poll(0.11); // above 10% but under 12%: still moderate
    expect(h.monitor.level()).toBe('moderate');
    h.poll(0.13); // past the margin: none at once
    expect(h.monitor.level()).toBe('none');
    expect(h.changes).toEqual(['critical', 'moderate', 'none']);
  });

  it('falls from critical straight to none on one plentiful reading', () => {
    const h = build();
    h.poll(0.03);
    h.poll(0.03);
    h.poll(0.5);
    expect(h.monitor.level()).toBe('none');
    expect(h.changes).toEqual(['critical', 'none']);
  });

  it('having fallen, a level needs its ENTER_POLLS again to return', () => {
    const h = build();
    h.poll(0.03);
    h.poll(0.03);
    h.poll(0.07); // moderate
    h.poll(0.03);
    expect(h.monitor.level()).toBe('moderate');
    h.poll(0.03);
    expect(h.monitor.level()).toBe('critical');
    expect(h.changes).toEqual(['critical', 'moderate', 'critical']);
  });

  it('calls onChange only on a change: repeated readings at a level say nothing', () => {
    const h = build();
    h.poll(0.03);
    h.poll(0.03);
    for (let i = 0; i < 5; i += 1) {
      h.poll(0.02);
      h.poll(0.055);
    }
    expect(h.changes).toEqual(['critical']);
  });

  it('keeps the last reading for diagnostics', () => {
    const h = build();
    h.poll(0.3);
    expect(h.monitor.lastReading()).toEqual(reading(0.3));
    h.poll(0.2);
    expect(h.monitor.lastReading()).toEqual(reading(0.2));
  });
});

describe('the thresholds are settings (M5.1)', () => {
  it('default to the documented fractions', () => {
    expect(DEFAULT_THRESHOLDS).toEqual({
      moderate: MODERATE_FRACTION,
      critical: CRITICAL_FRACTION,
    });
  });

  it('levelFor uses the thresholds it is given, with the same release margin', () => {
    const higher = { moderate: 0.2, critical: 0.08 };
    expect(levelFor(reading(0.15), 'none', higher)).toBe('moderate');
    expect(levelFor(reading(0.07), 'none', higher)).toBe('critical');
    expect(levelFor(reading(0.21), 'none', higher)).toBe('none');
    // Released only above the threshold plus the margin.
    expect(levelFor(reading(0.21), 'moderate', higher)).toBe('moderate');
    expect(levelFor(reading(0.23), 'moderate', higher)).toBe('none');
    // The defaults would have said none for all of these.
    expect(levelFor(reading(0.15), 'none')).toBe('none');
  });

  it('the monitor reads them at every poll, so a change applies from the next one', () => {
    const thresholds = { current: DEFAULT_THRESHOLDS };
    const h = build(() => thresholds.current);
    h.poll(0.15);
    h.poll(0.15);
    expect(h.monitor.level()).toBe('none');

    thresholds.current = { moderate: 0.2, critical: 0.05 };
    h.poll(0.15);
    h.poll(0.15);
    expect(h.monitor.level()).toBe('moderate');

    thresholds.current = DEFAULT_THRESHOLDS;
    h.poll(0.15);
    expect(h.monitor.level()).toBe('none');
    expect(h.changes).toEqual(['moderate', 'none']);
  });
});

describe('MemoryPressureMonitor: readings that cannot be used', () => {
  it('ignores a reader that throws: the level, the count and the last reading stay', () => {
    const h = build();
    h.poll(0.03);
    h.poll(0.03);
    expect(h.monitor.level()).toBe('critical');

    h.system.throws = true;
    expect(() => {
      h.monitor.poll();
    }).not.toThrow();
    expect(h.monitor.level()).toBe('critical');
    expect(h.monitor.lastReading()).toEqual(reading(0.03));
    expect(h.changes).toEqual(['critical']);
  });

  it('a failed read neither counts toward a level nor breaks a run of readings', () => {
    const h = build();
    h.poll(0.03);
    h.system.throws = true;
    h.monitor.poll();
    h.system.throws = false;
    h.poll(0.03);
    expect(h.monitor.level()).toBe('critical');
    expect(h.changes).toEqual(['critical']);
  });

  it('survives a reader that throws from the first poll and from the timer', () => {
    const h = build();
    h.system.throws = true;
    expect(() => {
      h.monitor.start();
    }).not.toThrow();
    expect(h.monitor.lastReading()).toBeNull();
    expect(h.timers.pending).toEqual([POLL_INTERVAL_MS]);

    expect(() => {
      h.timers.fire(POLL_INTERVAL_MS);
    }).not.toThrow();
    expect(h.timers.pending).toEqual([POLL_INTERVAL_MS]); // still polling
    expect(h.system.reads).toBe(2);
  });

  it('a reading that makes no sense keeps the level and does not count as a low reading', () => {
    const h = build();
    h.poll(0.03);
    h.system.info = { total: 0, free: 0 };
    h.monitor.poll();
    h.poll(0.03);
    expect(h.monitor.level()).toBe('none'); // not two in a row: a nonsense reading came between
    expect(h.changes).toEqual([]);
  });

  it('a reading that makes no sense does not release a level', () => {
    const h = build();
    h.poll(0.03);
    h.poll(0.03);
    h.system.info = { total: 1000, free: -5 };
    h.monitor.poll();
    h.system.info = { total: Number.NaN, free: 100 };
    h.monitor.poll();
    expect(h.monitor.level()).toBe('critical');
    expect(h.changes).toEqual(['critical']);
  });
});

describe('MemoryPressureMonitor: renderers the system killed', () => {
  it.each(['oom', 'memory-eviction'])(
    '%s goes critical at once, whatever the readings say',
    (reason) => {
      const h = build();
      h.poll(0.5);
      h.monitor.rendererGone(reason);
      expect(h.monitor.level()).toBe('critical');
      expect(h.changes).toEqual(['critical']);
    },
  );

  it('goes critical from moderate at once too', () => {
    const h = build();
    h.poll(0.08);
    h.poll(0.08);
    h.monitor.rendererGone('oom');
    expect(h.monitor.level()).toBe('critical');
    expect(h.changes).toEqual(['moderate', 'critical']);
  });

  it('stays critical for OOM_CRITICAL_MS however plentiful memory is, and ends on the first poll after', () => {
    const h = build();
    h.monitor.rendererGone('oom');

    h.poll(0.9, 1_000);
    expect(h.monitor.level()).toBe('critical');
    h.poll(0.9, OOM_CRITICAL_MS - 1_000 - 1); // OOM_CRITICAL_MS - 1 ms since the death
    expect(h.monitor.level()).toBe('critical');
    expect(h.changes).toEqual(['critical']);

    h.poll(0.9, 1); // OOM_CRITICAL_MS since the death
    expect(h.monitor.level()).toBe('none');
    expect(h.changes).toEqual(['critical', 'none']);
  });

  it('a second death extends the window from then', () => {
    const h = build();
    h.monitor.rendererGone('oom');
    h.pass(100_000);
    h.monitor.rendererGone('memory-eviction');
    expect(h.changes).toEqual(['critical']); // already critical: nothing to say

    h.poll(0.9, OOM_CRITICAL_MS - 100_000 + 1); // past the first window, inside the second
    expect(h.monitor.level()).toBe('critical');
    h.poll(0.9, 100_000); // OOM_CRITICAL_MS + 1 since the second death
    expect(h.monitor.level()).toBe('none');
  });

  it('holds a level that the readings had already made critical', () => {
    const h = build();
    h.poll(0.03);
    h.poll(0.03);
    h.monitor.rendererGone('oom');
    expect(h.changes).toEqual(['critical']);
    h.poll(0.9, 1_000);
    expect(h.monitor.level()).toBe('critical');
  });

  it('after the window, low memory keeps it critical', () => {
    const h = build();
    h.monitor.rendererGone('oom');
    h.poll(0.03, OOM_CRITICAL_MS + 1);
    h.poll(0.03, POLL_INTERVAL_MS);
    expect(h.monitor.level()).toBe('critical');
    expect(h.changes).toEqual(['critical']);
  });

  it.each(['crashed', 'killed', 'launch-failed', 'abnormal-exit', 'clean-exit', 'OOM', ''])(
    'does nothing for the reason "%s"',
    (reason) => {
      const h = build();
      h.monitor.rendererGone(reason);
      expect(h.monitor.level()).toBe('none');
      expect(h.changes).toEqual([]);
    },
  );

  it('another reason starts no window: a critical level still ends on one plentiful reading', () => {
    const h = build();
    h.poll(0.03);
    h.poll(0.03);
    h.monitor.rendererGone('crashed');
    h.poll(0.9, 1_000);
    expect(h.monitor.level()).toBe('none');
    expect(h.changes).toEqual(['critical', 'none']);
  });
});

describe('MemoryPressureMonitor: the poll timer', () => {
  it('start() polls at once and arms one POLL_INTERVAL_MS timer', () => {
    const h = build();
    h.monitor.start();
    expect(h.system.reads).toBe(1);
    expect(h.monitor.lastReading()).toEqual(reading(0.5));
    expect(h.timers.pending).toEqual([POLL_INTERVAL_MS]);
    expect(h.changes).toEqual([]);
  });

  it('polls and re-arms on every timer, one timer at a time', () => {
    const h = build();
    h.monitor.start();
    for (let i = 1; i <= 3; i += 1) {
      h.timers.fire(POLL_INTERVAL_MS);
      expect(h.system.reads).toBe(1 + i);
      expect(h.timers.pending).toEqual([POLL_INTERVAL_MS]);
    }
  });

  it('low memory from the start becomes a level one timer later', () => {
    const h = build();
    h.system.info = reading(0.03);
    h.monitor.start();
    expect(h.monitor.level()).toBe('none');

    h.pass(POLL_INTERVAL_MS);
    h.timers.fire(POLL_INTERVAL_MS);
    expect(h.monitor.level()).toBe('critical');
    expect(h.changes).toEqual(['critical']);
  });

  it('stop() cancels the timer, and nothing polls afterwards', () => {
    const h = build();
    h.monitor.start();
    h.monitor.stop();
    expect(h.timers.pending).toEqual([]);
    expect(() => {
      h.timers.fire(POLL_INTERVAL_MS);
    }).toThrow(/no 10000 ms timer is pending/);
    expect(h.system.reads).toBe(1);
  });

  it('stop() is harmless before start() and when repeated', () => {
    const h = build();
    expect(() => {
      h.monitor.stop();
      h.monitor.start();
      h.monitor.stop();
      h.monitor.stop();
    }).not.toThrow();
    expect(h.timers.pending).toEqual([]);
  });
});
