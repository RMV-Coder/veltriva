// The HTTP-authentication routes of the fixture server (M1.4b). They answer `401` with
// `WWW-Authenticate: Basic realm="…"` until a request carries the one known username and password.
//   /auth/page?realm=     the protected page; `realm` is sent as the server's own words (UTF-8).
//                         Chromium reads a realm as Latin-1, Basic and Digest alike, so UTF-8 bytes
//                         come out as mojibake: a U+202E cannot reach main in a realm, but the C1
//                         controls and the soft hyphen of the Latin-1 range can
//   /auth/image.png       a protected image, for a page that embeds it from the same or another origin
// The server records every request's headers, so a spec can read the `Authorization` it received
// (`FixtureServer.requestsTo`).
import type { IncomingMessage, ServerResponse } from 'node:http';

import { buildPng } from './images';

export const AUTH_USERNAME = 'veltriva-tester';
/** Long and unlike any other text in the app, so a leak is found by a plain substring search. */
export const AUTH_PASSWORD = 'Rt7-correct-pw-5512';
export const AUTH_WRONG_PASSWORD = 'Qm3-wrong-pw-9046';

/** The `Authorization` header a browser sends for these credentials. */
export function basicAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

export const AUTH_OK_TITLE = 'Protected page';
export const AUTH_REFUSED_TITLE = 'Sign-in required';
export const AUTH_REFUSED_TEXT = 'The server refused: you are not signed in.';
export const AUTH_DEFAULT_REALM = 'Fixture area';

const HTML = 'text/html; charset=utf-8';
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/**
 * A header value whose text is sent as UTF-8 bytes, which is what a server does with a realm
 * that has non-ASCII characters. Node writes header strings as Latin-1, one byte per character.
 */
function utf8HeaderValue(text: string): string {
  return Buffer.from(text, 'utf8').toString('latin1');
}

function isSignedIn(request: IncomingMessage): boolean {
  return request.headers.authorization === basicAuthorization(AUTH_USERNAME, AUTH_PASSWORD);
}

function refuse(response: ServerResponse, realm: string, contentType: string, body: string): void {
  response.writeHead(401, {
    'WWW-Authenticate': `Basic realm="${utf8HeaderValue(realm.replace(/["\\]/g, '_'))}"`,
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    ...NO_STORE,
  });
  response.end(body);
}

/** Answers an `/auth/…` request. Returns false for a path that is not an auth route. */
export function handleAuthRoute(
  pathname: string,
  params: URLSearchParams,
  request: IncomingMessage,
  response: ServerResponse,
): boolean {
  const realm = params.get('realm') ?? AUTH_DEFAULT_REALM;
  if (pathname === '/auth/page') {
    if (!isSignedIn(request)) {
      refuse(
        response,
        realm,
        HTML,
        `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>${AUTH_REFUSED_TITLE}</title></head>` +
          `<body><p>${AUTH_REFUSED_TEXT}</p></body></html>`,
      );
      return true;
    }
    const body =
      `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>${AUTH_OK_TITLE}</title></head>` +
      '<body><p>Welcome, you are signed in.</p></body></html>';
    response.writeHead(200, {
      'Content-Type': HTML,
      'Content-Length': Buffer.byteLength(body),
      ...NO_STORE,
    });
    response.end(body);
    return true;
  }
  if (pathname === '/auth/image.png') {
    if (!isSignedIn(request)) {
      refuse(response, realm, 'text/plain; charset=utf-8', AUTH_REFUSED_TEXT);
      return true;
    }
    const image = buildPng();
    response.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': image.length,
      ...NO_STORE,
    });
    response.end(image);
    return true;
  }
  return false;
}
