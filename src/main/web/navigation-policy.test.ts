import { describe, expect, it } from 'vitest';

import { isNavigationAllowed, PDF_VIEWER_EXTENSION_ID } from './navigation-policy';
import type { WebContentsRole } from './web-contents-role';

const PDF_FRAME = `chrome-extension://${PDF_VIEWER_EXTENSION_ID}/index.html`;

const main = (url: string) => ({ url, isMainFrame: true });
const sub = (url: string) => ({ url, isMainFrame: false });

describe('isNavigationAllowed', () => {
  describe.each(['tab', 'popup'] as const)('a %s', (role) => {
    it.each([
      'https://example.com/',
      'http://127.0.0.1:8080/page?q=1#frag',
      'about:blank',
      'about:blank#top',
    ])('may navigate its main frame to %s', (url) => {
      expect(isNavigationAllowed(role, main(url))).toBe(true);
    });

    it.each(['https://example.com/frame', 'about:blank', 'about:srcdoc', PDF_FRAME])(
      'may load %s in a subframe',
      (url) => {
        expect(isNavigationAllowed(role, sub(url))).toBe(true);
      },
    );

    it.each([
      ['the PDF viewer as a page', PDF_FRAME],
      ['srcdoc as a page', 'about:srcdoc'],
    ])('may not load %s in its main frame', (_label, url) => {
      expect(isNavigationAllowed(role, main(url))).toBe(false);
    });

    it.each([
      'veltriva://settings',
      'VELTRIVA://settings',
      'app://shell/index.html',
      'app://shell/../index.html',
      'file:///C:/Windows/win.ini',
      'data:text/html,<script>alert(1)</script>',
      'blob:https://example.com/0b8a7c5e-8f0e-4b0e-9c2e-0d9f1a2b3c4d',
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
