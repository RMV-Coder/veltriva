import { describe, expect, it } from 'vitest';

import {
  decayedFrecency,
  frecencyAfterVisit,
  FRECENCY_HALF_LIFE_MS,
  VISIT_TRANSITIONS,
  VISIT_WEIGHTS,
} from './frecency';
import type { VisitTransition } from './frecency';

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

describe('the frecency constants', () => {
  it('has a half-life of 30 days, which the expression index in 0001_init.sql also uses', () => {
    expect(FRECENCY_HALF_LIFE_MS).toBe(30 * DAY);
    expect(FRECENCY_HALF_LIFE_MS).toBe(2_592_000_000);
  });

  it('knows each transition the visits table allows, and no other', () => {
    expect([...VISIT_TRANSITIONS].sort()).toEqual(
      [
        'back_forward',
        'generated',
        'link',
        'other',
        'redirect',
        'reload',
        'restore',
        'typed',
      ].sort(),
    );
  });
});

describe('VISIT_WEIGHTS', () => {
  it.each<[VisitTransition, number]>([
    ['typed', 2],
    ['link', 1],
    ['generated', 1],
    ['restore', 0.5],
    ['back_forward', 0.5],
    ['other', 0.5],
    ['reload', 0],
    ['redirect', 0],
  ])('weighs a %s visit %s', (transition, weight) => {
    expect(VISIT_WEIGHTS[transition]).toBe(weight);
  });

  it('has a weight for every transition', () => {
    expect(Object.keys(VISIT_WEIGHTS).sort()).toEqual([...VISIT_TRANSITIONS].sort());
  });

  it('counts a typed address for most, and never a reload or a redirect', () => {
    for (const transition of VISIT_TRANSITIONS) {
      expect(VISIT_WEIGHTS[transition]).toBeLessThanOrEqual(VISIT_WEIGHTS.typed);
      expect(VISIT_WEIGHTS[transition]).toBeGreaterThanOrEqual(0);
    }
    expect(VISIT_WEIGHTS.typed).toBeGreaterThan(VISIT_WEIGHTS.link);
    expect(VISIT_WEIGHTS.link).toBeGreaterThan(VISIT_WEIGHTS.restore);
  });
});

describe('decayedFrecency', () => {
  it('is the score itself when no time has passed', () => {
    expect(decayedFrecency(10, T0, T0)).toBe(10);
  });

  it('halves after exactly one half-life', () => {
    expect(decayedFrecency(8, T0, T0 + FRECENCY_HALF_LIFE_MS)).toBe(4);
  });

  it('quarters after two, and is an eighth after three', () => {
    expect(decayedFrecency(8, T0, T0 + 2 * FRECENCY_HALF_LIFE_MS)).toBe(2);
    expect(decayedFrecency(8, T0, T0 + 3 * FRECENCY_HALF_LIFE_MS)).toBe(1);
  });

  it('is f times two to the power of minus elapsed over the half-life, in between', () => {
    const elapsed = 10 * DAY;
    expect(decayedFrecency(5, T0, T0 + elapsed)).toBeCloseTo(5 * 2 ** (-1 / 3), 12);
    expect(decayedFrecency(1, T0, T0 + 15 * DAY)).toBeCloseTo(Math.SQRT1_2, 12);
  });

  it('is one millisecond short of a half-life a hair above half', () => {
    const almost = decayedFrecency(1, T0, T0 + FRECENCY_HALF_LIFE_MS - 1);
    expect(almost).toBeGreaterThan(0.5);
    expect(almost).toBeLessThan(0.5000001);
  });

  it('never goes up with time, and falls steadily towards zero', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let days = 0; days <= 365; days += 5) {
      const score = decayedFrecency(100, T0, T0 + days * DAY);
      expect(score).toBeLessThanOrEqual(previous);
      expect(score).toBeGreaterThan(0);
      previous = score;
    }
    expect(decayedFrecency(100, T0, T0 + 365 * DAY)).toBeCloseTo(100 * 2 ** (-365 / 30), 12);
  });

  it('keeps zero at zero', () => {
    expect(decayedFrecency(0, T0, T0 + 100 * DAY)).toBe(0);
    expect(decayedFrecency(0, T0, T0 - 100 * DAY)).toBe(0);
  });

  it('is proportional to the score', () => {
    const elapsed = 7 * DAY;
    expect(decayedFrecency(6, T0, T0 + elapsed)).toBeCloseTo(
      3 * decayedFrecency(2, T0, T0 + elapsed),
      12,
    );
  });

  it('counts a clock that went back as no time passing: no decay, and no growth', () => {
    expect(decayedFrecency(10, T0, T0 - 1)).toBe(10);
    expect(decayedFrecency(10, T0, T0 - 90 * DAY)).toBe(10);
    expect(decayedFrecency(10, T0, 0)).toBe(10);
  });

  it('never goes above the score it was given, whatever the two times', () => {
    for (const now of [
      T0 - 5 * FRECENCY_HALF_LIFE_MS,
      T0 - 1,
      T0,
      T0 + 1,
      T0 + 5 * FRECENCY_HALF_LIFE_MS,
    ]) {
      expect(decayedFrecency(7, T0, now)).toBeLessThanOrEqual(7);
    }
  });

  it('decays in one step what two steps would', () => {
    const twice = decayedFrecency(
      decayedFrecency(9, T0, T0 + 12 * DAY),
      T0 + 12 * DAY,
      T0 + 40 * DAY,
    );
    expect(twice).toBeCloseTo(decayedFrecency(9, T0, T0 + 40 * DAY), 12);
  });
});

describe('frecencyAfterVisit', () => {
  it('is the weight of the visit for a page seen for the first time', () => {
    expect(frecencyAfterVisit(0, T0, T0, 'typed')).toBe(2);
    expect(frecencyAfterVisit(0, T0, T0, 'link')).toBe(1);
    expect(frecencyAfterVisit(0, T0, T0, 'restore')).toBe(0.5);
  });

  it.each(VISIT_TRANSITIONS)(
    'adds the weight of a %s visit to the score at that moment',
    (transition) => {
      expect(frecencyAfterVisit(3, T0, T0, transition)).toBe(3 + VISIT_WEIGHTS[transition]);
    },
  );

  it('decays the old score to the visit, and then adds the weight', () => {
    // 4 after one half-life is 2; a link visit makes it 3.
    expect(frecencyAfterVisit(4, T0, T0 + FRECENCY_HALF_LIFE_MS, 'link')).toBe(3);
    // 4 after two half-lives is 1; a typed visit makes it 3.
    expect(frecencyAfterVisit(4, T0, T0 + 2 * FRECENCY_HALF_LIFE_MS, 'typed')).toBe(3);
  });

  it('leaves a reloaded or redirected page with its decayed score only', () => {
    expect(frecencyAfterVisit(4, T0, T0 + FRECENCY_HALF_LIFE_MS, 'reload')).toBe(2);
    expect(frecencyAfterVisit(4, T0, T0 + FRECENCY_HALF_LIFE_MS, 'redirect')).toBe(2);
    expect(frecencyAfterVisit(4, T0, T0, 'reload')).toBe(4);
  });

  it('adds the weight undecayed after a clock that went back, and does not shrink the score', () => {
    expect(frecencyAfterVisit(4, T0, T0 - 10 * DAY, 'link')).toBe(5);
    expect(frecencyAfterVisit(4, T0, T0 - 10 * DAY, 'reload')).toBe(4);
  });

  it('is higher for a page visited often and recently than one visited once long ago', () => {
    let often = 0;
    let at = T0;
    for (let visit = 0; visit < 10; visit += 1) {
      often = frecencyAfterVisit(often, at, at + DAY, 'link');
      at += DAY;
    }
    const once = frecencyAfterVisit(0, T0, T0, 'typed');
    const asOfNow = T0 + 10 * DAY;

    expect(decayedFrecency(often, at, asOfNow)).toBeGreaterThan(decayedFrecency(once, T0, asOfNow));
  });

  it('lets old visits fade: a visit a year ago adds next to nothing today', () => {
    const score = frecencyAfterVisit(1, T0, T0 + 365 * DAY, 'link');

    expect(score).toBeGreaterThan(1);
    expect(score).toBeLessThan(1.001);
  });

  it('keeps the same order in time as the index expression log2(f) + t / H', () => {
    // The pages_frecency_idx claim (0001_init.sql): the stored (score, time) pairs sort like the
    // decayed scores as of any single moment.
    const pages = [
      { f: 5, at: T0 },
      { f: 3, at: T0 + 20 * DAY },
      { f: 12, at: T0 - 50 * DAY },
      { f: 1, at: T0 + 60 * DAY },
    ];
    const byIndex = [...pages].sort(
      (a, b) =>
        Math.log2(b.f) +
        b.at / FRECENCY_HALF_LIFE_MS -
        (Math.log2(a.f) + a.at / FRECENCY_HALF_LIFE_MS),
    );
    const asOf = T0 + 90 * DAY;
    const byScore = [...pages].sort(
      (a, b) => decayedFrecency(b.f, b.at, asOf) - decayedFrecency(a.f, a.at, asOf),
    );

    expect(byIndex).toEqual(byScore);
  });
});
