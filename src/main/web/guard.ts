// The global web-contents guard (ADR-0002 §4). Every web contents Electron creates, ours or
// Chromium's, passes through `web-contents-created`: it gets a role, then the role's policy for
// navigation, window.open, <webview> and device choosers. Install it before anything creates a
// web contents.
import { app } from 'electron';
import type { WebContents } from 'electron';

import { classifyExternalUrl } from '../../core/url/external-protocol';
import type { Logger } from '../platform/logger';
import { isNavigationAllowed } from './navigation-policy';
import { assignRole, takePendingClaim } from './roles';
import type { WebContentsRole } from './web-contents-role';

/**
 * A page tried to navigate its top frame to another app's URL (`mailto:`, `zoommtg:`). The guard
 * has already cancelled the navigation; the external-protocol guard decides whether to ask the
 * user (src/main/external/protocol-guard.ts). Set once main has built it.
 */
export type ExternalNavigationHandler = (contents: WebContents, url: string) => void;

let onExternalNavigation: ExternalNavigationHandler | undefined;

export function setExternalNavigationHandler(handler: ExternalNavigationHandler): void {
  onExternalNavigation = handler;
}

/** Unclaimed contents: DevTools front ends report the `remote` type (checked on Electron 44). */
function inferRole(contents: WebContents): WebContentsRole {
  return contents.getType() === 'remote' ? 'devtools' : 'unknown';
}

export function installWebContentsGuard(logger: Logger): void {
  app.on('web-contents-created', (_event, contents) => {
    const role = takePendingClaim() ?? inferRole(contents);
    assignRole(contents, role);
    if (role === 'unknown') {
      logger.warn('guard.unknownWebContents', { type: contents.getType() });
    }
    applyPolicy(contents, role, logger);
  });
}

function applyPolicy(contents: WebContents, role: WebContentsRole, logger: Logger): void {
  // Every role: no <webview>, and no window.open. Tabs and popup windows replace the window-open
  // handler with the popup policy (src/main/popups/popup-policy.ts) before they load anything.
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Web Bluetooth's device chooser: cancel. (Electron would otherwise wait for a selection.)
  contents.on('select-bluetooth-device', (event, _devices, callback) => {
    event.preventDefault();
    callback('');
  });

  if (role === 'devtools') {
    return;
  }

  const blockUnlessAllowed = (
    event: { preventDefault(): void },
    target: { url: string; isMainFrame: boolean },
    kind: string,
  ): void => {
    if (isNavigationAllowed(role, target)) {
      return;
    }
    event.preventDefault();
    const external = classifyExternalUrl(target.url).kind === 'external';
    if (external && target.isMainFrame && (role === 'tab' || role === 'popup')) {
      // Another app's link in the page itself: the protocol guard may ask the user.
      onExternalNavigation?.(contents, target.url);
      return;
    }
    // Everything else, including another app's link in an embedded frame (an ad can't launch
    // apps in the name of the page around it).
    logger.warn('guard.navigationBlocked', {
      role,
      kind,
      mainFrame: target.isMainFrame,
      external,
    });
  };
  contents.on('will-navigate', (event) => {
    blockUnlessAllowed(event, { url: event.url, isMainFrame: true }, 'navigate');
  });
  contents.on('will-frame-navigate', (event) => {
    blockUnlessAllowed(event, { url: event.url, isMainFrame: event.isMainFrame }, 'frame');
  });
  contents.on('will-redirect', (event) => {
    blockUnlessAllowed(event, { url: event.url, isMainFrame: event.isMainFrame }, 'redirect');
  });
}
