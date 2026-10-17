// TabRuntime over a WebContentsView (assessment §3.2): creates the tab's view with the `tab` role
// and hardened webPreferences, turns Chromium's events into TabRuntimeEvents, and destroys the
// view explicitly (ADR-0002 §2). Event mapping, checked on Electron 44 in M1.3:
//   did-navigate / did-navigate-in-page (main frame)  → committed
//   did-fail-load (main frame, except ERR_ABORTED)    → loadFailed (no page commits then)
//   render-process-gone                               → crashed
//   found-in-page                                     → foundInPage
//   zoom-changed (Ctrl+wheel, pinch)                  → zoomRequested
//   enter-html-full-screen / leave-html-full-screen   → fullscreenChanged
// M1.4: `input-event` feeds the user-activation tracker, and the window-open handler is the popup
// policy (src/main/popups/popup-policy.ts), set before the view loads anything.
// `did-start-navigation` is deliberately unused (see TabRuntimeEvents in ./tab-manager.ts).
import type { ContextMenuParams, Event, Input, WebContentsView } from 'electron';

import { isActivationInput } from '../../core/input/user-activation';
import type { ActivationTracker } from '../../core/input/user-activation';
import type { Logger } from '../platform/logger';
import type { WindowOpenHandler, WindowOpenSource } from '../popups/popup-policy';
import { createViewWithRole } from '../web/roles';
import { TAB_WEB_PREFERENCES } from '../web/web-preferences';
import type { FaviconService } from './favicons';
import type { TabId, TabRuntime, TabRuntimeFactory } from './tab-manager';

/** Where a tab's view is shown: the LayoutManager's content area. */
export interface ContentHost {
  showContent(view: WebContentsView): void;
  hideContent(view: WebContentsView): void;
}

/** What other parts of main need from a tab's input (src/main/input, src/main/menus). */
export interface TabInputHandlers {
  /** Every key before the page sees it: the reserved shortcuts (assessment §3.9). */
  beforeInput(tabId: TabId, event: Event, input: Input): void;
  /** The user asked for the page's context menu. */
  contextMenu(tabId: TabId, params: ContextMenuParams): void;
}

const ERR_ABORTED = -3;

/**
 * An isolated world of our own (the page can't touch its globals) for the one script main runs in
 * a page: leaving fullscreen. World 0 is the page's own and 999 is Electron's.
 */
const BROWSER_WORLD_ID = 1001;
const EXIT_FULLSCREEN = 'document.fullscreenElement ? document.exitFullscreen() : undefined';

export interface TabRuntimes {
  readonly factory: TabRuntimeFactory;
  /** The live view of each tab that has one. For main's own controllers and test hooks. */
  readonly views: ReadonlyMap<TabId, WebContentsView>;
}

export function createTabRuntimes(options: {
  readonly host: ContentHost;
  readonly favicons: FaviconService;
  readonly input: TabInputHandlers;
  /** Trusted input per web contents, for the popup and external-protocol gesture rule. */
  readonly activation: ActivationTracker<number>;
  readonly windowOpenHandler: (source: WindowOpenSource) => WindowOpenHandler;
  readonly logger: Logger;
}): TabRuntimes {
  const views = new Map<TabId, WebContentsView>();

  const factory: TabRuntimeFactory = (tabId, events) => {
    const view = createViewWithRole('tab', { webPreferences: { ...TAB_WEB_PREFERENCES } });
    const contents = view.webContents;
    views.set(tabId, view);
    let destroyed = false;
    /** Increases with each cross-document commit; stale favicon lookups are dropped. */
    let document = 0;

    contents.setWindowOpenHandler(
      options.windowOpenHandler({ contents, tabId: () => tabId, fromPopupWindow: false }),
    );
    contents.on('input-event', (_event, input) => {
      if (!destroyed && isActivationInput(input)) {
        options.activation.record(contents.id, Date.now());
      }
    });

    const history = (): { canGoBack: boolean; canGoForward: boolean } => ({
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
    });

    contents.on('did-navigate', (_event, url) => {
      if (destroyed) {
        return;
      }
      document += 1;
      events.committed({ url, sameDocument: false, ...history() });
    });
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!destroyed && isMainFrame) {
        events.committed({ url, sameDocument: true, ...history() });
      }
    });
    contents.on('did-fail-load', (_event, code, name, url, isMainFrame) => {
      if (!destroyed && isMainFrame && code !== ERR_ABORTED) {
        // History may have moved (a failed navigation can still add an entry): report it.
        events.loadFailed({ code, name, url, ...history() });
      }
    });
    contents.on('did-start-loading', () => {
      if (!destroyed) {
        events.loadingChanged(true);
      }
    });
    contents.on('did-stop-loading', () => {
      if (!destroyed) {
        events.loadingChanged(false);
      }
    });
    contents.on('page-title-updated', (_event, title) => {
      if (!destroyed) {
        events.titleChanged(title);
      }
    });
    contents.on('render-process-gone', (_event, details) => {
      if (!destroyed) {
        options.logger.warn('tab.rendererGone', { reason: details.reason });
        events.crashed({ code: details.exitCode, name: details.reason });
      }
    });
    contents.on('page-favicon-updated', (_event, candidates) => {
      const forDocument = document;
      // The committed page decides which local hosts its favicon may come from.
      options.favicons
        .resolve(candidates, contents.getURL())
        .then((favicon) => {
          if (!destroyed && forDocument === document) {
            events.faviconChanged(favicon);
          }
        })
        .catch(() => undefined);
    });
    contents.on('found-in-page', (_event, result) => {
      if (!destroyed) {
        events.foundInPage({
          requestId: result.requestId,
          activeMatch: result.activeMatchOrdinal,
          matches: result.matches,
        });
      }
    });
    contents.on('zoom-changed', (_event, direction) => {
      if (!destroyed) {
        events.zoomRequested(direction);
      }
    });
    contents.on('enter-html-full-screen', () => {
      if (!destroyed) {
        events.fullscreenChanged(true);
      }
    });
    contents.on('leave-html-full-screen', () => {
      if (!destroyed) {
        events.fullscreenChanged(false);
      }
    });
    contents.on('before-input-event', (event, input) => {
      if (!destroyed) {
        options.input.beforeInput(tabId, event, input);
      }
    });
    contents.on('context-menu', (_event, params) => {
      if (!destroyed) {
        options.input.contextMenu(tabId, params);
      }
    });

    const runtime: TabRuntime = {
      load(url) {
        // Failures arrive as did-fail-load; the promise's rejection carries nothing more.
        contents.loadURL(url).catch(() => undefined);
      },
      goBack() {
        contents.navigationHistory.goBack();
      },
      goForward() {
        contents.navigationHistory.goForward();
      },
      reload({ ignoreCache = false } = {}) {
        if (ignoreCache) {
          contents.reloadIgnoringCache();
        } else {
          contents.reload();
        }
      },
      stop() {
        contents.stop();
      },
      find(text, { forward, newSearch }) {
        // Electron's `findNext` means "start a new search session", despite its name.
        return contents.findInPage(text, { forward, findNext: newSearch });
      },
      stopFind(action) {
        contents.stopFindInPage(action);
      },
      zoomFactor() {
        return destroyed ? 1 : contents.getZoomFactor();
      },
      setZoomFactor(factor) {
        if (!destroyed) {
          contents.setZoomFactor(factor);
        }
      },
      toggleDevTools() {
        if (destroyed) {
          return;
        }
        if (contents.isDevToolsOpened()) {
          contents.closeDevTools();
        } else {
          contents.openDevTools({ mode: 'detach', activate: true });
        }
      },
      exitFullscreen() {
        if (destroyed) {
          return;
        }
        // In our own world, so a page that replaced document.exitFullscreen can't trap the user.
        contents
          .executeJavaScriptInIsolatedWorld(BROWSER_WORLD_ID, [{ code: EXIT_FULLSCREEN }], true)
          .catch(() => undefined);
      },
      show() {
        if (!destroyed) {
          options.host.showContent(view);
        }
      },
      hide() {
        options.host.hideContent(view);
      },
      focus() {
        if (!destroyed) {
          contents.focus();
        }
      },
      destroy() {
        if (destroyed) {
          return;
        }
        destroyed = true;
        // ADR-0002 §2: detach, close, drop every reference.
        options.host.hideContent(view);
        if (contents.isDevToolsOpened()) {
          contents.closeDevTools();
        }
        options.activation.forget(contents.id);
        contents.close();
        views.delete(tabId);
      },
    };
    return runtime;
  };

  return { factory, views };
}
