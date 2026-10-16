import { describe, expect, it } from 'vitest';

import { findKeyAction } from './find-keys';

const press = (key: string, overrides: Partial<Parameters<typeof findKeyAction>[0]> = {}) =>
  findKeyAction({
    key,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    ...overrides,
  });

describe('findKeyAction', () => {
  it('finds the next match on Enter', () => {
    expect(press('Enter')).toBe('next');
  });

  it('finds the previous match on Shift+Enter', () => {
    expect(press('Enter', { shiftKey: true })).toBe('previous');
  });

  it('closes the bar on Escape', () => {
    expect(press('Escape')).toBe('close');
  });

  it('leaves other keys to the field', () => {
    for (const key of ['a', ' ', 'Backspace', 'Tab', 'ArrowDown', 'F3', 'g', 'f', '=', 'Delete']) {
      expect(press(key)).toBeNull();
    }
  });

  it('leaves shortcuts to main: no action with Ctrl, Alt or Meta held', () => {
    expect(press('Enter', { ctrlKey: true })).toBeNull();
    expect(press('Enter', { altKey: true })).toBeNull();
    expect(press('Enter', { metaKey: true })).toBeNull();
    expect(press('Enter', { ctrlKey: true, shiftKey: true })).toBeNull();
    expect(press('Escape', { ctrlKey: true })).toBeNull();
    expect(press('g', { ctrlKey: true })).toBeNull();
    expect(press('f', { ctrlKey: true })).toBeNull();
  });

  it('leaves Enter and Escape to an input method that is composing text', () => {
    expect(press('Enter', { isComposing: true })).toBeNull();
    expect(press('Enter', { isComposing: true, shiftKey: true })).toBeNull();
    expect(press('Escape', { isComposing: true })).toBeNull();
  });
});
