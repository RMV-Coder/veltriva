// Which navigations each role may make (ADR-0002, assessment §6.4). Pure, so the table is
// unit-tested directly. Used for `will-navigate`, `will-frame-navigate` and `will-redirect`.
import type { WebContentsRole } from './web-contents-role';

/** Chromium's built-in PDF viewer. Blocking its frame renders PDFs blank (spike S7). Re-check the ID on every Electron upgrade. */
export const PDF_VIEWER_EXTENSION_ID = 'mhjfbmdgcfjbbpaeojofohoefgiehjai';

export interface NavigationTarget {
  readonly url: string;
  readonly isMainFrame: boolean;
}

export function isNavigationAllowed(role: WebContentsRole, target: NavigationTarget): boolean {
  switch (role) {
    case 'tab':
    case 'popup':
      return isWebNavigationAllowed(target);
    case 'devtools':
      // Electron manages DevTools; it is never wired to this policy.
      return true;
    case 'shell':
    case 'unknown':
      return false;
  }
}

function isWebNavigationAllowed({ url: raw, isMainFrame }: NavigationTarget): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  switch (url.protocol) {
    case 'http:':
    case 'https:':
      return true;
    case 'about:':
      // `about:srcdoc` is how `<iframe srcdoc>` documents load; it only exists in subframes.
      return url.pathname === 'blank' || (!isMainFrame && url.pathname === 'srcdoc');
    case 'data:':
      // Like Chrome: data: frames load, but a page can't navigate a tab to a data: document
      // (a phishing vector, since the address bar would show attacker-chosen content).
      return !isMainFrame;
    case 'blob:':
      // A blob: document keeps its creator's origin. Sites show generated files (reports,
      // previews) in frames or in place. A tab only shows one whose origin the address bar can
      // name: an opaque one ("blob:null/...", made by a sandboxed or data: frame) would, like
      // data:, put content on screen under no site's name.
      return !isMainFrame || /^https?:\/\//.test(url.origin);
    case 'chrome-extension:':
      return !isMainFrame && url.host === PDF_VIEWER_EXTENSION_ID;
    default:
      // veltriva:, app:, file:, javascript: and every external scheme. The external-protocol
      // guard (M1.4) will route some of these to a prompt.
      return false;
  }
}
