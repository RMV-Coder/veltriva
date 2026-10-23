// Which network a host is on, for the requests main makes on a page's behalf (threat T5). Main
// fetches page-declared favicons itself, as browser-initiated requests, and those skip Chromium's
// local-network-access checks (which pages are denied). Without this, any web page could make
// main send requests into the user's local network or to services on this machine. Pure.
//
// Names are classified as written. A public name that resolves to a private address is caught by
// the resolved-address check below (M6.1), which main runs before each request with the browsing
// session's own resolver. What stays open is true DNS rebinding: a name whose answer changes
// between that check and the request's own lookup. That residual risk is recorded under T5.

/**
 * - `loopback`: this machine (127.0.0.0/8, 0.0.0.0/8, ::1, ::, localhost and *.localhost).
 * - `private`: private and shared networks (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7,
 *   fec0::/10).
 * - `link-local`: 169.254/16, fe80::/10.
 * - `local-name`: names only a local resolver knows: single labels (`intranet`) and the `.local`
 *   (mDNS), `.internal`, `.home.arpa` and `.lan` suffixes.
 * - `public`: everything else.
 */
export type HostClass = 'loopback' | 'private' | 'link-local' | 'local-name' | 'public';

const LOCAL_NAME_SUFFIXES = ['.local', '.internal', '.home.arpa', '.lan'] as const;

/**
 * Classifies a host. It is parsed the way a URL parser would first, so `127.1`, `0x7f.0.0.1`,
 * `[::FFFF:127.0.0.1]` and `LOCALHOST.` are all recognized for what they are.
 */
export function classifyHost(host: string): HostClass {
  const canonical = canonicalHost(host);
  if (canonical === undefined) {
    // Not a valid host at all: never treat it as public.
    return 'local-name';
  }
  if (canonical.startsWith('[')) {
    const groups = parseIPv6(canonical.slice(1, -1));
    return groups === undefined ? 'local-name' : classifyIPv6(groups);
  }
  const v4 = parseIPv4(canonical);
  if (v4 !== undefined) {
    return classifyIPv4(v4);
  }
  const name = canonical.endsWith('.') ? canonical.slice(0, -1) : canonical;
  if (name === 'localhost' || name.endsWith('.localhost')) {
    return 'loopback';
  }
  if (!name.includes('.') || LOCAL_NAME_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    return 'local-name';
  }
  return 'public';
}

/**
 * Whether main may fetch `faviconUrl` for the page at `pageUrl`, judging its host as written.
 * Inline `data:` favicons need no request. A favicon on a public host is fine. A favicon on a
 * local host is allowed only for a page whose own host is in the same class (a router's admin
 * page may show its own icon), so a public page can never use one to reach into the local
 * network. With `pageAddresses`, what the page's host resolved to widens that as `addressReach`
 * says (M6.1). Main also checks what the favicon's host resolves to (`areAddressesWithinReach`).
 */
export function isFaviconUrlAllowed(
  faviconUrl: string,
  pageUrl: string,
  pageAddresses: readonly string[] = [],
): boolean {
  const favicon = tryParse(faviconUrl);
  if (favicon === undefined) {
    return false;
  }
  if (favicon.protocol === 'data:') {
    return true;
  }
  if (favicon.protocol !== 'http:' && favicon.protocol !== 'https:') {
    return false;
  }
  return addressReach(pageUrl, pageAddresses).has(classifyHost(favicon.hostname));
}

/**
 * The host of the page at `pageUrl` (the creator's for a `blob:` page), as the URL parser writes
 * it, or undefined for a page with no web host.
 */
export function pageHost(pageUrl: string): string | undefined {
  return webOrigin(pageUrl)?.hostname;
}

/** A host as a resolver takes it: an IPv6 literal without its brackets. */
export function resolvableHost(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/**
 * The classes of address main may reach on behalf of the page at `pageUrl` (M6.1): public ones,
 * the class of the page's host as written, and the classes its host resolved to
 * (`pageAddresses`) if none of them is public. So an intranet page whose public-looking name
 * resolves to 10.0.0.5 may use an icon there, while a name with both a public and a private
 * record opens nothing local.
 */
export function addressReach(
  pageUrl: string,
  pageAddresses: readonly string[],
): ReadonlySet<HostClass> {
  const reach = new Set<HostClass>(['public']);
  const host = pageHost(pageUrl);
  if (host === undefined) {
    return reach;
  }
  reach.add(classifyHost(host));
  const resolved = pageAddresses.map(classifyHost);
  if (!resolved.includes('public')) {
    for (const kind of resolved) {
      reach.add(kind);
    }
  }
  return reach;
}

/**
 * Whether every address a host resolved to is within `reach` (M6.1). No addresses (the name
 * didn't resolve) means no: the request would fail anyway, and nothing is sent.
 */
export function areAddressesWithinReach(
  addresses: readonly string[],
  reach: ReadonlySet<HostClass>,
): boolean {
  return addresses.length > 0 && addresses.every((address) => reach.has(classifyHost(address)));
}

/** The http(s) URL a page's host comes from: its own, or the creator's for a blob: page. */
function webOrigin(pageUrl: string): URL | undefined {
  const page = tryParse(pageUrl);
  if (page?.protocol === 'blob:') {
    return webOrigin(page.origin);
  }
  return page?.protocol === 'http:' || page?.protocol === 'https:' ? page : undefined;
}

/** The host as the URL parser serializes it: lowercase, IPv4 in dotted decimal, IPv6 bracketed. */
function canonicalHost(host: string): string | undefined {
  const bare = host.trim();
  if (bare === '') {
    return undefined;
  }
  const bracketed = bare.includes(':') && !bare.startsWith('[') ? `[${bare}]` : bare;
  return tryParse(`http://${bracketed}/`)?.hostname;
}

function tryParse(input: string): URL | undefined {
  try {
    return new URL(input);
  } catch {
    return undefined;
  }
}

/** Dotted decimal only (the parser's canonical form), as an unsigned 32-bit number. */
function parseIPv4(text: string): number | undefined {
  const parts = text.split('.');
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) {
    return undefined;
  }
  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) {
    return undefined;
  }
  return octets.reduce((value, octet) => value * 256 + octet, 0);
}

function classifyIPv4(address: number): HostClass {
  const a = Math.floor(address / 2 ** 24);
  const b = Math.floor(address / 2 ** 16) % 256;
  if (a === 127 || a === 0) {
    return 'loopback';
  }
  if (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  ) {
    return 'private';
  }
  if (a === 169 && b === 254) {
    return 'link-local';
  }
  return 'public';
}

/** The eight 16-bit groups of an IPv6 address (without brackets), or undefined if it isn't one. */
function parseIPv6(address: string): number[] | undefined {
  let text = address.toLowerCase();
  // A trailing dotted IPv4 (::ffff:192.168.1.1) is two more groups.
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted !== null) {
    const v4 = parseIPv4(dotted[2] ?? '');
    if (v4 === undefined) {
      return undefined;
    }
    const high = Math.floor(v4 / 2 ** 16).toString(16);
    const low = (v4 % 2 ** 16).toString(16);
    text = `${dotted[1] ?? ''}${high}:${low}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) {
    return undefined;
  }
  const head = parseGroups(halves[0] ?? '');
  const tail = parseGroups(halves[1] ?? '');
  if (head === undefined || tail === undefined) {
    return undefined;
  }
  if (halves.length === 1) {
    return head.length === 8 ? head : undefined;
  }
  const missing = 8 - head.length - tail.length;
  return missing < 1 ? undefined : [...head, ...Array<number>(missing).fill(0), ...tail];
}

function parseGroups(part: string): number[] | undefined {
  if (part === '') {
    return [];
  }
  const groups: number[] = [];
  for (const group of part.split(':')) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) {
      return undefined;
    }
    groups.push(Number.parseInt(group, 16));
  }
  return groups;
}

function classifyIPv6(groups: readonly number[]): HostClass {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const embeddedV4 = g6 * 2 ** 16 + g7;
  const firstSixZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0;
  if (firstSixZero && g6 === 0 && (g7 === 0 || g7 === 1)) {
    // :: (unspecified) and ::1.
    return 'loopback';
  }
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    // IPv4-mapped, ::ffff:a.b.c.d.
    return classifyIPv4(embeddedV4);
  }
  if (firstSixZero) {
    // The deprecated IPv4-compatible form, ::a.b.c.d.
    return classifyIPv4(embeddedV4);
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    // NAT64, 64:ff9b::a.b.c.d: the IPv4 address it reaches.
    return classifyIPv4(embeddedV4);
  }
  if ((g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfec0) {
    return 'private';
  }
  if ((g0 & 0xffc0) === 0xfe80) {
    return 'link-local';
  }
  return 'public';
}
