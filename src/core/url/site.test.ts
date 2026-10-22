import { describe, expect, it } from 'vitest';

import { MAX_SITE_LENGTH, siteOf } from './site';

/** A host name of exactly `length` characters, in labels of at most 63, ending in `.com`. */
function hostOfLength(length: number): string {
  const tld = '.com';
  const body = length - tld.length;
  let host = '';
  for (let index = 0; index < body; index += 1) {
    // A dot after every 63 characters, but never as the last character of the body.
    host += (index + 1) % 64 === 0 && index !== body - 1 ? '.' : 'a';
  }
  return host + tld;
}

describe('MAX_SITE_LENGTH', () => {
  it('is the longest a host name can be: 253 characters', () => {
    expect(MAX_SITE_LENGTH).toBe(253);
  });
});

describe('siteOf', () => {
  describe('the registrable domain of a host', () => {
    it.each([
      ['https://example.com/', 'example.com'],
      ['https://www.example.com/', 'example.com'],
      ['https://mail.example.com/inbox', 'example.com'],
      ['https://a.b.c.example.com/deep/path?q=1#frag', 'example.com'],
      ['http://example.com', 'example.com'],
      ['http://www.example.org', 'example.org'],
    ])('gives %s the site %s', (url, site) => {
      expect(siteOf(url)).toBe(site);
    });

    it('goes by the public suffix list: example.co.uk is a site, co.uk is not', () => {
      expect(siteOf('https://mail.example.co.uk/')).toBe('example.co.uk');
      expect(siteOf('https://example.co.uk/')).toBe('example.co.uk');
      expect(siteOf('https://www.bbc.co.uk/news')).toBe('bbc.co.uk');
      expect(siteOf('https://shop.example.com.au/')).toBe('example.com.au');
    });

    it('gives the same site to every host of a registrable domain', () => {
      const urls = [
        'https://example.com',
        'https://www.example.com',
        'https://mail.example.com:8443/x',
        'http://a.b.example.com/?q=1',
      ];

      expect(new Set(urls.map(siteOf)).size).toBe(1);
    });

    it('gives different sites to different registrable domains', () => {
      expect(siteOf('https://example.com')).not.toBe(siteOf('https://example.org'));
      expect(siteOf('https://example.com')).not.toBe(siteOf('https://notexample.com'));
      expect(siteOf('https://example.co.uk')).not.toBe(siteOf('https://other.co.uk'));
    });

    it('lowercases the host', () => {
      expect(siteOf('https://WWW.Example.COM/Path')).toBe('example.com');
      expect(siteOf('HTTPS://EXAMPLE.COM')).toBe('example.com');
    });

    it('ignores the port, the credentials, the path, the query and the fragment', () => {
      expect(siteOf('https://user:secret@www.example.com:8443/a/b?c=d#e')).toBe('example.com');
      expect(siteOf('http://example.com:80')).toBe('example.com');
    });

    it('never puts the credentials of an address into the site', () => {
      const site = siteOf('https://user:secret@www.example.com/');

      expect(site).not.toContain('secret');
      expect(site).not.toContain('user');
      expect(site).not.toContain('@');
    });

    it('drops a trailing dot of an absolute host name', () => {
      expect(siteOf('https://www.example.com./')).toBe('example.com');
    });

    it('gives an internationalised host its punycode form', () => {
      expect(siteOf('https://www.münchen.de/')).toBe('xn--mnchen-3ya.de');
    });
  });

  describe('private domains of the public suffix list', () => {
    it('keeps every user of a hosting service apart: foo.github.io and bar.github.io are two sites', () => {
      expect(siteOf('https://foo.github.io/project')).toBe('foo.github.io');
      expect(siteOf('https://bar.github.io/')).toBe('bar.github.io');
      expect(siteOf('https://foo.github.io')).not.toBe(siteOf('https://bar.github.io'));
    });

    it('goes up to the owner of a private domain, not to the hosting service', () => {
      expect(siteOf('https://docs.foo.github.io/page')).toBe('foo.github.io');
      expect(siteOf('https://someone.blogspot.com/')).toBe('someone.blogspot.com');
    });

    it('does not make the service itself a site of all its users', () => {
      expect(siteOf('https://foo.github.io')).not.toBe('github.io');
    });
  });

  describe('a host without a registrable domain is its own site', () => {
    it.each([
      ['http://localhost/', 'localhost'],
      ['http://localhost:3000/app', 'localhost'],
      ['https://LOCALHOST', 'localhost'],
      ['http://127.0.0.1:8080/', '127.0.0.1'],
      ['http://192.168.1.20/admin', '192.168.1.20'],
      ['http://intranet/', 'intranet'],
      ['http://router.local/', 'router.local'],
    ])('gives %s the site %s', (url, site) => {
      expect(siteOf(url)).toBe(site);
    });

    it('gives an IPv6 address its bracketed host', () => {
      expect(siteOf('http://[::1]:8080/')).toBe('[::1]');
    });

    it('keeps two IP addresses apart', () => {
      expect(siteOf('http://10.0.0.1/')).not.toBe(siteOf('http://10.0.0.2/'));
    });

    it('does not mistake the parts of an IP address for subdomains', () => {
      expect(siteOf('http://10.0.0.1/')).toBe('10.0.0.1');
      expect(siteOf('http://10.0.0.1/')).not.toBe('0.0.1');
    });

    it('does not group hosts of a bare public suffix with its neighbours', () => {
      // `co.uk` has no registrable domain of its own: it is its own site.
      expect(siteOf('https://co.uk/')).toBe('co.uk');
    });
  });

  describe('pages without a site', () => {
    it.each([
      'file:///C:/Users/me/page.html',
      'about:blank',
      'about:srcdoc',
      'veltriva://newtab',
      'veltriva://diagnostics/',
      'chrome://settings',
      'devtools://devtools/bundled/inspector.html',
      'data:text/html,<p>hi</p>',
      'javascript:alert(1)',
      'blob:https://example.com/5a2c1c1a-7e9a-4b3a-8b1c-3a1b2c3d4e5f',
      'ftp://example.com/file.txt',
      'ws://example.com/socket',
      'wss://example.com/socket',
      'mailto:someone@example.com',
      'view-source:https://example.com/',
    ])('gives %s null', (url) => {
      expect(siteOf(url)).toBeNull();
    });

    it.each([
      '',
      ' ',
      'example.com',
      'www.example.com/path',
      'not a url',
      '//example.com',
      '/path',
    ])('gives the unparsable address %j null', (url) => {
      expect(siteOf(url)).toBeNull();
    });

    it('gives null for a scheme with no host', () => {
      expect(siteOf('http://')).toBeNull();
      expect(siteOf('https://')).toBeNull();
    });

    it('does not throw on any of them', () => {
      for (const url of [
        '',
        'http://[',
        'http://exa mple.com',
        'https://%',
        '\u0000',
        'http://:80',
      ]) {
        expect(() => siteOf(url)).not.toThrow();
      }
    });
  });

  describe('the length of a host', () => {
    it('gives a host of exactly 253 characters a site', () => {
      const host = hostOfLength(253);

      expect(host).toHaveLength(253);
      const site = siteOf(`https://${host}/`);
      expect(site).not.toBeNull();
      expect((site ?? '').length).toBeLessThanOrEqual(MAX_SITE_LENGTH);
    });

    it('gives a host of 254 characters null', () => {
      const host = hostOfLength(254);

      expect(host).toHaveLength(254);
      expect(siteOf(`https://${host}/`)).toBeNull();
    });

    it('gives a host of 1000 characters null', () => {
      expect(siteOf(`https://${hostOfLength(1000)}/`)).toBeNull();
    });

    it('never gives a site longer than a settings entry can hold', () => {
      for (const length of [10, 100, 200, 253, 254, 300]) {
        const site = siteOf(`https://${hostOfLength(length)}/`);

        expect(site === null || site.length <= MAX_SITE_LENGTH).toBe(true);
      }
    });
  });

  it('gives the same answer every time', () => {
    expect(siteOf('https://www.example.co.uk/a')).toBe(siteOf('https://www.example.co.uk/a'));
  });

  it('gives a site that is its own site: siteOf of a site is itself', () => {
    for (const url of [
      'https://mail.example.co.uk/',
      'https://foo.github.io/',
      'http://localhost:3000/',
      'http://127.0.0.1/',
    ]) {
      const site = siteOf(url);

      expect(site).not.toBeNull();
      expect(siteOf(`https://${site ?? ''}/`)).toBe(site);
    }
  });
});
