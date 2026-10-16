// What the address bar shows for a committed URL (assessment §3.6 step 8). Pure. The address bar
// never shows page-controlled text: only the URL, rebuilt from its parsed parts.

export type SecurityState = 'secure' | 'not-secure' | 'local' | 'internal' | 'neutral';

export interface UrlDisplay {
  /** The address-bar text: the URL without credentials, its host in punycode. */
  readonly text: string;
  readonly security: SecurityState;
  /** The URL carried `user:pass@`, which was removed; the shell warns. */
  readonly hadCredentials: boolean;
}

/** Long URLs are cut here (a data-heavy query string can be megabytes). */
export const MAX_DISPLAY_LENGTH = 2048;

export function displayUrl(raw: string): UrlDisplay {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { text: '', security: 'neutral', hadCredentials: false };
  }
  const hadCredentials = url.username !== '' || url.password !== '';
  url.username = '';
  url.password = '';
  // The URL parser already stores hosts in punycode (`xn--...`), which defeats homograph tricks.
  const text =
    url.href.length > MAX_DISPLAY_LENGTH ? `${url.href.slice(0, MAX_DISPLAY_LENGTH)}…` : url.href;
  return { text, security: securityOf(url), hadCredentials };
}

function securityOf(url: URL): SecurityState {
  switch (url.protocol) {
    case 'https:':
      return 'secure';
    case 'http:':
      return 'not-secure';
    case 'file:':
      return 'local';
    case 'veltriva:':
      return 'internal';
    case 'blob:':
      // A blob: document has the origin of the page that made it, and that origin's security.
      // Any other origin ("null": file:, opaque) has no http(s) state to inherit.
      return /^https?:\/\//.test(url.origin) ? securityOf(new URL(url.origin)) : 'neutral';
    default:
      return 'neutral';
  }
}
