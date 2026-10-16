// Which URLs may be handed to another app (ADR-0002 §4, assessment §6.4). Electron would pass any
// scheme it can't load straight to Windows, with no prompt. Veltriva launches only a URL that
// passes here, and only after a gesture and the user's yes (src/main/external/protocol-guard.ts).
// Pure, so the rules are unit-tested.

/**
 * Schemes never launched, whatever the user says: the Follina-class remote-execution vectors
 * (assessment §6.4), plus the ones Chrome itself never hands to the OS (`shell:` opens Explorer
 * locations, `hcp:` the old Help Center, and so on).
 */
export const BLOCKED_EXTERNAL_SCHEMES: ReadonlySet<string> = new Set([
  'ms-msdt',
  'search-ms',
  'search',
  'ms-officecmd',
  'ms-cxh',
  'ms-cxh-full',
  'ms-appinstaller',
  'vbscript',
  'javascript',
  'jar',
  'file',
  // Chrome's always-denied list.
  'afp',
  'data',
  'disk',
  'disks',
  'hcp',
  'ie.http',
  'ms-help',
  'nntp',
  'res',
  'shell',
  'view-source',
  'vnd.ms.radio',
]);

/** Schemes the browser itself loads (or deliberately never loads). None is another app's. */
const BROWSER_SCHEMES: ReadonlySet<string> = new Set([
  'http',
  'https',
  'about',
  'blob',
  'ws',
  'wss',
  'filesystem',
  'chrome',
  'chrome-extension',
  'chrome-untrusted',
  'devtools',
  'app',
  'veltriva',
]);

/**
 * The longest URL launched. Electron quotes the URL for Windows and refuses anything over 2048
 * characters with the quotes, like Chrome; this keeps the escaped URL under that.
 */
export const MAX_EXTERNAL_URL_LENGTH = 2046;

export type ExternalUrlVerdict =
  /** Another app's URL, escaped and ready to launch once the user agrees. */
  | { readonly kind: 'external'; readonly scheme: string; readonly url: string }
  /** A scheme that is never launched. */
  | { readonly kind: 'blocked'; readonly scheme: string }
  /** The browser's own scheme: not a question for another app. */
  | { readonly kind: 'browser'; readonly scheme: string }
  /** Unparsable, or too long once escaped. */
  | { readonly kind: 'invalid' };

/** Characters a launched URL keeps; Chrome percent-encodes the rest before handing it to Windows. */
const KEPT = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]$/;

export function classifyExternalUrl(raw: string): ExternalUrlVerdict {
  // Long input can't produce a short enough URL; don't parse megabytes for nothing.
  if (raw.length > MAX_EXTERNAL_URL_LENGTH * 4) {
    return { kind: 'invalid' };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { kind: 'invalid' };
  }
  // The parser lowercases the scheme and keeps only [a-z0-9+.-].
  const scheme = parsed.protocol.slice(0, -1);
  if (BLOCKED_EXTERNAL_SCHEMES.has(scheme)) {
    return { kind: 'blocked', scheme };
  }
  if (BROWSER_SCHEMES.has(scheme)) {
    return { kind: 'browser', scheme };
  }
  const url = escapeForLaunch(parsed.href);
  if (url === undefined || url.length > MAX_EXTERNAL_URL_LENGTH) {
    return { kind: 'invalid' };
  }
  return { kind: 'external', scheme, url };
}

/** Spaces, quotes, `<>\^`{|}`, controls and non-ASCII become %XX, so Windows sees one argument. */
function escapeForLaunch(href: string): string | undefined {
  let escaped = '';
  try {
    for (const char of href) {
      escaped += KEPT.test(char) ? char : encodeURIComponent(char);
    }
  } catch {
    // A lone surrogate; the URL parser never leaves one, but don't launch if it did.
    return undefined;
  }
  return escaped;
}
