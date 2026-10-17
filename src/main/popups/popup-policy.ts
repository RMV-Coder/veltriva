// The window-open handler of tabs and popup windows (ADR-0002 §4, assessment §3.7). Electron has
// no popup blocker and its handler carries no gesture signal (spike S7), so:
//   1. ./window-open-route.ts refuses dangerous schemes and decides tab, popup window or another app;
//   2. a popup (or new tab) needs a trusted click or key press in that page within the last 5 s,
//      used up by the popup, as Chromium's user activation is; without one it's blocked, and the
//      toolbar offers to open it anyway;
//   3. tabs are created and loaded by TabManager (no opener); `new-window` popups with features
//      host Chromium's pre-created contents in a popup window, so `window.opener` and postMessage
//      keep working for sign-in and payment flows, even across sites.
import type {
  BrowserWindowConstructorOptions,
  HandlerDetails,
  WebContents,
  WindowOpenHandlerResponse,
} from 'electron';

import type { ActivationTracker } from '../../core/input/user-activation';
import type { ExternalProtocolGuard } from '../external/protocol-guard';
import type { Logger } from '../platform/logger';
import type { TabId, TabManager } from '../tabs/tab-manager';
import { claimNextPopupContents } from '../web/roles';
import type { BlockedPopups } from './blocked-popups';
import { routeWindowOpen } from './window-open-route';
import type { PopupSize } from './window-open-route';

/** Hosts a popup's contents in a popup window (src/main/windows/popup-windows.ts). */
export interface PopupHost {
  host(
    contents: WebContents | undefined,
    popup: { readonly url: string; readonly size: PopupSize },
    openerTabId: TabId,
  ): WebContents;
}

export interface PopupPolicyDependencies {
  readonly activation: ActivationTracker<number>;
  readonly now: () => number;
  readonly tabs: () => TabManager;
  readonly blocked: BlockedPopups;
  readonly external: ExternalProtocolGuard;
  readonly popupWindows: () => PopupHost;
  readonly logger: Logger;
}

export interface WindowOpenSource {
  readonly contents: WebContents;
  /** The tab the page belongs to; for a popup window, the tab that opened it. */
  readonly tabId: () => TabId | undefined;
  readonly fromPopupWindow: boolean;
}

export type WindowOpenHandler = (details: HandlerDetails) => WindowOpenHandlerResponse;

/**
 * Chromium's pre-created contents for the popup. Electron passes it as `options.webContents`
 * (measured on Electron 44; spike S7), though its typings leave the field out.
 */
function precreatedContents(options: BrowserWindowConstructorOptions): WebContents | undefined {
  const candidate = (options as { readonly webContents?: unknown }).webContents;
  return typeof candidate === 'object' && candidate !== null && 'id' in candidate
    ? (candidate as WebContents)
    : undefined;
}

export function createWindowOpenHandler(
  deps: PopupPolicyDependencies,
  source: WindowOpenSource,
): WindowOpenHandler {
  return (details) => {
    const route = routeWindowOpen({
      url: details.url,
      disposition: details.disposition,
      features: details.features,
      hasPostBody: details.postBody !== undefined,
      fromPopupWindow: source.fromPopupWindow,
    });
    if (route.kind === 'deny') {
      deps.logger.warn('popup.refused', { reason: route.reason, disposition: details.disposition });
      return { action: 'deny' };
    }
    const tabId = source.tabId();
    const tabs = deps.tabs();
    if (tabId === undefined || !tabs.has(tabId)) {
      return { action: 'deny' };
    }
    const gesture = deps.activation.consume(source.contents.id, deps.now());

    if (route.kind === 'external') {
      // window.open('mailto:…') and friends arrive here, not as openExternal (spike S7).
      void deps.external.request({
        tabId,
        url: route.url,
        pageUrl: source.contents.getURL(),
        gesture,
      });
      return { action: 'deny' };
    }
    if (route.kind === 'download') {
      // A download needs the click too; it never opens a tab or a window.
      if (gesture) {
        source.contents.downloadURL(route.url);
      }
      return { action: 'deny' };
    }
    if (!gesture) {
      deps.blocked.record(tabId, route.url);
      return { action: 'deny' };
    }
    if (route.kind === 'tab') {
      const id = tabs.create({ afterTabId: tabId, select: !route.background });
      tabs.navigate(id, route.url, { focus: !route.background });
      return { action: 'deny' };
    }

    // A popup window. Chromium creates its contents right after this returns; claim it now.
    claimNextPopupContents();
    return {
      action: 'allow',
      // Sign-in popups must survive their opener tab closing or being unloaded, as in Chrome.
      outlivesOpener: true,
      createWindow: (options) =>
        deps.popupWindows().host(precreatedContents(options), route, tabId),
    };
  };
}
