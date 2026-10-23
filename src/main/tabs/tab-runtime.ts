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
//
// M3.1, the discard and restore of assessment §4.9 (spikes S2 and S3):
//   dom-ready (main frame)       → install the trusted-input tracker in our isolated world
//   ping()                       → the probe's dry run in that world: the renderer is awake
//   probe()                      → the probe and page-state flush, in the same world; the
//                                  same-document commit the flush causes is dropped
//   closeForDiscard('beforeunload') → close({ waitForBeforeUnload: true }); `will-prevent-unload`
//                                  (never preventDefault'ed, so the page stays) means `prevented`
//   closeForDiscard('plain')     → close()
//   destroyed                    → settles every close; `gone` unless destroy() asked for it
//   freeze() / thaw()            → CDP Page.setWebLifecycleState through webContents.debugger
//                                  (experimental, off by default; a detach means thawed)
//
// M5.0: a page's `beforeunload` that stops a navigation or a reload (outside a close above) is
//   `will-prevent-unload`, which Electron answers by cancelling silently: it becomes
//   `unloadBlocked`, so TabManager can ask "Leave page?" about the user's own navigation.
//   `allowNextUnload()` lets the next objection through (`preventDefault`), once, after the user
//   chose to leave. A navigation the page starts itself (a link in it) gives no target: its
//   handler runs in the renderer before main hears of any navigation (measured, Electron 45).
import type { ContextMenuParams, Event, Input, WebContents, WebContentsView } from 'electron';

import { isActivationInput } from '../../core/input/user-activation';
import type { ActivationTracker } from '../../core/input/user-activation';
import { trackMainFrameNavigations } from '../auth/sign-in';
import type { Logger } from '../platform/logger';
import type { WindowOpenHandler, WindowOpenSource } from '../popups/popup-policy';
import { createViewWithRole } from '../web/roles';
import { TAB_WEB_PREFERENCES } from '../web/web-preferences';
import type { FaviconService } from './favicons';
import {
  BROWSER_WORLD_ID,
  EXIT_FULLSCREEN,
  INSTALL_INPUT_TRACKER,
  PROBE,
  PROBE_DRY_RUN,
} from './page-scripts';
import type { CloseResult, TabId, TabRuntime, TabRuntimeFactory } from './tab-manager';

/** Where a tab's view is shown: the LayoutManager's content area. */
export interface ContentHost {
  showContent(view: WebContentsView): void;
  hideContent(view: WebContentsView): void;
  /** Attached, invisible and under everything: for a restore in the background (S2). */
  attachHidden(view: WebContentsView): void;
}

/** What other parts of main need from a tab's input (src/main/input, src/main/menus). */
export interface TabInputHandlers {
  /** Every key before the page sees it: the reserved shortcuts (assessment §3.9). */
  beforeInput(tabId: TabId, event: Event, input: Input): void;
  /** The user asked for the page's context menu. */
  contextMenu(tabId: TabId, params: ContextMenuParams): void;
}

const ERR_ABORTED = -3;
/** How long after a load stops a document's own favicon candidates may still arrive. */
const SAME_FAVICON_GRACE_MS = 1000;
/**
 * How long the same-document commit of the probe's flush may take to arrive, before or after the
 * probe's answer (S2: the flush itself takes 4–11 ms).
 */
const FLUSH_COMMIT_WINDOW_MS = 2000;
/** The recent-interaction guard needs minutes, not every mouse move. */
const INTERACTION_REPORT_MS = 1000;
/** The DevTools protocol version the freeze experiment speaks. */
const DEBUGGER_PROTOCOL = '1.3';

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
  /** A tab's web contents was just created: the protection monitor watches it from here (M3.4). */
  readonly onContentsCreated?: (tabId: TabId, contents: WebContents) => void;
}): TabRuntimes {
  const views = new Map<TabId, WebContentsView>();

  const factory: TabRuntimeFactory = (tabId, events) => {
    const view = createViewWithRole('tab', { webPreferences: { ...TAB_WEB_PREFERENCES } });
    const contents = view.webContents;
    // Read once: a destroyed web contents can't be asked any more.
    const contentsId = contents.id;
    views.set(tabId, view);
    options.onContentsCreated?.(tabId, contents);
    /** destroy() was called, or the web contents is gone: nothing more is reported. */
    let destroyed = false;
    /** The pending discard closes, settled when the web contents is destroyed. */
    const closeWaiters = new Set<() => void>();
    /** The same-document commit the probe's page-state flush causes, which is not a navigation. */
    let flushCommit: { readonly url: string; until: number } | null = null;
    /** The freeze experiment holds the debugger while the page is frozen. */
    let frozenByDebugger = false;
    /** Increases with each cross-document commit; stale favicon lookups are dropped. */
    let document = 0;
    /**
     * Chromium (Electron 44) reports a document's favicon candidates only when they differ from
     * the previous document's in this web contents: the second of two pages with the same icon
     * got no event, so neither the strip nor the memory showed one (found by E2E, M2.2b). The
     * last candidates are kept, and a committed document that stops loading without reporting
     * any takes them again.
     */
    let lastCandidates: readonly string[] | null = null;
    /** The document whose candidates arrived last; `document` once this one has reported. */
    let candidatesFor = 0;
    /** The main frame failed after the last commit: an error page shows, with no icon. */
    let failedSinceCommit = false;
    /** A close for a discard or for the user is asking the page; its own listener answers. */
    let closingForDiscard = false;
    /** The user chose to leave: the page's next objection is overridden (M5.0). */
    let allowUnload = false;

    const resolveFavicon = (candidates: readonly string[]): void => {
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
    };

    trackMainFrameNavigations(contents);
    contents.setWindowOpenHandler(
      options.windowOpenHandler({ contents, tabId: () => tabId, fromPopupWindow: false }),
    );
    /** When the last `interacted` was reported: at most one a second (§4.10's guard). */
    let interactionReportedAt = 0;
    contents.on('input-event', (_event, input) => {
      if (destroyed) {
        return;
      }
      const now = Date.now();
      if (isActivationInput(input)) {
        options.activation.record(contents.id, now);
        events.activated?.();
      }
      if (now - interactionReportedAt >= INTERACTION_REPORT_MS || now < interactionReportedAt) {
        interactionReportedAt = now;
        events.interacted?.();
      }
    });

    const history = (): { canGoBack: boolean; canGoForward: boolean } => ({
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
    });

    contents.on('will-prevent-unload', (event) => {
      if (destroyed || closingForDiscard) {
        return;
      }
      if (allowUnload) {
        allowUnload = false;
        event.preventDefault();
        return;
      }
      // Electron cancels the navigation or reload now, with no dialog: TabManager asks the user.
      events.unloadBlocked?.();
    });

    contents.on('did-navigate', (_event, url) => {
      if (destroyed) {
        return;
      }
      document += 1;
      failedSinceCommit = false;
      allowUnload = false;
      events.committed({ url, sameDocument: false, ...history() });
    });
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (destroyed || !isMainFrame) {
        return;
      }
      // The probe's flush (S2): neither a navigation nor engagement.
      if (flushCommit !== null && url === flushCommit.url && Date.now() <= flushCommit.until) {
        flushCommit = null;
        return;
      }
      events.committed({ url, sameDocument: true, ...history() });
    });
    // The trusted-input tracker, in each new document (S3). Never with a user gesture.
    contents.on('dom-ready', () => {
      if (!destroyed) {
        contents
          .executeJavaScriptInIsolatedWorld(
            BROWSER_WORLD_ID,
            [{ code: INSTALL_INPUT_TRACKER }],
            false,
          )
          .catch(() => undefined);
      }
    });
    contents.once('destroyed', () => {
      for (const settle of [...closeWaiters]) {
        settle();
      }
      if (destroyed) {
        return;
      }
      // Closed for a discard, or by something else: either way it is gone, and no view of it may
      // stay in the window.
      destroyed = true;
      options.host.hideContent(view);
      options.activation.forget(contentsId);
      if (views.get(tabId) === view) {
        views.delete(tabId);
      }
      events.gone();
    });
    // A click into a cross-site frame reaches main only here (S3): it activates the page too.
    contents.on('before-mouse-event', (_event, mouse) => {
      if (!destroyed && mouse.type === 'mouseDown') {
        events.activated?.();
      }
    });
    contents.debugger.on('detach', () => {
      if (frozenByDebugger) {
        // DevTools took the debugger, or it detached by itself: the page runs again.
        frozenByDebugger = false;
        if (!destroyed) {
          events.thawed();
        }
      }
    });
    contents.on('did-fail-load', (_event, code, name, url, isMainFrame) => {
      if (!destroyed && isMainFrame && code !== ERR_ABORTED) {
        failedSinceCommit = true;
        // The address is written only while diagnostic logging is on (M5.3, file-logger.ts).
        options.logger.warn('tab.loadFailed', { code, name, url });
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
      if (destroyed) {
        return;
      }
      events.loadingChanged(false);
      // Changed candidates arrive just after the load stops (seen on Electron 44), so give them a
      // moment before taking none to mean "the same as the last".
      const stopped = document;
      setTimeout(() => {
        if (
          !destroyed &&
          stopped > 0 &&
          stopped === document &&
          candidatesFor !== document &&
          !failedSinceCommit &&
          lastCandidates !== null
        ) {
          candidatesFor = document;
          resolveFavicon(lastCandidates);
        }
      }, SAME_FAVICON_GRACE_MS);
    });
    contents.on('page-title-updated', (_event, title) => {
      if (!destroyed) {
        events.titleChanged(title);
      }
    });
    contents.on('render-process-gone', (_event, details) => {
      if (!destroyed) {
        options.logger.warn('tab.rendererGone', { reason: details.reason, url: contents.getURL() });
        events.crashed({ code: details.exitCode, name: details.reason });
      }
    });
    contents.on('page-favicon-updated', (_event, candidates) => {
      lastCandidates = [...candidates];
      candidatesFor = document;
      resolveFavicon(candidates);
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
        // Leaving fullscreen needs no user activation, and granting it would tell the discard
        // that the user had been on the page (S3).
        contents
          .executeJavaScriptInIsolatedWorld(BROWSER_WORLD_ID, [{ code: EXIT_FULLSCREEN }], false)
          .catch(() => undefined);
      },
      show() {
        if (!destroyed) {
          options.host.showContent(view);
        }
      },
      showHidden() {
        if (!destroyed) {
          options.host.attachHidden(view);
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
      restore(history) {
        if (destroyed) {
          return;
        }
        // S2's three failure shapes: a synchronous throw (bad index, no entries), a rejection
        // without a failed load (an invalid entry, a used web contents) — both mean this web
        // contents can't be used — and a rejection after did-fail-load, which leaves the tab live
        // on an error page with its stack intact (loadFailed has already reported it). HTTP
        // errors resolve, and did-finish-load is no success signal (error pages emit it too).
        let failedLoad = false;
        const onFailedLoad = (
          _event: Event,
          _code: number,
          _name: string,
          _url: string,
          isMainFrame: boolean,
        ): void => {
          failedLoad ||= isMainFrame;
        };
        contents.on('did-fail-load', onFailedLoad);
        const done = (): void => {
          contents.off('did-fail-load', onFailedLoad);
        };
        let restoring: Promise<void>;
        try {
          restoring = contents.navigationHistory.restore({
            index: history.index,
            // Page state only from a discard in this run (never persisted); '' would be rejected,
            // and core/lifecycle/snapshot.ts never keeps one.
            entries: history.entries.map(({ url, title, pageState }) =>
              pageState === undefined ? { url, title } : { url, title, pageState },
            ),
          });
        } catch {
          done();
          events.restoreFailed();
          return;
        }
        restoring.then(done, () => {
          done();
          if (!destroyed && !failedLoad) {
            events.restoreFailed();
          }
        });
      },
      history() {
        if (destroyed) {
          return null;
        }
        const entries = contents.navigationHistory.getAllEntries();
        if (entries.length === 0) {
          return null;
        }
        return {
          index: contents.navigationHistory.getActiveIndex(),
          entries: entries.map(({ url, title }) => ({ url, title })),
        };
      },
      ping() {
        if (destroyed) {
          return Promise.reject(new Error('The tab is gone.'));
        }
        return contents.executeJavaScriptInIsolatedWorld(
          BROWSER_WORLD_ID,
          [{ code: PROBE_DRY_RUN }],
          false,
        );
      },
      probe() {
        if (destroyed) {
          return Promise.reject(new Error('The tab is gone.'));
        }
        const url = contents.getURL();
        flushCommit = { url, until: Date.now() + FLUSH_COMMIT_WINDOW_MS };
        return contents
          .executeJavaScriptInIsolatedWorld(BROWSER_WORLD_ID, [{ code: PROBE }], false)
          .then((reading: unknown) => {
            const flushed =
              typeof reading === 'object' &&
              reading !== null &&
              (reading as { flushed?: unknown }).flushed === true;
            if (!flushed) {
              flushCommit = null;
            } else if (flushCommit !== null) {
              // The commit may come just after the answer.
              flushCommit.until = Date.now() + FLUSH_COMMIT_WINDOW_MS;
            }
            return reading;
          });
      },
      snapshot() {
        if (destroyed || contents.isDestroyed()) {
          return null;
        }
        const entries = contents.navigationHistory.getAllEntries();
        if (entries.length === 0) {
          return null;
        }
        return { index: contents.navigationHistory.getActiveIndex(), entries };
      },
      allowNextUnload() {
        allowUnload = true;
      },
      print() {
        if (destroyed || contents.isDestroyed()) {
          return;
        }
        // The system dialog: the user chooses the printer, or cancels. Nothing prints silently.
        contents.print({ silent: false }, (succeeded, reason) => {
          if (!succeeded && reason !== 'Print job canceled' && reason !== 'cancelled') {
            options.logger.warn('tab.printFailed', { reason });
          }
        });
      },
      closeForDiscard(mode) {
        if (destroyed || contents.isDestroyed()) {
          return Promise.resolve<CloseResult>('closed');
        }
        return new Promise<CloseResult>((resolve) => {
          let settled = false;
          const settle = (result: CloseResult): void => {
            if (settled) {
              return;
            }
            settled = true;
            closingForDiscard = false;
            // S3: a listener left from one attempt must not answer for the next.
            contents.off('will-prevent-unload', onPreventUnload);
            closeWaiters.delete(onClosed);
            resolve(result);
          };
          // Never preventDefault(): that would close the page anyway (S3). Without it, Electron
          // silently cancels the close and the page lives on, with no dialog.
          const onPreventUnload = (): void => {
            settle('prevented');
          };
          const onClosed = (): void => {
            settle('closed');
          };
          closeWaiters.add(onClosed);
          // ADR-0002 §2: detach first.
          options.host.hideContent(view);
          if (contents.isDevToolsOpened()) {
            contents.closeDevTools();
          }
          if (mode === 'beforeunload') {
            closingForDiscard = true;
            contents.on('will-prevent-unload', onPreventUnload);
            contents.close({ waitForBeforeUnload: true });
          } else {
            contents.close();
          }
        });
      },
      async freeze() {
        if (destroyed) {
          throw new Error('The tab is gone.');
        }
        if (!contents.debugger.isAttached()) {
          contents.debugger.attach(DEBUGGER_PROTOCOL);
        }
        frozenByDebugger = true;
        await contents.debugger.sendCommand('Page.setWebLifecycleState', { state: 'frozen' });
      },
      thaw() {
        if (!frozenByDebugger) {
          return;
        }
        frozenByDebugger = false;
        if (destroyed || contents.isDestroyed() || !contents.debugger.isAttached()) {
          return;
        }
        contents.debugger
          .sendCommand('Page.setWebLifecycleState', { state: 'active' })
          .catch(() => undefined)
          .finally(() => {
            if (!contents.isDestroyed() && contents.debugger.isAttached()) {
              contents.debugger.detach();
            }
          });
      },
      destroy() {
        if (destroyed) {
          return;
        }
        destroyed = true;
        // ADR-0002 §2: detach, close, drop every reference.
        options.host.hideContent(view);
        options.activation.forget(contentsId);
        if (!contents.isDestroyed()) {
          if (contents.isDevToolsOpened()) {
            contents.closeDevTools();
          }
          contents.close();
        }
        if (views.get(tabId) === view) {
          views.delete(tabId);
        }
      },
    };
    return runtime;
  };

  return { factory, views };
}
