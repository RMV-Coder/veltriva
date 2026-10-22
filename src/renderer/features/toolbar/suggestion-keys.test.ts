import { describe, expect, it } from 'vitest';

import { moveSelection, suggestionKeyAction } from './suggestion-keys';
import type { SuggestionKeyPress, SuggestionState } from './suggestion-keys';

const OPEN: SuggestionState = { open: true, selected: false };
const SELECTED: SuggestionState = { open: true, selected: true };
const CLOSED: SuggestionState = { open: false, selected: false };

const press = (
  key: string,
  state: SuggestionState = OPEN,
  overrides: Partial<SuggestionKeyPress> = {},
) =>
  suggestionKeyAction(
    {
      key,
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      isComposing: false,
      ...overrides,
    },
    state,
  );

describe('suggestionKeyAction', () => {
  it('selects with Down and Up', () => {
    expect(press('ArrowDown')).toBe('next');
    expect(press('ArrowUp')).toBe('previous');
    expect(press('ArrowDown', SELECTED)).toBe('next');
  });

  it('opens the selected suggestion on Enter', () => {
    expect(press('Enter', SELECTED)).toBe('open');
  });

  it('leaves Enter to the form when nothing is selected: it submits what was typed', () => {
    expect(press('Enter', OPEN)).toBeNull();
  });

  it('closes the dropdown on Escape, selected or not', () => {
    expect(press('Escape', OPEN)).toBe('dismiss');
    expect(press('Escape', SELECTED)).toBe('dismiss');
  });

  it('does nothing while the dropdown is closed, so Escape reverts the field as before', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Escape']) {
      expect(press(key, CLOSED)).toBeNull();
    }
  });

  it('leaves the other keys to the field', () => {
    for (const key of ['a', ' ', 'Backspace', 'Tab', 'Home', 'End', 'ArrowLeft', 'PageDown']) {
      expect(press(key, SELECTED)).toBeNull();
    }
  });

  it('leaves shortcuts to main: no action with Ctrl, Alt or Meta held', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Escape']) {
      expect(press(key, SELECTED, { ctrlKey: true })).toBeNull();
      expect(press(key, SELECTED, { altKey: true })).toBeNull();
      expect(press(key, SELECTED, { metaKey: true })).toBeNull();
    }
  });

  it('leaves Enter and Escape to an input method that is composing text', () => {
    expect(press('Enter', SELECTED, { isComposing: true })).toBeNull();
    expect(press('Escape', SELECTED, { isComposing: true })).toBeNull();
    expect(press('ArrowDown', SELECTED, { isComposing: true })).toBeNull();
  });
});

describe('moveSelection', () => {
  it('goes down through the suggestions', () => {
    expect(moveSelection(6, -1, 1)).toBe(0);
    expect(moveSelection(6, 0, 1)).toBe(1);
    expect(moveSelection(6, 4, 1)).toBe(5);
  });

  it('goes off the last one to none, so the typed text can be submitted again', () => {
    expect(moveSelection(6, 5, 1)).toBe(-1);
    expect(moveSelection(1, 0, 1)).toBe(-1);
  });

  it('goes up, from none to the last, and from the first to none', () => {
    expect(moveSelection(6, 3, -1)).toBe(2);
    expect(moveSelection(6, -1, -1)).toBe(5);
    expect(moveSelection(6, 0, -1)).toBe(-1);
  });

  it('treats a selection that no longer exists (the list shrank) as none', () => {
    expect(moveSelection(3, 5, 1)).toBe(0);
    expect(moveSelection(3, 5, -1)).toBe(2);
  });

  it('has nothing to select without suggestions', () => {
    expect(moveSelection(0, -1, 1)).toBe(-1);
    expect(moveSelection(0, 0, -1)).toBe(-1);
  });

  it('cycles through every suggestion and none', () => {
    const seen: number[] = [];
    let at = -1;
    for (let step = 0; step < 4; step += 1) {
      at = moveSelection(3, at, 1);
      seen.push(at);
    }
    expect(seen).toEqual([0, 1, 2, -1]);
  });
});
