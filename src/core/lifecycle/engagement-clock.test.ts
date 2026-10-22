import { describe, expect, it } from 'vitest';

import {
  ACTIVE_DAY_THRESHOLD_MS,
  IDLE_THRESHOLD_S,
  MAX_SAMPLE_STEP_MS,
  SAMPLE_INTERVAL_MS,
  advance,
  dayKeyOf,
  initialEngagement,
  parseEngagement,
} from './engagement-clock';
import type { EngagementState } from './engagement-clock';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Monday 2 March 2026, midnight UTC: day 0 of the calendar these tests walk through. */
const MONDAY = Date.UTC(2026, 2, 2);
/** The calendar day `n` days after that Monday, spelled out without the code under test. */
const day = (n: number): string => new Date(MONDAY + n * DAY).toISOString().slice(0, 10);

/** The wall-clock time of an ISO instant. */
const at = (iso: string): number => Date.parse(iso);

/** A clock on Monday with nothing counted yet, unless `overrides` say otherwise. */
const state = (overrides: Partial<EngagementState> = {}): EngagementState => ({
  engagedMs: 0,
  activeDay: 1,
  dayKey: day(0),
  dayEngagedMs: 0,
  ...overrides,
});

type Sample = Parameters<typeof advance>[1];
const engaged = (elapsedMs: number, dayKey = day(0)): Sample => ({
  elapsedMs,
  engaged: true,
  dayKey,
});
const idle = (elapsedMs: number, dayKey = day(0)): Sample => ({
  elapsedMs,
  engaged: false,
  dayKey,
});

/** The clock after `count` identical samples. */
function feed(start: EngagementState, count: number, sample: Sample): EngagementState {
  let current = start;
  for (let i = 0; i < count; i += 1) {
    current = advance(current, sample);
  }
  return current;
}

/** One calendar day: a first sample names the day, then `engagedSamples` engaged 30 s samples. */
function spendDay(start: EngagementState, dayKey: string, engagedSamples: number): EngagementState {
  return feed(
    advance(start, idle(SAMPLE_INTERVAL_MS, dayKey)),
    engagedSamples,
    engaged(SAMPLE_INTERVAL_MS, dayKey),
  );
}

/** A small deterministic generator (mulberry32): the same seed always gives the same sequence. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (random: () => number, below: number): number => Math.floor(random() * below);
const chance = (random: () => number, p: number): boolean => random() < p;
function pick<T>(random: () => number, items: readonly T[]): T {
  const item = items[int(random, items.length)];
  if (item === undefined) {
    throw new Error('pick() needs a non-empty list of defined items');
  }
  return item;
}

describe('the constants of assessment §4.6', () => {
  it('samples every 30 seconds', () => {
    expect(SAMPLE_INTERVAL_MS).toBe(30_000);
  });

  it('calls the user active after some input in the last 5 minutes', () => {
    expect(IDLE_THRESHOLD_S).toBe(300);
  });

  it('counts a day once engagement reaches 10 minutes', () => {
    expect(ACTIVE_DAY_THRESHOLD_MS).toBe(600_000);
  });

  it('lets one sample add at most two sampling intervals', () => {
    expect(MAX_SAMPLE_STEP_MS).toBe(60_000);
    expect(MAX_SAMPLE_STEP_MS).toBe(2 * SAMPLE_INTERVAL_MS);
  });
});

describe('initialEngagement', () => {
  it('starts with nothing engaged, on the first active day, on the day it is given', () => {
    expect(initialEngagement('2026-03-02')).toStrictEqual({
      engagedMs: 0,
      activeDay: 1,
      dayKey: '2026-03-02',
      dayEngagedMs: 0,
    });
  });

  it('gives a new object each time', () => {
    const first = initialEngagement('2026-03-02');
    const second = initialEngagement('2026-03-02');

    expect(first).toStrictEqual(second);
    expect(first).not.toBe(second);
  });

  it('makes a document parseEngagement accepts', () => {
    const fresh = initialEngagement('2026-03-02');

    expect(parseEngagement(fresh)).toStrictEqual(fresh);
  });

  it('does not change on a sample of the same day in which the user was away', () => {
    const fresh = initialEngagement(day(0));

    expect(advance(fresh, idle(SAMPLE_INTERVAL_MS))).toStrictEqual(fresh);
  });
});

describe('advance', () => {
  describe('within a day', () => {
    it('adds an engaged interval to the total and to the day', () => {
      expect(advance(state(), engaged(30 * SECOND))).toStrictEqual(
        state({ engagedMs: 30_000, dayEngagedMs: 30_000 }),
      );
    });

    it('adds to what the clock already holds', () => {
      const before = state({ engagedMs: 5 * HOUR, dayEngagedMs: 3 * MINUTE, activeDay: 7 });

      expect(advance(before, engaged(30_000))).toStrictEqual({
        engagedMs: 5 * HOUR + 30_000,
        dayEngagedMs: 3 * MINUTE + 30_000,
        activeDay: 7,
        dayKey: day(0),
      });
    });

    it('keeps adding, sample after sample', () => {
      const result = feed(state(), 5, engaged(SAMPLE_INTERVAL_MS));

      expect(result.engagedMs).toBe(150_000);
      expect(result.dayEngagedMs).toBe(150_000);
    });

    it('adds a single millisecond', () => {
      expect(advance(state(), engaged(1)).engagedMs).toBe(1);
    });

    it('adds a fraction of a millisecond, which a monotonic clock can report', () => {
      expect(advance(state(), engaged(0.5)).engagedMs).toBe(0.5);
    });

    it.each([1, 30_000, 60_000, 10 * HOUR])(
      'adds nothing for an interval of %i ms in which the user was not engaged',
      (elapsedMs) => {
        const before = state({ engagedMs: 90_000, dayEngagedMs: 60_000 });

        expect(advance(before, idle(elapsedMs))).toStrictEqual(before);
      },
    );

    it.each([
      ['zero', 0],
      ['negative', -1],
      ['a large negative', -HOUR],
      ['negative infinity', -Infinity],
      ['NaN', Number.NaN],
    ])('adds nothing when the elapsed time is %s', (_label, elapsedMs) => {
      const before = state({ engagedMs: 90_000, dayEngagedMs: 60_000 });

      expect(advance(before, engaged(elapsedMs))).toStrictEqual(before);
    });

    it('never lets NaN into the totals', () => {
      const result = feed(state(), 3, engaged(Number.NaN));

      expect(Number.isFinite(result.engagedMs)).toBe(true);
      expect(Number.isFinite(result.dayEngagedMs)).toBe(true);
    });

    it.each([
      ['one under the cap', MAX_SAMPLE_STEP_MS - 1, MAX_SAMPLE_STEP_MS - 1],
      ['exactly the cap', MAX_SAMPLE_STEP_MS, MAX_SAMPLE_STEP_MS],
      ['one over the cap', MAX_SAMPLE_STEP_MS + 1, MAX_SAMPLE_STEP_MS],
      ['five minutes, a stalled machine', 5 * MINUTE, MAX_SAMPLE_STEP_MS],
      ['eight hours, a sleep with no suspend event', 8 * HOUR, MAX_SAMPLE_STEP_MS],
      ['an infinite gap', Infinity, MAX_SAMPLE_STEP_MS],
    ])('adds at most the cap: %s', (_label, elapsedMs, added) => {
      const result = advance(state(), engaged(elapsedMs));

      expect(result.engagedMs).toBe(added);
      expect(result.dayEngagedMs).toBe(added);
    });

    it('counts a long engaged day in the day, and the day stays the same one', () => {
      const result = feed(state(), 240, engaged(SAMPLE_INTERVAL_MS));

      expect(result.dayEngagedMs).toBe(2 * HOUR);
      expect(result.dayKey).toBe(day(0));
    });

    it('does not count today as an active day, however much the user has done today', () => {
      // §4.6: today's index is 1 + the earlier days that reached the threshold.
      const result = feed(state(), 100, engaged(SAMPLE_INTERVAL_MS));

      expect(result.dayEngagedMs).toBeGreaterThan(ACTIVE_DAY_THRESHOLD_MS);
      expect(result.activeDay).toBe(1);
    });

    it('changes neither the dayKey nor the active day for a sample of the same day', () => {
      const before = state({ activeDay: 4, dayKey: '2026-07-19' });
      const result = advance(before, engaged(30_000, '2026-07-19'));

      expect(result.activeDay).toBe(4);
      expect(result.dayKey).toBe('2026-07-19');
    });

    it('does not change the state it was given', () => {
      const before = Object.freeze(state({ engagedMs: 1000, dayEngagedMs: 500 }));
      const copy = { ...before };

      advance(before, engaged(30_000));
      advance(before, engaged(30_000, day(1)));
      advance(before, idle(30_000, day(1)));

      expect(before).toStrictEqual(copy);
    });
  });

  describe('when a new calendar day begins', () => {
    const T = ACTIVE_DAY_THRESHOLD_MS;

    it('starts the new day at zero, keeps the total and names the new day', () => {
      const before = state({ engagedMs: 3 * HOUR, dayEngagedMs: 4 * MINUTE });

      expect(advance(before, idle(30_000, day(1)))).toStrictEqual({
        engagedMs: 3 * HOUR,
        dayEngagedMs: 0,
        activeDay: 1,
        dayKey: day(1),
      });
    });

    it.each([
      ['nothing', 0],
      ['one millisecond', 1],
      ['a glance of 30 seconds', 30_000],
      ['9 minutes 30 seconds', 9 * MINUTE + 30 * SECOND],
      ['one millisecond short of the threshold', T - 1],
    ])('does not count the day that ended with %s', (_label, dayEngagedMs) => {
      const before = state({ engagedMs: 5 * HOUR, dayEngagedMs, activeDay: 3 });

      expect(advance(before, idle(30_000, day(1))).activeDay).toBe(3);
    });

    it.each([
      ['exactly the threshold', T],
      ['one millisecond past it', T + 1],
      ['twice the threshold', 2 * T],
      ['a whole working day', 8 * HOUR],
    ])('counts the day that ended with %s', (_label, dayEngagedMs) => {
      const before = state({ engagedMs: 12 * HOUR, dayEngagedMs, activeDay: 3 });

      expect(advance(before, idle(30_000, day(1))).activeDay).toBe(4);
    });

    it('counts the day that ended only once, whatever the new day brings', () => {
      const before = state({ engagedMs: T, dayEngagedMs: T, activeDay: 2 });
      const result = feed(advance(before, idle(30_000, day(1))), 50, engaged(30_000, day(1)));

      expect(result.activeDay).toBe(3);
    });

    it('attributes an engaged sample taken on the new day to the new day', () => {
      const before = state({ engagedMs: HOUR, dayEngagedMs: 20 * MINUTE, activeDay: 5 });

      expect(advance(before, engaged(30_000, day(1)))).toStrictEqual({
        engagedMs: HOUR + 30_000,
        dayEngagedMs: 30_000,
        activeDay: 6,
        dayKey: day(1),
      });
    });

    it('does not let the sample that crosses midnight finish the day that just ended', () => {
      // Nine and a half minutes, then a 30 s interval reported on the next day: the interval
      // belongs to the new day, so the old one stays one sample short of the threshold.
      const before = state({ engagedMs: T - 30_000, dayEngagedMs: T - 30_000, activeDay: 5 });
      const result = advance(before, engaged(30_000, day(1)));

      expect(result.activeDay).toBe(5);
      expect(result.dayEngagedMs).toBe(30_000);
      expect(result.engagedMs).toBe(T);
    });

    it('caps the engaged interval of the sample that crosses midnight', () => {
      const result = advance(state(), engaged(3 * MINUTE, day(1)));

      expect(result.dayEngagedMs).toBe(MAX_SAMPLE_STEP_MS);
      expect(result.engagedMs).toBe(MAX_SAMPLE_STEP_MS);
    });

    it.each([0, -5, Number.NaN])(
      'rolls the day over for an engaged sample whose elapsed time is %f, adding nothing',
      (elapsedMs) => {
        const before = state({ engagedMs: T, dayEngagedMs: T, activeDay: 2 });

        expect(advance(before, engaged(elapsedMs, day(1)))).toStrictEqual({
          engagedMs: T,
          dayEngagedMs: 0,
          activeDay: 3,
          dayKey: day(1),
        });
      },
    );

    it('counts the day that ended once, however many days the sample skips', () => {
      // The app was closed on the days in between: nothing happened on them.
      const before = state({ engagedMs: T, dayEngagedMs: T, activeDay: 2 });

      expect(advance(before, idle(30_000, day(4))).activeDay).toBe(3);
    });

    it('changes the day at a month and a year boundary like any other', () => {
      const newYear = advance(
        state({ dayKey: '2026-12-31', dayEngagedMs: T, engagedMs: T }),
        idle(30_000, '2027-01-01'),
      );
      const newMonth = advance(
        state({ dayKey: '2026-03-31', dayEngagedMs: T - 1, engagedMs: T }),
        idle(30_000, '2026-04-01'),
      );

      expect(newYear).toStrictEqual(
        state({ dayKey: '2027-01-01', engagedMs: T, dayEngagedMs: 0, activeDay: 2 }),
      );
      expect(newMonth).toStrictEqual(
        state({ dayKey: '2026-04-01', engagedMs: T, dayEngagedMs: 0, activeDay: 1 }),
      );
    });

    it('also counts a day when the clock is set back to an earlier one, but never goes back', () => {
      const counted = state({ dayKey: day(5), dayEngagedMs: T, engagedMs: T, activeDay: 3 });
      const notCounted = state({ dayKey: day(5), dayEngagedMs: T - 1, engagedMs: T, activeDay: 3 });

      expect(advance(counted, idle(30_000, day(2)))).toStrictEqual({
        engagedMs: T,
        dayEngagedMs: 0,
        activeDay: 4,
        dayKey: day(2),
      });
      expect(advance(notCounted, idle(30_000, day(2)))).toStrictEqual({
        engagedMs: T,
        dayEngagedMs: 0,
        activeDay: 3,
        dayKey: day(2),
      });
    });

    it('keeps engagement the same when the clock is set back and the user is engaged', () => {
      const before = state({ dayKey: day(5), dayEngagedMs: 2 * MINUTE, engagedMs: HOUR });
      const result = advance(before, engaged(30_000, day(2)));

      expect(result.engagedMs).toBe(HOUR + 30_000);
      expect(result.dayEngagedMs).toBe(30_000);
    });

    it('never lets the active day go back when the clock is moved back and forth', () => {
      let current = state({ dayKey: day(5) });
      const indexes: number[] = [];
      for (const target of [5, 1, 5, 2, 9, 3, 3, 0, 8]) {
        current = feed(current, 25, engaged(SAMPLE_INTERVAL_MS, day(target)));
        indexes.push(current.activeDay);
      }

      for (let i = 1; i < indexes.length; i += 1) {
        expect(indexes[i]).toBeGreaterThanOrEqual(indexes[i - 1] ?? 0);
      }
      expect(current.engagedMs).toBe(9 * 25 * SAMPLE_INTERVAL_MS);
    });
  });

  describe('over several days', () => {
    it('advances the active day five times in a week where only the weekdays reach ten minutes', () => {
      // Mon-Fri: 20 samples of 30 s, exactly 10 minutes. Saturday: 19, a half minute short.
      // Sunday: the user did not touch the machine.
      const samplesOnEachDay = [20, 20, 20, 20, 20, 19, 0];
      const indexOnEachDay: number[] = [];
      let current = initialEngagement(day(0));
      for (const [d, samples] of samplesOnEachDay.entries()) {
        current = spendDay(current, day(d), samples);
        indexOnEachDay.push(current.activeDay);
      }

      // Today's index counts only the days before today: Monday shows up on Tuesday.
      expect(indexOnEachDay).toStrictEqual([1, 2, 3, 4, 5, 6, 6]);

      current = spendDay(current, day(7), 0);

      expect(current.activeDay).toBe(1 + 5);
      expect(current.engagedMs).toBe((5 * 20 + 19) * SAMPLE_INTERVAL_MS);
      expect(current.dayKey).toBe(day(7));
      expect(current.dayEngagedMs).toBe(0);
    });

    it('does not advance in a week of absence', () => {
      let current = initialEngagement(day(0));
      for (let d = 0; d <= 7; d += 1) {
        current = spendDay(current, day(d), 0);
      }

      expect(current).toStrictEqual({
        engagedMs: 0,
        activeDay: 1,
        dayKey: day(7),
        dayEngagedMs: 0,
      });
    });

    it('does not advance in ten days of 9 minutes 30 seconds', () => {
      let current = initialEngagement(day(0));
      for (let d = 0; d <= 10; d += 1) {
        current = spendDay(current, day(d), 19);
      }

      expect(current.activeDay).toBe(1);
      expect(current.engagedMs).toBe(11 * 19 * SAMPLE_INTERVAL_MS);
    });

    it('advances once a day in ten days of exactly ten minutes', () => {
      let current = initialEngagement(day(0));
      for (let d = 0; d <= 10; d += 1) {
        current = spendDay(current, day(d), 20);
      }

      // Days 0-9 have ended by day 10; day 10 is today and still counts for nothing.
      expect(current.activeDay).toBe(1 + 10);
    });

    it('counts days that are not consecutive', () => {
      let current = initialEngagement(day(0));
      for (const [d, samples] of [20, 0, 0, 0, 25, 0, 0].entries()) {
        current = spendDay(current, day(d), samples);
      }

      expect(current.activeDay).toBe(1 + 2);
    });

    it('does not count a day for a few glances at the screen', () => {
      let current = initialEngagement(day(0));
      for (let d = 0; d < 6; d += 1) {
        current = spendDay(current, day(d), 3);
      }

      expect(current.activeDay).toBe(1);
      expect(current.engagedMs).toBe(6 * 3 * SAMPLE_INTERVAL_MS);
    });

    it('never lets the total engagement go down', () => {
      let current = initialEngagement(day(0));
      let previous = current.engagedMs;
      for (let d = 0; d < 20; d += 1) {
        for (const samples of [0, 5, 20]) {
          current = spendDay(current, day(d), samples);
          expect(current.engagedMs).toBeGreaterThanOrEqual(previous);
          previous = current.engagedMs;
        }
      }
    });
  });
});

describe('dayKeyOf', () => {
  describe('in UTC', () => {
    it.each([
      ['2026-03-05T12:00:00.000Z', '2026-03-05'],
      ['2026-03-05T00:00:00.000Z', '2026-03-05'],
      ['2026-03-04T23:59:59.999Z', '2026-03-04'],
      ['2026-12-31T23:59:59.999Z', '2026-12-31'],
      ['2027-01-01T00:00:00.000Z', '2027-01-01'],
      ['2028-02-29T10:00:00.000Z', '2028-02-29'],
      ['2027-02-28T23:59:59.999Z', '2027-02-28'],
      ['2027-03-01T00:00:00.000Z', '2027-03-01'],
      ['1970-01-01T00:00:00.000Z', '1970-01-01'],
    ])('names %s as %s', (instant, expected) => {
      expect(dayKeyOf(at(instant), 0)).toBe(expected);
    });
  });

  describe('east of UTC, where getTimezoneOffset() is negative (UTC+8 is -480)', () => {
    it.each([
      ['2026-03-04T15:59:59.999Z', '2026-03-04'], // 23:59:59.999 on the 4th
      ['2026-03-04T16:00:00.000Z', '2026-03-05'], // local midnight
      ['2026-03-05T00:00:00.000Z', '2026-03-05'], // 08:00
      ['2026-03-05T15:59:59.999Z', '2026-03-05'], // the last millisecond of the 5th
      ['2026-03-05T16:00:00.000Z', '2026-03-06'], // the next local midnight
      ['2026-12-31T16:00:00.000Z', '2027-01-01'], // across the new year
    ])('names %s as %s', (instant, expected) => {
      expect(dayKeyOf(at(instant), -480)).toBe(expected);
    });

    it('can already be the next day while it is still the same day in UTC', () => {
      // 20:00Z on the 5th is already the 6th at UTC+8.
      expect(dayKeyOf(at('2026-03-05T20:00:00.000Z'), 0)).toBe('2026-03-05');
      expect(dayKeyOf(at('2026-03-05T20:00:00.000Z'), -480)).toBe('2026-03-06');
    });
  });

  describe('west of UTC, where getTimezoneOffset() is positive (UTC-5 is 300)', () => {
    it.each([
      ['2026-03-05T04:59:59.999Z', '2026-03-04'], // 23:59:59.999 on the 4th
      ['2026-03-05T05:00:00.000Z', '2026-03-05'], // local midnight
      ['2026-03-05T12:00:00.000Z', '2026-03-05'], // 07:00
      ['2026-03-06T04:59:59.999Z', '2026-03-05'], // the last millisecond of the 5th
      ['2026-03-06T05:00:00.000Z', '2026-03-06'], // the next local midnight
      ['2026-03-05T00:00:00.000Z', '2026-03-04'], // 19:00 on the 4th, already the 5th in UTC
      ['2027-01-01T04:59:59.999Z', '2026-12-31'], // still the old year
    ])('names %s as %s', (instant, expected) => {
      expect(dayKeyOf(at(instant), 300)).toBe(expected);
    });
  });

  describe('in a zone that is not a whole number of hours from UTC', () => {
    it.each([
      ['2026-03-05T18:29:59.999Z', -330, '2026-03-05'], // India, UTC+5:30
      ['2026-03-05T18:30:00.000Z', -330, '2026-03-06'],
      ['2026-03-05T18:14:59.999Z', -345, '2026-03-05'], // Nepal, UTC+5:45
      ['2026-03-05T18:15:00.000Z', -345, '2026-03-06'],
      ['2026-03-05T03:29:59.999Z', 210, '2026-03-04'], // Newfoundland standard, UTC-3:30
      ['2026-03-05T03:30:00.000Z', 210, '2026-03-05'],
    ])('names %s at offset %i as %s', (instant, offset, expected) => {
      expect(dayKeyOf(at(instant), offset)).toBe(expected);
    });
  });

  describe('in the extreme zones', () => {
    it('names the day at UTC+14 (-840)', () => {
      expect(dayKeyOf(at('2026-03-05T09:59:59.999Z'), -840)).toBe('2026-03-05');
      expect(dayKeyOf(at('2026-03-05T10:00:00.000Z'), -840)).toBe('2026-03-06');
    });

    it('names the day at UTC-12 (720)', () => {
      expect(dayKeyOf(at('2026-03-06T11:59:59.999Z'), 720)).toBe('2026-03-05');
      expect(dayKeyOf(at('2026-03-06T12:00:00.000Z'), 720)).toBe('2026-03-06');
    });
  });

  describe('on a daylight-saving change day (New York, 2026)', () => {
    // Spring forward: Sunday 8 March, 02:00 EST (UTC-5, offset 300) becomes 03:00 EDT (UTC-4, 240)
    // at 07:00Z. The day lasts 23 hours.
    it('names the 23-hour spring day the same from its first millisecond to its last', () => {
      expect(dayKeyOf(at('2026-03-08T04:59:59.999Z'), 300)).toBe('2026-03-07');
      expect(dayKeyOf(at('2026-03-08T05:00:00.000Z'), 300)).toBe('2026-03-08'); // midnight EST
      expect(dayKeyOf(at('2026-03-08T06:59:59.999Z'), 300)).toBe('2026-03-08'); // 01:59:59.999 EST
      expect(dayKeyOf(at('2026-03-08T07:00:00.000Z'), 240)).toBe('2026-03-08'); // 03:00 EDT
      expect(dayKeyOf(at('2026-03-09T03:59:59.999Z'), 240)).toBe('2026-03-08'); // 23:59:59.999 EDT
      expect(dayKeyOf(at('2026-03-09T04:00:00.000Z'), 240)).toBe('2026-03-09'); // midnight EDT
    });

    // Fall back: Sunday 1 November, 02:00 EDT (offset 240) becomes 01:00 EST (300) at 06:00Z. The
    // day lasts 25 hours, and 01:30 happens twice.
    it('names the 25-hour autumn day the same from its first millisecond to its last', () => {
      expect(dayKeyOf(at('2026-11-01T03:59:59.999Z'), 240)).toBe('2026-10-31');
      expect(dayKeyOf(at('2026-11-01T04:00:00.000Z'), 240)).toBe('2026-11-01'); // midnight EDT
      expect(dayKeyOf(at('2026-11-01T05:30:00.000Z'), 240)).toBe('2026-11-01'); // 01:30 EDT
      expect(dayKeyOf(at('2026-11-01T06:30:00.000Z'), 300)).toBe('2026-11-01'); // 01:30 EST, again
      expect(dayKeyOf(at('2026-11-02T04:59:59.999Z'), 300)).toBe('2026-11-01'); // 23:59:59.999 EST
      expect(dayKeyOf(at('2026-11-02T05:00:00.000Z'), 300)).toBe('2026-11-02'); // midnight EST
    });

    it('lets the offset in force name the day: the same instant is two days in two zones', () => {
      // 04:30Z on 8 March is 23:30 on the 7th in New York (offset 300) and 12:30 on the 8th in
      // Hong Kong (offset -480).
      expect(dayKeyOf(at('2026-03-08T04:30:00.000Z'), 300)).toBe('2026-03-07');
      expect(dayKeyOf(at('2026-03-08T04:30:00.000Z'), -480)).toBe('2026-03-08');
    });
  });

  describe('as a day key', () => {
    it('is always a document parseEngagement accepts', () => {
      const random = mulberry32(11);
      for (let i = 0; i < 200; i += 1) {
        const wall = Date.UTC(2000, 0, 1) + int(random, 40 * 365) * DAY + int(random, DAY);
        const key = dayKeyOf(wall, pick(random, [0, -480, 300, -330, 240, 720, -840]));

        expect(
          parseEngagement({ engagedMs: 0, activeDay: 1, dayKey: key, dayEngagedMs: 0 }),
        ).not.toBeNull();
      }
    });

    it('is the local day: the floor of local milliseconds over a day, for any instant and offset', () => {
      const random = mulberry32(12);
      const offsets = [0, -480, 300, -330, -345, 210, 720, -840, 60, -60, 480, -300];
      const wrong: string[] = [];
      for (let i = 0; i < 5000; i += 1) {
        const offset = pick(random, offsets);
        // From 1950 to 2030.
        const wall = Math.floor(random() * 80 * 365 * DAY) - 20 * 365 * DAY;
        const key = dayKeyOf(wall, offset);
        const keyAsDays = Date.parse(`${key}T00:00:00.000Z`) / DAY;
        const expectedDays = Math.floor((wall - offset * MINUTE) / DAY);
        if (keyAsDays !== expectedDays) {
          wrong.push(`${String(wall)} @ ${String(offset)}: ${key}`);
        }
      }

      expect(wrong.slice(0, 5)).toStrictEqual([]);
    });

    it('never goes back as time moves forward, for a fixed offset', () => {
      for (const offset of [0, -480, 300, -330]) {
        let previous = '';
        for (
          let wall = at('2026-01-01T00:00:00.000Z');
          wall < at('2027-01-01T00:00:00.000Z');
          wall += 37 * MINUTE
        ) {
          const key = dayKeyOf(wall, offset);

          expect(key >= previous).toBe(true);
          previous = key;
        }
      }
    });
  });
});

describe('parseEngagement', () => {
  const VALID = {
    engagedMs: 90 * MINUTE,
    activeDay: 4,
    dayKey: '2026-03-05',
    dayEngagedMs: 12 * MINUTE,
  };

  /** `VALID` with `field` replaced. */
  const withField = (field: string, value: unknown): Record<string, unknown> => ({
    ...VALID,
    [field]: value,
  });
  /** `VALID` with `field` left out. */
  const without = (field: string): Record<string, unknown> =>
    Object.fromEntries(Object.entries(VALID).filter(([key]) => key !== field));

  describe('accepts a valid document', () => {
    it('and returns the same four fields', () => {
      expect(parseEngagement(VALID)).toStrictEqual(VALID);
    });

    it('as a new object, not the one it was given', () => {
      expect(parseEngagement(VALID)).not.toBe(VALID);
    });

    it('after a round trip through JSON, which is how it is stored', () => {
      expect(parseEngagement(JSON.parse(JSON.stringify(VALID)))).toStrictEqual(VALID);
    });

    it('with zeros', () => {
      const zeros = { engagedMs: 0, activeDay: 1, dayKey: '2026-01-01', dayEngagedMs: 0 };

      expect(parseEngagement(zeros)).toStrictEqual(zeros);
    });

    it('with fractional times, which a monotonic clock can leave behind', () => {
      const fractional = { ...VALID, engagedMs: 1000.25, dayEngagedMs: 3.5 };

      expect(parseEngagement(fractional)).toStrictEqual(fractional);
    });

    it('with a very large active day and total', () => {
      const large = { ...VALID, activeDay: 36_500, engagedMs: 1e12, dayEngagedMs: 1e6 };

      expect(parseEngagement(large)).toStrictEqual(large);
    });

    it('for whatever advance produces', () => {
      let current = initialEngagement(day(0));
      for (let d = 0; d < 12; d += 1) {
        current = spendDay(current, day(d), (d * 7) % 25);

        expect(parseEngagement(current)).toStrictEqual(current);
      }
    });

    it('ignores fields it does not know', () => {
      const parsed = parseEngagement({ ...VALID, extra: 'x', version: 2, nested: { a: 1 } });

      expect(parsed).toStrictEqual(VALID);
      expect(Object.keys(parsed ?? {}).sort()).toStrictEqual([
        'activeDay',
        'dayEngagedMs',
        'dayKey',
        'engagedMs',
      ]);
    });
  });

  describe('rejects what is not an object', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['a number', 42],
      ['zero', 0],
      ['a string', 'engagement'],
      ['a JSON string of a valid document', JSON.stringify(VALID)],
      ['true', true],
      ['an empty array', []],
      ['an array of valid documents', [VALID]],
      ['an array that carries the right properties', Object.assign([], VALID)],
      ['a function', () => VALID],
      ['a bigint', 5n],
    ])('%s', (_label, raw) => {
      expect(parseEngagement(raw)).toBeNull();
    });

    it('rejects an empty object', () => {
      expect(parseEngagement({})).toBeNull();
    });
  });

  describe('rejects a document with a field missing', () => {
    it.each(['engagedMs', 'activeDay', 'dayKey', 'dayEngagedMs'])('without %s', (field) => {
      expect(parseEngagement(without(field))).toBeNull();
    });

    it('with a field present but undefined', () => {
      for (const field of ['engagedMs', 'activeDay', 'dayKey', 'dayEngagedMs']) {
        expect(parseEngagement(withField(field, undefined))).toBeNull();
      }
    });
  });

  describe('rejects a field of the wrong type', () => {
    const NOT_A_NUMBER = [
      ['a numeric string', '5'],
      ['an empty string', ''],
      ['null', null],
      ['a boolean', true],
      ['an array', [5]],
      ['an object', { value: 5 }],
      ['a bigint', 5n],
    ] as const;

    describe.each(['engagedMs', 'dayEngagedMs', 'activeDay'])('%s', (field) => {
      it.each(NOT_A_NUMBER)('as %s', (_label, value) => {
        expect(parseEngagement(withField(field, value))).toBeNull();
      });
    });

    it.each([
      ['a number', 20_260_305],
      ['null', null],
      ['a Date', new Date(MONDAY)],
      ['an array', ['2026-03-05']],
      ['an object', { value: '2026-03-05' }],
      ['a boolean', true],
    ])('dayKey as %s', (_label, value) => {
      expect(parseEngagement(withField('dayKey', value))).toBeNull();
    });
  });

  describe('rejects numbers that cannot be a time', () => {
    describe.each(['engagedMs', 'dayEngagedMs'])('%s', (field) => {
      it.each([
        ['negative', -1],
        ['a small negative fraction', -0.001],
        ['NaN', Number.NaN],
        ['Infinity', Infinity],
        ['negative infinity', -Infinity],
      ])('when it is %s', (_label, value) => {
        expect(parseEngagement(withField(field, value))).toBeNull();
      });
    });
  });

  describe('rejects an active day that is not a day number', () => {
    it.each([
      ['zero', 0],
      ['negative', -1],
      ['just under one', 0.999],
      ['a fraction', 1.5],
      ['a fraction above', 7.25],
      ['NaN', Number.NaN],
      ['Infinity', Infinity],
      ['negative infinity', -Infinity],
    ])('when it is %s', (_label, value) => {
      expect(parseEngagement(withField('activeDay', value))).toBeNull();
    });

    it('accepts the first active day', () => {
      expect(parseEngagement(withField('activeDay', 1))?.activeDay).toBe(1);
    });
  });

  describe('rejects a malformed dayKey', () => {
    it.each([
      ['empty', ''],
      ['month and day without zeros', '2026-3-5'],
      ['day without a zero', '2026-03-5'],
      ['a two-digit year', '26-03-05'],
      ['no separators', '20260305'],
      ['slashes', '2026/03/05'],
      ['dots', '2026.03.05'],
      ['a time attached', '2026-03-05T10:00:00Z'],
      ['a leading space', ' 2026-03-05'],
      ['a trailing space', '2026-03-05 '],
      ['a trailing newline', '2026-03-05\n'],
      ['a prefix', 'day 2026-03-05'],
      ['a suffix', '2026-03-05-01'],
      ['full-width digits', '２０２６-03-05'],
      ['letters', 'YYYY-MM-DD'],
      ['a five-digit year', '12026-03-05'],
    ])('when it is %s', (_label, dayKey) => {
      expect(parseEngagement(withField('dayKey', dayKey))).toBeNull();
    });
  });

  describe('clamps the day to the total', () => {
    it('lowers dayEngagedMs to engagedMs when it is larger', () => {
      expect(parseEngagement({ ...VALID, engagedMs: 100, dayEngagedMs: 500 })).toStrictEqual({
        engagedMs: 100,
        activeDay: 4,
        dayKey: '2026-03-05',
        dayEngagedMs: 100,
      });
    });

    it('leaves dayEngagedMs alone when it equals engagedMs', () => {
      expect(parseEngagement({ ...VALID, engagedMs: 500, dayEngagedMs: 500 })?.dayEngagedMs).toBe(
        500,
      );
    });

    it('leaves dayEngagedMs alone when it is smaller', () => {
      expect(parseEngagement({ ...VALID, engagedMs: 500, dayEngagedMs: 499 })?.dayEngagedMs).toBe(
        499,
      );
    });

    it('never changes engagedMs', () => {
      expect(parseEngagement({ ...VALID, engagedMs: 7, dayEngagedMs: 7000 })?.engagedMs).toBe(7);
    });

    it('clamps to zero when nothing has been engaged', () => {
      expect(parseEngagement({ ...VALID, engagedMs: 0, dayEngagedMs: 1234 })?.dayEngagedMs).toBe(0);
    });

    it('still rejects a negative day total instead of clamping it up', () => {
      expect(parseEngagement({ ...VALID, dayEngagedMs: -1 })).toBeNull();
    });
  });
});

describe('a simulated stretch of 30-second samples', () => {
  const ENGAGED_CHANCES = [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 1] as const;
  const ELAPSED_VALUES = [
    SAMPLE_INTERVAL_MS,
    SAMPLE_INTERVAL_MS,
    SAMPLE_INTERVAL_MS,
    SAMPLE_INTERVAL_MS,
    0,
    SAMPLE_INTERVAL_MS - 1,
    MAX_SAMPLE_STEP_MS,
    MAX_SAMPLE_STEP_MS + 1,
    4 * MAX_SAMPLE_STEP_MS,
    -1,
    Number.NaN,
    5 * MINUTE,
  ] as const;
  const SAMPLES = 4000;

  interface Outcome {
    readonly violations: string[];
    /** Days that ended at or above the threshold, and below it. */
    readonly daysCounted: number;
    readonly daysNotCounted: number;
    readonly samplesEngaged: number;
  }

  /**
   * Feeds `SAMPLES` samples to the clock, a new day now and then, and checks the invariants after
   * each. With `forwardOnly` the days only advance and an independent per-day tally checks the
   * clock exactly; without it the clock is also set back now and then, and the samples are
   * irregular (gaps, zero, negative, NaN), so only the invariants are checked.
   */
  function simulate(seed: number, forwardOnly: boolean): Outcome {
    const random = mulberry32(seed);
    const violations: string[] = [];
    const perDay = new Map<string, number>();
    let current = initialEngagement(day(0));
    let dayIndex = 0;
    let engagedChance = pick(random, ENGAGED_CHANCES);
    let engagedTotal = 0;
    let samplesEngaged = 0;

    for (let i = 0; i < SAMPLES; i += 1) {
      const previous = current;
      if (chance(random, 1 / 150)) {
        dayIndex =
          !forwardOnly && chance(random, 0.3)
            ? Math.max(0, dayIndex - 1 - int(random, 3))
            : dayIndex + 1 + int(random, 2);
        engagedChance = pick(random, ENGAGED_CHANCES);
      }
      const sample: Sample = {
        elapsedMs: forwardOnly ? SAMPLE_INTERVAL_MS : pick(random, ELAPSED_VALUES),
        engaged: chance(random, engagedChance),
        dayKey: day(dayIndex),
      };
      const step = sample.engaged && sample.elapsedMs > 0 ? Math.min(sample.elapsedMs, 60_000) : 0;
      current = advance(previous, sample);
      if (step > 0) {
        samplesEngaged += 1;
      }
      const where = `seed ${String(seed)}, sample ${String(i)}`;
      const dayChanged = sample.dayKey !== previous.dayKey;

      if (current.engagedMs < previous.engagedMs) {
        violations.push(`${where}: engagedMs went down`);
      }
      if (current.engagedMs - previous.engagedMs !== step) {
        violations.push(
          `${where}: engagedMs grew by ${String(current.engagedMs - previous.engagedMs)}, expected ${String(step)}`,
        );
      }
      if (current.dayEngagedMs > current.engagedMs) {
        violations.push(`${where}: dayEngagedMs is above engagedMs`);
      }
      if (current.activeDay < 1 || current.activeDay < previous.activeDay) {
        violations.push(`${where}: activeDay went to ${String(current.activeDay)}`);
      }
      if (!dayChanged && current.activeDay !== previous.activeDay) {
        violations.push(`${where}: activeDay changed without a day change`);
      }
      if (dayChanged && current.activeDay - previous.activeDay > 1) {
        violations.push(`${where}: activeDay jumped by more than one`);
      }
      if (current.dayKey !== sample.dayKey) {
        violations.push(`${where}: dayKey is ${current.dayKey}`);
      }
      if (parseEngagement(current) === null) {
        violations.push(`${where}: the state is not a valid document`);
      }

      if (forwardOnly) {
        // An independent tally: engagement per calendar day, and the days before today that
        // reached the threshold.
        perDay.set(sample.dayKey, (perDay.get(sample.dayKey) ?? 0) + step);
        engagedTotal += step;
        const earlierActive = [...perDay].filter(
          ([key, ms]) => key < sample.dayKey && ms >= ACTIVE_DAY_THRESHOLD_MS,
        ).length;
        if (current.activeDay !== 1 + earlierActive) {
          violations.push(
            `${where}: activeDay is ${String(current.activeDay)}, expected ${String(1 + earlierActive)}`,
          );
        }
        if (current.dayEngagedMs !== (perDay.get(sample.dayKey) ?? 0)) {
          violations.push(`${where}: dayEngagedMs is ${String(current.dayEngagedMs)}`);
        }
        if (current.engagedMs !== engagedTotal) {
          violations.push(`${where}: engagedMs is ${String(current.engagedMs)}`);
        }
      }
    }

    const ended = [...perDay].filter(([key]) => key < current.dayKey);
    return {
      violations,
      daysCounted: ended.filter(([, ms]) => ms >= ACTIVE_DAY_THRESHOLD_MS).length,
      daysNotCounted: ended.filter(([, ms]) => ms < ACTIVE_DAY_THRESHOLD_MS).length,
      samplesEngaged,
    };
  }

  it('keeps every invariant, and agrees with a per-day tally, while the days only go forward', () => {
    let daysCounted = 0;
    let daysNotCounted = 0;
    const violations: string[] = [];
    for (let seed = 1; seed <= 25; seed += 1) {
      const outcome = simulate(seed, true);
      violations.push(...outcome.violations);
      daysCounted += outcome.daysCounted;
      daysNotCounted += outcome.daysNotCounted;
    }

    expect(violations.slice(0, 5)).toStrictEqual([]);
    // The simulation is not vacuous: it saw days on both sides of the threshold.
    expect(daysCounted).toBeGreaterThan(20);
    expect(daysNotCounted).toBeGreaterThan(20);
  });

  it('keeps its invariants when the clock is also set back and the samples are irregular', () => {
    const violations: string[] = [];
    let samplesEngaged = 0;
    for (let seed = 101; seed <= 125; seed += 1) {
      const outcome = simulate(seed, false);
      violations.push(...outcome.violations);
      samplesEngaged += outcome.samplesEngaged;
    }

    expect(violations.slice(0, 5)).toStrictEqual([]);
    expect(samplesEngaged).toBeGreaterThan(1000);
  });

  it('is repeatable: the same seed gives the same outcome', () => {
    expect(simulate(5, true)).toStrictEqual(simulate(5, true));
  });
});

describe('parseEngagement: impossible calendar days (review fix)', () => {
  it.each(['2026-13-45', '2026-02-30', '2026-00-10', '2026-04-31'])('refuses %s', (dayKey) => {
    expect(parseEngagement({ engagedMs: 1000, activeDay: 2, dayKey, dayEngagedMs: 10 })).toBeNull();
  });

  it('accepts a leap day in a leap year only', () => {
    expect(
      parseEngagement({ engagedMs: 0, activeDay: 1, dayKey: '2028-02-29', dayEngagedMs: 0 }),
    ).not.toBeNull();
    expect(
      parseEngagement({ engagedMs: 0, activeDay: 1, dayKey: '2026-02-29', dayEngagedMs: 0 }),
    ).toBeNull();
  });
});
