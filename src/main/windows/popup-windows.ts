// Popup windows (ADR-0002 §4, assessment §3.7): small windows for sign-in and payment popups.
// Each hosts Chromium's pre-created contents, so `window.opener` and postMessage keep working,
// even across sites (spike S7), under a read-only address bar drawn by trusted UI:
//   - The bar is app://shell/popup-bar.html on the shell's session, with no preload and no IPC.
//     Main pushes its text as a JSON string literal; the page renders it as text.
//   - It shows only committed URLs, starting at about:blank, which is what the popup holds until
//     its first commit. A page that writes into a blank popup can't pass it off as another site.
//   - The bar is a separate view above the page's, so the page can never cover it, and popup
//     windows get no fullscreen (the permission broker refuses it there).
// A popup's own window.open opens tabs in the main window, never further popup windows.
// Lifecycle (S7): the page's window.close() destroys its contents but leaves the window open, so
// the window is closed here; closing the window closes the contents and the bar.
// Known gap (S7): a hosted popup doesn't inherit `safeDialogs`, and overriding the options doesn't
// help. A popup window is a separate, closable window with its own address bar.
import { BaseWindow, nativeTheme, WebContentsView } from 'electron';
import type { Rectangle, Session, WebContents } from 'electron';

import { isActivationInput } from '../../core/input/user-activation';
import type { ActivationTracker } from '../../core/input/user-activation';
import { displayUrl, originLabel } from '../../core/url/display';
import type { SecurityState } from '../../core/url/display';
import { PRODUCT_NAME } from '../../shared/constants/app-identity';
import type { Logger } from '../platform/logger';
import type { PopupHost, WindowOpenHandler, WindowOpenSource } from '../popups/popup-policy';
import type { PopupSize } from '../popups/window-open-route';
import type { TabId } from '../tabs/tab-manager';
import { assertPopupContents, createViewWithRole } from '../web/roles';
import { popupBarWebPreferences, TAB_WEB_PREFERENCES } from '../web/web-preferences';
import { windowBackground } from './main-window';

/** The address bar's height, in DIPs. */
export const POPUP_BAR_HEIGHT = 36;

/** What the address bar shows. */
export interface PopupBarState {
  readonly text: string;
  readonly security: SecurityState;
}

export interface PopupWindowInfo {
  readonly webContentsId: number;
  readonly url: string;
  readonly title: string;
  readonly bar: PopupBarState;
  readonly contentBounds: Rectangle;
  readonly barBounds: Rectangle;
  readonly pageBounds: Rectangle;
}

interface PopupWindow {
  readonly window: BaseWindow;
  readonly page: WebContentsView;
  readonly bar: WebContentsView;
  state: PopupBarState;
}

export interface PopupWindowsOptions {
  /** The main window: popups open centered on it. */
  readonly parent: () => BaseWindow;
  readonly shellSession: Session;
  /** app://shell/popup-bar.html (or the dev server's). */
  readonly barUrl: string;
  readonly activation: ActivationTracker<number>;
  /** The popup's own window.open handler (tabs only). */
  readonly windowOpenHandler: (source: WindowOpenSource) => WindowOpenHandler;
  /** Which tab a popup's own popups open next to: its opener, or the selected one. */
  readonly tabFor: (openerTabId: TabId) => TabId | undefined;
  readonly logger: Logger;
}

const BLANK: PopupBarState = { text: 'about:blank', security: 'neutral' };

export class PopupWindows implements PopupHost {
  readonly #options: PopupWindowsOptions;
  readonly #popups = new Set<PopupWindow>();

  constructor(options: PopupWindowsOptions) {
    this.#options = options;
  }

  /** `createWindow` of the popup policy. Returns the contents Electron must use. */
  host(
    precreated: WebContents | undefined,
    popup: { readonly url: string; readonly size: PopupSize },
    openerTabId: TabId,
  ): WebContents {
    let page: WebContentsView;
    if (precreated === undefined) {
      // No pre-created contents (a `noopener` popup): a popup-role view of our own, loaded here.
      page = createViewWithRole('popup', { webPreferences: { ...TAB_WEB_PREFERENCES } });
    } else {
      assertPopupContents(precreated);
      page = new WebContentsView({ webContents: precreated });
    }
    const contents = page.webContents;

    const window = new BaseWindow({
      ...this.#centeredBounds(popup.size),
      useContentSize: true,
      title: PRODUCT_NAME,
      minWidth: 240,
      minHeight: 180 + POPUP_BAR_HEIGHT,
      backgroundColor: windowBackground(nativeTheme.shouldUseDarkColors),
      show: true,
    });
    const bar = createViewWithRole('shell', {
      webPreferences: popupBarWebPreferences(this.#options.shellSession),
    });
    window.contentView.addChildView(page);
    window.contentView.addChildView(bar);
    const entry: PopupWindow = { window, page, bar, state: BLANK };
    this.#popups.add(entry);

    const layout = (): void => {
      if (window.isDestroyed()) {
        return;
      }
      const { width, height } = window.getContentBounds();
      bar.setBounds({ x: 0, y: 0, width, height: POPUP_BAR_HEIGHT });
      page.setBounds({
        x: 0,
        y: POPUP_BAR_HEIGHT,
        width,
        height: Math.max(0, height - POPUP_BAR_HEIGHT),
      });
    };
    layout();
    window.on('resize', layout);

    const pushState = (): void => {
      if (bar.webContents.isDestroyed()) {
        return;
      }
      // A JSON string literal can't break out of the call, and the bar renders it as text.
      bar.webContents
        .executeJavaScript(`globalThis.veltrivaPopupBar?.show(${JSON.stringify(entry.state)})`)
        .catch(() => undefined);
    };
    const committed = (url: string): void => {
      const shown = displayUrl(url);
      entry.state = {
        text: shown.text === '' ? 'about:blank' : shown.text,
        security: shown.security,
      };
      if (!window.isDestroyed()) {
        window.setTitle(`${originLabel(url)} – ${PRODUCT_NAME}`);
      }
      pushState();
    };
    bar.webContents.on('did-finish-load', pushState);
    bar.webContents.loadURL(this.#options.barUrl).catch(() => undefined);

    contents.on('did-navigate', (_event, url) => {
      committed(url);
    });
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) {
        committed(url);
      }
    });
    contents.on('input-event', (_event, input) => {
      if (isActivationInput(input)) {
        this.#options.activation.record(contents.id, Date.now());
      }
    });
    contents.on('before-input-event', (event, input) => {
      // Ctrl+W and Ctrl+F4 close the popup window, as in Chrome.
      const key = input.key.toLowerCase();
      if (
        input.type === 'keyDown' &&
        input.control &&
        !input.alt &&
        (key === 'w' || key === 'f4')
      ) {
        event.preventDefault();
        window.close();
      }
    });
    contents.setWindowOpenHandler(
      this.#options.windowOpenHandler({
        contents,
        tabId: () => this.#options.tabFor(openerTabId),
        fromPopupWindow: true,
      }),
    );
    // The page closed itself (window.close()) or its renderer is gone: close the window too.
    contents.once('destroyed', () => {
      if (!window.isDestroyed()) {
        window.close();
      }
    });
    contents.on('render-process-gone', (_event, details) => {
      this.#options.logger.warn('popup.rendererGone', { reason: details.reason });
      if (!window.isDestroyed()) {
        window.close();
      }
    });
    window.once('closed', () => {
      this.#popups.delete(entry);
      this.#options.activation.forget(contents.id);
      if (!contents.isDestroyed()) {
        contents.close();
      }
      if (!bar.webContents.isDestroyed()) {
        bar.webContents.close();
      }
    });

    if (precreated === undefined) {
      contents.loadURL(popup.url).catch(() => undefined);
    }
    return contents;
  }

  /** The main window closed: the app is quitting, and popups go with it. */
  closeAll(): void {
    for (const popup of [...this.#popups]) {
      if (!popup.window.isDestroyed()) {
        popup.window.close();
      }
    }
  }

  /** For test hooks. */
  list(): PopupWindowInfo[] {
    return [...this.#popups]
      .filter((popup) => !popup.window.isDestroyed() && !popup.page.webContents.isDestroyed())
      .map((popup) => ({
        webContentsId: popup.page.webContents.id,
        url: popup.page.webContents.getURL(),
        title: popup.window.getTitle(),
        bar: popup.state,
        contentBounds: popup.window.getContentBounds(),
        barBounds: popup.bar.getBounds(),
        pageBounds: popup.page.getBounds(),
      }));
  }

  /** Centered on the browser window, whatever position the page asked for. */
  #centeredBounds(size: PopupSize): Rectangle {
    const parent = this.#options.parent();
    const area = parent.isDestroyed()
      ? { x: 0, y: 0, width: 1280, height: 800 }
      : parent.getBounds();
    const height = size.height + POPUP_BAR_HEIGHT;
    return {
      x: Math.round(area.x + (area.width - size.width) / 2),
      y: Math.round(area.y + (area.height - height) / 2),
      width: size.width,
      height,
    };
  }
}
