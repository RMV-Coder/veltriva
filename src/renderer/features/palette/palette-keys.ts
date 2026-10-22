// What a key press in the memory palette's search field does. Pure, so Vitest covers it. The shell
// handles only the keys of the palette itself: Ctrl+Shift+K (open it), Ctrl+L and the other
// browser shortcuts belong to main, which sees them before the field does (Alt+D is one: it
// focuses the address bar, so the score view is on Alt+S). Home, End, the left
// and right arrows and every character stay with the text field.

/** The parts of a key event the palette reads. */
export interface PaletteKeyPress {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  /** An input method is composing text: Enter, Escape and the arrows belong to it. */
  readonly isComposing: boolean;
}

/** How far PageUp and PageDown move the active result. */
export const PAGE_STEP = 8;

export type PaletteKeyAction =
  /** Up (-1) and Down (1): the active result, wrapping around at the ends. */
  | { readonly kind: 'move'; readonly delta: 1 | -1 }
  /** PageUp and PageDown: the active result by `PAGE_STEP`, stopping at the ends. */
  | { readonly kind: 'page'; readonly delta: 1 | -1 }
  /** Enter opens the active result where its tab is; Ctrl+Enter in a new tab. */
  | { readonly kind: 'open'; readonly target: 'switch' | 'newTab' }
  | { readonly kind: 'close' }
  /** Tab (1) and Shift+Tab (-1): the next filter, wrapping around. */
  | { readonly kind: 'scope'; readonly direction: 1 | -1 }
  /** Alt+S: the score-breakdown debug view (Alt+D is main's: it focuses the address bar). */
  | { readonly kind: 'toggleDebug' };

/** The palette's action for a key, or null to leave the key to the text field. */
export function paletteKeyAction(press: PaletteKeyPress): PaletteKeyAction | null {
  if (press.isComposing) {
    return null;
  }
  const { key } = press;
  const bare = !press.ctrlKey && !press.altKey && !press.metaKey;

  if (key === 'Enter') {
    if (press.altKey) {
      return null;
    }
    return press.ctrlKey || press.metaKey
      ? { kind: 'open', target: 'newTab' }
      : { kind: 'open', target: 'switch' };
  }
  if (key.toLowerCase() === 's' && press.altKey && !press.ctrlKey && !press.metaKey) {
    return press.shiftKey ? null : { kind: 'toggleDebug' };
  }
  if (!bare) {
    return null;
  }
  switch (key) {
    case 'Escape':
      return { kind: 'close' };
    case 'ArrowDown':
      return { kind: 'move', delta: 1 };
    case 'ArrowUp':
      return { kind: 'move', delta: -1 };
    case 'PageDown':
      return { kind: 'page', delta: 1 };
    case 'PageUp':
      return { kind: 'page', delta: -1 };
    case 'Tab':
      return { kind: 'scope', direction: press.shiftKey ? -1 : 1 };
    default:
      return null;
  }
}

/**
 * The active result after Up (-1) or Down (1): the next one, wrapping around at the ends. With
 * nothing active (-1) Down gives the first and Up the last. -1 when there are no results.
 */
export function moveActive(count: number, current: number, delta: 1 | -1): number {
  if (count <= 0) {
    return -1;
  }
  if (current < 0 || current >= count) {
    return delta > 0 ? 0 : count - 1;
  }
  return (current + delta + count) % count;
}

/** The active result after PageDown (1) or PageUp (-1): `PAGE_STEP` further, stopping at the ends. */
export function pageActive(count: number, current: number, delta: 1 | -1): number {
  if (count <= 0) {
    return -1;
  }
  const from = current < 0 || current >= count ? (delta > 0 ? -1 : count) : current;
  return Math.min(Math.max(from + delta * PAGE_STEP, 0), count - 1);
}
