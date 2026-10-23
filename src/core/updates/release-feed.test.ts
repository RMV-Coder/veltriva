import { describe, expect, it } from 'vitest';

import {
  CHECK_INTERVAL_MS,
  DEFAULT_FEED_URL,
  MAX_FEED_URL,
  isFeedUrlAllowed,
  FIRST_CHECK_DELAY_MS,
  compareVersions,
  isNewer,
  nextCheckAt,
  parseReleaseFeed,
} from './release-feed';

const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  html_url: `https://github.com/RMV-Coder/veltriva/releases/tag/${tag}`,
  draft: false,
  prerelease: false,
  ...extra,
});

describe('compareVersions and isNewer (M6.3)', () => {
  it.each([
    ['0.2.0', '0.1.0', 1],
    ['0.1.0', '0.1.0', 0],
    ['v1.0.0', '0.9.9', 1],
    ['0.10.0', '0.9.0', 1],
    ['0.1.9', '0.1.10', -1],
  ])('%s against %s', (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b) ?? Number.NaN)).toBe(sign);
  });

  it('refuses anything that is not a plain major.minor.patch', () => {
    for (const bad of ['1.0', '1.0.0-beta.1', 'latest', '', '1.0.0.0', '01x.2.3']) {
      expect(compareVersions(bad, '0.1.0')).toBeNull();
    }
  });

  it('calls a release newer only when its version is greater', () => {
    expect(isNewer({ version: '0.2.0', url: 'https://x.example/' }, '0.1.0')).toBe(true);
    expect(isNewer({ version: '0.1.0', url: 'https://x.example/' }, '0.1.0')).toBe(false);
    expect(isNewer({ version: '0.1.0', url: 'https://x.example/' }, 'not a version')).toBe(false);
  });
});

describe('parseReleaseFeed (M6.3)', () => {
  it("reads GitHub's latest-release answer", () => {
    expect(parseReleaseFeed(release('v0.2.0'))).toEqual({
      version: '0.2.0',
      url: 'https://github.com/RMV-Coder/veltriva/releases/tag/v0.2.0',
    });
  });

  it('takes the newest published release from a list, skipping drafts and prereleases', () => {
    expect(
      parseReleaseFeed([
        release('v0.3.0', { draft: true }),
        release('v0.2.1', { prerelease: true }),
        release('v0.2.0'),
        release('v0.1.0'),
      ])?.version,
    ).toBe('0.2.0');
  });

  it('links only to an https page with no credentials', () => {
    for (const page of [
      'http://github.com/x',
      'javascript:alert(1)',
      'https://user:pass@github.com/x',
      'file:///C:/x',
      'not a url',
    ]) {
      expect(parseReleaseFeed(release('v0.2.0', { html_url: page }))).toBeNull();
    }
  });

  it('ignores answers that are not releases', () => {
    for (const answer of [null, 'v0.2.0', 42, {}, [], { message: 'Not Found' }, [null, 'x']]) {
      expect(parseReleaseFeed(answer)).toBeNull();
    }
  });
});

describe('isFeedUrlAllowed (M6.3)', () => {
  it('takes https, and http only to this machine', () => {
    for (const url of [
      DEFAULT_FEED_URL,
      'https://example.com/feed.json',
      'http://127.0.0.1:8080/releases/latest',
      'http://localhost:3000/feed',
      'http://[::1]/feed',
    ]) {
      expect(isFeedUrlAllowed(url), url).toBe(true);
    }
  });

  it('refuses everything else', () => {
    for (const url of [
      'http://example.com/feed',
      'http://192.168.1.1/feed',
      'https://user:pass@example.com/feed',
      'file:///C:/feed.json',
      'javascript:alert(1)',
      'ftp://example.com/feed',
      '',
      'not a url',
      `https://example.com/${'a'.repeat(MAX_FEED_URL)}`,
    ]) {
      expect(isFeedUrlAllowed(url), url).toBe(false);
    }
  });
});

describe('nextCheckAt (M6.3)', () => {
  const started = 1_000_000;

  it('never schedules a check while checks are off', () => {
    expect(nextCheckAt(false, null, started)).toBeNull();
    expect(nextCheckAt(false, started - 1, started)).toBeNull();
  });

  it('waits after startup, then once a day', () => {
    expect(nextCheckAt(true, null, started)).toBe(started + FIRST_CHECK_DELAY_MS);
    expect(nextCheckAt(true, started - CHECK_INTERVAL_MS * 2, started)).toBe(
      started + FIRST_CHECK_DELAY_MS,
    );
    const last = started + 10 * 60 * 1000;
    expect(nextCheckAt(true, last, started)).toBe(last + CHECK_INTERVAL_MS);
  });
});
