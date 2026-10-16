// The shell's Content Security Policy (assessment §6.2). It's sent as a response header, not a
// <meta> tag, so `frame-ancestors` applies. `script-src` never relaxes in production.

const COMMON = [
  "default-src 'none'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
];

export const SHELL_CSP = [
  ...COMMON,
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
].join('; ');

/**
 * Development only, for the Vite dev server: React Fast Refresh injects an inline module script,
 * Vite injects <style> tags, and hot reload talks over a WebSocket to the dev server.
 */
export function devShellCsp(devServerOrigin: string): string {
  const url = new URL(devServerOrigin);
  if (url.protocol !== 'http:') {
    throw new Error('The dev server must be served over http');
  }
  const socketOrigin = `ws://${url.host}`;
  return [
    ...COMMON,
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${socketOrigin}`,
  ].join('; ');
}
