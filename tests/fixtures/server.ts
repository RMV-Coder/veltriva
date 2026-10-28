// A deterministic fixture server for the E2E suite (ADR-0008 §4): plain HTTP on 127.0.0.1 and an
// OS-chosen port (or one the test asks for), with no external network. It serves the files in
// ./pages and these routes made in code:
//   /echo-headers      the request headers as JSON, to see what a page really sends
//   /release-feed      a release feed in GitHub's format, from `tag` and `page` (M6.3)
//   /download          a small file with `Content-Disposition: attachment`
//   /sample.pdf        a tiny valid PDF
//   /search?q=…        a local search engine: its title echoes the query (HTML-escaped)
//   /slow[?ms=n]       an HTML page that answers after n ms (4000 by default); a closed
//                      connection cancels it
//   /held?key=k        an HTML page that answers when the test calls `release('k')`, so a test
//                      decides exactly when a load starts, stays pending and ends
//   /favicon.png       a valid 16x16 PNG
//   /favicon.svg       an SVG image (the shell must never show it)
//   /favicon-big.png   a PNG that is over the 64 KB limit
//   /favicon-fake.png  HTML bytes labeled image/png (the bytes decide, not the label)
//   /redirect-external a 302 to `veltriva-test:redirected`, a URL scheme no app has registered (M1.4a)
//   /dl/…              files with known bytes to download, one held open until released (M1.4b;
//                      ./download-routes.ts)
//   /auth/…            pages and an image behind HTTP Basic authentication (M1.4b; ./auth-routes.ts)
//   /memory/…          pages, redirects and favicons made from the query, for the history and
//                      favicon specs (M2.2b; ./memory-routes.ts)
//   /cost/page         a page of controlled memory cost, for the §9.3 benchmark (./cost-routes.ts)
// `hits(path)` counts the requests that reached the server for exactly that path and query;
// `pathHits(pathname)` counts them whatever the query. Nothing is cached, and the same request
// always gives the same response.
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

import { handleAuthRoute } from './auth-routes';
import { handleCostRoute } from './cost-routes';
import { createGates, handleDownloadRoute } from './download-routes';
import type { Gates } from './download-routes';
import { buildPng, buildOversizedPng } from './images';
import { handleMemoryRoute } from './memory-routes';
import { buildSamplePdf } from './sample-pdf';

const PAGES_DIR = resolve(__dirname, 'pages');

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export const DOWNLOAD_FILE_NAME = 'veltriva-fixture-download.txt';
const DOWNLOAD_BODY = 'This file exists to be downloaded. The browser must not save it.\n';

/** One request the server received, as it arrived. */
export interface RecordedRequest {
  readonly method: string;
  /** The path and query. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

export interface FixtureServer {
  /** `http://127.0.0.1:<port>`, without a trailing slash. */
  readonly origin: string;
  /**
   * `http://localhost:<port>`: the same server under another host, so another origin and another
   * site (M1.4a). Chromium treats `localhost` as loopback, so it is as promptable as `127.0.0.1`.
   */
  readonly otherSiteOrigin: string;
  /** Absolute URL for a path (and query) on this server, e.g. `url('/hostile.html')`. */
  url(pathAndQuery: string): string;
  /** The same for the other-site origin (`localhost`), e.g. `otherSiteUrl('/popup-child.html')`. */
  otherSiteUrl(pathAndQuery: string): string;
  /** How many requests arrived for exactly this path and query (the hash never reaches a server). */
  hits(pathAndQuery: string): number;
  /** How many requests arrived for this path, whatever their query (e.g. `/search`). */
  pathHits(pathname: string): number;
  /** Every request that reached this path (the query is ignored), oldest first (M1.4b). */
  requestsTo(pathname: string): readonly RecordedRequest[];
  /** How many requests reached the server in all, whatever their path (M4.2: "nothing was sent"). */
  totalRequests(): number;
  /** Lets every download held on `/dl/gated?key=<key>` finish, and any later one at once. */
  releaseGate(key: string): void;
  /** Answers every pending request to `/held?key=<key>`, and any later one at once. */
  release(key: string): void;
  /** Undoes a `release`: the next requests to `/held?key=<key>` are held again. */
  rearm(key: string): void;
  close(): Promise<void>;
}

export interface FixtureServerOptions {
  /** Listen on this port instead of an OS-chosen one (to bring a server back on a known address). */
  readonly port?: number;
}

export async function startFixtureServer(
  options: FixtureServerOptions = {},
): Promise<FixtureServer> {
  const hitCounts = new Map<string, number>();
  const pathCounts = new Map<string, number>();
  const held = createHeldPages();
  const gates = createGates();
  const received = new Map<string, RecordedRequest[]>();
  let total = 0;

  const server = createServer((request, response) => {
    total += 1;
    const target = request.url ?? '/';
    hitCounts.set(target, (hitCounts.get(target) ?? 0) + 1);
    const { pathname } = new URL(target, 'http://fixture.invalid');
    pathCounts.set(pathname, (pathCounts.get(pathname) ?? 0) + 1);
    const log = received.get(pathname) ?? [];
    received.set(pathname, log);
    log.push({ method: request.method ?? 'GET', url: target, headers: { ...request.headers } });
    route(request, response, held, gates).catch((error: unknown) => {
      console.error('Fixture server error:', error);
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end();
    });
  });

  await new Promise<void>((resolveListening, rejectListening) => {
    server.once('error', rejectListening);
    server.listen(options.port ?? 0, '127.0.0.1', resolveListening);
  });
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${String(port)}`;
  const otherSiteOrigin = `http://localhost:${String(port)}`;

  return {
    origin,
    otherSiteOrigin,
    url: (pathAndQuery) => `${origin}${pathAndQuery}`,
    otherSiteUrl: (pathAndQuery) => `${otherSiteOrigin}${pathAndQuery}`,
    hits: (pathAndQuery) => hitCounts.get(pathAndQuery) ?? 0,
    pathHits: (pathname) => pathCounts.get(pathname) ?? 0,
    requestsTo: (pathname) => [...(received.get(pathname) ?? [])],
    totalRequests: () => total,
    releaseGate: (key) => {
      gates.release(key);
    },
    release: (key) => {
      held.release(key);
    },
    rearm: (key) => {
      held.rearm(key);
    },
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClosed, rejectClosed) => {
    server.close((error) => {
      if (error === undefined) {
        resolveClosed();
      } else {
        rejectClosed(error);
      }
    });
    // Chromium keeps connections alive; don't wait for them.
    server.closeAllConnections();
  });
}

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

const DEFAULT_SLOW_MS = 4_000;
const MAX_SLOW_MS = 60_000;

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  held: HeldPages,
  gates: Gates,
): Promise<void> {
  const { pathname, searchParams } = new URL(request.url ?? '/', 'http://fixture.invalid');
  if (
    (pathname.startsWith('/dl/') && handleDownloadRoute(pathname, searchParams, response, gates)) ||
    (pathname.startsWith('/auth/') && handleAuthRoute(pathname, searchParams, request, response)) ||
    (pathname.startsWith('/memory/') && handleMemoryRoute(pathname, searchParams, response)) ||
    (pathname.startsWith('/cost/') && handleCostRoute(pathname, searchParams, response))
  ) {
    return;
  }

  switch (pathname) {
    case '/echo-headers':
      respond(response, 200, 'application/json; charset=utf-8', JSON.stringify(request.headers));
      return;
    case '/release-feed':
      // A release feed in GitHub's latest-release format (M6.3, tests/e2e/about-updates.spec.ts):
      // `tag` names the release, `page` is its page.
      respond(
        response,
        200,
        'application/json; charset=utf-8',
        JSON.stringify({
          tag_name: searchParams.get('tag') ?? 'v0.0.0',
          html_url: searchParams.get('page') ?? 'https://releases.invalid/',
          draft: false,
          prerelease: false,
        }),
      );
      return;
    case '/client-hints-opt-in':
      // A page that asks for every opt-in client hint (tests/e2e/client-hints.spec.ts).
      respond(response, 200, HTML, '<!doctype html><title>Asks for client hints</title>', {
        'Accept-CH':
          'Sec-CH-UA-Arch, Sec-CH-UA-Bitness, Sec-CH-UA-Form-Factors, Sec-CH-UA-Full-Version, ' +
          'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Model, Sec-CH-UA-Platform-Version, Sec-CH-UA-WoW64',
      });
      return;
    case '/download':
      respond(response, 200, 'application/octet-stream', DOWNLOAD_BODY, {
        'Content-Disposition': `attachment; filename="${DOWNLOAD_FILE_NAME}"`,
      });
      return;
    case '/sample.pdf':
      respond(response, 200, 'application/pdf', buildSamplePdf());
      return;
    case '/search':
      respond(response, 200, HTML, searchPage(searchParams.get('q') ?? ''));
      return;
    case '/slow':
      slowPage(response, searchParams.get('ms'));
      return;
    case '/held':
      held.hold(searchParams.get('key') ?? '', response);
      return;
    case '/favicon.png':
      respond(response, 200, 'image/png', buildPng());
      return;
    case '/favicon.svg':
      respond(response, 200, 'image/svg+xml', SVG_ICON);
      return;
    case '/favicon-big.png':
      respond(response, 200, 'image/png', buildOversizedPng());
      return;
    case '/favicon-fake.png':
      respond(response, 200, 'image/png', '<!doctype html><title>not an image</title>');
      return;
    case '/redirect-external':
      // A redirect to another app's URL: the browser must ask before anything opens (M1.4a).
      response.writeHead(302, { Location: 'veltriva-test:redirected', ...NO_STORE });
      response.end();
      return;
    default:
      await serveFromPages(pathname, response);
  }
}

const HTML = 'text/html; charset=utf-8';
const SVG_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#c00"/></svg>';

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${String(character.charCodeAt(0))};`);
}

/** The title is what the specs read: "Search results for: <query>". */
function searchPage(query: string): string {
  const shown = escapeHtml(query);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Search results for: ${shown}</title>
  </head>
  <body>
    <h1>Search results</h1>
    <p id="query">${shown}</p>
  </body>
</html>
`;
}

/**
 * Answers after `ms` milliseconds. If the client goes away first (Stop, a closed tab, a closed
 * server) the timer is cleared, so a slow request never keeps the server or the test alive.
 */
function slowPage(response: ServerResponse, ms: string | null): void {
  const requested = Number(ms);
  const delay =
    ms !== null && Number.isFinite(requested) && requested >= 0
      ? Math.min(requested, MAX_SLOW_MS)
      : DEFAULT_SLOW_MS;
  const timer = setTimeout(() => {
    respond(
      response,
      200,
      HTML,
      '<!doctype html><html lang="en"><head><meta charset="utf-8" />' +
        '<title>Slow fixture</title></head><body><p>This page answered slowly.</p></body></html>',
    );
  }, delay);
  response.once('close', () => {
    clearTimeout(timer);
  });
}

const HELD_PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8" />' +
  '<title>Held fixture</title></head><body><p>This page was held back.</p></body></html>';

interface HeldPages {
  /** Answers at once if `key` was released; otherwise keeps the response until it is. */
  hold(key: string, response: ServerResponse): void;
  release(key: string): void;
  rearm(key: string): void;
}

function createHeldPages(): HeldPages {
  const pending = new Map<string, Set<ServerResponse>>();
  const released = new Set<string>();

  const answer = (response: ServerResponse): void => {
    // A client that gave up (Stop, a closed tab) has destroyed its end already.
    if (!response.destroyed) {
      respond(response, 200, HTML, HELD_PAGE);
    }
  };

  return {
    hold(key, response) {
      if (released.has(key)) {
        answer(response);
        return;
      }
      const waiting = pending.get(key) ?? new Set<ServerResponse>();
      pending.set(key, waiting);
      waiting.add(response);
      response.once('close', () => {
        waiting.delete(response);
      });
    },
    release(key) {
      released.add(key);
      for (const response of pending.get(key) ?? []) {
        answer(response);
      }
      pending.delete(key);
    },
    rearm(key) {
      released.delete(key);
    },
  };
}

async function serveFromPages(pathname: string, response: ServerResponse): Promise<void> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    respond(response, 400, 'text/plain; charset=utf-8', 'Bad request');
    return;
  }
  const file = resolve(PAGES_DIR, `.${decoded}`);
  const contentType = CONTENT_TYPES[extname(file).toLowerCase()];
  if (!file.startsWith(PAGES_DIR + sep) || contentType === undefined) {
    respond(response, 404, 'text/plain; charset=utf-8', 'Not found');
    return;
  }
  try {
    respond(response, 200, contentType, await readFile(file));
  } catch {
    respond(response, 404, 'text/plain; charset=utf-8', 'Not found');
  }
}

function respond(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string | Buffer,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    ...NO_STORE,
    ...headers,
  });
  response.end(body);
}
