// What a key press in the address bar does while its suggestions are showing. Pure, so Vitest
// covers it. Everything that is not listed here stays with the text field and the form: typing,
// Home and End, and Enter when no suggestion is selected (which submits what was typed).

export interface SuggestionKeyPress {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  /** An input method is composing text: Enter and Escape belong to it. */
  readonly isComposing: boolean;
}

export interface SuggestionState {
  /** The dropdown is showing. */
  readonly open: boolean;
  /** A suggestion is selected (the user pressed Down or Up, or pointed at one). */
  readonly selected: boolean;
}

export type SuggestionKeyAction =
  | 'next'
  | 'previous'
  /** Enter on the selected suggestion. */
  | 'open'
  /** Escape closes the dropdown; the field keeps what was typed. */
  | 'dismiss';

/** The action for a key, or null to leave it to the field. Null for every key while it is closed. */
export function suggestionKeyAction(
  press: SuggestionKeyPress,
  state: SuggestionState,
): SuggestionKeyAction | null {
  if (!state.open || press.isComposing) {
    return null;
  }
  if (press.ctrlKey || press.altKey || press.metaKey) {
    return null;
  }
  switch (press.key) {
    case 'ArrowDown':
      return 'next';
    case 'ArrowUp':
      return 'previous';
    case 'Enter':
      return state.selected ? 'open' : null;
    case 'Escape':
      return 'dismiss';
    default:
      return null;
  }
}

/**
 * The selection after Down (1) or Up (-1), as an index into `count` suggestions or -1 for none.
 * Down goes through the suggestions and then off the end to none, where Enter submits the typed
 * text again; Up from none goes to the last one, and Up from the first goes to none.
 */
export function moveSelection(count: number, current: number, direction: 1 | -1): number {
  if (count <= 0) {
    return -1;
  }
  const from = current >= count ? -1 : Math.max(current, -1);
  if (direction > 0) {
    return from + 1 >= count ? -1 : from + 1;
  }
  return from === -1 ? count - 1 : from - 1;
}
