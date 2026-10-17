// An HTTPS fixture server for the certificate specs (M1.4b): TLS on 127.0.0.1 and an OS-chosen
// port, with a throwaway identity made at test time (./certificate.ts). Nothing here is reachable
// from anywhere but this machine, and no key or certificate is ever written to disk.
//
// A browser that refuses the certificate stops at the handshake, so `requestsServed()` stays at 0
// and `handshakeFailures()` counts the refusals: that is how a spec shows nothing was sent to a
// server whose certificate Veltriva could not trust.
import { createServer } from 'node:https';
import type { Server } from 'node:https';
import type { AddressInfo } from 'node:net';

import type { ServerIdentity } from './certificate';

export interface HttpsFixtureServer {
  /** `https://127.0.0.1:<port>`, without a trailing slash. */
  readonly origin: string;
  url(pathAndQuery: string): string;
  /** Requests that got a response: handshakes the browser accepted. */
  requestsServed(): number;
  /** TLS handshakes that failed, which is what a refused certificate looks like to the server. */
  handshakeFailures(): number;
  close(): Promise<void>;
}

export interface HttpsFixtureOptions {
  readonly identity: ServerIdentity;
  /**
   * Ask the client for a certificate and refuse a connection that has none. Veltriva always
   * declines to choose one, so such a site cannot be opened. TLS is held to 1.2 for this: in 1.3
   * the client finishes its handshake before the server looks at the (empty) certificate, so the
   * refusal races the request and Chromium may report a dropped connection instead of the
   * client-certificate failure. In 1.2 the server's alert ends the handshake itself.
   */
  readonly requireClientCertificate?: boolean;
}

export async function startHttpsFixtureServer(
  options: HttpsFixtureOptions,
): Promise<HttpsFixtureServer> {
  let served = 0;
  let failures = 0;

  const server: Server = createServer(
    {
      key: options.identity.key,
      cert: options.identity.cert,
      ...(options.requireClientCertificate === true
        ? { requestCert: true, rejectUnauthorized: true, maxVersion: 'TLSv1.2' as const }
        : {}),
    },
    (request, response) => {
      served += 1;
      const body =
        '<!doctype html><html lang="en"><head><meta charset="utf-8" />' +
        '<title>Secure fixture</title></head><body><p>This page was served over TLS.</p></body></html>';
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    },
  );
  server.on('tlsClientError', () => {
    failures += 1;
  });

  await new Promise<void>((resolveListening, rejectListening) => {
    server.once('error', rejectListening);
    server.listen(0, '127.0.0.1', resolveListening);
  });
  const origin = `https://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  return {
    origin,
    url: (pathAndQuery) => `${origin}${pathAndQuery}`,
    requestsServed: () => served,
    handshakeFailures: () => failures,
    close: () =>
      new Promise<void>((resolveClosed, rejectClosed) => {
        server.close((error) => {
          if (error === undefined) {
            resolveClosed();
          } else {
            rejectClosed(error);
          }
        });
        server.closeAllConnections();
      }),
  };
}
