// The omnibox classifier (assessment §3.6): turns what the user typed into exactly one action.
// Pure and table-tested, including adversarial input (omnibox.test.ts, omnibox.table.test.ts).
// Main runs it on every submission; the shell never decides what a string means.
import { parse as parseDomain } from 'tldts';

import { INTERNAL_SCHEME, TYPEABLE_INTERNAL_PAGES } from './internal-pages';
import type { InternalPage } from './internal-pages';

/** Longer input is cut off before classification. */
export const MAX_OMNIBOX_INPUT = 8192;

export type OmniboxAction =
  | { readonly kind: 'navigate'; readonly url: string }
  | { readonly kind: 'search'; readonly query: string }
  | { readonly kind: 'internal'; readonly page: InternalPage }
  /** Another app's scheme (mailto:, zoommtg:, ...). The external-protocol guard decides (M1.4). */
  | { readonly kind: 'external'; readonly url: string }
  | { readonly kind: 'none' };

// Characters that don't belong in an address and are spoofing tools: C0 and C1 controls
// (newlines and tabs included), the combining grapheme joiner, the Arabic letter mark, Hangul and
// Mongolian fillers, line and paragraph separators, bidirectional embeddings, overrides and
// isolates, zero-width and other invisible format characters, and Unicode tag characters.
const INVISIBLE =
  // Each character is matched on its own, so a combining one in the class misleads no one.
  // eslint-disable-next-line no-control-regex, no-misleading-character-class -- that's the point.
  /[\u0000-\u001f\u007f-\u009f\u034f\u061c\u115f\u1160\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufeff\uffa0\u{e0000}-\u{e007f}]/gu;
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const PORT_AFTER_COLON = /^\d+(?:[/?#]|$)/;
const WINDOWS_DRIVE_PATH = /^[a-z]:[\\/]/i;
const DRIVE_LETTER = /^[a-z]:/i;
/** The only file URLs the omnibox opens: a local drive path, file:///C:/... (no host). */
const LOCAL_DRIVE_PATH = /^\/[a-z]:(?:\/|$)/i;
const BARE_IPV6 = /^[0-9a-f.:]+$/i;
const HIGH_SURROGATE_AT_END = /[\ud800-\udbff]$/;

/** Schemes that are never navigated from the omnibox: the text becomes a search instead. */
const NEVER_NAVIGATED = new Set([
  'javascript',
  'data',
  'vbscript',
  'blob',
  'app',
  'chrome',
  'chrome-error',
  'chrome-extension',
  'chrome-native',
  'chrome-search',
  'chrome-untrusted',
  'chrome-devtools',
  'devtools',
  'filesystem',
  'isolated-app',
  'view-source',
]);

/** Schemes whose "scheme:" prefix is always a scheme, never a host followed by a port. */
const KNOWN_SCHEMES = new Set([
  ...NEVER_NAVIGATED,
  'http',
  'https',
  'about',
  'file',
  INTERNAL_SCHEME,
  'mailto',
  'tel',
  'sms',
  'ftp',
]);

export function sanitizeOmniboxInput(raw: string): string {
  let text = raw.replace(INVISIBLE, '').trim();
  if (text.length > MAX_OMNIBOX_INPUT) {
    text = text.slice(0, MAX_OMNIBOX_INPUT);
    // Don't leave half of a surrogate pair at the cut.
    if (HIGH_SURROGATE_AT_END.test(text)) {
      text = text.slice(0, -1);
    }
  }
  // Lone surrogates (pasted, or left by a cut) would make encodeURIComponent throw.
  return text.toWellFormed().trim();
}

export function classifyOmniboxInput(raw: string): OmniboxAction {
  const input = sanitizeOmniboxInput(raw);
  if (input === '') {
    return { kind: 'none' };
  }
  // "?words" forces a search, as in other browsers.
  if (input.startsWith('?')) {
    const query = input.slice(1).trim();
    return query === '' ? { kind: 'none' } : search(query);
  }
  // A Windows path that starts with a backslash (\\server\share, \\?\C:\x, \dir) is neither a web
  // address nor a file the omnibox opens: see classifyFileUrl.
  if (input.startsWith('\\')) {
    return search(input);
  }
  // A typed Windows path (C:\Users\me\file.pdf) opens the file.
  if (WINDOWS_DRIVE_PATH.test(input)) {
    return classifyWindowsPath(input);
  }
  // A drive letter alone ("C:", "C:Users") is not another app's scheme.
  if (DRIVE_LETTER.test(input)) {
    return search(input);
  }

  const schemeMatch = SCHEME.exec(input);
  const scheme = schemeMatch?.[1]?.toLowerCase();
  if (schemeMatch !== null && scheme !== undefined) {
    if (KNOWN_SCHEMES.has(scheme)) {
      return classifyWithScheme(input, scheme);
    }
    if (looksLikeAppScheme(input, scheme, input.slice(schemeMatch[0].length))) {
      return classifyWithScheme(input, scheme);
    }
  }
  return classifyWithoutScheme(input);
}

function search(query: string): OmniboxAction {
  return { kind: 'search', query };
}

/**
 * Another app's scheme, such as `zoommtg:join?confno=1` or `ms-settings:`. Text with a colon is
 * often something else: words ("tip: buy milk"), a host and port ("intranet:8080", "a.b:"), an
 * IPv6 address ("fe80::1") or code ("std::vector").
 *
 * "user:pass@example.com" stays external: it reads exactly like "xmpp:user@example.com", and only
 * the OS knows which schemes have an app. The external-protocol guard (M1.4) asks it. Treating
 * the text as a search instead would send what may be a password to the search engine.
 */
function looksLikeAppScheme(input: string, scheme: string, rest: string): boolean {
  return (
    !/\s/.test(input) &&
    !scheme.includes('.') &&
    scheme !== 'localhost' &&
    !rest.startsWith(':') &&
    !PORT_AFTER_COLON.test(rest) &&
    !isBareIPv6Like(input)
  );
}

function classifyWithScheme(input: string, scheme: string): OmniboxAction {
  if (NEVER_NAVIGATED.has(scheme)) {
    return search(input);
  }
  switch (scheme) {
    case 'http':
    case 'https': {
      const url = tryParse(input);
      return url === undefined || url.hostname === ''
        ? search(input)
        : { kind: 'navigate', url: withoutCredentials(url) };
    }
    case 'about': {
      const url = tryParse(input);
      return url?.pathname.toLowerCase() === 'blank' && url.search === ''
        ? { kind: 'navigate', url: `about:blank${url.hash}` }
        : search(input);
    }
    case 'file':
      return classifyFileUrl(input, input);
    case INTERNAL_SCHEME:
      return classifyInternalPage(input);
    default: {
      const url = tryParse(input);
      return url === undefined ? search(input) : { kind: 'external', url: url.href };
    }
  }
}

/** `veltriva://<name>`, exactly: no path beyond "/", no query, fragment, port or credentials. */
function classifyInternalPage(input: string): OmniboxAction {
  const url = tryParse(input);
  if (
    url?.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.pathname !== '' && url.pathname !== '/')
  ) {
    return search(input);
  }
  const page = TYPEABLE_INTERNAL_PAGES.get(url.hostname.toLowerCase());
  return page === undefined ? search(input) : { kind: 'internal', page };
}

/**
 * C:\dir\a#1.txt → file:///C:/dir/a%231.txt. "%", "#" and "?" mean something in a URL, so they are
 * escaped to stay part of the file name; the parser escapes everything else (spaces, non-ASCII).
 */
function classifyWindowsPath(input: string): OmniboxAction {
  const path = input.replace(/\\/g, '/').replace(/[%#?]/g, (c) => encodeURIComponent(c));
  return classifyFileUrl(`file:///${path}`, input);
}

/**
 * Only local drive paths open. A file URL with a host (file://server/share), or one whose path
 * Chromium may read as a host (file:////server/share), is a network path: Windows would connect
 * over SMB and may send the user's credentials to that server. Those become searches.
 */
function classifyFileUrl(candidate: string, input: string): OmniboxAction {
  const url = tryParse(candidate);
  return url?.protocol === 'file:' && url.host === '' && LOCAL_DRIVE_PATH.test(url.pathname)
    ? { kind: 'navigate', url: url.href }
    : search(input);
}

function classifyWithoutScheme(input: string): OmniboxAction {
  // Words with spaces are a search.
  if (/\s/.test(input)) {
    return search(input);
  }
  const authority = authorityOf(input);
  // An email address, or a `user@host` / `user:pass@host` trick that hides the real host. An "@"
  // later on (youtube.com/@channel) is just part of the path.
  if (authority.includes('@')) {
    return search(input);
  }
  // A bare IPv6 address needs brackets in a URL; without them it's a search.
  if (isBareIPv6Like(input)) {
    return search(input);
  }
  const url = tryParse(`https://${input}`);
  if (url === undefined || url.hostname === '') {
    return search(input);
  }
  const host = url.hostname;

  // An IPv4 address counts only when typed exactly as the parser reads it. "1.1", "2130706433"
  // and octal "010.0.0.1" (which the parser reads as 8.0.0.1) are searches.
  if (isIPv4(host)) {
    const typedHost = authority.replace(/:\d*$/, '');
    return typedHost === host ? navigateInferred(input, url, isPrivateIPv4(host)) : search(input);
  }
  if (host.startsWith('[')) {
    return navigateInferred(input, url, isPrivateIPv6(host));
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return navigateInferred(input, url, true);
  }
  if (url.port !== '') {
    return navigateInferred(input, url, false);
  }
  // A registrable name under a real (ICANN) public suffix. Private suffixes such as github.io all
  // sit under an ICANN suffix, so ICANN rules alone accept every real host, including github.io.
  const domain = parseDomain(host);
  if (domain.domain !== null && domain.isIcann === true) {
    return navigateInferred(input, url, false);
  }
  return search(input);
}

/**
 * Inferred URLs use https, except localhost and private addresses, which use http (§3.6 step 5).
 * Those are parsed again as http, so a typed port survives: ":443" is https's default port and
 * would otherwise vanish.
 */
function navigateInferred(input: string, https: URL, usePlainHttp: boolean): OmniboxAction {
  if (!usePlainHttp) {
    return { kind: 'navigate', url: https.href };
  }
  const http = tryParse(`http://${input}`);
  return http === undefined ? search(input) : { kind: 'navigate', url: http.href };
}

/** Everything before the first "/", "?", "#" or backslash. */
function authorityOf(input: string): string {
  return input.split(/[/?#\\]/, 1)[0] ?? '';
}

function isBareIPv6Like(input: string): boolean {
  return BARE_IPV6.test(input) && (input.match(/:/g)?.length ?? 0) >= 2;
}

function tryParse(input: string): URL | undefined {
  try {
    return new URL(input);
  } catch {
    return undefined;
  }
}

function withoutCredentials(url: URL): string {
  url.username = '';
  url.password = '';
  return url.href;
}

function isIPv4(host: string): boolean {
  const parts = host.split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** Loopback, private, link-local and carrier-grade NAT ranges. */
export function isPrivateIPv4(host: string): boolean {
  const [a = -1, b = -1] = host.split('.').map(Number);
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/**
 * Loopback, unique-local (fc00::/7), link-local (fe80::/10), the deprecated site-local range
 * (fec0::/10) and IPv4-mapped private addresses (::ffff:192.168.1.1). `host` keeps its brackets.
 */
export function isPrivateIPv6(host: string): boolean {
  const address = host.replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = /^::ffff:(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/.exec(address);
  if (mapped !== null) {
    const [, high, low, dotted] = mapped;
    if (dotted !== undefined) {
      return isPrivateIPv4(dotted);
    }
    const value = (Number.parseInt(high ?? '0', 16) << 16) | Number.parseInt(low ?? '0', 16);
    const octets = [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff);
    return isPrivateIPv4(octets.join('.'));
  }
  // The first group must be four digits: "fe8::1" is 0fe8::1, which is public.
  return (
    address === '::1' || /^f[cd][0-9a-f]{2}:/.test(address) || /^fe[89a-f][0-9a-f]:/.test(address)
  );
}

export const DEFAULT_SEARCH_TEMPLATE = 'https://duckduckgo.com/?q={searchTerms}';
const SEARCH_TERMS = '{searchTerms}';
const PLACEHOLDER = 'veltrivasearchterms';

/**
 * A search template needs `{searchTerms}` in its path, query or fragment (never in the host or
 * credentials, so typed text can't choose where it goes), no whitespace or controls, and https
 * unless it points at this machine.
 */
export function isValidSearchTemplate(template: string): boolean {
  // eslint-disable-next-line no-control-regex -- matching control characters is the point.
  if (!template.includes(SEARCH_TERMS) || /[\s\u0000-\u001f\u007f]/.test(template)) {
    return false;
  }
  const url = tryParse(template.replaceAll(SEARCH_TERMS, PLACEHOLDER));
  if (url === undefined) {
    return false;
  }
  if (`${url.username}:${url.password}@${url.host}`.toLowerCase().includes(PLACEHOLDER)) {
    return false;
  }
  if (url.protocol === 'https:') {
    return true;
  }
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  return url.protocol === 'http:' && loopback;
}

export function buildSearchUrl(template: string, query: string): string {
  if (!isValidSearchTemplate(template)) {
    throw new Error('Invalid search template');
  }
  return template.replaceAll(SEARCH_TERMS, encodeURIComponent(query.toWellFormed()));
}
