// The role registry. Creation code claims a role while it constructs a view; Electron emits
// `web-contents-created` synchronously inside the WebContentsView constructor (checked on
// Electron 44 in M1.2), so the guard sees the claim before the contents can load anything.
// `createViewWithRole` verifies that on every call, so an Electron change fails loudly instead of
// leaving a view with the wrong policy.
import { WebContentsView } from 'electron';
import type { WebContents, WebContentsViewConstructorOptions } from 'electron';

import type { ClaimableRole, WebContentsRole } from './web-contents-role';

const roles = new WeakMap<WebContents, WebContentsRole>();
let pendingClaim: ClaimableRole | undefined;

export function roleOf(contents: WebContents): WebContentsRole | undefined {
  return roles.get(contents);
}

/** Called by the guard in `web-contents-created`. Returns the claimed role, if any. */
export function takePendingClaim(): ClaimableRole | undefined {
  const claim = pendingClaim;
  pendingClaim = undefined;
  return claim;
}

export function assignRole(contents: WebContents, role: WebContentsRole): void {
  if (roles.has(contents)) {
    throw new Error('A web contents can have only one role');
  }
  roles.set(contents, role);
}

/**
 * A popup window's web contents is created by Chromium, not by us. Measured on Electron 44: the
 * window-open handler returns, then `web-contents-created` fires for the new contents, then
 * `createWindow` runs, all in the same task. So the handler claims `popup` here just before it
 * returns `allow`, and `createWindow` checks the claim landed (`assertPopupContents`). A claim
 * that no contents took (Chromium declined after all) is dropped on the next turn of the event
 * loop, so it can never reach a later, unrelated web contents.
 */
export function claimNextPopupContents(): void {
  pendingClaim = 'popup';
  setImmediate(() => {
    if (pendingClaim === 'popup') {
      pendingClaim = undefined;
    }
  });
}

/**
 * Fails loudly if Chromium's pre-created popup contents didn't get the `popup` role: it would
 * otherwise load with the wrong policy (or `unknown`, which can't navigate at all). The contents
 * is closed first, so it never loads anything.
 */
export function assertPopupContents(contents: WebContents): void {
  if (roles.get(contents) === 'popup') {
    return;
  }
  contents.close();
  throw new Error(
    `A popup's web contents has the role ${roles.get(contents) ?? 'none'}, not popup; refusing it`,
  );
}

/** The only way Veltriva creates a WebContentsView. */
export function createViewWithRole(
  role: ClaimableRole,
  options: WebContentsViewConstructorOptions,
): WebContentsView {
  pendingClaim = role;
  let view: WebContentsView;
  try {
    view = new WebContentsView(options);
  } finally {
    pendingClaim = undefined;
  }
  if (roles.get(view.webContents) !== role) {
    view.webContents.close();
    throw new Error(
      `The web-contents guard did not see the ${role} claim; refusing to use the view`,
    );
  }
  return view;
}
