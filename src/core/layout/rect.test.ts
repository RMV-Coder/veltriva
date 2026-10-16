import { describe, expect, it } from 'vitest';

import { fillRect } from './rect';

describe('fillRect', () => {
  it('fills the content area from the origin', () => {
    expect(fillRect({ width: 1280, height: 800 })).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 800,
    });
  });

  it('floors fractional sizes to whole DIPs', () => {
    expect(fillRect({ width: 1279.8, height: 799.5 })).toEqual({
      x: 0,
      y: 0,
      width: 1279,
      height: 799,
    });
  });

  it.each([
    ['zero', 0],
    ['negative', -20],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
  ])('collapses a %s dimension to 0', (_label, value) => {
    expect(fillRect({ width: value, height: 600 })).toEqual({ x: 0, y: 0, width: 0, height: 600 });
    expect(fillRect({ width: 800, height: value })).toEqual({ x: 0, y: 0, width: 800, height: 0 });
  });
});
