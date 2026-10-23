import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '../platform/logger';
import { MAX_FAVICON_BYTES } from '../../core/net/favicon-format';
import { createFaviconService, MAX_FAVICON_REDIRECTS } from './favicons';
import type { FaviconFetch, HostResolve } from './favicons';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const logger: Logger = { warn: vi.fn(), error: vi.fn() };
/** The page the candidates come from: a public site. */
const PAGE = 'https://a.example/article';

/**
 * What names resolve to in these tests: IP literals to themselves, `localhost` to loopback,
 * the names below as listed, and any other name to one public address.
 */
const RECORDS: Readonly<Record<string, readonly string[]>> = {
  localhost: ['::1', '127.0.0.1'],
  router: ['192.168.1.1'],
  'loop.example': ['127.0.0.1'],
  'mixed.example': ['93.184.216.34', '10.0.0.7'],
  'intranet.corp.example': ['10.0.0.5'],
  'icons.corp.example': ['10.0.0.6'],
  'gone.example': [],
};
const resolveHost = vi.fn<HostResolve>((host) =>
  Promise.resolve(RECORDS[host] ?? (/^[\d.]+$|:/.test(host) ? [host] : ['93.184.216.34'])),
);

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

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
    const service = createFaviconService(fetchFavicon, resolveHost, logger);
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
    const service = createFaviconService(fetchFavicon, resolveHost, logger);
    const inline = `data:image/png;base64,${btoa(String.fromCharCode(...PNG))}`;
    await expect(service.resolve([inline], PAGE)).resolves.toBe(inline);
    expect(fetchFavicon).not.toHaveBeenCalled();
  });

  it('refuses SVG favicons, inline or fetched', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const service = createFaviconService(
      () => Promise.resolve(respond([svg])),
      resolveHost,
      logger,
    );
    await expect(service.resolve(['https://a.example/icon.svg'], PAGE)).resolves.toBeNull();
    await expect(
      service.resolve([`data:image/svg+xml;base64,${btoa('<svg/>')}`], PAGE),
    ).resolves.toBeNull();
  });

  it('gives up on a body over 64 KB, even when it starts like a PNG', async () => {
    const half = new Uint8Array(MAX_FAVICON_BYTES / 2 + 1);
    half.set(PNG);
    const service = createFaviconService(
      () => Promise.resolve(respond([half, half])),
      resolveHost,
      logger,
    );
    await expect(service.resolve(['https://a.example/huge.png'], PAGE)).resolves.toBeNull();
  });

  it('returns null for failed responses and network errors', async () => {
    const notFound = createFaviconService(
      () => Promise.resolve(respond([PNG], 404)),
      resolveHost,
      logger,
    );
    await expect(notFound.resolve(['https://a.example/favicon.ico'], PAGE)).resolves.toBeNull();
    const offline = createFaviconService(
      () => Promise.reject(new TypeError('fetch failed')),
      resolveHost,
      logger,
    );
    await expect(offline.resolve(['https://a.example/favicon.ico'], PAGE)).resolves.toBeNull();
  });

  it('ignores candidates that are neither http(s) nor data:', async () => {
    const fetchFavicon = vi.fn<FaviconFetch>();
    const service = createFaviconService(fetchFavicon, resolveHost, logger);
    await expect(
      service.resolve(['file:///C:/x.ico', 'javascript:alert(1)', 'chrome://favicon/x'], PAGE),
    ).resolves.toBeNull();
    expect(fetchFavicon).not.toHaveBeenCalled();
  });

  it('caches results per URL', async () => {
    const fetchFavicon = vi.fn<FaviconFetch>(() => Promise.resolve(respond([PNG])));
    const service = createFaviconService(fetchFavicon, resolveHost, logger);
    await service.resolve(['https://a.example/favicon.ico'], PAGE);
    await service.resolve(['https://a.example/favicon.ico'], PAGE);
    expect(fetchFavicon).toHaveBeenCalledTimes(1);
  });

  it('skips favicons on local hosts for a public page, and takes the next candidate', async () => {
    const fetchFavicon = vi.fn<FaviconFetch>(() => Promise.resolve(respond([PNG])));
    const service = createFaviconService(fetchFavicon, resolveHost, logger);
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
    const service = createFaviconService(fetchFavicon, resolveHost, logger);
    await expect(
      service.resolve(['http://169.254.169.254/latest/meta-data', 'http://localhost/x.ico'], PAGE),
    ).resolves.toBeNull();
    expect(fetchFavicon).not.toHaveBeenCalled();
  });

  it('lets a page on a local host use a favicon on the same kind of host', async () => {
    const fetchFavicon = vi.fn<FaviconFetch>(() => Promise.resolve(respond([PNG])));
    const service = createFaviconService(fetchFavicon, resolveHost, logger);
    await expect(
      service.resolve(['http://localhost:3000/favicon.ico'], 'http://127.0.0.1:3000/'),
    ).resolves.toMatch(/^data:image\/png;base64,/);
    await expect(
      service.resolve(['http://localhost:3000/other.ico'], 'http://192.168.1.1/'),
    ).resolves.toBeNull();
    expect(fetchFavicon).toHaveBeenCalledTimes(1);
  });
});

describe('FaviconService: redirects and resolved addresses (M6.1, T5)', () => {
  it('follows a redirect to another public host, asking for each hop itself', async () => {
    const fetchFavicon = vi.fn<FaviconFetch>((url) =>
      Promise.resolve(
        url === 'https://a.example/favicon.ico'
          ? redirect('https://cdn.example/icons/a.png', 301)
          : respond([PNG]),
      ),
    );
    const service = createFaviconService(fetchFavicon, resolveHost, logger);
    await expect(service.resolve(['https://a.example/favicon.ico'], PAGE)).resolves.toMatch(
      /^data:image\/png;base64,/,
    );
    expect(fetchFavicon.mock.calls.map(([url]) => url)).toEqual([
      'https://a.example/favicon.ico',
      'https://cdn.example/icons/a.png',
    ]);
  });

  it.each([
    ['an address on this machine', 'http://127.0.0.1:631/printers'],
    ['a private address', 'http://192.168.1.1/reboot.cgi'],
    ['the cloud metadata address', 'http://169.254.169.254/latest/meta-data'],
    ['a local name', 'http://router/favicon.ico'],
    ['a public name for this machine', 'http://loop.example/favicon.ico'],
    ['a scheme other than http(s)', 'file:///C:/Windows/win.ini'],
  ])('never follows a redirect to %s', async (_what, location) => {
    const fetchFavicon = vi.fn<FaviconFetch>(() => Promise.resolve(redirect(location)));
    const service = createFaviconService(fetchFavicon, resolveHost, logger);
    await expect(service.resolve(['https://a.example/favicon.ico'], PAGE)).resolves.toBeNull();
    expect(fetchFavicon).toHaveBeenCalledTimes(1);
  });

  it('resolves a relative redirect against the request it answers', async () => {
    const fetchFavicon = vi.fn<FaviconFetch>((url) =>
      Promise.resolve(url.endsWith('/favicon.ico') ? redirect('/static/icon.png') : respond([PNG])),
    );
    const service = createFaviconService(fetchFavicon, resolveHost, logger);
    await service.resolve(['https://a.example/favicon.ico'], PAGE);
    expect(fetchFavicon.mock.calls[1]?.[0]).toBe('https://a.example/static/icon.png');
  });

  it(`gives up after ${String(MAX_FAVICON_REDIRECTS)} redirects`, async () => {
    let n = 0;
    const fetchFavicon = vi.fn<FaviconFetch>(() => {
      n += 1;
      return Promise.resolve(redirect(`https://a.example/hop/${String(n)}`));
    });
    const service = createFaviconService(fetchFavicon, resolveHost, logger);
    await expect(service.resolve(['https://a.example/favicon.ico'], PAGE)).resolves.toBeNull();
    expect(fetchFavicon).toHaveBeenCalledTimes(MAX_FAVICON_REDIRECTS + 1);
  });

  it('refuses a public name that resolves to this machine or the local network', async () => {
    const fetchFavicon = vi.fn<FaviconFetch>(() => Promise.resolve(respond([PNG])));
    const service = createFaviconService(fetchFavicon, resolveHost, logger);
    await expect(service.resolve(['http://loop.example/favicon.ico'], PAGE)).resolves.toBeNull();
    await expect(service.resolve(['https://mixed.example/favicon.ico'], PAGE)).resolves.toBeNull();
    expect(fetchFavicon).not.toHaveBeenCalled();
  });

  it('refuses a name that does not resolve, without a request', async () => {
    const fetchFavicon = vi.fn<FaviconFetch>(() => Promise.resolve(respond([PNG])));
    const rejecting = vi.fn<HostResolve>(() => Promise.reject(new Error('ERR_NAME_NOT_RESOLVED')));
    const service = createFaviconService(fetchFavicon, rejecting, logger);
    await expect(service.resolve(['https://a.example/favicon.ico'], PAGE)).resolves.toBeNull();
    await expect(
      createFaviconService(fetchFavicon, resolveHost, logger).resolve(
        ['https://gone.example/favicon.ico'],
        PAGE,
      ),
    ).resolves.toBeNull();
    expect(fetchFavicon).not.toHaveBeenCalled();
  });

  it('lets an intranet page whose name resolves to a private address use icons there', async () => {
    const fetchFavicon = vi.fn<FaviconFetch>(() => Promise.resolve(respond([PNG])));
    const service = createFaviconService(fetchFavicon, resolveHost, logger);
    await expect(
      service.resolve(
        ['https://icons.corp.example/favicon.ico'],
        'https://intranet.corp.example/wiki',
      ),
    ).resolves.toMatch(/^data:image\/png;base64,/);
    // A page with a public record opens nothing local, even with a private one beside it.
    await expect(
      service.resolve(['https://icons.corp.example/other.ico'], 'https://mixed.example/'),
    ).resolves.toBeNull();
    expect(fetchFavicon).toHaveBeenCalledTimes(1);
  });

  it('caches per page reach: a result fetched for a local page is not reused for a public one', async () => {
    const fetchFavicon = vi.fn<FaviconFetch>((url) =>
      Promise.resolve(
        url === 'https://a.example/favicon.ico'
          ? redirect('http://10.0.0.6/icon.png')
          : respond([PNG]),
      ),
    );
    const service = createFaviconService(fetchFavicon, resolveHost, logger);
    // An intranet page may follow the redirect to its own network.
    await expect(
      service.resolve(['https://a.example/favicon.ico'], 'https://intranet.corp.example/'),
    ).resolves.toMatch(/^data:image\/png;base64,/);
    // A public page gets its own answer, and its redirect is refused.
    await expect(service.resolve(['https://a.example/favicon.ico'], PAGE)).resolves.toBeNull();
    expect(fetchFavicon.mock.calls.map(([url]) => url)).toEqual([
      'https://a.example/favicon.ico',
      'http://10.0.0.6/icon.png',
      'https://a.example/favicon.ico',
    ]);
  });

  it('resolves IPv6 literals without their brackets', async () => {
    const fetchFavicon = vi.fn<FaviconFetch>(() => Promise.resolve(respond([PNG])));
    const seen = vi.fn<HostResolve>((host) => resolveHost(host));
    const service = createFaviconService(fetchFavicon, seen, logger);
    await service.resolve(['http://[::1]:3000/favicon.ico'], 'http://[::1]:3000/');
    expect(seen.mock.calls.map(([host]) => host)).toEqual(['::1', '::1']);
    expect(fetchFavicon).toHaveBeenCalledTimes(1);
  });
});
