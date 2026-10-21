import { describe, expect, it } from 'vitest';

import { parseSavedWindow, placeWindow } from './window-bounds';
import type { Rect, Size } from './rect';

const PRIMARY: Rect = { x: 0, y: 0, width: 1920, height: 1040 };
const LEFT: Rect = { x: -1920, y: 0, width: 1920, height: 1040 };
const MIN: Size = { width: 800, height: 600 };

const saved = (overrides: Record<string, unknown> = {}) => ({
  x: 100,
  y: 80,
  width: 1200,
  height: 800,
  maximized: false,
  ...overrides,
});

describe('placeWindow', () => {
  it('keeps a window that is on a screen', () => {
    expect(placeWindow(saved(), [PRIMARY], MIN)).toEqual(saved());
  });

  it('keeps the maximized flag', () => {
    expect(placeWindow(saved({ maximized: true }), [PRIMARY], MIN)?.maximized).toBe(true);
    expect(placeWindow(saved({ maximized: false }), [PRIMARY], MIN)?.maximized).toBe(false);
  });

  it('returns only the five window fields', () => {
    const result = placeWindow(saved({ extra: 'x', title: 'y' }), [PRIMARY], MIN);

    expect(Object.keys(result ?? {}).sort()).toEqual(['height', 'maximized', 'width', 'x', 'y']);
  });

  describe('size', () => {
    it('shrinks a window that is bigger than its screen to the screen', () => {
      const result = placeWindow(saved({ width: 5000, height: 4000 }), [PRIMARY], MIN);

      expect(result).toMatchObject({ x: 100, y: 80, width: 1920, height: 1040 });
    });

    it('never goes below the minimum size, even for a tiny saved window', () => {
      const result = placeWindow(saved({ width: 300, height: 200 }), [PRIMARY], MIN);

      expect(result).toMatchObject({ width: 800, height: 600 });
    });

    it('lets the minimum win when the screen is smaller than it', () => {
      const small: Rect = { x: 0, y: 0, width: 640, height: 480 };

      const result = placeWindow(saved({ x: 0, y: 0, width: 640, height: 480 }), [small], MIN);

      expect(result).toMatchObject({ width: 800, height: 600 });
    });

    it('fits a window to the screen it is on, not to another one', () => {
      const wide: Rect = { x: 1920, y: 0, width: 3840, height: 2000 };

      const onWide = placeWindow(
        saved({ x: 2000, y: 50, width: 3000, height: 1900 }),
        [PRIMARY, wide],
        MIN,
      );
      const onPrimary = placeWindow(saved({ width: 3000, height: 1900 }), [PRIMARY, wide], MIN);

      expect(onWide).toMatchObject({ width: 3000, height: 1900 });
      expect(onPrimary).toMatchObject({ width: 1920, height: 1040 });
    });
  });

  describe('being reachable', () => {
    it('refuses a window on no screen at all', () => {
      expect(placeWindow(saved(), [], MIN)).toBeNull();
    });

    it('refuses a window far to the right of every screen', () => {
      expect(placeWindow(saved({ x: 4000 }), [PRIMARY], MIN)).toBeNull();
    });

    it('refuses a window far below every screen', () => {
      expect(placeWindow(saved({ y: 3000 }), [PRIMARY], MIN)).toBeNull();
    });

    it('refuses a window whose title bar is above every screen, even if its body is on one', () => {
      expect(placeWindow(saved({ y: -100, height: 900 }), [PRIMARY], MIN)).toBeNull();
    });

    it('refuses a window on a monitor that is no longer there', () => {
      expect(placeWindow(saved({ x: -1800 }), [PRIMARY], MIN)).toBeNull();
    });

    it('needs the title bar to overlap a screen by 120 pixels across', () => {
      // The window starts 120 pixels before the screen's right edge, then 119.
      expect(placeWindow(saved({ x: 1800 }), [PRIMARY], MIN)).not.toBeNull();
      expect(placeWindow(saved({ x: 1801 }), [PRIMARY], MIN)).toBeNull();
      // Or ends 120 pixels past its left edge, then 119.
      expect(placeWindow(saved({ x: -1080, width: 1200 }), [PRIMARY], MIN)).not.toBeNull();
      expect(placeWindow(saved({ x: -1081, width: 1200 }), [PRIMARY], MIN)).toBeNull();
    });

    it('needs the title bar to overlap a screen by 40 pixels down', () => {
      // 40 pixels of the title bar strip above the screen's bottom edge, then 39.
      expect(placeWindow(saved({ y: 1000 }), [PRIMARY], MIN)).not.toBeNull();
      expect(placeWindow(saved({ y: 1001 }), [PRIMARY], MIN)).toBeNull();
      // Starting above the top edge, with 40 pixels of it still showing, then 39.
      expect(placeWindow(saved({ y: 0 }), [PRIMARY], MIN)).not.toBeNull();
      expect(placeWindow(saved({ y: -1 }), [PRIMARY], MIN)).toBeNull();
    });

    it('refuses a window narrower than the strip it must show, whatever the screen', () => {
      expect(placeWindow(saved({ width: 100 }), [PRIMARY], { width: 50, height: 50 })).toBeNull();
    });

    it('uses a work area, so a window under the taskbar counts as off screen', () => {
      // Work area 0..1000 high (taskbar below); the title bar starts at y = 990.
      const withTaskbar: Rect = { x: 0, y: 0, width: 1920, height: 1000 };

      expect(placeWindow(saved({ y: 990 }), [withTaskbar], MIN)).toBeNull();
      expect(placeWindow(saved({ y: 960 }), [withTaskbar], MIN)).not.toBeNull();
    });
  });

  describe('more than one monitor', () => {
    it('keeps a window on a monitor to the left, where x is negative', () => {
      const result = placeWindow(saved({ x: -1800, y: 100 }), [PRIMARY, LEFT], MIN);

      expect(result).toEqual(saved({ x: -1800, y: 100 }));
    });

    it('keeps a window on a monitor above the primary, where y is negative', () => {
      const above: Rect = { x: 0, y: -1080, width: 1920, height: 1080 };

      expect(placeWindow(saved({ x: 200, y: -900 }), [PRIMARY, above], MIN)).toEqual(
        saved({ x: 200, y: -900 }),
      );
    });

    it('refuses the same window once that monitor is gone', () => {
      expect(placeWindow(saved({ x: -1800, y: 100 }), [PRIMARY], MIN)).toBeNull();
    });

    it('keeps a window that straddles two monitors, sized to the first screen it reaches', () => {
      const result = placeWindow(saved({ x: -500, y: 0, width: 3000 }), [PRIMARY, LEFT], MIN);

      expect(result).toMatchObject({ x: -500, y: 0, width: 1920 });
    });

    it('does not mind the order of the screens', () => {
      expect(placeWindow(saved({ x: -1800 }), [LEFT, PRIMARY], MIN)).toEqual(saved({ x: -1800 }));
      expect(placeWindow(saved(), [LEFT, PRIMARY], MIN)).toEqual(saved());
    });
  });

  describe('input that is not a window', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['a string', 'window'],
      ['a number', 5],
      ['an array', [100, 80, 1200, 800, false]],
      ['an empty object', {}],
    ])('refuses %s', (_name, value) => {
      expect(placeWindow(value, [PRIMARY], MIN)).toBeNull();
    });

    it.each([
      ['a string x', { x: '100' }],
      ['a string width', { width: '1200' }],
      ['NaN', { x: Number.NaN }],
      ['Infinity', { width: Number.POSITIVE_INFINITY }],
      ['a fractional x', { x: 100.5 }],
      ['a fractional height', { height: 800.25 }],
      ['a missing maximized', { maximized: undefined }],
      ['maximized as a string', { maximized: 'true' }],
      ['maximized as 1', { maximized: 1 }],
      ['null maximized', { maximized: null }],
      ['zero width', { width: 0 }],
      ['negative height', { height: -800 }],
      ['a huge width', { width: 1e12 }],
      ['a huge x', { x: 40_000 }],
      ['a huge negative y', { y: -40_000 }],
      ['a null y', { y: null }],
    ])('refuses a window with %s', (_name, overrides) => {
      expect(placeWindow(saved(overrides), [PRIMARY], MIN)).toBeNull();
    });

    it('refuses a window with a missing field', () => {
      for (const field of ['x', 'y', 'width', 'height', 'maximized']) {
        const without = Object.fromEntries(
          Object.entries(saved()).filter(([key]) => key !== field),
        );

        expect(placeWindow(without, [PRIMARY], MIN)).toBeNull();
      }
    });
  });
});

describe('parseSavedWindow', () => {
  it('returns a well-formed window as five fields', () => {
    expect(parseSavedWindow({ ...saved(), extra: true })).toEqual(saved());
  });

  it('accepts the edges of what is allowed', () => {
    expect(parseSavedWindow(saved({ x: -32_768, y: 32_768, width: 1, height: 32_768 }))).toEqual(
      saved({ x: -32_768, y: 32_768, width: 1, height: 32_768 }),
    );
  });

  it('refuses one past those edges', () => {
    expect(parseSavedWindow(saved({ x: -32_769 }))).toBeNull();
    expect(parseSavedWindow(saved({ y: 32_769 }))).toBeNull();
    expect(parseSavedWindow(saved({ width: 32_769 }))).toBeNull();
    expect(parseSavedWindow(saved({ height: 0 }))).toBeNull();
  });

  it('refuses what a JSON document could hold in place of a window', () => {
    for (const value of [null, true, 7, 'x', [], [saved()], {}, { x: 1 }]) {
      expect(parseSavedWindow(value)).toBeNull();
    }
  });
});
