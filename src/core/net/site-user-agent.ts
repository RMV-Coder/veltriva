// A per-site user agent, the last resort of assessment §3.7, for Google's sign-in only.
// With honest client hints (./client-hints.ts) Google still answered the first sign-in with
// "Couldn't sign you in: This browser or app may not be secure"; "Try again" then let the user in
// (manual check M1, 2026-10-19). Min browser has long sent a Firefox user agent to
// accounts.google.com for the same reason (minbrowser/min#868), and Veltriva does what Min does:
//   - only the `User-Agent` request header, only on requests to accounts.google.com itself;
//   - client hints and `navigator.userAgent` stay Chromium's, as in Min;
//   - every other host, Google's other hosts included, gets Veltriva's own user agent.
// Pure, so the host rule and the version estimate are unit-tested.

/** The hosts that get the Firefox user agent. Exact names: no subdomains, no other Google hosts. */
export const FIREFOX_USER_AGENT_HOSTS: ReadonlySet<string> = new Set(['accounts.google.com']);

/** Firefox 158 was released on 2026-10-13 (product-details.mozilla.org, read 2026-10-19). */
const ANCHOR_VERSION = 158;
const ANCHOR_RELEASE = Date.UTC(2026, 9, 13);
/**
 * Firefox ships every 4 weeks, with holiday delays. Counting 4.1 weeks per release keeps the
 * estimate at or just behind the real latest version, never at one that isn't out yet (Min's rule).
 */
const RELEASE_INTERVAL_MS = 4.1 * 7 * 24 * 60 * 60 * 1000;

/** A recent, released Firefox version for `now`, estimated from the release cadence. */
export function firefoxVersion(now: number): number {
  const releases = Math.floor((now - ANCHOR_RELEASE) / RELEASE_INTERVAL_MS);
  return ANCHOR_VERSION + Math.max(0, releases);
}

/** Firefox's own user agent on 64-bit Windows, for `now`. */
export function firefoxUserAgent(now: number): string {
  const version = `${String(firefoxVersion(now))}.0`;
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${version}) Gecko/20100101 Firefox/${version}`;
}

/** The user agent a request to `url` must carry instead of the default, or null to keep it. */
export function userAgentOverride(url: string, now: number): string | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  return FIREFOX_USER_AGENT_HOSTS.has(host) ? firefoxUserAgent(now) : null;
}
