import { describe, expect, it } from 'vitest';

import { MAX_ZOOM_FACTOR, MIN_ZOOM_FACTOR, nextZoomFactor, zoomPercent } from './zoom';

describe('nextZoomFactor', () => {
  it.each([
    [1, 'in', 1.1],
    [1.1, 'in', 1.25],
    [1.75, 'in', 2],
    [4, 'in', 5],
    [5, 'in', 5],
    [1, 'out', 0.9],
    [0.9, 'out', 0.8],
    [0.33, 'out', 0.25],
    [0.25, 'out', 0.25],
    // From a factor between presets, the next preset in that direction.
    [1.05, 'in', 1.1],
    [1.05, 'out', 1],
    [1.2 ** 1, 'in', 1.25],
    [1.2 ** 1, 'out', 1.1],
    // Floating point on the way in must not skip a step.
    [1.1000000000000001, 'in', 1.25],
    [0.6666666, 'out', 0.5],
    [0.6666666, 'in', 0.75],
    // Outside the range, back inside it.
    [10, 'out', 5],
    [0.1, 'in', 0.25],
  ] as const)('%d zoomed %s is %d', (current, direction, expected) => {
    expect(nextZoomFactor(current, direction)).toBe(expected);
  });

  it('resets to 100% from anywhere, and treats nonsense as 100%', () => {
    expect(nextZoomFactor(3, 'reset')).toBe(1);
    expect(nextZoomFactor(Number.NaN, 'in')).toBe(1);
    expect(nextZoomFactor(0, 'out')).toBe(1);
    expect(nextZoomFactor(-2, 'in')).toBe(1);
  });

  it('steps through every preset from the smallest to the largest and back', () => {
    const up: number[] = [MIN_ZOOM_FACTOR];
    while (up.at(-1) !== MAX_ZOOM_FACTOR) {
      up.push(nextZoomFactor(up.at(-1) ?? 1, 'in'));
    }
    expect(up).toHaveLength(17);
    const down: number[] = [MAX_ZOOM_FACTOR];
    while (down.at(-1) !== MIN_ZOOM_FACTOR) {
      down.push(nextZoomFactor(down.at(-1) ?? 1, 'out'));
    }
    expect(down).toEqual([...up].reverse());
  });
});

describe('zoomPercent', () => {
  it.each([
    [1, 100],
    [1.1, 110],
    [0.67, 67],
    [0.333333, 33],
    [1.2 ** 2, 144],
    [Number.NaN, 100],
    [0, 100],
  ])('%d is %d%%', (factor, expected) => {
    expect(zoomPercent(factor)).toBe(expected);
  });
});
