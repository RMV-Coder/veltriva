import { describe, expect, it } from 'vitest';

import { matchReservedShortcut } from './shortcuts';
import type { KeyInput, ReservedCommand } from './shortcuts';

interface Keys {
  readonly key: string;
  readonly code?: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
  readonly meta?: boolean;
}

function input({
  key,
  code,
  ctrl = false,
  shift = false,
  alt = false,
  meta = false,
}: Keys): KeyInput {
  const defaultCode = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key;
  return { key, code: code ?? defaultCode, control: ctrl, shift, alt, meta };
}

const cmd = (kind: Exclude<ReservedCommand['kind'], 'selectTab'>): ReservedCommand => ({ kind });

describe('matchReservedShortcut', () => {
  it.each<[string, Keys, ReservedCommand]>([
    ['Ctrl+T', { key: 't', ctrl: true }, cmd('newTab')],
    ['Ctrl+W', { key: 'w', ctrl: true }, cmd('closeTab')],
    ['Ctrl+F4', { key: 'F4', ctrl: true }, cmd('closeTab')],
    ['Ctrl+Shift+T', { key: 'T', ctrl: true, shift: true }, cmd('reopenClosedTab')],
    ['Ctrl+Tab', { key: 'Tab', ctrl: true }, cmd('nextTab')],
    ['Ctrl+Shift+Tab', { key: 'Tab', ctrl: true, shift: true }, cmd('previousTab')],
    ['Ctrl+1', { key: '1', code: 'Digit1', ctrl: true }, { kind: 'selectTab', index: 0 }],
    ['Ctrl+8', { key: '8', code: 'Digit8', ctrl: true }, { kind: 'selectTab', index: 7 }],
    ['Ctrl+Numpad3', { key: '3', code: 'Numpad3', ctrl: true }, { kind: 'selectTab', index: 2 }],
    ['Ctrl+9', { key: '9', code: 'Digit9', ctrl: true }, cmd('selectLastTab')],
    // A French layout types "&" on the 1 key without Shift: still Ctrl+1.
    ['Ctrl+1 on AZERTY', { key: '&', code: 'Digit1', ctrl: true }, { kind: 'selectTab', index: 0 }],
    ['Ctrl+L', { key: 'l', ctrl: true }, cmd('focusAddressBar')],
    ['Alt+D', { key: 'd', alt: true }, cmd('focusAddressBar')],
    ['F6', { key: 'F6' }, cmd('cycleFocus')],
    ['Shift+F6', { key: 'F6', shift: true }, cmd('cycleFocus')],
    ['F5', { key: 'F5' }, cmd('reload')],
    ['Ctrl+R', { key: 'r', ctrl: true }, cmd('reload')],
    ['Shift+F5', { key: 'F5', shift: true }, cmd('reloadIgnoringCache')],
    ['Ctrl+F5', { key: 'F5', ctrl: true }, cmd('reloadIgnoringCache')],
    ['Ctrl+Shift+R', { key: 'R', ctrl: true, shift: true }, cmd('reloadIgnoringCache')],
    ['Alt+Left', { key: 'ArrowLeft', alt: true }, cmd('back')],
    ['Alt+Right', { key: 'ArrowRight', alt: true }, cmd('forward')],
    ['BrowserBack', { key: 'BrowserBack' }, cmd('back')],
    ['BrowserForward', { key: 'BrowserForward' }, cmd('forward')],
    ['F11', { key: 'F11' }, cmd('toggleFullscreen')],
    ['F12', { key: 'F12' }, cmd('toggleDevTools')],
    ['Ctrl+Shift+K', { key: 'K', ctrl: true, shift: true }, cmd('memoryPalette')],
    // Caps Lock gives an uppercase key without Shift.
    ['Ctrl+T with Caps Lock', { key: 'T', ctrl: true }, cmd('newTab')],
    // On a Russian layout Ctrl+the T key types "е": the physical key decides.
    ['Ctrl+T on a Russian layout', { key: 'е', code: 'KeyT', ctrl: true }, cmd('newTab')],
  ])('%s is reserved', (_name, keys, expected) => {
    expect(matchReservedShortcut(input(keys))).toEqual(expected);
  });

  it.each<[string, Keys]>([
    // The page's own shortcuts: find, zoom, select all, copy, save, bold, editors' commands.
    ['Ctrl+F', { key: 'f', ctrl: true }],
    ['Ctrl+=', { key: '=', ctrl: true }],
    ['Ctrl+-', { key: '-', ctrl: true }],
    ['Ctrl+0', { key: '0', code: 'Digit0', ctrl: true }],
    ['Ctrl+A', { key: 'a', ctrl: true }],
    ['Ctrl+C', { key: 'c', ctrl: true }],
    ['Ctrl+S', { key: 's', ctrl: true }],
    ['Ctrl+K', { key: 'k', ctrl: true }],
    ['Ctrl+B', { key: 'b', ctrl: true }],
    ['Ctrl+Shift+I', { key: 'I', ctrl: true, shift: true }],
    // Plain typing and navigation keys.
    ['t', { key: 't' }],
    ['Shift+T', { key: 'T', shift: true }],
    ['Tab', { key: 'Tab' }],
    ['Shift+Tab', { key: 'Tab', shift: true }],
    ['ArrowLeft', { key: 'ArrowLeft' }],
    ['Escape', { key: 'Escape' }],
    ['F1', { key: 'F1' }],
    ['F3', { key: 'F3' }],
    ['Backspace', { key: 'Backspace' }],
    // AltGr is Ctrl+Alt on Windows, and types characters: never a browser shortcut.
    ['AltGr+T', { key: 't', ctrl: true, alt: true }],
    ['AltGr+W (Polish ś)', { key: 'ś', code: 'KeyW', ctrl: true, alt: true }],
    ['AltGr+1', { key: '1', code: 'Digit1', ctrl: true, alt: true }],
    // Other combinations of the reserved keys.
    ['Alt+Shift+D', { key: 'D', alt: true, shift: true }],
    ['Alt+T', { key: 't', alt: true }],
    ['Ctrl+Alt+Left', { key: 'ArrowLeft', ctrl: true, alt: true }],
    ['Ctrl+Shift+W', { key: 'W', ctrl: true, shift: true }],
    ['Ctrl+Shift+1', { key: '!', code: 'Digit1', ctrl: true, shift: true }],
    ['Ctrl+0 is zoom, not a tab', { key: '0', code: 'Digit0', ctrl: true }],
    ['Shift+F11', { key: 'F11', shift: true }],
    ['Shift+F12', { key: 'F12', shift: true }],
    ['Alt+F4 closes the window, not a tab', { key: 'F4', alt: true }],
    ['the Windows key', { key: 't', meta: true }],
    ['Ctrl+Win+T', { key: 't', ctrl: true, meta: true }],
  ])('%s goes to the page', (_name, keys) => {
    expect(matchReservedShortcut(input(keys))).toBeNull();
  });
});
