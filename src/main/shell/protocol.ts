// The app://shell protocol (ADR-0002, assessment §6.2). The scheme is registered as privileged
// for every session, but its handler exists only on the shell's own session, so web pages in
// `persist:browsing` can't load it. Every response carries the shell CSP as a header, so
// `frame-ancestors` applies.
import { readFile } from 'node:fs/promises';

import { protocol } from 'electron';
import type { Session } from 'electron';

import { resolveShellAsset, SHELL_SCHEME } from './assets';
import { SHELL_CSP } from './csp';

const SECURITY_HEADERS = {
  'Content-Security-Policy': SHELL_CSP,
  'X-Content-Type-Options': 'nosniff',
} as const;

/** Must run before `ready`. */
export function registerShellScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SHELL_SCHEME,
      // `standard` gives app://shell a real origin, `secure` makes it a secure context, and
      // `supportFetchAPI` lets the shell's own code fetch from it. Nothing else: no CORS, no
      // service workers, no CSP bypass.
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
  ]);
}

/** Serves the built renderer from `rendererRoot` on `session` only. */
export function handleShellProtocol(session: Session, rendererRoot: string): void {
  session.protocol.handle(SHELL_SCHEME, async (request) => {
    if (request.method !== 'GET') {
      return new Response(null, { status: 405, headers: SECURITY_HEADERS });
    }
    const asset = resolveShellAsset(rendererRoot, request.url);
    if (asset.kind === 'error') {
      return new Response(null, { status: asset.status, headers: SECURITY_HEADERS });
    }
    try {
      const body = await readFile(asset.path);
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': asset.contentType, ...SECURITY_HEADERS },
      });
    } catch {
      return new Response(null, { status: 404, headers: SECURITY_HEADERS });
    }
  });
}
