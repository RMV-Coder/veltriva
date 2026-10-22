import { describe, expect, it } from 'vitest';

import { siteFromValue, splitSiteFilter } from './site-filter';

describe('siteFromValue', () => {
  it.each([
    ['github.com', 'github.com'],
    ['GitHub.com', 'github.com'],
    ['docs.github.com', 'github.com'],
    ['https://github.com/rust-lang/rust', 'github.com'],
    ['http://www.bbc.co.uk/news', 'bbc.co.uk'],
    ['user.github.io', 'user.github.io'],
    ['localhost', 'localhost'],
    ['127.0.0.1', '127.0.0.1'],
    ['localhost:3000', 'localhost'],
  ])('reads %j as the site %j, as the memory stores sites', (value, site) => {
    expect(siteFromValue(value)).toBe(site);
  });

  it.each([
    '',
    '   ',
    'ftp://example.com',
    'file:///C:/x',
    'javascript:alert(1)',
    'a'.repeat(3000),
  ])('names no site for %j', (value) => {
    expect(siteFromValue(value)).toBeNull();
  });
});

describe('splitSiteFilter', () => {
  it('takes the site: word out of the words', () => {
    expect(splitSiteFilter('site:github.com rust')).toEqual({ text: 'rust', site: 'github.com' });
    expect(splitSiteFilter('rust site:github.com book')).toEqual({
      text: 'rust book',
      site: 'github.com',
    });
  });

  it('reads the word in any case, and its value as a site', () => {
    expect(splitSiteFilter('SITE:Docs.GitHub.com pulls')).toEqual({
      text: 'pulls',
      site: 'github.com',
    });
  });

  it('keeps the last site when there are several', () => {
    expect(splitSiteFilter('site:a.example site:b.example x').site).toBe('b.example');
  });

  it('drops a site: word that names no site, and keeps no filter', () => {
    expect(splitSiteFilter('site: rust')).toEqual({ text: 'rust', site: null });
    expect(splitSiteFilter('site:ftp://x.example rust')).toEqual({ text: 'rust', site: null });
  });

  it('keeps an earlier good site when a later site: word names none', () => {
    expect(splitSiteFilter('site:github.com site: rust').site).toBe('github.com');
  });

  it('leaves words that only contain site: alone', () => {
    expect(splitSiteFilter('website:github.com')).toEqual({
      text: 'website:github.com',
      site: null,
    });
    expect(splitSiteFilter('rust')).toEqual({ text: 'rust', site: null });
    expect(splitSiteFilter('')).toEqual({ text: '', site: null });
  });
});
