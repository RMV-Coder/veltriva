// A deterministic fixture server for the E2E suite (ADR-0008 §4): plain HTTP on 127.0.0.1 and an
// OS-chosen port, with no external network. It serves the files in ./pages and three routes made
// in code:
//   /echo-headers  the request headers as JSON, to see what a page really sends
//   /download      a small file with `Content-Disposition: attachment`
//   /sample.pdf    a tiny valid PDF
// `hits(path)` counts the requests that reached the server. Nothing is cached, and the same
// request always gives the same response.
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

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

export interface FixtureServer {
  /** `http://127.0.0.1:<port>`, without a trailing slash. */
  readonly origin: string;
  /** Absolute URL for a path (and query) on this server, e.g. `url('/hostile.html')`. */
  url(pathAndQuery: string): string;
  /** How many requests arrived for exactly this path and query (the hash never reaches a server). */
  hits(pathAndQuery: string): number;
  close(): Promise<void>;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const hitCounts = new Map<string, number>();

  const server = createServer((request, response) => {
    const target = request.url ?? '/';
    hitCounts.set(target, (hitCounts.get(target) ?? 0) + 1);
    route(request, response).catch((error: unknown) => {
      console.error('Fixture server error:', error);
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end();
    });
  });

  await new Promise<void>((resolveListening, rejectListening) => {
    server.once('error', rejectListening);
    server.listen(0, '127.0.0.1', resolveListening);
  });
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  return {
    origin,
    url: (pathAndQuery) => `${origin}${pathAndQuery}`,
    hits: (pathAndQuery) => hitCounts.get(pathAndQuery) ?? 0,
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

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const { pathname } = new URL(request.url ?? '/', 'http://fixture.invalid');

  switch (pathname) {
    case '/echo-headers':
      respond(response, 200, 'application/json; charset=utf-8', JSON.stringify(request.headers));
      return;
    case '/download':
      respond(response, 200, 'application/octet-stream', DOWNLOAD_BODY, {
        'Content-Disposition': `attachment; filename="${DOWNLOAD_FILE_NAME}"`,
      });
      return;
    case '/sample.pdf':
      respond(response, 200, 'application/pdf', buildSamplePdf());
      return;
    default:
      await serveFromPages(pathname, response);
  }
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
