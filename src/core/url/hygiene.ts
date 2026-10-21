// URL hygiene for the memory (assessment §5.7): what a history entry is keyed by, what it shows,
// and what is never recorded. Pure, so the rules are unit-tested; the history recorder applies
// them before anything reaches the database.
//
//   - Identity (`urlKey`): lowercase scheme and host and no default port (the URL parser does
//     those), no fragment, and no tracking parameters (utm_*, fbclid, gclid, ...), so one page is
//     one row however it was linked.
//   - Display and search (`url`): the address minus parameters that look like credentials
//     (token, access_token, password, signatures, X-Amz-*, `code` beside `state`, ...) and minus
//     a fragment that carries a token. Everything else stays, fragment included.
//   - Never recorded: anything but http: and https:, an address with a username or password in
//     it, and OAuth callbacks (a `code` + `state` query, or a token in the fragment): their
//     addresses are one-time credentials, not places to go back to.
import { getDomain } from 'tldts';

import { stripTokenFragment } from '../session/history';

/** The same limit as everything else Veltriva stores (src/shared/contracts/data-rpc.ts). */
const MAX_URL = 65_536;

/** Tracking parameters: they say how someone arrived, not where. Compared in lowercase. */
const TRACKING_PARAMETERS: ReadonlySet<string> = new Set([
  'fbclid',
  'gclid',
  'gclsrc',
  'dclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'yclid',
  'twclid',
  'ttclid',
  'li_fat_id',
  'igshid',
  'mc_cid',
  'mc_eid',
  '_ga',
  '_gl',
  '_hsenc',
  '_hsmi',
  'mkt_tok',
  'oly_anon_id',
  'oly_enc_id',
  'vero_id',
  'rb_clickid',
  's_cid',
  'ref_src',
]);
const TRACKING_PREFIXES = ['utm_', 'pk_', 'hsa_'] as const;

/** Parameters that carry a credential. Compared in lowercase. */
const SECRET_PARAMETERS: ReadonlySet<string> = new Set([
  'token',
  'access_token',
  'id_token',
  'refresh_token',
  'auth',
  'auth_token',
  'authorization',
  'password',
  'passwd',
  'pwd',
  'secret',
  'client_secret',
  'api_key',
  'apikey',
  'key',
  'session',
  'sessionid',
  'sid',
  'sig',
  'signature',
  'otp',
  'ticket',
  'jwt',
]);
const SECRET_PREFIXES = ['x-amz-', 'x-goog-'] as const;

export interface HistoryUrl {
  /** The page's identity in the memory: one row per key. */
  readonly urlKey: string;
  /** What the memory shows and searches. */
  readonly url: string;
  readonly host: string;
  /** The registrable domain (eTLD+1, private suffixes included); the host for IPs and the like. */
  readonly site: string;
}

/** The page as the memory records it, or null if it must not be recorded at all. */
export function historyUrl(raw: string): HistoryUrl | null {
  if (raw.length === 0 || raw.length > MAX_URL) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '') {
    return null;
  }
  if (url.username !== '' || url.password !== '' || isOAuthCallback(url)) {
    return null;
  }

  const shown = without(url, (name) => isSecret(name, url.searchParams));
  const identity = without(shown, isTracking);
  identity.hash = '';

  const host = url.hostname;
  return {
    urlKey: identity.href,
    url: stripTokenFragment(shown.href),
    host,
    site: getDomain(host, { allowPrivateDomains: true }) ?? host,
  };
}

/**
 * An address to keep on file that is not a history entry (a download's source, §5.7): http(s)
 * without credentials, secret parameters or a token fragment; a `blob:` address as it is; for
 * anything else (`data:` above all, whose address is the content) only the scheme. '' if it
 * can't be parsed.
 */
export function withoutSecrets(raw: string): string {
  if (raw.length > MAX_URL) {
    return '';
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }
  if (url.protocol === 'blob:') {
    return url.href;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return url.protocol;
  }
  url.username = '';
  url.password = '';
  return stripTokenFragment(without(url, (name) => isSecret(name, url.searchParams)).href);
}

/**
 * The URL without the query parameters `drop` picks, as a new URL. Deleting re-serializes the
 * whole query, so the URL is only rebuilt when something actually goes.
 */
function without(url: URL, drop: (name: string) => boolean): URL {
  const copy = new URL(url.href);
  const names = [...new Set(copy.searchParams.keys())].filter(drop);
  if (names.length === 0) {
    return copy;
  }
  for (const name of names) {
    copy.searchParams.delete(name);
  }
  if (copy.search === '?') {
    copy.search = ''; // A `?` alone, left when every parameter went.
  }
  return copy;
}

/**
 * An OAuth (or OpenID) callback: the authorization server sends the browser back with a one-time
 * `code` and the `state` it was given, or with a token in the fragment (the implicit flow).
 */
export function isOAuthCallback(url: URL): boolean {
  const query = url.searchParams;
  if (query.has('code') && query.has('state')) {
    return true;
  }
  if (query.has('id_token') || query.has('access_token')) {
    return true;
  }
  // The fragment as parameters: `#access_token=…`, or after a hash route, `#/cb?code=…&state=…`.
  const hash = url.hash.slice(1);
  const question = hash.indexOf('?');
  const fragment = new URLSearchParams(question === -1 ? hash : hash.slice(question + 1));
  return (
    fragment.has('access_token') ||
    fragment.has('id_token') ||
    (fragment.has('code') && fragment.has('state'))
  );
}

function isTracking(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    TRACKING_PARAMETERS.has(lower) || TRACKING_PREFIXES.some((prefix) => lower.startsWith(prefix))
  );
}

function isSecret(name: string, query: URLSearchParams): boolean {
  const lower = name.toLowerCase();
  if (SECRET_PARAMETERS.has(lower) || SECRET_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return true;
  }
  // `code` alone is often harmless (a product code); beside `state` it is an OAuth grant.
  return lower === 'code' && query.has('state');
}
