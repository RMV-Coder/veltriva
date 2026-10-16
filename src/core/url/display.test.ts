import { describe, expect, it } from 'vitest';

import { displayUrl, MAX_DISPLAY_LENGTH, originLabel } from './display';

describe('originLabel', () => {
  it.each([
    ['https://www.example.com/watch?v=1', 'www.example.com'],
    ['http://127.0.0.1:4173/page', '127.0.0.1:4173'],
    ['https://example.com:443/', 'example.com'],
    // Homographs show in punycode, as in the address bar.
    ['https://аpple.com/', 'xn--pple-43d.com'],
    // Credentials never make it into the notice.
    ['https://paypal.com@evil.example/', 'evil.example'],
    ['blob:https://video.example/0b8a', 'video.example'],
    ['blob:null/0b8a', 'This page'],
    ['file:///C:/movie.html', 'A local file'],
    ['about:blank', 'This page'],
    ['data:text/html,<title>fake.com</title>', 'This page'],
    ['not a url', 'This page'],
  ])('%s is %s', (url, expected) => {
    expect(originLabel(url)).toBe(expected);
  });
});

describe('displayUrl', () => {
  it.each([
    ['https://example.com/a?b#c', 'https://example.com/a?b#c', 'secure'],
    ['http://example.com/', 'http://example.com/', 'not-secure'],
    ['file:///C:/a.pdf', 'file:///C:/a.pdf', 'local'],
    ['veltriva://newtab', 'veltriva://newtab', 'internal'],
    ['about:blank', 'about:blank', 'neutral'],
    // A blob: document is as secure as the origin that made it.
    ['blob:https://example.com/0e1f', 'blob:https://example.com/0e1f', 'secure'],
    ['blob:http://example.com/0e1f', 'blob:http://example.com/0e1f', 'not-secure'],
    ['blob:null/0e1f', 'blob:null/0e1f', 'neutral'],
    ['blob:file:///0e1f', 'blob:file:///0e1f', 'neutral'],
    // Homographs: the host is shown in punycode.
    ['https://аpple.com/', 'https://xn--pple-43d.com/', 'secure'],
    ['https://bücher.de/', 'https://xn--bcher-kva.de/', 'secure'],
  ])('shows %s as %s (%s)', (url, text, security) => {
    expect(displayUrl(url)).toEqual({ text, security, hadCredentials: false });
  });

  it('strips credentials and reports that it did', () => {
    expect(displayUrl('https://paypal.com:secret@evil.example/login')).toEqual({
      text: 'https://evil.example/login',
      security: 'secure',
      hadCredentials: true,
    });
  });

  it('shows nothing for something that is not a URL', () => {
    expect(displayUrl('not a url')).toEqual({
      text: '',
      security: 'neutral',
      hadCredentials: false,
    });
  });

  it('cuts very long URLs', () => {
    const { text } = displayUrl(`https://example.com/?q=${'x'.repeat(5000)}`);
    expect(text).toHaveLength(MAX_DISPLAY_LENGTH + 1);
    expect(text.endsWith('…')).toBe(true);
  });
});
