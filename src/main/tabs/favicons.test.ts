import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '../platform/logger';
import { MAX_FAVICON_BYTES } from '../../core/net/favicon-format';
import { createFaviconService } from './favicons';
import type { FaviconFetch } from './favicons';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const logger: Logger = { warn: vi.fn(), error: vi.fn() };
/** The page the candidates come from: a public site. */
const PAGE = 'https://a.example/article';

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
      service.resolve(
        ['blob:https://x/1', 'https://a.example/favicon.ico', 'https://a.example/b.png'],
        PAGE,
      ),
    ).resolves.toMatch(/^data:image\/png;base64,/);
    expect(fetchFavicon).toHaveBeenCalledTimes(1);
    expect(fetchFavicon.mock.calls[0]?.[0]).toBe('https://a.example/favicon.ico');
  });

  it('uses inline data: favicons without fetching', async () => {
    const fetchFavicon = vi.fn<FaviconFetch>();
    const service = createFaviconService(fetchFavicon, logger);
    const inline = `data:image/png;base64,${btoa(String.fromCharCode(...PNG))}`;
    await expect(service.resolve([inline], PAGE)).resolves.toBe(inline);
    expect(fetchFavicon).not.toHaveBeenCalled();
  });

  it('refuses SVG favicons, inline or fetched', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const service = createFaviconService(() => Promise.resolve(respond([svg])), logger);
    await expect(service.resolve(['https://a.example/icon.svg'], PAGE)).resolves.toBeNull();
    await expect(
      service.resolve([`data:image/svg+xml;base64,${btoa('<svg/>')}`], PAGE),
    ).resolves.toBeNull();
  });

  it('gives up on a body over 64 KB, even when it starts like a PNG', async () => {
    const half = new Uint8Array(MAX_FAVICON_BYTES / 2 + 1);
    half.set(PNG);
    const service = createFaviconService(() => Promise.resolve(respond([half, half])), logger);
    await expect(service.resolve(['https://a.example/huge.png'], PAGE)).resolves.toBeNull();
  });

  it('returns null for failed responses and network errors', async () => {
    const notFound = createFaviconService(() => Promise.resolve(respond([PNG], 404)), logger);
    await expect(notFound.resolve(['https://a.example/favicon.ico'], PAGE)).resolves.toBeNull();
    const offline = createFaviconService(
      () => Promise.reject(new TypeError('fetch failed')),
      logger,
    );
    await expect(offline.resolve(['https://a.example/favicon.ico'], PAGE)).resolves.toBeNull();
  });

  it('ignores candidates that are neither http(s) nor data:', async () => {
    const fetchFavicon = vi.fn<FaviconFetch>();
    const service = createFaviconService(fetchFavicon, logger);
    await expect(
      service.resolve(['file:///C:/x.ico', 'javascript:alert(1)', 'chrome://favicon/x'], PAGE),
    ).resolves.toBeNull();
    expect(fetchFavicon).not.toHaveBeenCalled();
  });

  it('caches results per URL', async () => {
    const fetchFavicon = vi.fn<FaviconFetch>(() => Promise.resolve(respond([PNG])));
    const service = createFaviconService(fetchFavicon, logger);
    await service.resolve(['https://a.example/favicon.ico'], PAGE);
    await service.resolve(['https://a.example/favicon.ico'], PAGE);
    expect(fetchFavicon).toHaveBeenCalledTimes(1);
  });

  it('skips favicons on local hosts for a public page, and takes the next candidate', async () => {
    const fetchFavicon = vi.fn<FaviconFetch>(() => Promise.resolve(respond([PNG])));
    const service = createFaviconService(fetchFavicon, logger);
    await expect(
      service.resolve(
        [
          'http://127.0.0.1:8080/favicon.ico',
          'http://[::ffff:192.168.1.1]/icon.png',
          'http://router/favicon.ico',
          'https://cdn.a.example/favicon.ico',
        ],
        PAGE,
      ),
    ).resolves.toMatch(/^data:image\/png;base64,/);
    expect(fetchFavicon.mock.calls.map(([url]) => url)).toEqual([
      'https://cdn.a.example/favicon.ico',
    ]);
  });

  it('fetches nothing when every candidate is on a local host the page may not reach', async () => {
    const fetchFavicon = vi.fn<FaviconFetch>();
    const service = createFaviconService(fetchFavicon, logger);
    await expect(
      service.resolve(['http://169.254.169.254/latest/meta-data', 'http://localhost/x.ico'], PAGE),
    ).resolves.toBeNull();
    expect(fetchFavicon).not.toHaveBeenCalled();
  });

  it('lets a page on a local host use a favicon on the same kind of host', async () => {
    const fetchFavicon = vi.fn<FaviconFetch>(() => Promise.resolve(respond([PNG])));
    const service = createFaviconService(fetchFavicon, logger);
    await expect(
      service.resolve(['http://localhost:3000/favicon.ico'], 'http://127.0.0.1:3000/'),
    ).resolves.toMatch(/^data:image\/png;base64,/);
    await expect(
      service.resolve(['http://localhost:3000/other.ico'], 'http://192.168.1.1/'),
    ).resolves.toBeNull();
    expect(fetchFavicon).toHaveBeenCalledTimes(1);
  });
});
