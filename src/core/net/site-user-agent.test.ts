import { describe, expect, it } from 'vitest';

import { firefoxUserAgent, firefoxVersion, userAgentOverride } from './site-user-agent';

const DAY = 24 * 60 * 60 * 1000;
/** Firefox 158's release day. */
const ANCHOR = Date.UTC(2026, 9, 13);
/** The day this was written. */
const WRITTEN = Date.UTC(2026, 9, 19);

describe('the Firefox version estimate', () => {
  it('is the latest release on the day this was written', () => {
    expect(firefoxVersion(WRITTEN)).toBe(158);
  });

  it('moves up one version per 4.1 weeks, so it never names an unreleased one', () => {
    expect(firefoxVersion(ANCHOR + 28 * DAY)).toBe(158);
    expect(firefoxVersion(ANCHOR + 29 * DAY)).toBe(159);
    // A year on: 12.7 intervals, so 12 versions, a little behind the 13 Firefox will have shipped.
    expect(firefoxVersion(ANCHOR + 365 * DAY)).toBe(170);
  });

  it('never goes below the anchor, even with a clock set in the past', () => {
    expect(firefoxVersion(ANCHOR - 400 * DAY)).toBe(158);
    expect(firefoxVersion(0)).toBe(158);
  });
});

describe('the Firefox user agent', () => {
  it('is Firefox’s own string for 64-bit Windows', () => {
    expect(firefoxUserAgent(WRITTEN)).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:158.0) Gecko/20100101 Firefox/158.0',
    );
  });

  it('names no Chrome, Chromium, Electron or Veltriva', () => {
    expect(firefoxUserAgent(WRITTEN)).not.toMatch(/Chrome|Chromium|Electron|Veltriva/);
  });
});

describe('which requests get it', () => {
  it.each([
    'https://accounts.google.com/v3/signin/identifier?flowName=GlifWebSignIn',
    'https://accounts.google.com/',
    'https://ACCOUNTS.Google.com/x',
    'https://accounts.google.com:8443/signin',
    'http://accounts.google.com/',
  ])('%s does', (url) => {
    expect(userAgentOverride(url, WRITTEN)).toBe(firefoxUserAgent(WRITTEN));
  });

  it.each([
    'https://mail.google.com/',
    'https://www.google.com/search?q=accounts.google.com',
    'https://google.com/',
    'https://myaccount.google.com/',
    'https://accounts.youtube.com/',
    'https://sub.accounts.google.com/',
    'https://accounts.google.com.evil.example/',
    'https://evil.example/accounts.google.com',
    'https://evil.example/?next=https://accounts.google.com/',
    'about:blank',
    'not a url',
    '',
  ])('%s does not', (url) => {
    expect(userAgentOverride(url, WRITTEN)).toBeNull();
  });
});
