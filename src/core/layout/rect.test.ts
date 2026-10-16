import { describe, expect, it } from 'vitest';

import { fillRect, insetRect, NO_INSETS } from './rect';

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

describe('insetRect', () => {
  const window = { width: 1280, height: 800 };

  it('is the window minus the shell chrome', () => {
    expect(insetRect(window, { top: 48, right: 0, bottom: 0, left: 260 })).toEqual({
      x: 260,
      y: 48,
      width: 1020,
      height: 752,
    });
  });

  it('is the whole window without insets', () => {
    expect(insetRect(window, NO_INSETS)).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
  });

  it('rounds fractional chrome inward, so the view never covers it', () => {
    expect(insetRect(window, { top: 47.6, right: 0.2, bottom: 0.5, left: 259.4 })).toEqual({
      x: 260,
      y: 48,
      width: 1019,
      height: 751,
    });
  });

  it('treats invalid insets as 0', () => {
    expect(
      insetRect(window, {
        top: Number.NaN,
        right: -10,
        bottom: Number.POSITIVE_INFINITY,
        left: Number.NEGATIVE_INFINITY,
      }),
    ).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
  });

  it('collapses to an empty rectangle when the chrome is larger than the window', () => {
    expect(
      insetRect({ width: 200, height: 100 }, { top: 150, right: 0, bottom: 0, left: 300 }),
    ).toEqual({ x: 200, y: 100, width: 0, height: 0 });
    expect(
      insetRect({ width: 500, height: 400 }, { top: 0, right: 300, bottom: 0, left: 300 }),
    ).toEqual({ x: 300, y: 0, width: 0, height: 400 });
  });
});
