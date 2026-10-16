import { describe, expect, it } from 'vitest';

import { isNavigationAllowed, PDF_VIEWER_EXTENSION_ID } from './navigation-policy';
import type { WebContentsRole } from './web-contents-role';

const PDF_FRAME = `chrome-extension://${PDF_VIEWER_EXTENSION_ID}/index.html`;

const BLOB = 'blob:https://example.com/0b8a7c5e-8f0e-4b0e-9c2e-0d9f1a2b3c4d';
const DATA = 'data:text/html,<p>hello</p>';
const OPAQUE_BLOB = 'blob:null/0b8a7c5e-8f0e-4b0e-9c2e-0d9f1a2b3c4d';

const main = (url: string) => ({ url, isMainFrame: true });
const sub = (url: string) => ({ url, isMainFrame: false });

describe('isNavigationAllowed', () => {
  describe.each(['tab', 'popup'] as const)('a %s', (role) => {
    it.each([
      'https://example.com/',
      'http://127.0.0.1:8080/page?q=1#frag',
      'about:blank',
      'about:blank#top',
      // M1.3: sites open generated files in place.
      BLOB,
      'blob:http://127.0.0.1:8080/0b8a7c5e-8f0e-4b0e-9c2e-0d9f1a2b3c4d',
    ])('may navigate its main frame to %s', (url) => {
      expect(isNavigationAllowed(role, main(url))).toBe(true);
    });

    it.each([
      'https://example.com/frame',
      'about:blank',
      'about:srcdoc',
      PDF_FRAME,
      DATA,
      BLOB,
      // A sandboxed or data: frame's blobs have an opaque origin; they may load in frames.
      OPAQUE_BLOB,
    ])('may load %s in a subframe', (url) => {
      expect(isNavigationAllowed(role, sub(url))).toBe(true);
    });

    it.each([
      ['the PDF viewer as a page', PDF_FRAME],
      ['srcdoc as a page', 'about:srcdoc'],
      // Like Chrome: no renderer-initiated top-level data: navigation.
      ['a data: document as a page', DATA],
      ['a data: script page as a page', 'data:text/html,<script>alert(1)</script>'],
      ['a base64 data: page', 'data:text/html;base64,PHA+aGk8L3A+'],
      // Like data:, an opaque blob would show its content under no site's name.
      ['an opaque-origin blob: as a page', OPAQUE_BLOB],
      ['a file: blob as a page', 'blob:file:///0b8a7c5e-8f0e-4b0e-9c2e-0d9f1a2b3c4d'],
    ])('may not load %s in its main frame', (_label, url) => {
      expect(isNavigationAllowed(role, main(url))).toBe(false);
    });

    it.each([
      'veltriva://settings',
      'VELTRIVA://settings',
      'app://shell/index.html',
      'app://shell/../index.html',
      'file:///C:/Windows/win.ini',
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'ms-msdt:/id PCWDiagnostic',
      'search-ms:query=x',
      'mailto:someone@example.com',
      'chrome://settings',
      'devtools://devtools/bundled/devtools_app.html',
      'chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh/index.html',
      'about:settings',
      'not a url',
      '',
    ])('may not navigate any frame to %s', (url) => {
      expect(isNavigationAllowed(role, main(url))).toBe(false);
      expect(isNavigationAllowed(role, sub(url))).toBe(false);
    });
  });

  it.each(['shell', 'unknown'] as const satisfies readonly WebContentsRole[])(
    'a %s may not navigate anywhere',
    (role) => {
      for (const url of ['https://example.com/', 'about:blank', 'app://shell/index.html']) {
        expect(isNavigationAllowed(role, main(url))).toBe(false);
        expect(isNavigationAllowed(role, sub(url))).toBe(false);
      }
    },
  );
});
