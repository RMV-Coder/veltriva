import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '../platform/logger';
import { MAX_FAVICON_BYTES } from './favicon-format';
import { createFaviconService } from './favicons';
import type { FaviconFetch } from './favicons';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const logger: Logger = { warn: vi.fn(), error: vi.fn() };

/** A response whose body arrives in chunks, so the size cap is tested on a real stream. */
function respond(chunks: readonly Uint8Array[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  return new Response(stream, { status });
}

describe('FaviconService', () => {
  it('fetches the first http(s) candidate and encodes it from its bytes', async () => {
    const fetchFavicon = vi.fn<FaviconFetch>(() => Promise.resolve(respond([PNG])));
    const service = createFaviconService(fetchFavicon, logger);
    await expect(
      service.resolve([
        'blob:https://x/1',
        'https://a.example/favicon.ico',
        'https://a.example/b.png',
      ]),
    ).resolves.toMatch(/^data:image\/png;base64,/);
    expect(fetchFavicon).toHaveBeenCalledTimes(1);
    expect(fetchFavicon.mock.calls[0]?.[0]).toBe('https://a.example/favicon.ico');
  });

  it('uses inline data: favicons without fetching', async () => {
    const fetchFavicon = vi.fn<FaviconFetch>();
    const service = createFaviconService(fetchFavicon, logger);
    const inline = `data:image/png;base64,${btoa(String.fromCharCode(...PNG))}`;
    await expect(service.resolve([inline])).resolves.toBe(inline);
    expect(fetchFavicon).not.toHaveBeenCalled();
  });

  it('refuses SVG favicons, inline or fetched', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const service = createFaviconService(() => Promise.resolve(respond([svg])), logger);
    await expect(service.resolve(['https://a.example/icon.svg'])).resolves.toBeNull();
    await expect(
      service.resolve([`data:image/svg+xml;base64,${btoa('<svg/>')}`]),
    ).resolves.toBeNull();
  });

  it('gives up on a body over 64 KB, even when it starts like a PNG', async () => {
    const half = new Uint8Array(MAX_FAVICON_BYTES / 2 + 1);
    half.set(PNG);
    const service = createFaviconService(() => Promise.resolve(respond([half, half])), logger);
    await expect(service.resolve(['https://a.example/huge.png'])).resolves.toBeNull();
  });

  it('returns null for failed responses and network errors', async () => {
    const notFound = createFaviconService(() => Promise.resolve(respond([PNG], 404)), logger);
    await expect(notFound.resolve(['https://a.example/favicon.ico'])).resolves.toBeNull();
    const offline = createFaviconService(
      () => Promise.reject(new TypeError('fetch failed')),
      logger,
    );
    await expect(offline.resolve(['https://a.example/favicon.ico'])).resolves.toBeNull();
  });

  it('ignores candidates that are neither http(s) nor data:', async () => {
    const fetchFavicon = vi.fn<FaviconFetch>();
    const service = createFaviconService(fetchFavicon, logger);
    await expect(
      service.resolve(['file:///C:/x.ico', 'javascript:alert(1)', 'chrome://favicon/x']),
    ).resolves.toBeNull();
    expect(fetchFavicon).not.toHaveBeenCalled();
  });

  it('caches results per URL', async () => {
    const fetchFavicon = vi.fn<FaviconFetch>(() => Promise.resolve(respond([PNG])));
    const service = createFaviconService(fetchFavicon, logger);
    await service.resolve(['https://a.example/favicon.ico']);
    await service.resolve(['https://a.example/favicon.ico']);
    expect(fetchFavicon).toHaveBeenCalledTimes(1);
  });
});
