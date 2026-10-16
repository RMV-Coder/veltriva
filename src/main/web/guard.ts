// The global web-contents guard (ADR-0002 §4). Every web contents Electron creates, ours or
// Chromium's, passes through `web-contents-created`: it gets a role, then the role's policy for
// navigation, window.open, <webview> and device choosers. Install it before anything creates a
// web contents.
import { app } from 'electron';
import type { WebContents } from 'electron';

import type { Logger } from '../platform/logger';
import { isNavigationAllowed } from './navigation-policy';
import { assignRole, takePendingClaim } from './roles';
import type { WebContentsRole } from './web-contents-role';

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
  // Every role: no <webview>, and no window.open until the popup policy (M1.4).
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
    if (!isNavigationAllowed(role, target)) {
      event.preventDefault();
      logger.warn('guard.navigationBlocked', { role, kind, mainFrame: target.isMainFrame });
    }
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
