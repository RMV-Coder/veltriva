// Browser-reserved shortcuts (assessment §3.9): keys main handles before the page sees them, from
// `before-input-event` on the shell and on every tab. Every other key goes to the page first, and
// only reaches the browser if the page leaves it alone (Ctrl+F, zoom: src/main/input/page-menu.ts).
// Pure, so the table is unit-tested.

/** The parts of a key event the matcher reads (Electron's `Input` has these). */
export interface KeyInput {
  /** The character or key name, layout-dependent: `t`, `T`, `Tab`, `F5`, `ArrowLeft`. */
  readonly key: string;
  /** The physical key, layout-independent: `KeyT`, `Digit1`, `Numpad1`. */
  readonly code: string;
  readonly control: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
}

export type ReservedCommand =
  | { readonly kind: 'newTab' }
  | { readonly kind: 'closeTab' }
  | { readonly kind: 'reopenClosedTab' }
  | { readonly kind: 'nextTab' }
  | { readonly kind: 'previousTab' }
  /** Ctrl+1 to Ctrl+8: the tab at this index (0-based) in strip order. */
  | { readonly kind: 'selectTab'; readonly index: number }
  | { readonly kind: 'selectLastTab' }
  | { readonly kind: 'focusAddressBar' }
  /** F6: cycles the address bar, the sidebar's selected tab and the page (M6.2). */
  | { readonly kind: 'cycleFocus' }
  | { readonly kind: 'reload' }
  | { readonly kind: 'reloadIgnoringCache' }
  | { readonly kind: 'back' }
  | { readonly kind: 'forward' }
  | { readonly kind: 'toggleFullscreen' }
  | { readonly kind: 'toggleDevTools' }
  /** Ctrl+Shift+K: the memory palette (Phase 4). Reserved now, so pages never learn to rely on it. */
  | { readonly kind: 'memoryPalette' };

/**
 * The reserved command for a key, or null to let the page have it. Ctrl shortcuts need Ctrl
 * without Alt: Windows reports AltGr as Ctrl+Alt, and AltGr+key types characters on many layouts.
 */
export function matchReservedShortcut(input: KeyInput): ReservedCommand | null {
  if (input.meta) {
    return null;
  }
  const key = letterOf(input) ?? input.key;
  const ctrl = input.control && !input.alt;
  const alt = input.alt && !input.control;
  const plain = !input.control && !input.alt;

  if (ctrl) {
    return ctrlShortcut(key, input.code, input.shift);
  }
  if (alt && !input.shift) {
    switch (key) {
      case 'd':
        return { kind: 'focusAddressBar' };
      case 'ArrowLeft':
        return { kind: 'back' };
      case 'ArrowRight':
        return { kind: 'forward' };
      default:
        return null;
    }
  }
  if (plain) {
    return functionKey(key, input.shift);
  }
  return null;
}

function ctrlShortcut(key: string, code: string, shift: boolean): ReservedCommand | null {
  if (shift) {
    switch (key) {
      case 't':
        return { kind: 'reopenClosedTab' };
      case 'Tab':
        return { kind: 'previousTab' };
      case 'r':
        return { kind: 'reloadIgnoringCache' };
      case 'k':
        return { kind: 'memoryPalette' };
      default:
        return null;
    }
  }
  switch (key) {
    case 't':
      return { kind: 'newTab' };
    case 'w':
    case 'F4':
      return { kind: 'closeTab' };
    case 'Tab':
      return { kind: 'nextTab' };
    case 'l':
      return { kind: 'focusAddressBar' };
    case 'r':
      return { kind: 'reload' };
    case 'F5':
      return { kind: 'reloadIgnoringCache' };
    default:
      break;
  }
  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(code)?.[1];
  if (digit === undefined) {
    return null;
  }
  return digit === '9'
    ? { kind: 'selectLastTab' }
    : { kind: 'selectTab', index: Number(digit) - 1 };
}

function functionKey(key: string, shift: boolean): ReservedCommand | null {
  switch (key) {
    case 'F5':
      return shift ? { kind: 'reloadIgnoringCache' } : { kind: 'reload' };
    case 'F6':
      return { kind: 'cycleFocus' };
    case 'F11':
      return shift ? null : { kind: 'toggleFullscreen' };
    case 'F12':
      return shift ? null : { kind: 'toggleDevTools' };
    case 'BrowserBack':
      return { kind: 'back' };
    case 'BrowserForward':
      return { kind: 'forward' };
    default:
      return null;
  }
}

/**
 * The Latin letter a shortcut means. On a Latin layout that is the key itself; on others (Russian,
 * Greek) Ctrl+the physical T key still means Ctrl+T, as in Chrome.
 */
function letterOf(input: KeyInput): string | undefined {
  if (/^[a-z]$/i.test(input.key)) {
    return input.key.toLowerCase();
  }
  const physical = /^Key([A-Z])$/.exec(input.code)?.[1];
  return input.key.length === 1 && physical !== undefined ? physical.toLowerCase() : undefined;
}
