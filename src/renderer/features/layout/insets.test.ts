import { describe, expect, it } from 'vitest';

import { computeInsets, insetsEqual } from './insets';

const viewport = { width: 1280, height: 800 };

describe('computeInsets', () => {
  it('measures the chrome around a content area that fills the rest', () => {
    const content = { top: 48, left: 260, right: 1280, bottom: 800 };
    expect(computeInsets(content, viewport)).toEqual({ top: 48, right: 0, bottom: 0, left: 260 });
  });

  it('measures chrome on every side', () => {
    const content = { top: 40, left: 10, right: 1200, bottom: 760 };
    expect(computeInsets(content, viewport)).toEqual({ top: 40, right: 80, bottom: 40, left: 10 });
  });

  it('keeps fractional measurements', () => {
    const content = { top: 47.5, left: 259.25, right: 1279.5, bottom: 800 };
    expect(computeInsets(content, viewport)).toEqual({
      top: 47.5,
      right: 0.5,
      bottom: 0,
      left: 259.25,
    });
  });

  it('is all zeros when the content area is the whole window', () => {
    const content = { top: 0, left: 0, right: 1280, bottom: 800 };
    expect(computeInsets(content, viewport)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  it('clamps negative results, such as a box that overflows the viewport', () => {
    const content = { top: -5, left: -1, right: 1300, bottom: 820 };
    expect(computeInsets(content, viewport)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  it('clamps to the largest value the command accepts', () => {
    const content = { top: 20_000, left: 15_000, right: 1280, bottom: 800 };
    expect(computeInsets(content, viewport)).toEqual({
      top: 10_000,
      right: 0,
      bottom: 0,
      left: 10_000,
    });
  });

  it('turns non-finite measurements into 0', () => {
    const content = { top: Number.NaN, left: Number.POSITIVE_INFINITY, right: 1280, bottom: 800 };
    expect(computeInsets(content, viewport)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    const noViewport = { width: Number.NaN, height: 800 };
    expect(computeInsets({ top: 1, left: 2, right: 3, bottom: 4 }, noViewport).right).toBe(0);
  });
});

describe('insetsEqual', () => {
  const a = { top: 48, right: 0, bottom: 0, left: 260 };

  it('compares every edge', () => {
    expect(insetsEqual(a, { ...a })).toBe(true);
    expect(insetsEqual(a, { ...a, top: 49 })).toBe(false);
    expect(insetsEqual(a, { ...a, right: 1 })).toBe(false);
    expect(insetsEqual(a, { ...a, bottom: 1 })).toBe(false);
    expect(insetsEqual(a, { ...a, left: 261 })).toBe(false);
  });
});
