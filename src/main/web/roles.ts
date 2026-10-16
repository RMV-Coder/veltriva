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
