// What a key press in the find field does. Pure, so Vitest covers it. The shell handles only the
// keys of the field itself: Ctrl+F, F3, Ctrl+G and the zoom keys belong to main, which sees them
// before the field does.

export type FindKeyAction = 'next' | 'previous' | 'close';

interface FindKeyPress {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  /** An input method is composing text: Enter or Escape belongs to it. */
  readonly isComposing: boolean;
}

/**
 * Enter finds the next match, Shift+Enter the previous one, and Escape closes the bar. Any other
 * key, or a key with Ctrl, Alt or Meta held, is left to the field (null).
 */
export function findKeyAction(press: FindKeyPress): FindKeyAction | null {
  if (press.isComposing || press.ctrlKey || press.altKey || press.metaKey) {
    return null;
  }
  if (press.key === 'Escape') {
    return 'close';
  }
  if (press.key === 'Enter') {
    return press.shiftKey ? 'previous' : 'next';
  }
  return null;
}
