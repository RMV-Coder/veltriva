// TabRuntime over a WebContentsView (assessment §3.2): creates the tab's view with the `tab` role
// and hardened webPreferences, turns Chromium's events into TabRuntimeEvents, and destroys the
// view explicitly (ADR-0002 §2). Event mapping, checked on Electron 44 in M1.3:
//   did-navigate / did-navigate-in-page (main frame)  → committed
//   did-fail-load (main frame, except ERR_ABORTED)    → loadFailed (no page commits then)
//   render-process-gone                               → crashed
// `did-start-navigation` is deliberately unused (see TabRuntimeEvents in ./tab-manager.ts).
import type { WebContentsView } from 'electron';

import type { Logger } from '../platform/logger';
import { createViewWithRole } from '../web/roles';
import { TAB_WEB_PREFERENCES } from '../web/web-preferences';
import type { FaviconService } from './favicons';
import type { TabId, TabRuntime, TabRuntimeFactory } from './tab-manager';

/** Where a tab's view is shown: the LayoutManager's content area. */
export interface ContentHost {
  showContent(view: WebContentsView): void;
  hideContent(view: WebContentsView): void;
}

const ERR_ABORTED = -3;

export interface TabRuntimes {
  readonly factory: TabRuntimeFactory;
  /** The live view of each tab that has one. For test hooks and diagnostics only. */
  readonly views: ReadonlyMap<TabId, WebContentsView>;
}

export function createTabRuntimes(options: {
  readonly host: ContentHost;
  readonly favicons: FaviconService;
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
        events.loadFailed({ code, name, url });
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
      reload() {
        contents.reload();
      },
      stop() {
        contents.stop();
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
        contents.close();
        views.delete(tabId);
      },
    };
    return runtime;
  };

  return { factory, views };
}
