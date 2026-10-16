// The orchestrator's own cases for the classifier. A separate, larger adversarial table lives in
// omnibox.table.test.ts.
import { describe, expect, it } from 'vitest';

import {
  buildSearchUrl,
  classifyOmniboxInput,
  DEFAULT_SEARCH_TEMPLATE,
  isPrivateIPv4,
  isPrivateIPv6,
  isValidSearchTemplate,
  sanitizeOmniboxInput,
} from './omnibox';
import type { OmniboxAction } from './omnibox';

const navigate = (url: string): OmniboxAction => ({ kind: 'navigate', url });
const search = (query: string): OmniboxAction => ({ kind: 'search', query });

describe('classifyOmniboxInput', () => {
  it.each([
    // Explicit http(s)
    ['https://example.com', navigate('https://example.com/')],
    ['HTTP://EXAMPLE.COM/Path', navigate('http://example.com/Path')],
    ['https://user:pass@example.com/x', navigate('https://example.com/x')],
    // No scheme: real public suffixes, IPs, localhost, ports
    ['example.com', navigate('https://example.com/')],
    ['github.io', navigate('https://github.io/')],
    ['foo.github.io/bar?q=1#h', navigate('https://foo.github.io/bar?q=1#h')],
    ['bücher.de', navigate('https://xn--bcher-kva.de/')],
    ['localhost', navigate('http://localhost/')],
    ['localhost:3000/app', navigate('http://localhost:3000/app')],
    ['app.localhost:5173', navigate('http://app.localhost:5173/')],
    ['192.168.1.1', navigate('http://192.168.1.1/')],
    ['10.0.0.2:8080', navigate('http://10.0.0.2:8080/')],
    ['8.8.8.8', navigate('https://8.8.8.8/')],
    ['[::1]:8080', navigate('http://[::1]:8080/')],
    ['[2001:db8::1]', navigate('https://[2001:db8::1]/')],
    ['intranet:8080', navigate('https://intranet:8080/')],
    // Searches
    ['hello', search('hello')],
    ['hello world', search('hello world')],
    ['foo.notatld', search('foo.notatld')],
    ['com', search('com')],
    ['1.1', search('1.1')],
    ['2130706433', search('2130706433')],
    ['0x7f.0.0.1', search('0x7f.0.0.1')],
    ['999.1.1.1', search('999.1.1.1')],
    ['someone@example.com', search('someone@example.com')],
    ['https://', search('https://')],
    ['? example.com', search('example.com')],
    // Dangerous or never-navigated schemes become searches
    ['javascript:alert(1)', search('javascript:alert(1)')],
    ['JaVaScRiPt:alert(1)', search('JaVaScRiPt:alert(1)')],
    [
      'data:text/html,<script>alert(1)</script>',
      search('data:text/html,<script>alert(1)</script>'),
    ],
    ['vbscript:msgbox', search('vbscript:msgbox')],
    ['app://shell/index.html', search('app://shell/index.html')],
    ['about:srcdoc', search('about:srcdoc')],
    ['veltriva://settings', search('veltriva://settings')],
    // Internal pages, about:blank, files
    ['veltriva://newtab', { kind: 'internal', page: 'new-tab' }],
    ['about:blank', navigate('about:blank')],
    ['file:///C:/Users/me/a.pdf', navigate('file:///C:/Users/me/a.pdf')],
    ['C:\\Users\\me\\My File.pdf', navigate('file:///C:/Users/me/My%20File.pdf')],
    // Other apps' schemes go to the external-protocol guard
    ['mailto:someone@example.com', { kind: 'external', url: 'mailto:someone@example.com' }],
    ['zoommtg:join?confno=1', { kind: 'external', url: 'zoommtg:join?confno=1' }],
    // Nothing to do
    ['', { kind: 'none' }],
    ['   ', { kind: 'none' }],
    ['?', { kind: 'none' }],
  ])('classifies %j', (input, expected) => {
    expect(classifyOmniboxInput(input)).toEqual(expected);
  });

  it('removes invisible and control characters before classifying', () => {
    expect(classifyOmniboxInput('java\nscript:alert(1)')).toEqual(search('javascript:alert(1)'));
    expect(classifyOmniboxInput('\u202eexample.com')).toEqual(navigate('https://example.com/'));
    expect(classifyOmniboxInput('exa\u200bmple.com')).toEqual(navigate('https://example.com/'));
  });
});

describe('sanitizeOmniboxInput', () => {
  it('trims, strips controls and caps the length', () => {
    expect(sanitizeOmniboxInput('  a\tb\r\nc\u0000  ')).toBe('abc');
    expect(sanitizeOmniboxInput('x'.repeat(10_000))).toHaveLength(8192);
  });
});

describe('private addresses', () => {
  it.each([
    ['10.1.2.3', true],
    ['127.0.0.1', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['192.168.0.1', true],
    ['169.254.10.10', true],
    ['100.64.0.1', true],
    ['100.128.0.1', false],
    ['8.8.8.8', false],
  ])('IPv4 %s is private: %s', (host, expected) => {
    expect(isPrivateIPv4(host)).toBe(expected);
  });

  it.each([
    ['[::1]', true],
    ['[fd12:3456::1]', true],
    ['[fe80::1]', true],
    ['[2001:db8::1]', false],
  ])('IPv6 %s is private: %s', (host, expected) => {
    expect(isPrivateIPv6(host)).toBe(expected);
  });
});

describe('search templates', () => {
  it('builds a search URL with the query encoded', () => {
    expect(buildSearchUrl(DEFAULT_SEARCH_TEMPLATE, 'a&b c/é')).toBe(
      'https://duckduckgo.com/?q=a%26b%20c%2F%C3%A9',
    );
  });

  it.each([
    ['https://search.example/?q={searchTerms}', true],
    ['http://127.0.0.1:4000/search?q={searchTerms}', true],
    ['http://localhost/search?q={searchTerms}', true],
    ['http://search.example/?q={searchTerms}', false],
    ['https://search.example/', false],
    ['javascript:{searchTerms}', false],
    ['not a url {searchTerms}', false],
  ])('%s is a valid template: %s', (template, expected) => {
    expect(isValidSearchTemplate(template)).toBe(expected);
  });

  it('refuses to build from an invalid template', () => {
    expect(() => buildSearchUrl('http://evil.example/?q={searchTerms}', 'x')).toThrow();
  });
});

// Regression cases for the findings of the independent table review (M1.3, D1–D8).
describe('review findings', () => {
  const external = (url: string): OmniboxAction => ({ kind: 'external', url });

  it.each([
    // D1: internal page names are looked up in a Map, never on an object's prototype chain.
    ['veltriva://constructor', search('veltriva://constructor')],
    ['veltriva://__proto__', search('veltriva://__proto__')],
    ['veltriva://hasOwnProperty', search('veltriva://hasOwnProperty')],
    ['veltriva://crashed', search('veltriva://crashed')],
    ['veltriva://NEWTAB', { kind: 'internal', page: 'new-tab' }],
    ['veltriva://newtab/', { kind: 'internal', page: 'new-tab' }],
    ['veltriva://newtab/x', search('veltriva://newtab/x')],
    ['veltriva://newtab?x=1', search('veltriva://newtab?x=1')],
    ['veltriva://newtab#x', search('veltriva://newtab#x')],
    ['veltriva://newtab:1', search('veltriva://newtab:1')],
    ['veltriva://user@newtab', search('veltriva://user@newtab')],
    // D2: an IPv4 address counts only when typed as the parser reads it (no octal or hex).
    ['010.0.0.1', search('010.0.0.1')],
    ['0127.0.0.1', search('0127.0.0.1')],
    ['192.168.001.001', search('192.168.001.001')],
    // D3: a typed port survives the switch to http, even https's default port.
    ['localhost:443', navigate('http://localhost:443/')],
    ['10.0.0.1:443', navigate('http://10.0.0.1:443/')],
    ['[::1]:443', navigate('http://[::1]:443/')],
    ['localhost:80', navigate('http://localhost/')],
    // D4: a colon alone doesn't make another app's scheme.
    ['tip: buy milk', search('tip: buy milk')],
    ['std::vector', search('std::vector')],
    ['fe80::1', search('fe80::1')],
    ['localhost:abc', search('localhost:abc')],
    ['example.com:', navigate('https://example.com/')],
    ['C:', search('C:')],
    ['c:foo', search('c:foo')],
    ['ms-settings:', external('ms-settings:')],
    ['xmpp:user@example.com', external('xmpp:user@example.com')],
    // Reads exactly like the line above; the external-protocol guard (M1.4) decides.
    ['user:pass@example.com', external('user:pass@example.com')],
    // D5: only an "@" before the path hides the host.
    ['youtube.com/@mkbhd', navigate('https://youtube.com/@mkbhd')],
    ['example.com?from=a@b.example', navigate('https://example.com/?from=a@b.example')],
    ['user@example.com/path', search('user@example.com/path')],
    // A backslash ends the host, for the parser too.
    ['example.com\\@evil.example', navigate('https://example.com/@evil.example')],
    // D7: "%", "#" and "?" stay part of a Windows file name.
    ['C:\\dir\\a#1.txt', navigate('file:///C:/dir/a%231.txt')],
    ['C:\\dir\\100%.txt', navigate('file:///C:/dir/100%25.txt')],
    ['C:\\dir\\a%20b.txt', navigate('file:///C:/dir/a%2520b.txt')],
    ['C:\\javascript:alert(1)', navigate('file:///C:/javascript:alert(1)')],
    // D8: more invisible characters are stripped.
    ['exa\u{e0041}mple.com', navigate('https://example.com/')],
    ['\u2028example.com', navigate('https://example.com/')],
    ['exa\u061cmple.com', navigate('https://example.com/')],
    ['exa\u180emple.com', navigate('https://example.com/')],
    ['exa\u206ample.com', navigate('https://example.com/')],
    // about:blank in any case; other Chromium-internal schemes are never navigated.
    ['ABOUT:BLANK', navigate('about:blank')],
    ['About:Blank#x', navigate('about:blank#x')],
    ['chrome-error://chromewebdata/', search('chrome-error://chromewebdata/')],
    ['chrome-untrusted://terminal/', search('chrome-untrusted://terminal/')],
    ['chrome-search://local-ntp/', search('chrome-search://local-ntp/')],
    ['chrome-devtools://devtools/', search('chrome-devtools://devtools/')],
    [
      'filesystem:https://a.example/temporary/x',
      search('filesystem:https://a.example/temporary/x'),
    ],
    ['isolated-app://abc/', search('isolated-app://abc/')],
    // IPv4-mapped private addresses use http.
    ['[::ffff:192.168.1.1]', navigate('http://[::ffff:c0a8:101]/')],
    // Network paths never open: Windows would connect over SMB with the user's credentials.
    ['\\\\server\\share', search('\\\\server\\share')],
    ['\\\\fileserver.example.com\\share', search('\\\\fileserver.example.com\\share')],
    ['file://server/share/a.txt', search('file://server/share/a.txt')],
    ['file:////server/share', search('file:////server/share')],
    ['file://///server/share', search('file://///server/share')],
    ['file:///\\\\server\\share', search('file:///\\\\server\\share')],
    ['file:///', search('file:///')],
    ['file://localhost/C:/x', navigate('file:///C:/x')],
    // Protocol-relative input with a real host still navigates.
    ['//example.com', navigate('https://example.com/')],
  ])('classifies %j', (input, expected) => {
    expect(classifyOmniboxInput(input)).toEqual(expected);
  });

  it('never leaves half a surrogate pair at the length cap (D6)', () => {
    const sanitized = sanitizeOmniboxInput(`${'a'.repeat(8191)}\u{1f600}`);
    expect(sanitized).toBe('a'.repeat(8191));
    expect(sanitized.isWellFormed()).toBe(true);
  });

  it('builds a search URL from text with a lone surrogate (D6)', () => {
    expect(sanitizeOmniboxInput('a\ud800b')).toBe('a\ufffdb');
    expect(buildSearchUrl(DEFAULT_SEARCH_TEMPLATE, 'a\udc00')).toBe(
      'https://duckduckgo.com/?q=a%EF%BF%BD',
    );
  });

  it.each([
    ['[::ffff:192.168.1.1]', true],
    ['[::ffff:c0a8:101]', true],
    ['[::ffff:7f00:1]', true],
    ['[::ffff:808:808]', false],
    ['[fe80::1]', true],
    ['[febf::1]', true],
    ['[fec0::1]', true],
    ['[fe8::1]', false],
    ['[fc00::1]', true],
    ['[fc0::1]', false],
  ])('IPv6 %s is private: %s', (host, expected) => {
    expect(isPrivateIPv6(host)).toBe(expected);
  });

  it.each([
    ['https://search.example/#q={searchTerms}', true],
    ['https://search.example/?q= {searchTerms}', false],
    ['https://search.example/\n?q={searchTerms}', false],
    ['https://{searchTerms}.example/', false],
    ['https://u:{searchTerms}@search.example/?q=x', false],
    ['https://{searchTerms}@search.example/', false],
    ['{searchTerms}://search.example/', false],
  ])('%j is a valid template: %s', (template, expected) => {
    expect(isValidSearchTemplate(template)).toBe(expected);
  });
});
