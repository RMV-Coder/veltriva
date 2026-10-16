// Independent adversarial tables for the omnibox classifier (assessment §3.6, test list in §9.2)
// and for the address-bar display rules (§3.6 step 8). Each row is what §3.6 requires, worked out
// from the spec and then checked against the implementation. Inputs whose correct result is
// disputed are deliberately not in these tables.
//
// Test names are JSON with everything outside printable ASCII written as \u{...}, so homoglyphs,
// bidi controls and zero-width characters stay visible. The source does the same: look-alike
// characters are always escapes, never literals.
import { describe, expect, it } from 'vitest';

import { displayUrl, MAX_DISPLAY_LENGTH } from './display';
import type { SecurityState } from './display';
import {
  buildSearchUrl,
  classifyOmniboxInput,
  DEFAULT_SEARCH_TEMPLATE,
  isValidSearchTemplate,
  MAX_OMNIBOX_INPUT,
  sanitizeOmniboxInput,
} from './omnibox';
import type { OmniboxAction } from './omnibox';

const nav = (url: string): OmniboxAction => ({ kind: 'navigate', url });
const search = (query: string): OmniboxAction => ({ kind: 'search', query });
const external = (url: string): OmniboxAction => ({ kind: 'external', url });
const NEW_TAB: OmniboxAction = { kind: 'internal', page: 'new-tab' };
const NOTHING: OmniboxAction = { kind: 'none' };

/** [input, what the classifier must return, optional note for the test name]. */
type Case = readonly [input: string, expected: OmniboxAction, note?: string];

/** JSON for a string, clipped, with every non-printable-ASCII character escaped. */
function show(text: string): string {
  const clipped =
    text.length > 64 ? `${text.slice(0, 64)}... (${String(text.length)} chars)` : text;
  return JSON.stringify(clipped).replace(
    /[^\x20-\x7e]/gu,
    (character) => `\\u{${(character.codePointAt(0) ?? 0).toString(16)}}`,
  );
}

function describeAction(action: OmniboxAction): string {
  switch (action.kind) {
    case 'navigate':
      return `navigate ${show(action.url)}`;
    case 'search':
      return `search ${show(action.query)}`;
    case 'external':
      return `external ${show(action.url)}`;
    case 'internal':
      return `internal ${action.page}`;
    case 'none':
      return 'nothing';
  }
}

let classifierCases = 0;

function classifyTable(cases: readonly Case[]): void {
  for (const [input, expected, note] of cases) {
    classifierCases += 1;
    const title = `${show(input)} -> ${describeAction(expected)}${note === undefined ? '' : ` (${note})`}`;
    it(title, () => {
      expect(classifyOmniboxInput(input)).toEqual(expected);
    });
  }
}

describe('omnibox table', () => {
  describe('explicit http and https', () => {
    classifyTable([
      ['http://example.com', nav('http://example.com/')],
      ['HTTPS://EXAMPLE.COM', nav('https://example.com/'), 'scheme and host ignore case'],
      ['HtTpS://Example.Com/Path', nav('https://example.com/Path'), 'the path keeps its case'],
      ['https://example.com:443', nav('https://example.com/'), 'default port is dropped'],
      ['http://example.com:80/', nav('http://example.com/')],
      ['https://example.com:8443/x', nav('https://example.com:8443/x')],
      ['https://user@example.com', nav('https://example.com/'), 'credentials are removed'],
      ['https://:pass@example.com', nav('https://example.com/')],
      ['https://user:@example.com', nav('https://example.com/')],
      ['https://@example.com', nav('https://example.com/')],
      ['https://user:pass@example.com:8443/p?q#f', nav('https://example.com:8443/p?q#f')],
      ['https://a:b@c:d@example.com', nav('https://example.com/'), 'the host follows the last @'],
      ['https://example.com@evil.example/', nav('https://evil.example/'), 'the real host is evil'],
      ['http://example.com@evil.example', nav('http://evil.example/')],
      [
        'https://paypal.com:secret@evil.example:8443/login?x=1#y',
        nav('https://evil.example:8443/login?x=1#y'),
      ],
      [
        'https://example.com\\@evil.example/',
        nav('https://example.com/@evil.example/'),
        'a backslash ends the host',
      ],
      ['http://evil.example\\@example.com', nav('http://evil.example/@example.com')],
      ['http://user@[::1]/', nav('http://[::1]/')],
      ['http://localhost', nav('http://localhost/')],
      ['https://localhost:3000/a', nav('https://localhost:3000/a'), 'explicit https is kept'],
      ['http://[::1]/', nav('http://[::1]/')],
      ['https://[::1]/', nav('https://[::1]/'), 'explicit https is kept on a loopback address'],
      ['http://[::1]:3000', nav('http://[::1]:3000/')],
      ['https://example.com/a b', nav('https://example.com/a%20b'), 'a space in the path'],
      ['https:example.com', nav('https://example.com/'), 'slashes are optional'],
      ['https:///example.com', nav('https://example.com/')],
      ['https:\\\\example.com', nav('https://example.com/'), 'backslashes count as slashes'],
      ['http:/example.com', nav('http://example.com/')],
      ['https://example.com?x=1', nav('https://example.com/?x=1')],
      ['https://example.com#frag', nav('https://example.com/#frag')],
      ['https://example.com/\u{fc}', nav('https://example.com/%C3%BC')],
      ['https://example.com/%E2%82%AC', nav('https://example.com/%E2%82%AC'), 'no double encoding'],
      [
        'http://intranet/',
        nav('http://intranet/'),
        'an explicit scheme skips the single-word rule',
      ],
      ['http://www', nav('http://www/')],
      ['https://foo.notatld', nav('https://foo.notatld/'), 'and the public-suffix rule'],
      ['https://example.com./', nav('https://example.com./'), 'trailing dot is kept'],
      ['http://1.1.1.1', nav('http://1.1.1.1/'), 'explicit http on a public address'],
      [
        'https://example.com/?q=javascript:alert(1)',
        nav('https://example.com/?q=javascript:alert(1)'),
        'javascript: inside a query is only text',
      ],
      // Not valid URLs: there is nothing to navigate to, so the text is searched.
      ['http://', search('http://')],
      ['http:///', search('http:///')],
      ['http:', search('http:')],
      ['https:', search('https:')],
      ['https://exa mple.com', search('https://exa mple.com'), 'space in the host'],
      ['https://example.com:99999', search('https://example.com:99999'), 'port out of range'],
      ['https://example.com:abc', search('https://example.com:abc')],
      ['https://:80', search('https://:80'), 'port without a host'],
      ['http://256.256.256.256', search('http://256.256.256.256')],
      ['http://[::1', search('http://[::1')],
      ['https://[fe80::1%25en0]', search('https://[fe80::1%25en0]'), 'zone IDs are not URLs'],
      [
        'https://example.com%40evil.example/',
        search('https://example.com%40evil.example/'),
        'an encoded @ cannot be part of a host',
      ],
    ]);
  });

  describe('no scheme: hosts under real public suffixes', () => {
    classifyTable([
      ['EXAMPLE.COM', nav('https://example.com/'), 'the host is lowercased'],
      ['www.example.com', nav('https://www.example.com/')],
      ['a.b.c.example.co.uk', nav('https://a.b.c.example.co.uk/')],
      ['example.co.uk', nav('https://example.co.uk/'), 'multi-label suffix'],
      ['x.co.uk', nav('https://x.co.uk/')],
      ['example.com.br', nav('https://example.com.br/')],
      ['a.com.au', nav('https://a.com.au/')],
      ['bbc.co.uk/news', nav('https://bbc.co.uk/news')],
      ['example.com.', nav('https://example.com./'), 'a trailing dot is a fully qualified name'],
      ['blogspot.com', nav('https://blogspot.com/'), 'private suffix under an ICANN suffix'],
      ['foo.blogspot.com', nav('https://foo.blogspot.com/')],
      ['user.github.io', nav('https://user.github.io/')],
      ['example.pages.dev', nav('https://example.pages.dev/')],
      ['my.app', nav('https://my.app/')],
      ['foo.dev', nav('https://foo.dev/')],
      ['a.io', nav('https://a.io/')],
      ['x.xyz', nav('https://x.xyz/')],
      ['x.museum', nav('https://x.museum/')],
      ['example.technology', nav('https://example.technology/')],
      ['veltriva.com', nav('https://veltriva.com/')],
      ['xn--bcher-kva.de', nav('https://xn--bcher-kva.de/'), 'punycode is already ASCII'],
      ['example.xn--p1ai', nav('https://example.xn--p1ai/'), 'internationalised TLD'],
      // File-like names that happen to end in a country-code or generic TLD.
      ['readme.md', nav('https://readme.md/'), '.md is Moldova'],
      ['script.py', nav('https://script.py/'), '.py is Paraguay'],
      ['build.sh', nav('https://build.sh/'), '.sh is Saint Helena'],
      ['tool.rs', nav('https://tool.rs/')],
      ['x.zip', nav('https://x.zip/')],
      ['//example.com', nav('https://example.com/'), 'protocol-relative'],
      ['1.1.1.1.com', nav('https://1.1.1.1.com/'), 'an IP-looking prefix of a real domain'],
      ['127.0.0.1.nip.io', nav('https://127.0.0.1.nip.io/'), 'not an IP address'],
    ]);
  });

  describe('no scheme: unknown suffixes, single words and odd shapes', () => {
    classifyTable([
      ['example.invalid', search('example.invalid')],
      ['example.local', search('example.local')],
      ['example.test', search('example.test')],
      ['example.example', search('example.example')],
      ['router.lan', search('router.lan')],
      ['host.internal', search('host.internal')],
      ['printer.home', search('printer.home')],
      ['file.exe', search('file.exe')],
      ['index.html', search('index.html')],
      ['main.ts', search('main.ts')],
      ['package.json', search('package.json')],
      ['node.js', search('node.js')],
      ['Next.js', search('Next.js')],
      ['archive.tar.gz', search('archive.tar.gz')],
      ['main.go', search('main.go')],
      ['photo.jpg', search('photo.jpg')],
      ['notes.txt', search('notes.txt')],
      ['example.c0m', search('example.c0m')],
      ['example.c', search('example.c')],
      ['example.comm', search('example.comm')],
      ['foo.bar.baz', search('foo.bar.baz')],
      ['a.b', search('a.b')],
      ['intranet', search('intranet'), 'no intranet guessing'],
      ['wiki', search('wiki')],
      ['newtab', search('newtab')],
      ['veltriva', search('veltriva')],
      ['http', search('http')],
      ['https', search('https')],
      ['uk', search('uk'), 'a bare suffix'],
      ['co.uk', search('co.uk'), 'a public suffix with no registrable name'],
      ['com.au', search('com.au')],
      ['.com', search('.com')],
      ['example..com', search('example..com'), 'empty label'],
      ['https//example.com', search('https//example.com'), 'the colon is missing'],
    ]);
  });

  describe('no scheme: paths, queries and fragments', () => {
    classifyTable([
      ['example.com/', nav('https://example.com/')],
      [
        'example.com/path/to?x=1&y=2#frag',
        nav('https://example.com/path/to?x=1&y=2#frag'),
        'every component survives',
      ],
      ['example.com?q=1', nav('https://example.com/?q=1')],
      ['example.com#top', nav('https://example.com/#top')],
      ['EXAMPLE.COM/PATH', nav('https://example.com/PATH'), 'only the host is lowercased'],
      ['example.com/p%20q', nav('https://example.com/p%20q'), 'no double encoding'],
      ['example.com/\u{fc}', nav('https://example.com/%C3%BC')],
      ['example.com/?q=\u{fc}', nav('https://example.com/?q=%C3%BC')],
      ['example.com#\u{fc}', nav('https://example.com/#%C3%BC')],
      ['example.com/<b>', nav('https://example.com/%3Cb%3E'), 'angle brackets are encoded'],
      ['example.com/"q"', nav('https://example.com/%22q%22')],
      ['example.com\\path', nav('https://example.com/path'), 'a backslash is a slash'],
      ['example.com/javascript:alert(1)', nav('https://example.com/javascript:alert(1)')],
      ['example.com:8080/path?q#f', nav('https://example.com:8080/path?q#f')],
      ['www.example.com:8080/a/b?c=d&e=f#g', nav('https://www.example.com:8080/a/b?c=d&e=f#g')],
      // Whitespace anywhere inside makes it a search.
      ['foo bar', search('foo bar')],
      ['example.com is great', search('example.com is great')],
      ['example.com/path with space', search('example.com/path with space')],
      ['localhost 3000', search('localhost 3000')],
      ['what is 1.1.1.1', search('what is 1.1.1.1')],
      // Not hosts at all.
      ['/', search('/')],
      ['//', search('//')],
      ['///', search('///')],
      ['/etc/passwd', search('/etc/passwd')],
      ['~/Documents', search('~/Documents')],
      ['./foo.html', search('./foo.html')],
      ['#anchor', search('#anchor')],
      ['#', search('#')],
      ['a#b', search('a#b')],
      [':', search(':')],
      ['::', search('::')],
      ['\\', search('\\')],
      ['.', search('.')],
      ['..', search('..')],
      ['-', search('-')],
    ]);
  });

  describe('IPv4', () => {
    classifyTable([
      // Private, loopback, link-local and carrier-grade NAT ranges use http.
      ['10.0.0.1', nav('http://10.0.0.1/')],
      ['10.255.255.255', nav('http://10.255.255.255/')],
      ['172.16.0.1', nav('http://172.16.0.1/'), '172.16.0.0/12 starts here'],
      ['172.31.255.255', nav('http://172.31.255.255/'), 'and ends here'],
      ['172.15.255.255', nav('https://172.15.255.255/'), 'one below the range'],
      ['172.32.0.0', nav('https://172.32.0.0/'), 'one above the range'],
      ['192.168.0.1', nav('http://192.168.0.1/')],
      ['192.167.255.255', nav('https://192.167.255.255/')],
      ['192.169.0.1', nav('https://192.169.0.1/')],
      ['127.0.0.1', nav('http://127.0.0.1/')],
      ['127.1.2.3', nav('http://127.1.2.3/'), 'all of 127.0.0.0/8 is loopback'],
      ['169.254.169.254', nav('http://169.254.169.254/'), 'link-local'],
      ['169.253.0.1', nav('https://169.253.0.1/')],
      ['100.64.0.0', nav('http://100.64.0.0/'), 'carrier-grade NAT starts here'],
      ['100.127.255.255', nav('http://100.127.255.255/'), 'and ends here'],
      ['100.63.255.255', nav('https://100.63.255.255/')],
      ['100.128.0.0', nav('https://100.128.0.0/')],
      // Public addresses use https.
      ['1.1.1.1', nav('https://1.1.1.1/')],
      ['203.0.113.5', nav('https://203.0.113.5/')],
      ['1.1.1.1/', nav('https://1.1.1.1/')],
      ['192.168.1.1/path?q=1#h', nav('http://192.168.1.1/path?q=1#h')],
      ['192.168.1.1:8080/admin', nav('http://192.168.1.1:8080/admin')],
      ['127.0.0.1:3000', nav('http://127.0.0.1:3000/')],
      ['10.0.0.1:80', nav('http://10.0.0.1/'), 'port 80 is the http default'],
      ['8.8.8.8:8443', nav('https://8.8.8.8:8443/')],
      ['8.8.8.8:443', nav('https://8.8.8.8/'), 'port 443 is the https default'],
      // Only a full dotted quad of ASCII decimal numbers is an address.
      ['127.1', search('127.1'), 'short form'],
      ['127.0.1', search('127.0.1')],
      ['192.168.1', search('192.168.1')],
      ['0x7f000001', search('0x7f000001'), 'hex'],
      ['017700000001', search('017700000001'), 'octal integer'],
      ['4294967295', search('4294967295'), 'decimal integer'],
      ['0177.0.0.1', search('0177.0.0.1'), 'octal octet'],
      ['192.168.08.1', search('192.168.08.1'), '08 is not octal'],
      ['256.1.1.1', search('256.1.1.1'), 'octet out of range'],
      ['1.2.3.256', search('1.2.3.256')],
      ['300.300.300.300', search('300.300.300.300')],
      ['1.2.3.4.5', search('1.2.3.4.5'), 'five octets'],
      ['1.1.1.1.1.1', search('1.1.1.1.1.1')],
      ['-1.1.1.1', search('-1.1.1.1')],
      ['+1.1.1.1', search('+1.1.1.1')],
      ['1..1.1', search('1..1.1')],
      ['.1.1.1.1', search('.1.1.1.1')],
      ['1 .1.1.1', search('1 .1.1.1')],
    ]);
  });

  describe('IPv6', () => {
    classifyTable([
      ['[::1]', nav('http://[::1]/'), 'loopback'],
      ['[0:0:0:0:0:0:0:1]', nav('http://[::1]/'), 'the long form is normalised'],
      ['[::1]/path?x#y', nav('http://[::1]/path?x#y')],
      ['[fe80::1]', nav('http://[fe80::1]/'), 'link-local'],
      ['[fe80::1]:80', nav('http://[fe80::1]/')],
      ['[febf::1]', nav('http://[febf::1]/'), 'last block of fe80::/10'],
      ['[fe7f::1]', nav('https://[fe7f::1]/'), 'just below it'],
      ['[fd00::1]', nav('http://[fd00::1]/'), 'unique local'],
      ['[fc00::1]', nav('http://[fc00::1]/')],
      ['[FD12:3456::1]', nav('http://[fd12:3456::1]/'), 'hex digits are lowercased'],
      ['[fbff::1]', nav('https://[fbff::1]/'), 'just below fc00::/7'],
      ['[2001:DB8::1]', nav('https://[2001:db8::1]/')],
      ['[2001:db8::1]:8443/x', nav('https://[2001:db8::1]:8443/x')],
      ['[2606:4700:4700::1111]', nav('https://[2606:4700:4700::1111]/')],
      ['[1::]', nav('https://[1::]/')],
      ['[::2]', nav('https://[::2]/'), 'only ::1 is loopback'],
      // Malformed literals are searches.
      ['[::1', search('[::1'), 'missing bracket'],
      ['::1]', search('::1]')],
      ['[::1]]', search('[::1]]')],
      ['[]', search('[]')],
      ['[::1]x', search('[::1]x')],
      ['[1:2:3:4:5:6:7:8:9]', search('[1:2:3:4:5:6:7:8:9]'), 'nine groups'],
      ['[gggg::1]', search('[gggg::1]')],
      ['[::1]:99999', search('[::1]:99999')],
      ['[::1]:abc', search('[::1]:abc')],
      ['[fe80::1%25eth0]', search('[fe80::1%25eth0]'), 'zone ID, encoded'],
      ['[fe80::1%eth0]', search('[fe80::1%eth0]'), 'zone ID, raw'],
      ['[ ::1]', search('[ ::1]')],
      ['[::1]@evil.com', search('[::1]@evil.com')],
      ['user@[::1]', search('user@[::1]')],
      ['user@[::1]:80', search('user@[::1]:80')],
    ]);
  });

  describe('ports', () => {
    classifyTable([
      ['example.com:8080', nav('https://example.com:8080/')],
      ['example.com:443', nav('https://example.com/'), 'the https default port is dropped'],
      ['example.com:80', nav('https://example.com:80/'), 'port 80 is not the https default'],
      ['example.com:65535', nav('https://example.com:65535/')],
      ['example.com:08080', nav('https://example.com:8080/'), 'leading zeros'],
      ['example.com:65536', search('example.com:65536'), 'out of range'],
      ['foo.notatld:3000', nav('https://foo.notatld:3000/'), 'an explicit port makes it a URL'],
      ['foo:8080', nav('https://foo:8080/'), 'a single word with a port'],
      ['foo.bar:9000', nav('https://foo.bar:9000/')],
      ['myhost:3000/x', nav('https://myhost:3000/x')],
      ['localhost:3000', nav('http://localhost:3000/')],
      ['LOCALHOST:3000', nav('http://localhost:3000/')],
      ['localhost:8443', nav('http://localhost:8443/')],
      ['localhost:80', nav('http://localhost/')],
      ['localhost:8080/', nav('http://localhost:8080/')],
      ['localhost:8080?x=1', nav('http://localhost:8080/?x=1')],
      ['localhost:8080#h', nav('http://localhost:8080/#h')],
      ['localhost:3000/#/route', nav('http://localhost:3000/#/route')],
      ['localhost:99999', search('localhost:99999')],
      ['localhost:65536', search('localhost:65536')],
      ['intranet:65536', search('intranet:65536')],
      ['foo.localhost', nav('http://foo.localhost/'), 'a name under .localhost is local'],
      ['a.b.localhost/x', nav('http://a.b.localhost/x')],
      ['app.localhost', nav('http://app.localhost/')],
      ['LOCALHOST', nav('http://localhost/')],
      // Digits after the colon of a known scheme stay part of that scheme.
      ['tel:5551234', external('tel:5551234')],
      ['mailto:123', external('mailto:123')],
      ['sms:5551234', external('sms:5551234')],
      ['javascript:80', search('javascript:80')],
      ['data:80', search('data:80')],
      ['chrome:80', search('chrome:80')],
      ['veltriva:80', search('veltriva:80')],
      ['about:80', search('about:80')],
    ]);
  });

  describe('IDN, homographs and look-alike characters', () => {
    classifyTable([
      // Navigated, but always as punycode, so that the host cannot pass for another one.
      ['\u{430}pple.com', nav('https://xn--pple-43d.com/'), 'Cyrillic a'],
      ['ex\u{430}mple.com', nav('https://xn--exmple-4nf.com/'), 'Cyrillic a in the middle'],
      ['googl\u{435}.com', nav('https://xn--googl-3we.com/'), 'Cyrillic e at the end'],
      ['\u{3c1}aypal.com', nav('https://xn--aypal-2ce.com/'), 'Greek rho for p'],
      [
        '\u{430}\u{440}\u{440}\u{4cf}\u{435}.com',
        nav('https://xn--80ak6aa92e.com/'),
        'whole-script Cyrillic apple',
      ],
      [
        '\u{43f}\u{440}\u{438}\u{43c}\u{435}\u{440}.\u{440}\u{444}',
        nav('https://xn--e1afmkfd.xn--p1ai/'),
      ],
      ['\u{44f}\u{43d}\u{434}\u{435}\u{43a}\u{441}.com', nav('https://xn--d1acpjx3f.com/')],
      ['\u{4f8b}\u{3048}.jp', nav('https://xn--r8jz45g.jp/')],
      ['\u{65e5}\u{672c}\u{8a9e}.jp', nav('https://xn--wgv71a119e.jp/')],
      ['\u{3b1}\u{3b2}\u{3b3}.gr', nav('https://xn--mxacd.gr/')],
      ['m\u{fc}nchen.de', nav('https://xn--mnchen-3ya.de/')],
      ['M\u{dc}NCHEN.DE', nav('https://xn--mnchen-3ya.de/'), 'upper case is folded first'],
      ['stra\u{df}e.de', nav('https://xn--strae-oqa.de/'), 'the sharp s is kept'],
      ['caf\u{e9}.fr', nav('https://xn--caf-dma.fr/'), 'precomposed'],
      ['cafe\u{301}.fr', nav('https://xn--caf-dma.fr/'), 'decomposed gives the same host'],
      ['\u{1f4a9}.la', nav('https://xn--ls8h.la/'), 'emoji'],
      // Compatibility characters fold to ASCII.
      [
        '\u{ff45}\u{ff58}\u{ff41}\u{ff4d}\u{ff50}\u{ff4c}\u{ff45}\u{ff0e}\u{ff43}\u{ff4f}\u{ff4d}',
        nav('https://example.com/'),
        'full-width letters and full stop',
      ],
      ['example\u{3002}com', nav('https://example.com/'), 'ideographic full stop'],
      ['example\u{ff61}com', nav('https://example.com/'), 'half-width ideographic full stop'],
      ['example\u{ff0e}com/path', nav('https://example.com/path')],
      ['exa\u{ad}mple.com', nav('https://example.com/'), 'a soft hyphen is ignored'],
      // Punycode typed directly.
      ['xn--pple-43d.com', nav('https://xn--pple-43d.com/')],
      ['XN--PPLE-43D.COM', nav('https://xn--pple-43d.com/'), 'the prefix ignores case'],
      ['xn--ls8h.la', nav('https://xn--ls8h.la/')],
      ['xn--a.com', search('xn--a.com'), 'invalid punycode'],
      ['xn--.com', search('xn--.com')],
      // Mixed scripts under a name that is not a TLD stay a search.
      ['ex\u{430}mple.\u{43a}om', search('ex\u{430}mple.\u{43a}om'), 'Cyrillic k in the TLD'],
      [
        '\u{43f}\u{440}\u{438}\u{43c}\u{435}\u{440}.\u{438}\u{441}\u{43f}\u{44b}\u{442}\u{430}\u{43d}\u{438}\u{435}',
        search(
          '\u{43f}\u{440}\u{438}\u{43c}\u{435}\u{440}.\u{438}\u{441}\u{43f}\u{44b}\u{442}\u{430}\u{43d}\u{438}\u{435}',
        ),
        'IDN test TLD',
      ],
      // Explicit scheme with a look-alike host.
      ['https://\u{430}pple.com', nav('https://xn--pple-43d.com/')],
      ['https://\u{ff45}xample.com', nav('https://example.com/')],
      [
        'https://\u{430}pple.com@evil.example/',
        nav('https://evil.example/'),
        'look-alike userinfo',
      ],
      // Full-width and other look-alike punctuation never forms a scheme or a path.
      [
        '\u{ff48}\u{ff54}\u{ff54}\u{ff50}\u{ff53}\u{ff1a}\u{ff0f}\u{ff0f}example.com',
        search('\u{ff48}\u{ff54}\u{ff54}\u{ff50}\u{ff53}\u{ff1a}\u{ff0f}\u{ff0f}example.com'),
        'full-width https://',
      ],
      ['exam\u{ff0f}ple.com', search('exam\u{ff0f}ple.com'), 'full-width slash'],
      ['javascript\u{ff1a}alert(1)', search('javascript\u{ff1a}alert(1)'), 'full-width colon'],
      [
        '\u{ff4a}\u{ff41}\u{ff56}\u{ff41}\u{ff53}\u{ff43}\u{ff52}\u{ff49}\u{ff50}\u{ff54}\u{ff1a}alert(1)',
        search(
          '\u{ff4a}\u{ff41}\u{ff56}\u{ff41}\u{ff53}\u{ff43}\u{ff52}\u{ff49}\u{ff50}\u{ff54}\u{ff1a}alert(1)',
        ),
        'full-width javascript:',
      ],
      [
        'j\u{430}vascript:alert(1)',
        search('j\u{430}vascript:alert(1)'),
        'Cyrillic a in the scheme',
      ],
      [
        'java\u{ad}script:alert(1)',
        search('java\u{ad}script:alert(1)'),
        'soft hyphen in the scheme',
      ],
      ['veltriva\u{ff1a}//newtab', search('veltriva\u{ff1a}//newtab')],
    ]);
  });

  describe('whitespace and invisible characters', () => {
    classifyTable([
      // Trimmed.
      ['  example.com  ', nav('https://example.com/')],
      ['\texample.com\n', nav('https://example.com/')],
      ['\r\nexample.com\r\n', nav('https://example.com/')],
      [' \u{a0}example.com\u{a0} ', nav('https://example.com/'), 'no-break spaces'],
      ['\u{3000}example.com\u{3000}', nav('https://example.com/'), 'ideographic spaces'],
      ['\u{2007}example.com', nav('https://example.com/'), 'figure space'],
      ['\u{200a}example.com', nav('https://example.com/'), 'hair space'],
      ['\u{1680}example.com', nav('https://example.com/'), 'ogham space mark'],
      ['\u{205f}example.com', nav('https://example.com/'), 'medium mathematical space'],
      ['\u{2029}example.com', nav('https://example.com/'), 'paragraph separator'],
      ['example.com\u{2028}', nav('https://example.com/'), 'line separator'],
      // Stripped, even in the middle.
      ['example.com\u{0}', nav('https://example.com/'), 'NUL'],
      ['exam\u{0}ple.com', nav('https://example.com/')],
      ['example\n.com', nav('https://example.com/'), 'a newline inside a host'],
      ['example.com\u{7}', nav('https://example.com/'), 'bell'],
      ['\u{7f}example.com', nav('https://example.com/'), 'DEL'],
      ['example.com\u{85}', nav('https://example.com/'), 'C1 next line'],
      ['\u{9f}example.com', nav('https://example.com/'), 'last C1 control'],
      ['\u{b}example.com', nav('https://example.com/'), 'vertical tab'],
      ['\u{c}example.com', nav('https://example.com/'), 'form feed'],
      ['\u{1f}example.com', nav('https://example.com/'), 'last C0 control'],
      ['\u{202e}example.com', nav('https://example.com/'), 'right-to-left override'],
      ['\u{202d}example.com\u{202c}', nav('https://example.com/'), 'left-to-right override, pop'],
      ['\u{2066}example.com\u{2069}', nav('https://example.com/'), 'isolates'],
      ['\u{200e}example.com', nav('https://example.com/'), 'left-to-right mark'],
      ['\u{200f}example.com', nav('https://example.com/'), 'right-to-left mark'],
      ['exam\u{200d}ple.com', nav('https://example.com/'), 'zero-width joiner'],
      ['exam\u{200c}ple.com', nav('https://example.com/'), 'zero-width non-joiner'],
      ['\u{200b}example.com', nav('https://example.com/'), 'zero-width space'],
      ['\u{feff}example.com', nav('https://example.com/'), 'byte order mark'],
      ['example\u{2060}.com', nav('https://example.com/'), 'word joiner'],
      ['\u{ad}example.com', nav('https://example.com/'), 'soft hyphen, ignored by the host parser'],
      ['ht\ttp://example.com', nav('http://example.com/'), 'tab inside the scheme'],
      ['https://exa\nmple.com', nav('https://example.com/')],
      // Whitespace that survives sanitising makes it a search.
      ['exam ple.com', search('exam ple.com')],
      ['exam\u{a0}ple.com', search('exam\u{a0}ple.com'), 'no-break space inside'],
      ['exam\u{3000}ple.com', search('exam\u{3000}ple.com'), 'ideographic space inside'],
      ['hello\nworld', search('helloworld'), 'the newline is removed, not replaced'],
      ['hello\tworld', search('helloworld')],
      ['hello \nworld', search('hello world')],
      ['\u{a0}foo\u{a0}bar\u{a0}', search('foo\u{a0}bar')],
      ['foo\u{a0}', search('foo')],
      // Nothing left.
      ['\u{a0}', NOTHING],
      ['\u{200b}', NOTHING],
      ['\u{0}', NOTHING],
      ['\u{202e}', NOTHING],
      ['\u{3000}', NOTHING],
      ['\u{feff}', NOTHING],
      [' \t\r\n', NOTHING],
      [' ? ', NOTHING, 'only the search marker'],
      ['?\u{200b}', NOTHING],
      ['?\n', NOTHING],
      // Forced search.
      ['?foo', search('foo')],
      ['\t?foo', search('foo')],
      ['?  foo  bar ', search('foo  bar'), 'inner spacing is kept'],
      ['??', search('?'), 'only the first ? is the marker'],
      ['?example.com', search('example.com'), 'a host after ? is still a search'],
      ['?https://example.com', search('https://example.com')],
      ['?javascript:alert(1)', search('javascript:alert(1)')],
      ['?C:\\x', search('C:\\x'), 'a drive path after ? is still a search'],
    ]);

    it('sanitizeOmniboxInput strips, trims and cuts in that order', () => {
      expect(sanitizeOmniboxInput('')).toBe('');
      expect(sanitizeOmniboxInput('  \u{a0}\t')).toBe('');
      expect(sanitizeOmniboxInput('a\u{0}b\u{202e}c\u{200b}d\u{2066}e\u{feff}f')).toBe('abcdef');
      expect(sanitizeOmniboxInput('\u{a0}a b\u{3000}')).toBe('a b');
      expect(sanitizeOmniboxInput('a'.repeat(8191) + ' b')).toBe('a'.repeat(8191));
    });
  });

  describe('length cap', () => {
    it('is 8192 characters', () => {
      expect(MAX_OMNIBOX_INPUT).toBe(8192);
    });

    it('keeps input of exactly 8192 characters whole', () => {
      expect(classifyOmniboxInput('a'.repeat(8192))).toEqual(search('a'.repeat(8192)));
    });

    it('cuts input of 8193 characters to 8192', () => {
      expect(classifyOmniboxInput('a'.repeat(8193))).toEqual(search('a'.repeat(8192)));
    });

    it('cuts input of 20000 characters to 8192', () => {
      expect(classifyOmniboxInput('a'.repeat(20_000))).toEqual(search('a'.repeat(8192)));
    });

    it('cuts a long explicit URL to 8192 characters before parsing it', () => {
      expect(classifyOmniboxInput(`https://example.com/${'a'.repeat(10_000)}`)).toEqual(
        nav(`https://example.com/${'a'.repeat(8172)}`),
      );
    });

    it('applies the cap to what was typed, not to the inferred URL', () => {
      expect(classifyOmniboxInput(`example.com/${'a'.repeat(10_000)}`)).toEqual(
        nav(`https://example.com/${'a'.repeat(8180)}`),
      );
    });

    it('cuts a long javascript: payload and still searches it', () => {
      expect(classifyOmniboxInput(`javascript:${'a'.repeat(9000)}`)).toEqual(
        search(`javascript:${'a'.repeat(8181)}`),
      );
    });

    it('cuts a long forced search to 8191 characters after the marker', () => {
      expect(classifyOmniboxInput(`?${'a'.repeat(9000)}`)).toEqual(search('a'.repeat(8191)));
    });

    it('cuts a long file URL', () => {
      expect(classifyOmniboxInput(`file:///C:/${'a'.repeat(9000)}`)).toEqual(
        nav(`file:///C:/${'a'.repeat(8181)}`),
      );
    });

    it('cuts a long run of words and trims what is left', () => {
      expect(classifyOmniboxInput('word '.repeat(3000))).toEqual(
        search(`${'word '.repeat(1638)}wo`),
      );
    });

    it('trims after cutting, so a trailing space at the cut disappears', () => {
      expect(classifyOmniboxInput(`${'a'.repeat(8191)} b`)).toEqual(search('a'.repeat(8191)));
    });

    it('removes control characters before cutting, so they cannot push text out', () => {
      expect(classifyOmniboxInput(`${'a'.repeat(8190)}${'\u{0}'.repeat(100)}bcdef`)).toEqual(
        search(`${'a'.repeat(8190)}bc`),
      );
    });

    it('trims leading padding before cutting, so spaces cannot push text out', () => {
      expect(classifyOmniboxInput(`${' '.repeat(9000)}hello`)).toEqual(search('hello'));
    });

    it('trims trailing padding', () => {
      expect(classifyOmniboxInput(`hello${' '.repeat(9000)}`)).toEqual(search('hello'));
    });

    it('finds nothing in a huge run of whitespace, NULs or zero-width characters', () => {
      expect(classifyOmniboxInput(' '.repeat(20_000))).toEqual(NOTHING);
      expect(classifyOmniboxInput('\u{0}'.repeat(20_000))).toEqual(NOTHING);
      expect(classifyOmniboxInput('\u{200b}'.repeat(20_000))).toEqual(NOTHING);
    });
  });

  describe('internal pages', () => {
    classifyTable([
      ['VELTRIVA://newtab', NEW_TAB, 'the scheme ignores case'],
      ['veltriva://newtab/', NEW_TAB, 'trailing slash'],
      ['veltriva://newtab ', NEW_TAB],
      ['  veltriva://newtab  ', NEW_TAB],
      ['veltriva\t://newtab', NEW_TAB, 'sanitised before parsing'],
      ['veltriva://new\ntab', NEW_TAB],
      ['veltriva://newt\u{200b}ab', NEW_TAB],
      // Only the allow-listed names open anything.
      ['veltriva://new-tab', search('veltriva://new-tab'), 'the page id is not its typeable name'],
      ['veltriva://network-error', search('veltriva://network-error')],
      ['veltriva://crashed', search('veltriva://crashed')],
      ['veltriva://prototype', search('veltriva://prototype')],
      ['veltriva://newtab.', search('veltriva://newtab.')],
      ['veltriva://new tab', search('veltriva://new tab')],
      ['veltriva://%6Eewtab', search('veltriva://%6Eewtab'), 'percent-encoding is not decoded'],
      ['veltriva://newtab%2e', search('veltriva://newtab%2e')],
      ['veltriva://\u{ff4e}ewtab', search('veltriva://\u{ff4e}ewtab'), 'full-width n'],
      ['veltriva://newtab\\evil', search('veltriva://newtab\\evil')],
      ['veltriva://newtab@evil', search('veltriva://newtab@evil'), 'newtab is the userinfo'],
      ['veltriva://newtab@evil.com/', search('veltriva://newtab@evil.com/')],
      // Not the veltriva://<name> form.
      ['veltriva:newtab', search('veltriva:newtab'), 'no slashes'],
      ['veltriva:/newtab', search('veltriva:/newtab')],
      ['veltriva:///newtab', search('veltriva:///newtab'), 'empty host'],
      ['veltriva:\\\\newtab', search('veltriva:\\\\newtab')],
      ['veltriva://', search('veltriva://')],
      ['veltriva:', search('veltriva:')],
      ['about:veltriva://newtab', search('about:veltriva://newtab')],
      // Other URLs that merely look similar.
      ['https://newtab', nav('https://newtab/'), 'explicit https, any host'],
    ]);
  });

  describe('never-navigated schemes', () => {
    classifyTable([
      // javascript:
      ['JAVASCRIPT:alert(1)', search('JAVASCRIPT:alert(1)'), 'the search keeps the typed case'],
      ['jAvAsCrIpT:alert(1)', search('jAvAsCrIpT:alert(1)')],
      ['  javascript:alert(1)', search('javascript:alert(1)'), 'leading spaces'],
      ['\tjavascript:alert(1)\n', search('javascript:alert(1)')],
      ['java\tscript:alert(1)', search('javascript:alert(1)'), 'tab inside the scheme'],
      ['java\r\nscript:alert(1)', search('javascript:alert(1)')],
      ['java\u{0}script:alert(1)', search('javascript:alert(1)'), 'NUL inside the scheme'],
      ['j\u{200b}avascript:alert(1)', search('javascript:alert(1)'), 'zero-width space'],
      ['java\u{202e}script:alert(1)', search('javascript:alert(1)'), 'bidi override'],
      ['java\u{200d}script:alert(1)', search('javascript:alert(1)'), 'zero-width joiner'],
      ['\u{1}javascript:alert(1)', search('javascript:alert(1)'), 'leading control character'],
      ['javascript:', search('javascript:')],
      ['javascript:void(0)', search('javascript:void(0)')],
      ['javascript://%0aalert(1)', search('javascript://%0aalert(1)'), 'comment-newline trick'],
      [
        'javascript://example.com/%0Aalert(1)',
        search('javascript://example.com/%0Aalert(1)'),
        'looks like a URL',
      ],
      [
        'javascript:alert(1)//https://example.com',
        search('javascript:alert(1)//https://example.com'),
        'a URL after the payload',
      ],
      ['%6Aavascript:alert(1)', search('%6Aavascript:alert(1)'), 'an encoded scheme is no scheme'],
      ['javascript&colon;alert(1)', search('javascript&colon;alert(1)'), 'an HTML entity'],
      ['javascript%3Aalert(1)', search('javascript%3Aalert(1)'), 'an encoded colon'],
      ['javascript\u{a0}:alert(1)', search('javascript\u{a0}:alert(1)'), 'no-break space'],
      ['javascript\u{3000}:alert(1)', search('javascript\u{3000}:alert(1)')],
      ['java\u{a0}script:alert(1)', search('java\u{a0}script:alert(1)')],
      ['java\u{85}script:alert(1)', search('javascript:alert(1)'), 'C1 next line is stripped'],
      // data:
      ['DATA:text/html,x', search('DATA:text/html,x')],
      ['data:,hi', search('data:,hi')],
      ['data://example.com', search('data://example.com'), 'looks like a URL'],
      [' data:text/plain,hello', search('data:text/plain,hello')],
      ['da\tta:text/html,x', search('data:text/html,x')],
      [
        'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
        search('data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='),
      ],
      [
        'data:image/svg+xml,<svg onload=alert(1)>',
        search('data:image/svg+xml,<svg onload=alert(1)>'),
      ],
      // vbscript:
      ['VBScript:msgbox', search('VBScript:msgbox')],
      ['vbscript:', search('vbscript:')],
      ['VbScRiPt:MsgBox("x")', search('VbScRiPt:MsgBox("x")')],
      ['vb\tscript:msgbox', search('vbscript:msgbox')],
      // blob:
      ['blob:https://example.com/0e1f-2a3b', search('blob:https://example.com/0e1f-2a3b')],
      ['BLOB:null/abc', search('BLOB:null/abc')],
      ['blob:', search('blob:')],
      ['blob:https://evil.example/uuid', search('blob:https://evil.example/uuid')],
      // app:
      ['app://shell', search('app://shell')],
      ['APP://SHELL', search('APP://SHELL')],
      ['app:shell', search('app:shell')],
      ['app://', search('app://')],
      ['app:', search('app:')],
      // chrome:
      ['chrome://settings', search('chrome://settings')],
      ['CHROME://FLAGS', search('CHROME://FLAGS')],
      ['chrome:settings', search('chrome:settings')],
      ['chrome://', search('chrome://')],
      // devtools:
      [
        'devtools://devtools/bundled/inspector.html',
        search('devtools://devtools/bundled/inspector.html'),
      ],
      ['DevTools://x', search('DevTools://x')],
      ['devtools:', search('devtools:')],
      // view-source:
      ['view-source:https://example.com', search('view-source:https://example.com')],
      ['VIEW-SOURCE:https://example.com', search('VIEW-SOURCE:https://example.com')],
      ['view-source:', search('view-source:')],
      ['view-source:javascript:alert(1)', search('view-source:javascript:alert(1)')],
      // A payload after something that does parse as a URL.
      [
        'https://example.com javascript:alert(1)',
        search('https://example.com javascript:alert(1)'),
        'space in the host',
      ],
      ['example.com javascript:alert(1)', search('example.com javascript:alert(1)')],
      [
        'https://example.com\njavascript:alert(1)',
        search('https://example.comjavascript:alert(1)'),
        'the newline is stripped, which breaks the host',
      ],
      [
        'https://example.com\u{0}javascript:alert(1)',
        search('https://example.comjavascript:alert(1)'),
      ],
      ['http://example.com;javascript:alert(1)', search('http://example.com;javascript:alert(1)')],
      ['example.com;javascript:alert(1)', search('example.com;javascript:alert(1)')],
      ['a.com,javascript:alert(1)', search('a.com,javascript:alert(1)')],
      [
        'https://example.com/ javascript:alert(1)',
        nav('https://example.com/%20javascript:alert(1)'),
        'it is only path text',
      ],
      ['https://example.com#javascript:alert(1)', nav('https://example.com/#javascript:alert(1)')],
      ['https://example.com/javascript:alert(1)', nav('https://example.com/javascript:alert(1)')],
      ['https://example.com/?javascript:alert(1)', nav('https://example.com/?javascript:alert(1)')],
    ]);
  });

  describe('about:, file: and Windows paths', () => {
    classifyTable([
      // about:
      ['About:blank', nav('about:blank'), 'the scheme ignores case'],
      ['about:blank ', nav('about:blank')],
      ['abou\tt:blank', nav('about:blank'), 'tab inside the scheme'],
      ['about:', search('about:')],
      ['about:config', search('about:config')],
      ['about://blank', search('about://blank')],
      ['about:blank/', search('about:blank/')],
      ['about:newtab', search('about:newtab')],
      ['about:blank%20', search('about:blank%20')],
      // Typed Windows drive paths.
      ['C:\\', nav('file:///C:/')],
      ['C:\\Users\\me\\file.txt', nav('file:///C:/Users/me/file.txt')],
      ['c:/Users/me', nav('file:///c:/Users/me'), 'forward slashes work too'],
      ['c:/', nav('file:///c:/')],
      ['C:/Users/me/', nav('file:///C:/Users/me/')],
      ['Z:\\share\\f.txt', nav('file:///Z:/share/f.txt')],
      ['C:\\Program Files\\x y.txt', nav('file:///C:/Program%20Files/x%20y.txt'), 'spaces'],
      ['C:\\a b\\c d.pdf', nav('file:///C:/a%20b/c%20d.pdf')],
      ['c:/foo bar', nav('file:///c:/foo%20bar')],
      ['D:\\Music\\\u{fc}.mp3', nav('file:///D:/Music/%C3%BC.mp3'), 'non-ASCII file name'],
      ['C:\\Users\\caf\u{e9}.txt', nav('file:///C:/Users/caf%C3%A9.txt')],
      ['C:\\Users\\me\\..\\other', nav('file:///C:/Users/other'), 'dot segments are resolved'],
      [
        'C:\\Users\\..\\..\\..\\Windows',
        nav('file:///C:/Windows'),
        'and cannot climb above the drive',
      ],
      ['  C:\\Users\\x  ', nav('file:///C:/Users/x')],
      ['C:\\Users\\x\ny', nav('file:///C:/Users/xy'), 'sanitised first'],
      ['C:\\javascript:alert(1)', nav('file:///C:/javascript:alert(1)'), 'only a file name'],
      ['1:\\x', search('1:\\x'), 'a digit is not a drive'],
      // UNC paths and other backslash forms.
      ['\\\\server\\share', search('\\\\server\\share'), 'one-word host'],
      ['\\\\server\\share\\file.txt', search('\\\\server\\share\\file.txt')],
      ['\\\\server\\my share', search('\\\\server\\my share')],
      ['\\\\?\\C:\\x', search('\\\\?\\C:\\x'), 'device path prefix'],
      ['\\\\.\\pipe\\x', search('\\\\.\\pipe\\x')],
      ['//server/share', search('//server/share')],
      ['\\\\\\', search('\\\\\\')],
      // file: URLs.
      ['FILE:///C:/x.txt', nav('file:///C:/x.txt')],
      ['file:///C:/My Docs/a.txt', nav('file:///C:/My%20Docs/a.txt')],
      ['file:///C:/a%20b.txt', nav('file:///C:/a%20b.txt'), 'no double encoding'],
      ['file://server/share/a.txt', search('file://server/share/a.txt'), 'network path: SMB'],
      ['file:///', search('file:///'), 'no drive letter'],
      ['file://localhost/C:/x', nav('file:///C:/x'), 'localhost is the empty host'],
      ['file:C:/x', nav('file:///C:/x'), 'slashes are optional'],
      ['file:/C:/x', nav('file:///C:/x')],
      ['file:///C|/x', nav('file:///C:/x'), 'old-style drive separator'],
      ['file:///C:/a.pdf?x=1#y', nav('file:///C:/a.pdf?x=1#y')],
      ['file:///etc/passwd', search('file:///etc/passwd'), 'no drive letter'],
      ['file:///C:/../x', nav('file:///C:/x')],
      ['file:///C:/%2e%2e/x', nav('file:///C:/x'), 'an encoded dot segment'],
      ['file:///C:/x\ny', nav('file:///C:/xy')],
      ['fil\te:///C:/x', nav('file:///C:/x'), 'tab inside the scheme'],
      ['file:\\\\\\C:\\x', nav('file:///C:/x'), 'backslashes'],
    ]);
  });

  describe("other apps' schemes", () => {
    classifyTable([
      ['MAILTO:a@b.com', external('mailto:a@b.com'), 'the scheme is lowercased'],
      ['mailto:', external('mailto:')],
      ['tel:+1-555-0100', external('tel:+1-555-0100')],
      ['sms:+15550100', external('sms:+15550100')],
      ['callto:+15550100', external('callto:+15550100')],
      ['skype:echo123?call', external('skype:echo123?call')],
      ['xmpp:user@example.com', external('xmpp:user@example.com')],
      ['ms-msdt:/id', external('ms-msdt:/id'), 'a known-dangerous scheme still reaches the guard'],
      ['MS-MSDT:/id', external('ms-msdt:/id')],
      ['ms-msdt:id=PCWDiagnostic', external('ms-msdt:id=PCWDiagnostic')],
      ['ms-msdt://x', external('ms-msdt://x')],
      ['ms-msdt:\n/id', external('ms-msdt:/id'), 'sanitised first'],
      ['search-ms:query=x', external('search-ms:query=x')],
      [
        'search-ms:query=x&crumb=location:\\\\evil\\share',
        external('search-ms:query=x&crumb=location:\\\\evil\\share'),
        'a UNC location',
      ],
      ['ms-officecmd:x', external('ms-officecmd:x')],
      [
        'ms-word:ofe|u|https://example.com/a.docx',
        external('ms-word:ofe|u|https://example.com/a.docx'),
      ],
      ['zoommtg://zoom.us/join?confno=123', external('zoommtg://zoom.us/join?confno=123')],
      ['ms-settings:', external('ms-settings:')],
      ['ms-settings:network-wifi', external('ms-settings:network-wifi')],
      ['steam://run/440', external('steam://run/440')],
      ['slack://open', external('slack://open')],
      ['spotify:track:abc', external('spotify:track:abc')],
      ['magnet:?xt=urn:btih:abc', external('magnet:?xt=urn:btih:abc')],
      ['web+custom:payload', external('web+custom:payload'), 'a web+ protocol handler'],
      ['ftp://example.com/file', external('ftp://example.com/file'), 'there is no ftp support'],
      ['FTP://example.com', external('ftp://example.com/')],
      ['ssh://host', external('ssh://host')],
      ['smb://server/share', external('smb://server/share')],
    ]);
  });

  describe('email addresses and user@host tricks', () => {
    classifyTable([
      ['a@b', search('a@b')],
      ['user@localhost', search('user@localhost')],
      ['user@192.168.1.1', search('user@192.168.1.1')],
      ['user@example.com:8080', search('user@example.com:8080')],
      ['example.com@evil.com', search('example.com@evil.com'), 'the real host is hidden'],
      ['evil.com@example.com', search('evil.com@example.com')],
      ['@example.com', search('@example.com')],
      ['a@b@c.com', search('a@b@c.com')],
      ['mailto:a@b.com@c.com', external('mailto:a@b.com@c.com')],
      [
        'http://user:pass@example.com',
        nav('http://example.com/'),
        'explicit scheme: credentials go',
      ],
    ]);
  });

  describe('table size', () => {
    it('has at least 150 classifier rows', () => {
      expect(classifierCases).toBeGreaterThanOrEqual(150);
    });
  });
});

describe('search templates', () => {
  const TEMPLATE = 'https://search.example/?q={searchTerms}';

  describe('building a search URL', () => {
    const cases: readonly (readonly [query: string, url: string])[] = [
      ['', 'https://search.example/?q='],
      [' ', 'https://search.example/?q=%20'],
      ['hello world', 'https://search.example/?q=hello%20world'],
      ['a b  c', 'https://search.example/?q=a%20b%20%20c'],
      ['a&b=c', 'https://search.example/?q=a%26b%3Dc'],
      ['a+b', 'https://search.example/?q=a%2Bb'],
      ['100%', 'https://search.example/?q=100%25'],
      ['%20', 'https://search.example/?q=%2520'],
      ['%zz', 'https://search.example/?q=%25zz'],
      ['a#b', 'https://search.example/?q=a%23b'],
      ['what?', 'https://search.example/?q=what%3F'],
      ['a/b', 'https://search.example/?q=a%2Fb'],
      ['../..', 'https://search.example/?q=..%2F..'],
      ['a;b,c:d@e$f', 'https://search.example/?q=a%3Bb%2Cc%3Ad%40e%24f'],
      ['"quoted"', 'https://search.example/?q=%22quoted%22'],
      ['<tag>', 'https://search.example/?q=%3Ctag%3E'],
      ['[x]', 'https://search.example/?q=%5Bx%5D'],
      ['a|b', 'https://search.example/?q=a%7Cb'],
      ['a\\b', 'https://search.example/?q=a%5Cb'],
      ['C:\\x', 'https://search.example/?q=C%3A%5Cx'],
      ['=', 'https://search.example/?q=%3D'],
      ['&&', 'https://search.example/?q=%26%26'],
      ['?', 'https://search.example/?q=%3F'],
      ['#', 'https://search.example/?q=%23'],
      // encodeURIComponent leaves these alone.
      ["it's", "https://search.example/?q=it's"],
      ['!*()~-_.', 'https://search.example/?q=!*()~-_.'],
      // Unicode.
      ['\u{e9}', 'https://search.example/?q=%C3%A9'],
      ['\u{f1}', 'https://search.example/?q=%C3%B1'],
      ['\u{65e5}\u{672c}\u{8a9e}', 'https://search.example/?q=%E6%97%A5%E6%9C%AC%E8%AA%9E'],
      ['\u{1f600}', 'https://search.example/?q=%F0%9F%98%80'],
      ['\u{1f600}x', 'https://search.example/?q=%F0%9F%98%80x'],
      ['e\u{301}', 'https://search.example/?q=e%CC%81'],
      ['\u{202e}rtl', 'https://search.example/?q=%E2%80%AErtl'],
      ['zero\u{200b}width', 'https://search.example/?q=zero%E2%80%8Bwidth'],
      ['\u{feff}', 'https://search.example/?q=%EF%BB%BF'],
      // Controls are encoded too (the classifier removes them first).
      ['\n', 'https://search.example/?q=%0A'],
      ['a\tb', 'https://search.example/?q=a%09b'],
      ['\u{0}', 'https://search.example/?q=%00'],
      // Text that looks like the placeholder or like a replacement pattern.
      ['{searchTerms}', 'https://search.example/?q=%7BsearchTerms%7D'],
      ['{{searchTerms}}', 'https://search.example/?q=%7B%7BsearchTerms%7D%7D'],
      ['$&', 'https://search.example/?q=%24%26'],
      ["$1 $$ $` $'", "https://search.example/?q=%241%20%24%24%20%24%60%20%24'"],
      ['javascript:alert(1)', 'https://search.example/?q=javascript%3Aalert(1)'],
    ];

    for (const [query, url] of cases) {
      it(`${show(query)} -> ${show(url)}`, () => {
        expect(buildSearchUrl(TEMPLATE, query)).toBe(url);
      });
    }

    it('fills a placeholder in the path', () => {
      expect(buildSearchUrl('https://search.example/search/{searchTerms}', 'a/b c')).toBe(
        'https://search.example/search/a%2Fb%20c',
      );
    });

    it('fills a placeholder in the middle of the path', () => {
      expect(buildSearchUrl('https://search.example/{searchTerms}/results', 'x y')).toBe(
        'https://search.example/x%20y/results',
      );
    });

    it('fills every placeholder', () => {
      expect(buildSearchUrl('https://search.example/?q={searchTerms}&x={searchTerms}', 'a b')).toBe(
        'https://search.example/?q=a%20b&x=a%20b',
      );
    });

    it('does not expand a placeholder typed by the user', () => {
      expect(
        buildSearchUrl('https://search.example/{searchTerms}/{searchTerms}', '{searchTerms}'),
      ).toBe('https://search.example/%7BsearchTerms%7D/%7BsearchTerms%7D');
    });

    it('uses the DuckDuckGo default', () => {
      expect(DEFAULT_SEARCH_TEMPLATE).toBe('https://duckduckgo.com/?q={searchTerms}');
      expect(isValidSearchTemplate(DEFAULT_SEARCH_TEMPLATE)).toBe(true);
      expect(buildSearchUrl(DEFAULT_SEARCH_TEMPLATE, 'hello world')).toBe(
        'https://duckduckgo.com/?q=hello%20world',
      );
    });

    it('builds from a plain-http template that points at this machine', () => {
      expect(buildSearchUrl('http://localhost:8080/s?q={searchTerms}', 'a b')).toBe(
        'http://localhost:8080/s?q=a%20b',
      );
    });
  });

  describe('validating a template', () => {
    const cases: readonly (readonly [template: string, valid: boolean, note?: string])[] = [
      // Valid.
      ['https://search.example/?q={searchTerms}', true],
      ['https://search.example/search/{searchTerms}', true, 'placeholder in the path'],
      ['https://search.example/{searchTerms}/results', true],
      ['https://search.example/?q={searchTerms}&x={searchTerms}', true, 'twice'],
      ['https://search.example/?q={searchTerms}#{searchTerms}', true, 'in the fragment'],
      ['HTTPS://SEARCH.EXAMPLE/?q={searchTerms}', true, 'the scheme ignores case'],
      ['https://www.google.com/search?q={searchTerms}', true],
      ['https://www.bing.com/search?q={searchTerms}&form=QBLH', true],
      ['https://search.brave.com/search?q={searchTerms}&source=web', true],
      ['https://localhost/?q={searchTerms}', true, 'https on this machine'],
      ['http://localhost/?q={searchTerms}', true, 'plain http is allowed on this machine'],
      ['http://localhost:8080/?q={searchTerms}', true],
      ['http://LOCALHOST/?q={searchTerms}', true],
      ['http://127.0.0.1/?q={searchTerms}', true],
      ['http://127.0.0.1:4000/s?q={searchTerms}', true],
      ['http://[::1]/?q={searchTerms}', true],
      ['http://[::1]:8080/s?q={searchTerms}', true],
      ['http://[0:0:0:0:0:0:0:1]/?q={searchTerms}', true, 'the long form of ::1'],
      ['http://2130706433/?q={searchTerms}', true, 'the integer form of 127.0.0.1'],
      // Missing or damaged placeholder.
      ['', false],
      ['{searchTerms}', false, 'not a URL'],
      ['https://search.example/', false, 'no placeholder'],
      ['https://search.example/?q=%s', false, 'a browser-style placeholder'],
      ['https://search.example/?q={searchterms}', false, 'wrong case'],
      ['https://search.example/?q={SEARCHTERMS}', false],
      ['https://search.example/?q={searchTerms', false, 'unterminated'],
      ['https://search.example/?q=searchTerms}', false],
      ['https://search.example/?q={ searchTerms }', false, 'padded'],
      // Wrong scheme.
      ['http://search.example/?q={searchTerms}', false, 'plain http to another host'],
      ['ftp://search.example/?q={searchTerms}', false],
      ['ws://search.example/?q={searchTerms}', false],
      ['wss://search.example/?q={searchTerms}', false],
      ['javascript:alert({searchTerms})', false],
      ['data:text/html,{searchTerms}', false],
      ['file:///C:/x?{searchTerms}', false],
      ['about:blank#{searchTerms}', false],
      ['veltriva://newtab/?{searchTerms}', false],
      ['app://shell/?{searchTerms}', false],
      ['blob:https://x/{searchTerms}', false],
      ['{searchTerms}://example.com', false, 'the placeholder is the scheme'],
      // Plain http that only pretends to be local.
      ['http://10.0.0.1/?q={searchTerms}', false, 'private is not local'],
      ['http://192.168.1.1/?q={searchTerms}', false],
      ['http://localhost.evil.com/?q={searchTerms}', false],
      ['http://localhost@evil.com/?q={searchTerms}', false, 'localhost is the userinfo'],
      ['http://evil.com#@localhost/?q={searchTerms}', false],
      ['http://evil.com\\@localhost/?q={searchTerms}', false, 'a backslash ends the host'],
      ['http://127.0.0.1.evil.com/?q={searchTerms}', false],
      ['http://127.0.0.1@evil.com/?q={searchTerms}', false],
      ['http://evil.com/?q={searchTerms}#localhost', false],
      // Not URLs once the placeholder is filled in.
      ['https://sea rch.example/?q={searchTerms}', false, 'space in the host'],
      ['https://search.example:99999/?q={searchTerms}', false, 'port out of range'],
      ['https://256.256.256.256/?q={searchTerms}', false],
      ['https://[::1/?q={searchTerms}', false],
    ];

    for (const [template, valid, note] of cases) {
      it(`${show(template)} is ${valid ? 'valid' : 'invalid'}${note === undefined ? '' : ` (${note})`}`, () => {
        expect(isValidSearchTemplate(template)).toBe(valid);
      });
    }

    it.each([
      'https://search.example/',
      'http://evil.example/?q={searchTerms}',
      '',
      'javascript:{searchTerms}',
      '{searchTerms}://example.com',
    ])('refuses to build from %j', (template) => {
      expect(() => buildSearchUrl(template, 'x')).toThrow('Invalid search template');
    });
  });

  describe('from typed text to a search URL', () => {
    const typed: readonly (readonly [input: string, url: string])[] = [
      ['foo bar', 'https://duckduckgo.com/?q=foo%20bar'],
      ['?example.com', 'https://duckduckgo.com/?q=example.com'],
      ['someone@example.com', 'https://duckduckgo.com/?q=someone%40example.com'],
      ['javascript:alert(1)', 'https://duckduckgo.com/?q=javascript%3Aalert(1)'],
      [
        'data:text/html,<script>alert(1)</script>',
        'https://duckduckgo.com/?q=data%3Atext%2Fhtml%2C%3Cscript%3Ealert(1)%3C%2Fscript%3E',
      ],
      ['caf\u{e9} menu', 'https://duckduckgo.com/?q=caf%C3%A9%20menu'],
      ['java\tscript:alert(1)', 'https://duckduckgo.com/?q=javascript%3Aalert(1)'],
      ['hello\nworld', 'https://duckduckgo.com/?q=helloworld'],
      ['1.1', 'https://duckduckgo.com/?q=1.1'],
      ['foo.notatld', 'https://duckduckgo.com/?q=foo.notatld'],
    ];

    for (const [input, url] of typed) {
      it(`${show(input)} searches ${show(url)}`, () => {
        const action = classifyOmniboxInput(input);
        expect(action.kind).toBe('search');
        if (action.kind === 'search') {
          expect(buildSearchUrl(DEFAULT_SEARCH_TEMPLATE, action.query)).toBe(url);
        }
      });
    }
  });
});

describe('displayUrl table', () => {
  /** [committed URL, address-bar text, security state, whether credentials were removed]. */
  type DisplayCase = readonly [
    url: string,
    text: string,
    security: SecurityState,
    hadCredentials?: boolean,
  ];

  let displayCases = 0;

  function displayTable(cases: readonly DisplayCase[]): void {
    for (const [url, text, security, hadCredentials] of cases) {
      displayCases += 1;
      it(`${show(url)} -> ${show(text)} (${security}${hadCredentials === true ? ', credentials removed' : ''})`, () => {
        expect(displayUrl(url)).toEqual({
          text,
          security,
          hadCredentials: hadCredentials ?? false,
        });
      });
    }
  }

  describe('http and https', () => {
    displayTable([
      ['https://example.com:443/', 'https://example.com/', 'secure'],
      ['http://example.com:8080/x', 'http://example.com:8080/x', 'not-secure'],
      ['http://EXAMPLE.COM:80/', 'http://example.com/', 'not-secure'],
      ['HTTPS://EXAMPLE.COM', 'https://example.com/', 'secure'],
      ['https://EXAMPLE.com/Path?Q=1#F', 'https://example.com/Path?Q=1#F', 'secure'],
      ['https://example.com./', 'https://example.com./', 'secure'],
      ['https://[::1]:8080/', 'https://[::1]:8080/', 'secure'],
      ['http://[2001:DB8::1]/', 'http://[2001:db8::1]/', 'not-secure'],
      ['http://[0:0:0:0:0:0:0:1]/', 'http://[::1]/', 'not-secure'],
      ['https://localhost/', 'https://localhost/', 'secure'],
      [' https://example.com ', 'https://example.com/', 'secure'],
      ['\thttps://example.com\n', 'https://example.com/', 'secure'],
    ]);
  });

  describe('credentials are removed and reported', () => {
    displayTable([
      ['https://user@example.com/', 'https://example.com/', 'secure', true],
      ['https://:pass@example.com/', 'https://example.com/', 'secure', true],
      ['http://user:pass@example.com', 'http://example.com/', 'not-secure', true],
      ['https://user:p%40ss@example.com/x', 'https://example.com/x', 'secure', true],
      ['https://paypal.com@evil.example/login', 'https://evil.example/login', 'secure', true],
      ['https://\u{430}pple.com@evil.example/', 'https://evil.example/', 'secure', true],
      ['https://a:b@[::1]:8080/', 'https://[::1]:8080/', 'secure', true],
      ['https://@example.com/', 'https://example.com/', 'secure'],
      ['https://:@example.com/', 'https://example.com/', 'secure'],
    ]);
  });

  describe('hosts are shown in punycode', () => {
    displayTable([
      ['https://\u{3c1}aypal.com/', 'https://xn--aypal-2ce.com/', 'secure'],
      ['https://\u{430}\u{440}\u{440}\u{4cf}\u{435}.com/', 'https://xn--80ak6aa92e.com/', 'secure'],
      ['https://\u{4f8b}\u{3048}.jp/', 'https://xn--r8jz45g.jp/', 'secure'],
      ['https://m\u{fc}nchen.de/', 'https://xn--mnchen-3ya.de/', 'secure'],
      ['https://stra\u{df}e.de/', 'https://xn--strae-oqa.de/', 'secure'],
      ['https://\u{1f4a9}.la/', 'https://xn--ls8h.la/', 'secure'],
      ['https://xn--pple-43d.com/', 'https://xn--pple-43d.com/', 'secure'],
      ['https://XN--PPLE-43D.COM/', 'https://xn--pple-43d.com/', 'secure'],
      [
        'https://\u{ff45}\u{ff58}\u{ff41}\u{ff4d}\u{ff50}\u{ff4c}\u{ff45}.com/',
        'https://example.com/',
        'secure',
      ],
      ['https://exam\u{200b}ple.com/', 'https://example.com/', 'secure'],
      ['https://exa\u{ad}mple.com/', 'https://example.com/', 'secure'],
    ]);
  });

  describe('odd IPv4 forms are shown as the address they are', () => {
    displayTable([
      ['http://2130706433/', 'http://127.0.0.1/', 'not-secure'],
      ['https://0x7f.1/', 'https://127.0.0.1/', 'secure'],
      ['http://0177.0.0.1/', 'http://127.0.0.1/', 'not-secure'],
    ]);
  });

  describe('other schemes', () => {
    displayTable([
      ['ftp://example.com/', 'ftp://example.com/', 'neutral'],
      ['mailto:a@b.com', 'mailto:a@b.com', 'neutral'],
      ['tel:+1555', 'tel:+1555', 'neutral'],
      ['view-source:https://example.com', 'view-source:https://example.com', 'neutral'],
      ['blob:https://example.com/uuid', 'blob:https://example.com/uuid', 'secure'],
      ['wss://example.com/', 'wss://example.com/', 'neutral'],
      ['file:///C:/a%20b.txt', 'file:///C:/a%20b.txt', 'local'],
      ['file://server/share/x', 'file://server/share/x', 'local'],
      ['FILE:///C:/x', 'file:///C:/x', 'local'],
      ['file:///C:/\u{fc}.txt', 'file:///C:/%C3%BC.txt', 'local'],
      ['VELTRIVA://newtab', 'veltriva://newtab', 'internal'],
      ['veltriva://newtab/', 'veltriva://newtab/', 'internal'],
    ]);
  });

  describe('spoofing characters outside the host are made visible', () => {
    displayTable([
      ['https://example.com/\u{202e}', 'https://example.com/%E2%80%AE', 'secure'],
      ['https://example.com/\u{200b}', 'https://example.com/%E2%80%8B', 'secure'],
      ['https://example.com/?q=\u{202e}evil', 'https://example.com/?q=%E2%80%AEevil', 'secure'],
      ['https://example.com/#\u{202e}', 'https://example.com/#%E2%80%AE', 'secure'],
      [
        'https://example.com/\u{fc}?\u{fc}#\u{fc}',
        'https://example.com/%C3%BC?%C3%BC#%C3%BC',
        'secure',
      ],
      ['https://example.com/a b', 'https://example.com/a%20b', 'secure'],
      ['https://example.com/<script>', 'https://example.com/%3Cscript%3E', 'secure'],
      ['https://example.com/"quoted"', 'https://example.com/%22quoted%22', 'secure'],
    ]);
  });

  describe('text that is not a URL shows nothing', () => {
    displayTable([
      ['', '', 'neutral'],
      [' ', '', 'neutral'],
      ['example.com', '', 'neutral'],
      ['//example.com', '', 'neutral'],
      ['/path', '', 'neutral'],
      ['https://', '', 'neutral'],
      ['https://exa mple.com/', '', 'neutral'],
      ['https://exam\u{202e}ple.com/', '', 'neutral', false],
      ['https://example.com:99999/', '', 'neutral'],
      ['http://256.1.1.1/', '', 'neutral'],
      ['https://[::1/', '', 'neutral'],
    ]);
  });

  describe('long URLs', () => {
    it('keeps a URL of exactly the maximum length whole', () => {
      const url = `https://example.com/${'a'.repeat(MAX_DISPLAY_LENGTH - 20)}`;
      expect(url).toHaveLength(MAX_DISPLAY_LENGTH);
      expect(displayUrl(url).text).toBe(url);
    });

    it('cuts a URL one character over the maximum and adds an ellipsis', () => {
      const url = `https://example.com/${'a'.repeat(MAX_DISPLAY_LENGTH - 19)}`;
      expect(displayUrl(url).text).toBe(`${url.slice(0, MAX_DISPLAY_LENGTH)}\u{2026}`);
    });

    it('cuts a huge URL to the same length', () => {
      const { text } = displayUrl(`https://example.com/${'a'.repeat(100_000)}`);
      expect(text).toHaveLength(MAX_DISPLAY_LENGTH + 1);
      expect(text.endsWith('\u{2026}')).toBe(true);
    });

    it('measures the length after encoding, so the cut never splits a character', () => {
      const { text } = displayUrl(`https://example.com/${'\u{1f600}'.repeat(500)}`);
      expect(text.endsWith('\u{2026}')).toBe(true);
      expect(text.slice(0, -1)).toMatch(/^[\x20-\x7e]+$/u);
      expect(text).toHaveLength(MAX_DISPLAY_LENGTH + 1);
    });

    it('removes credentials before measuring', () => {
      const url = `https://${'u'.repeat(3000)}:${'p'.repeat(3000)}@example.com/x`;
      expect(displayUrl(url)).toEqual({
        text: 'https://example.com/x',
        security: 'secure',
        hadCredentials: true,
      });
    });

    it('keeps the scheme and host at the start of a cut URL', () => {
      const { text } = displayUrl(`http://\u{430}pple.com/${'a'.repeat(5000)}`);
      expect(text.startsWith('http://xn--pple-43d.com/aaa')).toBe(true);
    });
  });

  describe('table size', () => {
    it('has at least 20 display rows', () => {
      expect(displayCases).toBeGreaterThanOrEqual(20);
    });
  });
});
