// Fetches favicons for the shell (threat T5). Requests go through the browsing session, like the
// page's own requests; the body is read only up to 64 KB, and the result is used only if its
// bytes are a raster image (core/net/favicon-format.ts). Results are cached per URL. Nothing about a
// favicon ever reaches the page, and failures are silent: the shell shows a generic icon.
//
// These are browser-initiated requests, which skip Chromium's local-network-access checks, so a
// page could name a favicon on this machine or the local network to make main request it. So,
// before every request (src/core/url/local-network.ts):
// - a URL on a local host is refused unless the page itself is on the same kind of host;
// - the host is resolved with the browsing session's resolver, and refused if any address it
//   resolves to is local where the page isn't (M6.1: a public name for 127.0.0.1 is caught);
// - a redirect is never followed blindly: each hop is a new request that passes both checks
//   again (M6.1; measured on Electron 45, `session.fetch` followed a redirect into 127.0.0.2).
// What stays open is true DNS rebinding, an answer that changes between the check and the
// request's own lookup (threat T5).
import {
  addressReach,
  areAddressesWithinReach,
  isFaviconUrlAllowed,
  pageHost,
  resolvableHost,
} from '../../core/url/local-network';
import type { HostClass } from '../../core/url/local-network';
import type { Logger } from '../platform/logger';
import { decodeDataUrl, faviconDataUrl, MAX_FAVICON_BYTES } from '../../core/net/favicon-format';

const TIMEOUT_MS = 10_000;
const CACHE_SIZE = 256;
/** Redirects followed, each checked like the first request; Chromium's own limit is 20. */
export const MAX_FAVICON_REDIRECTS = 5;
const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * One request that follows no redirect: a redirect comes back as its 3xx status with the target,
 * already resolved against the request's URL, in `Location`.
 */
export type FaviconFetch = (
  url: string,
  init: { readonly signal: AbortSignal },
) => Promise<Response>;

/** The addresses a host resolves to through the browsing session; empty when it doesn't. */
export type HostResolve = (host: string) => Promise<readonly string[]>;

/** The page a favicon is for, and the network it may make main reach. */
interface PageNetwork {
  readonly url: string;
  /** What the page's host resolved to; empty if it didn't, or wasn't looked up. */
  readonly addresses: readonly string[];
  readonly reach: ReadonlySet<HostClass>;
}

export interface FaviconService {
  /**
   * The first usable favicon among the candidates of the page at `pageUrl`, as a `data:` URL, or
   * null. Candidates on local hosts that the page may not reach are skipped.
   */
  resolve(candidates: readonly string[], pageUrl: string): Promise<string | null>;
}

export function createFaviconService(
  fetchFavicon: FaviconFetch,
  resolveHost: HostResolve,
  logger: Logger,
): FaviconService {
  const cache = new Map<string, Promise<string | null>>();

  const addresses = async (host: string): Promise<readonly string[]> => {
    try {
      return await resolveHost(resolvableHost(host));
    } catch {
      return [];
    }
  };

  /** Whether main may send a request for `url` on behalf of the page (both checks above). */
  const mayRequest = async (url: string, page: PageNetwork): Promise<boolean> => {
    if (!/^https?:/i.test(url) || !isFaviconUrlAllowed(url, page.url, page.addresses)) {
      return false;
    }
    return areAddressesWithinReach(await addresses(new URL(url).hostname), page.reach);
  };

  const load = async (url: string, page: PageNetwork): Promise<string | null> => {
    if (url.startsWith('data:')) {
      const bytes = decodeDataUrl(url);
      return (bytes === undefined ? undefined : faviconDataUrl(bytes)) ?? null;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, TIMEOUT_MS);
    try {
      let target = url;
      for (let redirects = 0; ; redirects += 1) {
        if (!(await mayRequest(target, page))) {
          logger.warn('favicon.localNetworkRefused', { redirects });
          return null;
        }
        const response = await fetchFavicon(target, { signal: controller.signal });
        if (REDIRECTS.has(response.status)) {
          const location = response.headers.get('location');
          if (location === null || redirects === MAX_FAVICON_REDIRECTS) {
            return null;
          }
          target = new URL(location, target).href;
          continue;
        }
        if (!response.ok || response.body === null) {
          return null;
        }
        const bytes = await readAtMost(response.body, MAX_FAVICON_BYTES, controller);
        return (bytes === undefined ? undefined : faviconDataUrl(bytes)) ?? null;
      }
    } catch {
      logger.warn('favicon.fetchFailed');
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async resolve(candidates, pageUrl) {
      const fetchable = candidates.filter((candidate) => /^(?:https?|data):/i.test(candidate));
      if (fetchable.length === 0) {
        return null;
      }
      // An inline favicon needs no request, so nothing about the page's network.
      const host = fetchable[0]?.startsWith('data:') === true ? undefined : pageHost(pageUrl);
      const pageAddresses = host === undefined ? [] : await addresses(host);
      const page: PageNetwork = {
        url: pageUrl,
        addresses: pageAddresses,
        reach: addressReach(pageUrl, pageAddresses),
      };
      const url = fetchable.find((candidate) =>
        isFaviconUrlAllowed(candidate, pageUrl, pageAddresses),
      );
      if (url === undefined) {
        logger.warn('favicon.localNetworkRefused', { redirects: 0 });
        return null;
      }
      // What the page may reach decides what a fetch may do, so it is part of the cache key.
      const key = `${[...page.reach].sort().join(',')} ${url}`;
      let result = cache.get(key);
      if (result === undefined) {
        result = load(url, page);
        cache.set(key, result);
        if (cache.size > CACHE_SIZE) {
          // Maps iterate in insertion order: drop the oldest entry.
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) {
            cache.delete(oldest);
          }
        }
      }
      return result;
    },
  };
}

/** Reads a stream into memory, giving up (and aborting the request) past `limit` bytes. */
async function readAtMost(
  body: ReadableStream<Uint8Array>,
  limit: number,
  controller: AbortController,
): Promise<Uint8Array | undefined> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > limit) {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
