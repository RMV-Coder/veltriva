import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { HIDDEN, isAddressLike, scrubAddresses } from './log-redaction';

describe('scrubAddresses (M6.1, §6.6)', () => {
  it.each([
    // What shell.openExternal and friends say when they fail.
    ['Failed to open mailto:alice@example.com', 'Failed to open [hidden]'],
    ['Failed to open: https://secret.example/path?token=abc#frag', 'Failed to open: [hidden]'],
    [
      "ENOENT: no such file or directory, open 'file:///C:/Users/me/Downloads/report.pdf'",
      "ENOENT: no such file or directory, open '[hidden]'",
    ],
    ['Error: file://server/share/x.txt was refused', 'Error: [hidden] was refused'],
    ['could not launch zoommtg://zoom.us/join?confno=123', 'could not launch [hidden]'],
    ['blocked javascript:alert(1)', 'blocked [hidden])'],
    ['(see https://a.example/b)', '(see [hidden])'],
    ['<https://a.example/>, then', '<[hidden]>, then'],
  ])('hides URLs with a scheme: %s', (text, expected) => {
    expect(scrubAddresses(text)).toBe(expected);
  });

  it.each([
    ['getaddrinfo ENOTFOUND secret.example.com', 'getaddrinfo ENOTFOUND [hidden]'],
    ['connect to www.example.co.uk:8443 failed', 'connect to [hidden] failed'],
    ['host bücher.de.', 'host [hidden].'],
    ['host xn--bcher-kva.de', 'host [hidden]'],
    ['host xn--e1afmkfd.xn--p1ai', 'host [hidden]'],
    ['_dmarc.example.org', HIDDEN],
    ['example.com/path/only', HIDDEN],
  ])('hides host names, with or without a path or port: %s', (text, expected) => {
    expect(scrubAddresses(text)).toBe(expected);
  });

  it.each([
    ['connect ECONNREFUSED 192.168.1.20:8080', 'connect ECONNREFUSED [hidden]'],
    ['from 10.0.0.1.', 'from [hidden].'],
    ['to [::1]:3000', 'to [[hidden]'],
    ['to [2001:db8:0:0:0:0:0:1]:443 now', 'to [[hidden] now'],
    ['to 2001:db8::1', 'to [hidden]'],
    ['to ::ffff:192.168.1.1', 'to [hidden]'],
    ['to fe80::1%eth0', 'to [hidden]'],
    ['to ::1%12', 'to [hidden]'],
  ])('hides IP addresses: %s', (text, expected) => {
    expect(scrubAddresses(text)).toBe(expected);
  });

  it.each([
    ['mail bob@example.org failed', 'mail [hidden] failed'],
    ['user:pass@host', HIDDEN],
    [String.raw`open C:\Users\Raymond Valdepeñas\Downloads\report.pdf`, 'open [hidden] [hidden]'],
    [String.raw`\\server\share\file`, HIDDEN],
    ['saved to report.pdf', 'saved to [hidden]'],
  ])('hides e-mail addresses, credentials, paths and file names: %s', (text, expected) => {
    expect(scrubAddresses(text)).toBe(expected);
  });

  it.each([
    'no printer',
    'SQLITE_CORRUPT',
    'SQLITE_IOERR_WRITE',
    '2 > 1',
    'migration history',
    'Error: net::ERR_NAME_NOT_RESOLVED',
    'net::ERR_CERT_AUTHORITY_INVALID',
    'version 45.0.0 at 1.5x',
    'at 12:30:00',
    'TypeError',
    'crashed',
    'foreground-tab',
    'clipboard-sanitized-write',
    'mailto',
    'localhost',
    'Something failed. Try again.',
    '',
  ])('keeps what is not an address: %s', (text) => {
    expect(scrubAddresses(text)).toBe(text);
  });

  it('keeps our own method and command names, which look like host names', () => {
    for (const name of ['session.save', 'tabs.list', 'history.page', 'search.query']) {
      expect(isAddressLike(name)).toBe(false);
      expect(scrubAddresses(`calling ${name}: timeout`)).toBe(`calling ${name}: timeout`);
    }
    for (const name of ['tabs.create', 'navigation.submit', 'app.getInfo']) {
      expect(isAddressLike(name)).toBe(false);
    }
  });

  it('keeps the whitespace between words', () => {
    expect(scrubAddresses('a\thttps://x.example/\n b')).toBe(`a\t${HIDDEN}\n b`);
  });

  it('never lets a generated URL, e-mail address or domain through', () => {
    const address = fc.oneof(
      fc.webUrl({ withQueryParameters: true, withFragments: true }),
      fc.emailAddress(),
      fc.domain(),
      fc.ipV4(),
      fc.ipV6(),
    );
    const word = fc.constantFrom('Failed', 'to', 'open', 'error:', '(', ')', "'", 'at');
    fc.assert(
      fc.property(
        fc.array(word, { maxLength: 3 }),
        address,
        fc.array(word, { maxLength: 3 }),
        (before, value, after) => {
          const text = [...before, value, ...after].join(' ');
          const scrubbed = scrubAddresses(text);
          expect(scrubbed).not.toContain(value);
          expect(scrubbed).toContain(HIDDEN);
        },
      ),
      { numRuns: 2000 },
    );
  });
});
