// Fetches favicons for the shell (threat T5). Requests go through the browsing session, like the
// page's own requests; the body is read only up to 64 KB, and the result is used only if its
// bytes are a raster image (./favicon-format.ts). Results are cached per URL. Nothing about a
// favicon ever reaches the page, and failures are silent: the shell shows a generic icon.
//
// These are browser-initiated requests, which skip Chromium's local-network-access checks, so a
// page could name a favicon on this machine or the local network to make main request it. Local
// hosts are refused unless the page itself is on the same kind of host (src/core/url/local-network.ts).
import { isFaviconUrlAllowed } from '../../core/url/local-network';
import type { Logger } from '../platform/logger';
import { decodeDataUrl, faviconDataUrl, MAX_FAVICON_BYTES } from './favicon-format';

const TIMEOUT_MS = 10_000;
const CACHE_SIZE = 256;

export type FaviconFetch = (
  url: string,
  init: { readonly signal: AbortSignal },
) => Promise<Response>;

export interface FaviconService {
  /**
   * The first usable favicon among the candidates of the page at `pageUrl`, as a `data:` URL, or
   * null. Candidates on local hosts that the page may not reach are skipped.
   */
  resolve(candidates: readonly string[], pageUrl: string): Promise<string | null>;
}

export function createFaviconService(fetchFavicon: FaviconFetch, logger: Logger): FaviconService {
  const cache = new Map<string, Promise<string | null>>();

  const load = async (url: string): Promise<string | null> => {
    if (url.startsWith('data:')) {
      const bytes = decodeDataUrl(url);
      return (bytes === undefined ? undefined : faviconDataUrl(bytes)) ?? null;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, TIMEOUT_MS);
    try {
      const response = await fetchFavicon(url, { signal: controller.signal });
      if (!response.ok || response.body === null) {
        return null;
      }
      const bytes = await readAtMost(response.body, MAX_FAVICON_BYTES, controller);
      return (bytes === undefined ? undefined : faviconDataUrl(bytes)) ?? null;
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
      const url = fetchable.find((candidate) => isFaviconUrlAllowed(candidate, pageUrl));
      if (url === undefined) {
        if (fetchable.length > 0) {
          logger.warn('favicon.localNetworkRefused');
        }
        return null;
      }
      let result = cache.get(url);
      if (result === undefined) {
        result = load(url);
        cache.set(url, result);
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
