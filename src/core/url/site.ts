// A page's site, for the user's site protection (assessment §4.10 "Protected site", M3.4): the
// registrable domain of its host, so protecting mail.example.co.uk protects every page of
// example.co.uk, as the memory groups visits (hygiene.ts). A host with no registrable domain
// (localhost, an IP address, a single-label name) is its own site. Only http(s) pages have one.
import { getDomain } from 'tldts';

/** Sites are stored in the site_rules table (M5.1); no real host name is longer. */
export const MAX_SITE_LENGTH = 253;

/** The site of a page's address, or null when it has none (not http(s), unparsable). */
export function siteOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host === '' || host.length > MAX_SITE_LENGTH) {
    return null;
  }
  return getDomain(host, { allowPrivateDomains: true }) ?? host;
}

/** What a stored site looks like: lower case, a host name's characters (IPv6 in brackets). */
const SITE_PATTERN = /^[a-z0-9.\-[\]:]+$/;
/** Longer than any address worth reading: what the user typed is checked no further. */
const MAX_SITE_INPUT = 2048;

/**
 * The site of what the user typed into the site rules' field (M5.1): a host name ("mail.example.com"
 * is example.com's, and so is "*.example.com"), an address, or a site. Null when it names none.
 * Nothing with `@` is a site: "mailto:me@example.com" would otherwise read as credentials and a host.
 */
export function siteFromInput(text: string): string | null {
  const trimmed = text.trim().replace(/^\*\./, '');
  if (trimmed === '' || trimmed.length > MAX_SITE_INPUT || /[\s@]/.test(trimmed)) {
    return null;
  }
  const site = siteOf(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  return site !== null && SITE_PATTERN.test(site) ? site : null;
}
