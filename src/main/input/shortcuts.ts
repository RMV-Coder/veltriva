// Browser-reserved shortcuts (assessment §3.9), from `before-input-event` on the shell and on
// every tab, before the page sees the key. A reserved key never reaches the page: its keyDown and
// keyUp are both cancelled, and the command runs once, on keyDown. Every other key goes on to the
// page (or the shell's own handlers); find and zoom come back as the hidden menu's accelerators
// if the page doesn't take them (./page-menu.ts).
import type { BaseWindow, Event, Input } from 'electron';

import { matchReservedShortcut } from '../../core/input/shortcuts';
import type { ReservedCommand } from '../../core/input/shortcuts';
import type { FocusManager } from '../focus/focus-manager';
import type { TabId, TabManager } from '../tabs/tab-manager';

/** Where a key event came from: the shell's web contents, or a tab's. */
export type InputSource = 'shell' | { readonly tabId: TabId };

export interface ShortcutDependencies {
  readonly window: BaseWindow;
  readonly tabs: () => TabManager;
  readonly focus: FocusManager;
}

/** Commands a held-down key may repeat: moving through tabs and history. */
const REPEATABLE: ReadonlySet<ReservedCommand['kind']> = new Set([
  'nextTab',
  'previousTab',
  'back',
  'forward',
]);

export type BeforeInputHandler = (source: InputSource, event: Event, input: Input) => void;

export function createShortcutHandler(deps: ShortcutDependencies): BeforeInputHandler {
  const run = createCommandRunner(deps);
  return (source, event, input) => {
    if (input.type !== 'keyDown' && input.type !== 'keyUp') {
      return;
    }
    // Esc leaves HTML fullscreen. Chromium does that itself while the page has focus; this is for
    // when the shell has it (a click on the fullscreen notice).
    if (source === 'shell' && input.key === 'Escape' && deps.tabs().fullscreenTabId() !== null) {
      event.preventDefault();
      if (input.type === 'keyDown') {
        deps.tabs().exitFullscreen();
      }
      return;
    }
    const command = matchReservedShortcut(input);
    if (command === null) {
      return;
    }
    event.preventDefault();
    if (input.type === 'keyDown' && (!input.isAutoRepeat || REPEATABLE.has(command.kind))) {
      run(command);
    }
  };
}

function createCommandRunner({ window, tabs, focus }: ShortcutDependencies) {
  /** Selection by shortcut moves focus to the new tab's page, or its address bar. */
  const afterSwitch = (): void => {
    focus.focusSelected();
  };

  return (command: ReservedCommand): void => {
    const manager = tabs();
    const selected = manager.selectedTabId();
    switch (command.kind) {
      case 'newTab':
        manager.create();
        focus.focusAddressBar();
        return;
      case 'closeTab':
        if (selected !== null) {
          manager.close(selected, { focus: false });
          afterSwitch();
        }
        return;
      case 'reopenClosedTab':
        // The reopened tab's page takes focus when it commits.
        manager.reopenClosed();
        return;
      case 'nextTab':
        manager.selectRelative(1, { focus: false });
        afterSwitch();
        return;
      case 'previousTab':
        manager.selectRelative(-1, { focus: false });
        afterSwitch();
        return;
      case 'selectTab':
        manager.selectIndex(command.index, { focus: false });
        afterSwitch();
        return;
      case 'selectLastTab':
        manager.selectLast({ focus: false });
        afterSwitch();
        return;
      case 'focusAddressBar':
        focus.focusAddressBar();
        return;
      case 'cycleFocus':
        focus.cycle();
        return;
      case 'reload':
      case 'reloadIgnoringCache':
        if (selected !== null) {
          manager.reload(selected, { ignoreCache: command.kind === 'reloadIgnoringCache' });
        }
        return;
      case 'back':
        if (selected !== null) {
          manager.goBack(selected);
        }
        return;
      case 'forward':
        if (selected !== null) {
          manager.goForward(selected);
        }
        return;
      case 'toggleFullscreen':
        // F11 also ends a page's HTML fullscreen, like Esc.
        if (manager.fullscreenTabId() !== null) {
          manager.exitFullscreen();
        } else {
          window.setFullScreen(!window.isFullScreen());
        }
        return;
      case 'toggleDevTools':
        if (selected !== null) {
          manager.toggleDevTools(selected);
        }
        return;
      case 'memoryPalette':
        // Reserved for the memory palette (Phase 4); nothing to open yet.
        return;
    }
  };
}
