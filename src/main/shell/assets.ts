// Maps an app://shell request to a file in the built renderer (ADR-0002, assessment §6.2).
// Pure, so the path-traversal defense is unit-tested: the decoded path is resolved under the
// renderer root and must still be inside it. Only known file types are served.
import { extname, resolve, sep } from 'node:path';

export const SHELL_SCHEME = 'app';
export const SHELL_HOST = 'shell';
export const SHELL_ORIGIN = `${SHELL_SCHEME}://${SHELL_HOST}`;
export const SHELL_URL = `${SHELL_ORIGIN}/index.html`;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export type ShellAsset =
  | { readonly kind: 'file'; readonly path: string; readonly contentType: string }
  | { readonly kind: 'error'; readonly status: 400 | 404 };

const NOT_FOUND = { kind: 'error', status: 404 } as const;
const BAD_REQUEST = { kind: 'error', status: 400 } as const;

export function resolveShellAsset(rendererRoot: string, requestUrl: string): ShellAsset {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return BAD_REQUEST;
  }
  if (url.protocol !== `${SHELL_SCHEME}:` || url.host !== SHELL_HOST) {
    return NOT_FOUND;
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return BAD_REQUEST;
  }
  // No NUL bytes, no backslashes (a second separator on Windows) and no colons (drive letters
  // and NTFS alternate data streams such as `index.html::$DATA`).
  if (/[\0\\:]/.test(pathname)) {
    return BAD_REQUEST;
  }

  const root = resolve(rendererRoot);
  const relative = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
  const path = resolve(root, `.${relative}`);
  if (!path.startsWith(root + sep)) {
    return NOT_FOUND;
  }

  const contentType = CONTENT_TYPES[extname(path).toLowerCase()];
  if (contentType === undefined) {
    return NOT_FOUND;
  }
  return { kind: 'file', path, contentType };
}
