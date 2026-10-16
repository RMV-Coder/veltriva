// Every web contents gets exactly one role when it's created (ADR-0002, assessment §6.4). The
// role decides its navigation, window-open and IPC policy. This module has no Electron imports,
// so the policies built on it can be unit-tested on plain Node.

/**
 * - `shell`: the trusted UI on app://shell. The only role IPC accepts.
 * - `tab`: untrusted web content on the `persist:browsing` partition. No preload, no IPC.
 * - `popup`: a window.open popup hosting web content (M1.4). Same policy as a tab.
 * - `devtools`: a DevTools front end. Electron manages its navigation.
 * - `unknown`: anything created without a claim. Treated as hostile: it can't navigate at all.
 */
export type WebContentsRole = 'shell' | 'tab' | 'popup' | 'devtools' | 'unknown';

/** Roles that creation code claims explicitly. `devtools` and `unknown` are inferred. */
export type ClaimableRole = Extract<WebContentsRole, 'shell' | 'tab' | 'popup'>;
