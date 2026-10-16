import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveShellAsset } from './assets';

const ROOT = resolve('C:\\app\\resources\\app.asar\\out\\renderer');

describe('resolveShellAsset', () => {
  it.each([
    ['app://shell/index.html', join(ROOT, 'index.html'), 'text/html; charset=utf-8'],
    ['app://shell/', join(ROOT, 'index.html'), 'text/html; charset=utf-8'],
    [
      'app://shell/assets/index-CfId2gVk.js',
      join(ROOT, 'assets', 'index-CfId2gVk.js'),
      'text/javascript; charset=utf-8',
    ],
    [
      'app://shell/assets/index-KYVAA-nw.css?v=1#x',
      join(ROOT, 'assets', 'index-KYVAA-nw.css'),
      'text/css; charset=utf-8',
    ],
    ['app://shell/fonts/Inter.WOFF2', join(ROOT, 'fonts', 'Inter.WOFF2'), 'font/woff2'],
    ['app://shell/a%20b.png', join(ROOT, 'a b.png'), 'image/png'],
  ])('serves %s', (url, path, contentType) => {
    expect(resolveShellAsset(ROOT, url)).toEqual({ kind: 'file', path, contentType });
  });

  it.each([
    // The URL parser itself removes plain and percent-encoded dot segments; what's left must
    // still resolve inside the root.
    'app://shell/../../../Windows/win.ini',
    'app://shell/%2e%2e/%2e%2e/Windows/win.ini',
    'app://shell/assets/..%2f..%2f..%2fpackage.json',
    'app://shell/..%2F..%2Fmain%2Findex.js',
    'app://shell/%2e%2e%2f%2e%2e%2fpackage.json',
  ])('never serves a file outside the renderer for %s', (url) => {
    const result = resolveShellAsset(ROOT, url);
    if (result.kind === 'file') {
      expect(result.path.startsWith(ROOT)).toBe(true);
      expect(result.path).not.toMatch(/win\.ini|package\.json|main/i);
    } else {
      expect(result.status).toBe(404);
    }
  });

  it.each([
    ['an encoded backslash', 'app://shell/..%5c..%5cmain%5cindex.js'],
    ['a drive letter', 'app://shell/C:/Windows/win.ini'],
    ['an encoded drive letter', 'app://shell/C%3A%5CWindows%5Cwin.ini'],
    ['an NTFS stream', 'app://shell/index.html::$DATA'],
    ['an encoded NUL', 'app://shell/index.html%00.png'],
    ['a malformed escape', 'app://shell/%E0%A4%A'],
  ])('rejects %s', (_label, url) => {
    expect(resolveShellAsset(ROOT, url)).toEqual({ kind: 'error', status: 400 });
  });

  it.each([
    ['another host', 'app://evil/index.html'],
    ['another scheme', 'veltriva://shell/index.html'],
    ['an unknown file type', 'app://shell/index.exe'],
    ['a source map', 'app://shell/assets/index.js.map'],
    ['a file without an extension', 'app://shell/assets/LICENSE'],
    ['a directory without a slash', 'app://shell/assets'],
  ])('returns 404 for %s', (_label, url) => {
    expect(resolveShellAsset(ROOT, url)).toEqual({ kind: 'error', status: 404 });
  });

  it('returns 400 for something that is not a URL', () => {
    expect(resolveShellAsset(ROOT, 'not a url')).toEqual({ kind: 'error', status: 400 });
  });
});
