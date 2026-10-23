// The favicon service's network side (threat T5, M6.1): one request through the browsing session
// that follows no redirect, so the service checks every hop itself (./favicons.ts). `session.fetch`
// can't do that: with `redirect: 'manual'` it fails with "Redirect was cancelled" and gives no
// target (measured on Electron 45). Cookies are sent as `session.fetch` sends them (measured), and
// an HTTP sign-in request is declined: a favicon never asks the user for a password.
import { net } from 'electron';
import type { Session } from 'electron';

import type { FaviconFetch, HostResolve } from './favicons';

/** Statuses a Response may carry no body for, by the Fetch standard. */
const NULL_BODY: ReadonlySet<number> = new Set([204, 205, 304]);

export function faviconRequest(session: Session): FaviconFetch {
  return (url, { signal }) =>
    new Promise<Response>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      const request = net.request({ url, session, redirect: 'manual', useSessionCookies: true });
      const onAbort = (): void => {
        request.abort();
        reject(new Error('aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      request.on('redirect', (statusCode, _method, redirectUrl) => {
        signal.removeEventListener('abort', onAbort);
        request.abort();
        resolve(new Response(null, { status: statusCode, headers: { location: redirectUrl } }));
      });
      request.on('login', (_authInfo, callback) => {
        callback();
      });
      request.on('response', (response) => {
        const status = response.statusCode;
        if (status < 200 || status > 599 || NULL_BODY.has(status)) {
          request.abort();
          resolve(new Response(null, { status: status < 200 || status > 599 ? 502 : status }));
          return;
        }
        let settled = false;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const fail = (error: Error): void => {
              if (!settled) {
                settled = true;
                controller.error(error);
              }
            };
            response.on('data', (chunk) => {
              if (!settled) {
                controller.enqueue(new Uint8Array(chunk));
              }
            });
            response.on('end', () => {
              if (!settled) {
                settled = true;
                controller.close();
              }
            });
            response.on('error', fail);
            response.on('aborted', () => {
              fail(new Error('aborted'));
            });
          },
          cancel() {
            settled = true;
            request.abort();
          },
        });
        // The service aborts the signal past 64 KB, which aborts the request too.
        resolve(new Response(body, { status }));
      });
      request.on('error', (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      });
      request.end();
    });
}

/** The addresses `host` resolves to with the browsing session's resolver (and its cache). */
export function sessionResolver(session: Session): HostResolve {
  return async (host) => {
    const { endpoints } = await session.resolveHost(host);
    return endpoints.map((endpoint) => endpoint.address);
  };
}
