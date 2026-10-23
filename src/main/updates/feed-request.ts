// The one request the update check makes (M6.3): GET the release feed, through a session of its
// own, so it carries none of the user's cookies, cache or site data and can't be told apart from
// any other client by them. The session is in memory (no `persist:`) and gets the same hardened
// baseline as every session (web/session-baseline.ts). Only the feed's JSON is read, at most 1 MB.
import { session } from 'electron';

import { isFeedUrlAllowed } from '../../core/updates/release-feed';

const PARTITION = 'veltriva-updates';
const MAX_FEED_BYTES = 1024 * 1024;

export async function fetchReleaseFeed(url: string, signal: AbortSignal): Promise<unknown> {
  if (!isFeedUrlAllowed(url)) {
    throw new TypeError('The release feed must be an https address');
  }
  const response = await session.fromPartition(PARTITION).fetch(url, {
    signal,
    credentials: 'omit',
    cache: 'no-store',
    headers: { Accept: 'application/vnd.github+json, application/json' },
  });
  // A redirect may not leave https (or this machine, for a feed served locally).
  if (!isFeedUrlAllowed(response.url === '' ? url : response.url)) {
    throw new TypeError('The release feed redirected away from https');
  }
  if (!response.ok) {
    throw new Error(`The release feed answered ${String(response.status)}`);
  }
  if (response.body === null) {
    throw new Error('The release feed sent nothing');
  }
  // Read up to the cap while it streams, so an endless answer can't fill memory.
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_FEED_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new RangeError('The release feed is too large');
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
