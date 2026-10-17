// Where a `window.open` (or a link that opens a new tab or window) goes (ADR-0002 §4, assessment
// §3.7 and §6.4). Pure, so the table is unit-tested; ./popup-policy.ts applies it, after the
// gesture check. What Electron reports (spike S7 on 44.7.2; re-measured on 44.9.0 for the
// Phase 1 wrap-up, see ADR-0002 item 9):
//   - left click on target=_blank: `foreground-tab`, pre-created contents, no opener;
//   - Ctrl or middle click: `background-tab`, no opener;
//   - Shift click: `new-window`, no features, no opener;
//   - a form posted to target=_blank: `foreground-tab` with a post body, pre-created contents;
//   - window.open(url, name, 'width=…'): `new-window`, pre-created contents, opener kept
//     (`noopener` drops the opener, not the pre-created contents);
//   - window.open('custom:…'): arrives here, not as `openExternal`.
// Ctrl, middle and Shift clicks had no pre-created contents up to 44.8 and do since 44.9.0
// (electron/electron#55048). Routing doesn't depend on it: they become tabs, and the handler
// denies them before Chromium creates anything.
import { classifyExternalUrl } from '../../core/url/external-protocol';
import { isNavigationAllowed } from '../web/navigation-policy';

export interface WindowOpenRequest {
  readonly url: string;
  readonly disposition: string;
  /** The `features` string of `window.open` (`width=500,height=600`). */
  readonly features: string;
  /** A form posted to a new tab or window. */
  readonly hasPostBody: boolean;
  /** Popup windows open tabs, never further popup windows (assessment §6.4). */
  readonly fromPopupWindow: boolean;
}

export interface PopupSize {
  readonly width: number;
  readonly height: number;
}

export type WindowOpenRoute =
  | { readonly kind: 'deny'; readonly reason: 'invalid-url' | 'refused-scheme' }
  /** Alt+click on a link: download it (the download manager names and places it). */
  | { readonly kind: 'download'; readonly url: string }
  /** Another app's URL: the external-protocol guard decides. */
  | { readonly kind: 'external'; readonly url: string }
  /** A tab that main creates and loads; the pre-created contents (if any) is not used. */
  | { readonly kind: 'tab'; readonly url: string; readonly background: boolean }
  /** A small popup window that hosts Chromium's pre-created contents, opener and all. */
  | { readonly kind: 'popup-window'; readonly url: string; readonly size: PopupSize };

export const DEFAULT_POPUP_SIZE: PopupSize = { width: 500, height: 600 };
const MIN_POPUP_SIZE: PopupSize = { width: 240, height: 180 };
const MAX_POPUP_SIZE: PopupSize = { width: 1200, height: 900 };

export function routeWindowOpen(request: WindowOpenRequest): WindowOpenRoute {
  // window.open() and window.open('') open about:blank, which sign-in libraries then navigate.
  const url = request.url === '' ? 'about:blank' : request.url;
  const external = classifyExternalUrl(url);
  switch (external.kind) {
    case 'invalid':
      return { kind: 'deny', reason: 'invalid-url' };
    case 'blocked':
      // javascript:, data:, file: and the always-blocked schemes.
      return { kind: 'deny', reason: 'refused-scheme' };
    case 'external':
      return { kind: 'external', url };
    case 'browser':
      break;
  }
  // The page a popup or new tab shows must be one a tab could show (no veltriva:, no blob:null).
  if (!isNavigationAllowed('tab', { url, isMainFrame: true })) {
    return { kind: 'deny', reason: 'refused-scheme' };
  }
  switch (request.disposition) {
    case 'background-tab':
      return { kind: 'tab', url, background: true };
    case 'save-to-disk':
      // Alt+click on a link.
      return { kind: 'download', url };
    case 'new-window':
      if (!request.fromPopupWindow && hasWindowFeatures(request.features)) {
        return { kind: 'popup-window', url, size: popupSize(request.features) };
      }
      // Shift+click, or a popup window's own window.open: one window, so a new tab.
      return { kind: 'tab', url, background: false };
    default:
      // A form that posts to a new tab keeps its body only in Chromium's pre-created contents.
      if (request.hasPostBody && !request.fromPopupWindow) {
        return { kind: 'popup-window', url, size: DEFAULT_POPUP_SIZE };
      }
      // foreground-tab, default, other.
      return { kind: 'tab', url, background: false };
  }
}

/** `window.open(url, name, features)` asked for a sized window, or explicitly for a popup. */
function hasWindowFeatures(features: string): boolean {
  const names = parseFeatures(features);
  return names.has('width') || names.has('height') || names.has('popup');
}

/** The requested size, clamped. Position is ignored: popups open centered on the browser. */
export function popupSize(features: string): PopupSize {
  const values = parseFeatures(features);
  return {
    width: clampDimension(
      values.get('width'),
      DEFAULT_POPUP_SIZE.width,
      MIN_POPUP_SIZE.width,
      MAX_POPUP_SIZE.width,
    ),
    height: clampDimension(
      values.get('height'),
      DEFAULT_POPUP_SIZE.height,
      MIN_POPUP_SIZE.height,
      MAX_POPUP_SIZE.height,
    ),
  };
}

/** `width=500, height = 600 ,popup` → width: '500', height: '600', popup: ''. */
function parseFeatures(features: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const part of features.split(',')) {
    const [rawName, ...rest] = part.split('=');
    const name = rawName?.trim().toLowerCase() ?? '';
    if (name !== '') {
      values.set(name, rest.join('=').trim());
    }
  }
  return values;
}

function clampDimension(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) {
    return fallback;
  }
  // Like Chromium, read the leading number ("500px" is 500).
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}
