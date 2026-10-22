// A page's site, for the user's site protection (assessment §4.10 "Protected site", M3.4): the
// registrable domain of its host, so protecting mail.example.co.uk protects every page of
// example.co.uk, as the memory groups visits (hygiene.ts). A host with no registrable domain
// (localhost, an IP address, a single-label name) is its own site. Only http(s) pages have one.
import { getDomain } from 'tldts';

/** Sites are stored in the settings document; no real host name is longer. */
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
