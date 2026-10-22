import { describe, expect, it } from 'vitest';

import { PAGE_STEP, moveActive, pageActive, paletteKeyAction } from './palette-keys';
import type { PaletteKeyPress } from './palette-keys';

const press = (key: string, overrides: Partial<PaletteKeyPress> = {}) =>
  paletteKeyAction({
    key,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    ...overrides,
  });

describe('paletteKeyAction', () => {
  it('moves the active result with Up and Down', () => {
    expect(press('ArrowDown')).toEqual({ kind: 'move', delta: 1 });
    expect(press('ArrowUp')).toEqual({ kind: 'move', delta: -1 });
  });

  it('moves a page with PageDown and PageUp', () => {
    expect(press('PageDown')).toEqual({ kind: 'page', delta: 1 });
    expect(press('PageUp')).toEqual({ kind: 'page', delta: -1 });
  });

  it('opens where the tab is on Enter, and in a new tab on Ctrl+Enter', () => {
    expect(press('Enter')).toEqual({ kind: 'open', target: 'switch' });
    expect(press('Enter', { ctrlKey: true })).toEqual({ kind: 'open', target: 'newTab' });
    expect(press('Enter', { metaKey: true })).toEqual({ kind: 'open', target: 'newTab' });
    expect(press('Enter', { shiftKey: true })).toEqual({ kind: 'open', target: 'switch' });
  });

  it('leaves Alt+Enter alone', () => {
    expect(press('Enter', { altKey: true })).toBeNull();
  });

  it('closes on Escape', () => {
    expect(press('Escape')).toEqual({ kind: 'close' });
  });

  it('steps the filters with Tab and Shift+Tab', () => {
    expect(press('Tab')).toEqual({ kind: 'scope', direction: 1 });
    expect(press('Tab', { shiftKey: true })).toEqual({ kind: 'scope', direction: -1 });
  });

  it('toggles the score view on Alt+S, in either case, but not with another modifier', () => {
    expect(press('s', { altKey: true })).toEqual({ kind: 'toggleDebug' });
    expect(press('S', { altKey: true })).toEqual({ kind: 'toggleDebug' });
    expect(press('s')).toBeNull();
    expect(press('s', { altKey: true, ctrlKey: true })).toBeNull();
    expect(press('s', { altKey: true, shiftKey: true })).toBeNull();
    expect(press('s', { altKey: true, metaKey: true })).toBeNull();
  });

  it('leaves Alt+D to main: it focuses the address bar, as in Chrome', () => {
    expect(press('d', { altKey: true })).toBeNull();
    expect(press('D', { altKey: true })).toBeNull();
  });

  it('leaves the text field its own keys: Home, End, the other arrows and characters', () => {
    for (const key of ['Home', 'End', 'ArrowLeft', 'ArrowRight', 'a', ' ', 'Backspace', 'Delete']) {
      expect(press(key)).toBeNull();
    }
  });

  it('leaves shortcuts to main: no action with Ctrl, Alt or Meta held (but Enter)', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Escape', 'Tab']) {
      expect(press(key, { ctrlKey: true })).toBeNull();
      expect(press(key, { altKey: true })).toBeNull();
      expect(press(key, { metaKey: true })).toBeNull();
    }
  });

  it('leaves everything to an input method that is composing text', () => {
    for (const key of ['Enter', 'Escape', 'ArrowDown', 'ArrowUp', 'Tab', 'PageDown']) {
      expect(press(key, { isComposing: true })).toBeNull();
    }
    expect(press('Enter', { isComposing: true, ctrlKey: true })).toBeNull();
    expect(press('s', { isComposing: true, altKey: true })).toBeNull();
  });
});

describe('moveActive', () => {
  it('moves one result', () => {
    expect(moveActive(5, 0, 1)).toBe(1);
    expect(moveActive(5, 3, -1)).toBe(2);
  });

  it('wraps around at both ends', () => {
    expect(moveActive(5, 4, 1)).toBe(0);
    expect(moveActive(5, 0, -1)).toBe(4);
    expect(moveActive(1, 0, 1)).toBe(0);
    expect(moveActive(1, 0, -1)).toBe(0);
  });

  it('starts at the first on Down and at the last on Up when nothing is active', () => {
    expect(moveActive(5, -1, 1)).toBe(0);
    expect(moveActive(5, -1, -1)).toBe(4);
    // An index that no longer exists (the list shrank) counts as nothing active.
    expect(moveActive(3, 7, 1)).toBe(0);
  });

  it('has nothing to move to without results', () => {
    expect(moveActive(0, -1, 1)).toBe(-1);
    expect(moveActive(0, 0, -1)).toBe(-1);
  });
});

describe('pageActive', () => {
  it('moves by a page', () => {
    expect(PAGE_STEP).toBe(8);
    expect(pageActive(30, 2, 1)).toBe(10);
    expect(pageActive(30, 20, -1)).toBe(12);
  });

  it('stops at the ends instead of wrapping', () => {
    expect(pageActive(30, 25, 1)).toBe(29);
    expect(pageActive(30, 3, -1)).toBe(0);
    expect(pageActive(5, 0, 1)).toBe(4);
    expect(pageActive(5, 4, -1)).toBe(0);
  });

  it('goes a page from the edge when nothing is active', () => {
    expect(pageActive(30, -1, 1)).toBe(7);
    expect(pageActive(30, -1, -1)).toBe(22);
  });

  it('has nothing to move to without results', () => {
    expect(pageActive(0, -1, 1)).toBe(-1);
  });
});

describe('paletteKeyAction: Shift+Delete forgets the active result (M5.2)', () => {
  it('is Shift+Delete, as in Chrome', () => {
    expect(press('Delete', { shiftKey: true })).toEqual({ kind: 'remove' });
  });

  it('leaves Delete alone to the text field, and any other modifier with it', () => {
    expect(press('Delete')).toBeNull();
    expect(press('Delete', { shiftKey: true, ctrlKey: true })).toBeNull();
    expect(press('Delete', { shiftKey: true, altKey: true })).toBeNull();
    expect(press('Delete', { shiftKey: true, isComposing: true })).toBeNull();
  });
});
