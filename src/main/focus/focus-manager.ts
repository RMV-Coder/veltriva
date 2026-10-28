// FocusManager (assessment §3.9): which view has the keyboard, the shell or the page, and the
// rules that move it. Main moves focus between views; the shell focuses its own elements when main
// tells it to (`ui.focusAddressBar`, `ui.focusFind`).
//
// The rules:
//   - Ctrl+L, Alt+D, Ctrl+T: the shell's address bar.
//   - A typed navigation that commits: its page (TabManager, `focusOnCommit`).
//   - A tab switch by shortcut, or by a click in the sidebar: the new tab's page, or the address
//     bar for a new tab. A switch by keyboard inside the sidebar keeps focus in the sidebar.
//   - F6: from the page to the address bar; then the shell moves on to the sidebar's selected tab,
//     and from there back to the page (M6.2, `ui.cycleFocus` and `focus.page`).
//   - Closing the find bar, or the fullscreen notice: back to the page.
//   - Ctrl+Shift+K: the shell, which opens the memory palette (M4.2); the palette's overlay keeps
//     it while open, and closing it without opening anything gives the page its keyboard back.
import type { WebContentsView } from 'electron';

import type { ShellEvents } from '../ipc/events';
import type { TabManager } from '../tabs/tab-manager';

export interface FocusManagerOptions {
  readonly shell: WebContentsView;
  readonly tabs: () => TabManager;
  readonly events: ShellEvents;
}

export class FocusManager {
  readonly #options: FocusManagerOptions;

  constructor(options: FocusManagerOptions) {
    this.#options = options;
  }

  /** Whether the shell, rather than a page, has the keyboard. */
  shellHasFocus(): boolean {
    const { webContents } = this.#options.shell;
    return !webContents.isDestroyed() && webContents.isFocused();
  }

  focusAddressBar(): void {
    this.#focusShell();
    this.#options.events.emit('ui.focusAddressBar', {});
  }

  focusFindBar(): void {
    this.#focusShell();
    this.#options.events.emit('ui.focusFind', {});
  }

  /** Ctrl+Shift+K: the shell gets the keyboard and opens the memory palette (M4.2). */
  openPalette(): void {
    this.#focusShell();
    this.#options.events.emit('ui.openPalette', {});
  }

  /** The shell's overlay is up (ADR-0006 A′): its field has the keyboard. */
  focusShell(): void {
    this.#focusShell();
  }

  /** The selected tab's page; for a tab without one, the address bar (a new tab) or the shell. */
  focusSelected(): void {
    const tabs = this.#options.tabs();
    const tabId = tabs.selectedTabId();
    if (tabId === null || tabs.focusPage(tabId)) {
      return;
    }
    const { page } = tabs.get(tabId);
    if (page.kind === 'internal' && page.name === 'new-tab') {
      this.focusAddressBar();
    } else {
      // An error or crashed page: its button is in the shell.
      this.#focusShell();
    }
  }

  /**
   * F6: the page, the address bar and the sidebar take turns (M6.2). From the page, main focuses
   * the address bar. With the shell focused, only the shell knows where its focus is, so it moves
   * on itself: from the address bar to the sidebar, and from the sidebar to the page (`focus.page`,
   * `focusSelected`).
   */
  cycle(): void {
    if (!this.shellHasFocus()) {
      this.focusAddressBar();
      return;
    }
    this.#options.events.emit('ui.cycleFocus', {});
  }

  #focusShell(): void {
    const { webContents } = this.#options.shell;
    if (!webContents.isDestroyed()) {
      webContents.focus();
    }
  }
}
