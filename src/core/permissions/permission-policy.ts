// The permission broker's rules (ADR-0002 §4, assessment §6.4). Electron forwards about 46
// Chromium permission types and grants all of them unless told otherwise, so this is an
// allow-list: anything not named here is denied. Pure, so every rule is unit-tested; the broker
// (src/main/permissions/permission-broker.ts) applies them and keeps the user's decisions.
import { classifyHost } from '../url/local-network';

/** What a prompt can ask for. `media` requests become camera and microphone. */
export const PROMPTED_PERMISSIONS = [
  'camera',
  'microphone',
  'geolocation',
  'notifications',
  'clipboard-read',
] as const;

export type PromptedPermission = (typeof PROMPTED_PERMISSIONS)[number];

/** Who asks: a tab's page, a popup window's page, or anything else (denied outright). */
export type RequesterRole = 'tab' | 'popup' | 'other';

export interface PermissionRequest {
  /** Electron's permission name: `media`, `geolocation`, `openExternal` and so on. */
  readonly permission: string;
  /** For `media`: `video` and/or `audio`. */
  readonly mediaTypes?: readonly string[];
  /** The requesting frame's origin (`https://a.example`). */
  readonly requestingOrigin: string;
  /** The origin of the page in the tab's address bar. */
  readonly topOrigin: string;
  readonly role: RequesterRole;
}

export type RequestVerdict =
  | { readonly kind: 'grant' }
  | { readonly kind: 'deny'; readonly reason: DenyReason }
  | {
      readonly kind: 'prompt';
      readonly origin: string;
      readonly permissions: readonly PromptedPermission[];
    }
  /** `openExternal`: the external-protocol guard decides, never the permission broker. */
  | { readonly kind: 'external' };

export type DenyReason =
  | 'not-a-page'
  | 'not-on-allow-list'
  | 'no-fullscreen-notice'
  | 'popup-window'
  | 'cross-origin-frame'
  | 'insecure-origin';

/** Granted to pages without a prompt, as Chrome does (M1.3a, M1.3b). */
function isGrantedWithoutPrompt(permission: string, role: RequesterRole): boolean {
  switch (permission) {
    case 'clipboard-sanitized-write':
      // A site's copy button. Writing sanitized text is harmless; reading needs a prompt.
      return true;
    case 'fullscreen':
      // Tabs only: their fullscreen gets the origin notice (threat T6). Popup windows have none.
      return role === 'tab';
    default:
      return false;
  }
}

/**
 * Pointer lock (`pointerLock`) and keyboard lock stay denied: a hidden, captured pointer helps a
 * page pass itself off as the desktop (threat T6), and Veltriva shows no notice for them yet.
 */
export function classifyRequest(request: PermissionRequest): RequestVerdict {
  if (request.permission === 'openExternal') {
    return { kind: 'external' };
  }
  if (request.role === 'other') {
    return deny('not-a-page');
  }
  if (isGrantedWithoutPrompt(request.permission, request.role)) {
    return { kind: 'grant' };
  }
  if (request.permission === 'fullscreen') {
    return deny('no-fullscreen-notice');
  }
  const permissions = promptedPermissions(request.permission, request.mediaTypes);
  if (permissions === undefined) {
    return deny('not-on-allow-list');
  }
  // Popup windows (sign-in, payment) don't ask for devices; their prompt would have nowhere
  // trusted to appear yet.
  if (request.role !== 'tab') {
    return deny('popup-window');
  }
  // An embedded page from another site never prompts in the name of the site the user sees.
  if (request.requestingOrigin !== request.topOrigin) {
    return deny('cross-origin-frame');
  }
  if (!isPromptableOrigin(request.topOrigin)) {
    return deny('insecure-origin');
  }
  return { kind: 'prompt', origin: request.topOrigin, permissions };
}

export interface PermissionCheck {
  readonly permission: string;
  /** For `media` checks: `video`, `audio` or `unknown`. */
  readonly mediaType?: string;
  readonly requestingOrigin: string;
  readonly topOrigin: string;
  readonly role: RequesterRole;
}

/**
 * The synchronous check (`navigator.permissions.query`, `Notification.permission`). It must agree
 * with what a request would get: granted only without a prompt, or after the user allowed it.
 */
export function isPermissionGranted(
  check: PermissionCheck,
  decisionOf: (origin: string, permission: PromptedPermission) => Decision | undefined,
): boolean {
  if (check.role === 'other') {
    return false;
  }
  if (isGrantedWithoutPrompt(check.permission, check.role)) {
    return true;
  }
  const permissions = promptedPermissions(
    check.permission,
    check.mediaType === undefined ? undefined : [check.mediaType],
  );
  if (
    permissions === undefined ||
    check.role !== 'tab' ||
    check.requestingOrigin !== check.topOrigin ||
    !isPromptableOrigin(check.topOrigin)
  ) {
    return false;
  }
  return permissions.every((permission) => decisionOf(check.topOrigin, permission) === 'allow');
}

function promptedPermissions(
  permission: string,
  mediaTypes: readonly string[] | undefined,
): PromptedPermission[] | undefined {
  switch (permission) {
    case 'media': {
      const types = mediaTypes ?? [];
      const asked: PromptedPermission[] = [];
      if (types.includes('video')) {
        asked.push('camera');
      }
      if (types.includes('audio')) {
        asked.push('microphone');
      }
      return asked.length === 0 ? undefined : asked;
    }
    case 'geolocation':
    case 'notifications':
    case 'clipboard-read':
      return [permission];
    default:
      return undefined;
  }
}

/**
 * Only an origin the user can be shown and that Chromium considers secure: `https:`, or `http:`
 * on this machine (Chromium's "potentially trustworthy" loopback). Chromium already refuses these
 * APIs elsewhere; this keeps a decision from ever being stored for an origin like `null`.
 */
export function isPromptableOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin) {
    return false;
  }
  return (
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && classifyHost(url.hostname) === 'loopback')
  );
}

/** A URL's origin, or `null` for one that has none (`about:blank`, `data:`, `file:`). */
export function originOf(raw: string): string | null {
  try {
    const origin = new URL(raw).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

export type Decision = 'allow' | 'block';

function deny(reason: DenyReason): RequestVerdict {
  return { kind: 'deny', reason };
}
