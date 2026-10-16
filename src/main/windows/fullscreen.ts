// HTML fullscreen (threat T6). When a page goes fullscreen its tab fills the window, and for a few
// seconds a notice says which site that is and how to leave, so a page can't pass itself off as
// the browser or the desktop. Chromium makes the window fullscreen itself and handles Esc before
// the page or before-input-event can see it (checked on Electron 44); main lays out the view and
// shows the notice.
//
// The notice is drawn by the shell, raised above the page (ADR-0006, option A′): the page stays
// visible and live underneath, and a click on the notice hides it. The shell is raised only once
// it says it shows the notice and nothing else, so its chrome never flashes over the page; if it
// doesn't say so in time, it is raised anyway, because the notice must not be skipped.
import { originLabel } from '../../core/url/display';
import type { TabId } from '../tabs/tab-manager';

/** How long the notice stays once it is on screen. Chrome shows its notice for about as long. */
export const NOTICE_MS = 4_000;
/** How long the shell may take to draw the notice before it is raised anyway. */
export const NOTICE_READY_TIMEOUT_MS = 500;

export interface FullscreenState {
  readonly tabId: TabId;
  /** Who is full screen, from the tab's committed URL (`originLabel`), never from page text. */
  readonly origin: string;
  /** The shell should draw the notice (and only the notice) now. */
  readonly notice: boolean;
}

export interface FullscreenLayout {
  setFullscreen(fullscreen: boolean): void;
  raiseShell(): void;
  lowerShell(): void;
}

/** The OS window's own fullscreen (`BaseWindow`). */
export interface FullscreenWindow {
  isFullScreen(): boolean;
  setFullScreen(fullscreen: boolean): void;
}

type Timer = ReturnType<typeof setTimeout>;

export interface FullscreenControllerOptions {
  readonly layout: FullscreenLayout;
  readonly window: FullscreenWindow;
  /** The URL of a tab's committed document. */
  readonly urlOf: (tabId: TabId) => string;
  /** Gives the page keyboard focus back (after a click on the notice took it). */
  readonly focusPage: (tabId: TabId) => void;
  /** The state changed: publish a snapshot. */
  readonly onChange: () => void;
  readonly schedule?: (callback: () => void, ms: number) => Timer;
  readonly cancel?: (timer: Timer) => void;
}

export class FullscreenController {
  readonly #options: FullscreenControllerOptions;
  readonly #schedule: (callback: () => void, ms: number) => Timer;
  readonly #cancel: (timer: Timer) => void;
  #state: FullscreenState | null = null;
  #raised = false;
  #timer: Timer | undefined;
  /** The user made the window fullscreen with F11, as opposed to a page making it so. */
  #windowFullscreenByUser = false;

  constructor(options: FullscreenControllerOptions) {
    this.#options = options;
    this.#schedule = options.schedule ?? ((callback, ms) => setTimeout(callback, ms));
    this.#cancel =
      options.cancel ??
      ((timer) => {
        clearTimeout(timer);
      });
  }

  state(): FullscreenState | null {
    return this.#state;
  }

  /** Whether the shell is above the page right now. */
  shellRaised(): boolean {
    return this.#raised;
  }

  /** F11 while no page is fullscreen: the window's own fullscreen, on or off. */
  toggleWindow(): void {
    const fullscreen = !this.#options.window.isFullScreen();
    this.#windowFullscreenByUser = fullscreen;
    this.#options.window.setFullScreen(fullscreen);
  }

  /** A tab entered HTML fullscreen (its id), or the window left it (null). From TabManager. */
  update(tabId: TabId | null): void {
    this.#clearTimer();
    if (tabId === null) {
      this.#state = null;
      this.#lower();
      this.#options.layout.setFullscreen(false);
      // Chromium takes the window out of fullscreen when the page leaves it, but not when the
      // page's web contents is destroyed while fullscreen (closing the tab; measured on Electron
      // 44). Unless the user chose fullscreen with F11, it was the page's: end it here too.
      const window = this.#options.window;
      if (!this.#windowFullscreenByUser && window.isFullScreen()) {
        window.setFullScreen(false);
      }
      this.#options.onChange();
      return;
    }
    this.#state = { tabId, origin: originLabel(this.#options.urlOf(tabId)), notice: true };
    this.#options.layout.setFullscreen(true);
    this.#options.onChange();
    this.#timer = this.#schedule(() => {
      this.noticeShown();
    }, NOTICE_READY_TIMEOUT_MS);
  }

  /** The shell draws the notice (and nothing else): raise it, and start the notice's time. */
  noticeShown(): void {
    if (this.#state?.notice !== true || this.#raised) {
      return;
    }
    this.#clearTimer();
    this.#raised = true;
    this.#options.layout.raiseShell();
    this.#timer = this.#schedule(() => {
      this.dismissNotice();
    }, NOTICE_MS);
  }

  /** The notice's time is up, or the user clicked it: lower the shell and hand focus back. */
  dismissNotice(): void {
    const state = this.#state;
    if (state?.notice !== true) {
      return;
    }
    this.#clearTimer();
    this.#state = { ...state, notice: false };
    this.#lower();
    this.#options.focusPage(state.tabId);
    this.#options.onChange();
  }

  dispose(): void {
    this.#clearTimer();
  }

  #lower(): void {
    if (this.#raised) {
      this.#raised = false;
      this.#options.layout.lowerShell();
    }
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) {
      this.#cancel(this.#timer);
      this.#timer = undefined;
    }
  }
}
