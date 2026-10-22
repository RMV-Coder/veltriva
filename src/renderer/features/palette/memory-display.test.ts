import { describe, expect, it } from 'vitest';

import {
  PALETTE_SCOPES,
  displayTitle,
  emptyMessage,
  formatScore,
  isOpenInStrip,
  removeSiteWords,
  resultsAnnouncement,
  scoreBreakdown,
  siteChipLabel,
  siteChipText,
  stateBadgeLabel,
  stepScope,
  suggestionOpenFor,
  visitedText,
} from './memory-display';
import type { MemoryResult, MemoryScope } from './memory-display';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;

const tab = (placement: 'strip' | 'shelf' | 'archive'): NonNullable<MemoryResult['tab']> => ({
  tabId: '0199f000-0000-7000-8000-000000000001',
  placement,
});

describe('PALETTE_SCOPES and stepScope', () => {
  it('lists the filters of assessment §7.3, in the order Tab steps through them', () => {
    expect(PALETTE_SCOPES.map((entry) => entry.label)).toEqual([
      'All',
      'Open',
      'Sleeping',
      'Archived',
      'Today',
      'This week',
    ]);
    expect(PALETTE_SCOPES.map((entry) => entry.scope)).toEqual([
      'all',
      'open',
      'sleeping',
      'archived',
      'today',
      'week',
    ]);
  });

  it('steps forward and back', () => {
    expect(stepScope('all', 1)).toBe('open');
    expect(stepScope('open', 1)).toBe('sleeping');
    expect(stepScope('archived', 1)).toBe('today');
    expect(stepScope('archived', -1)).toBe('sleeping');
  });

  it('wraps around at both ends', () => {
    expect(stepScope('week', 1)).toBe('all');
    expect(stepScope('all', -1)).toBe('week');
  });

  it('visits every filter once in a full turn', () => {
    const visited: string[] = [];
    let scope: MemoryScope = 'all';
    do {
      scope = stepScope(scope, 1);
      visited.push(scope);
    } while (scope !== 'all' && visited.length < 20);
    expect(visited).toEqual(['open', 'sleeping', 'archived', 'today', 'week', 'all']);
  });
});

describe('removeSiteWords and the chip', () => {
  it('removes a site: word and tidies the spaces', () => {
    expect(removeSiteWords('rust site:github.com')).toBe('rust');
    expect(removeSiteWords('site:github.com rust')).toBe('rust');
    expect(removeSiteWords('rust site:github.com traits')).toBe('rust traits');
    expect(removeSiteWords('site:github.com')).toBe('');
  });

  it('removes every site: word, whatever its case', () => {
    expect(removeSiteWords('a SITE:one.com b Site:two.org')).toBe('a b');
  });

  it('removes a site: word that names no site, and a bare "site:"', () => {
    expect(removeSiteWords('site: rust')).toBe('rust');
    expect(removeSiteWords('rust site:')).toBe('rust');
  });

  it('leaves words that merely contain "site:" alone', () => {
    expect(removeSiteWords('the website:home page')).toBe('the website:home page');
    expect(removeSiteWords('rust')).toBe('rust');
  });

  it('says "site: github.com" in the chip and names the button for what it does', () => {
    expect(siteChipText('github.com')).toBe('site: github.com');
    expect(siteChipLabel('github.com')).toBe('Remove the site filter github.com');
  });
});

describe('stateBadgeLabel', () => {
  it('names where the tab is, in words', () => {
    expect(stateBadgeLabel(tab('strip'))).toBe('Open');
    expect(stateBadgeLabel(tab('shelf'))).toBe('Sleeping');
    expect(stateBadgeLabel(tab('archive'))).toBe('Archived');
  });

  it('has no badge for a page without a tab', () => {
    expect(stateBadgeLabel(null)).toBeNull();
  });
});

describe('visitedText', () => {
  it('reads "visited 3 days ago" in words, as the sidebar says its times', () => {
    expect(visitedText(NOW - 3 * DAY, NOW)).toBe('visited 3 days ago');
    expect(visitedText(NOW - 5 * MINUTE, NOW)).toBe('visited 5 minutes ago');
    expect(visitedText(NOW - 2 * HOUR, NOW)).toBe('visited 2 hours ago');
    expect(visitedText(NOW - DAY, NOW)).toBe('visited 1 day ago');
  });

  it('says "just now" for the first minute and for a clock set back', () => {
    expect(visitedText(NOW - 10_000, NOW)).toBe('visited just now');
    expect(visitedText(NOW + HOUR, NOW)).toBe('visited just now');
  });

  it('says nothing for a page with no visit time', () => {
    expect(visitedText(0, NOW)).toBeNull();
    expect(visitedText(Number.NaN, NOW)).toBeNull();
  });
});

describe('displayTitle', () => {
  const base = {
    address: 'postgresql.org/docs/indexes',
    titleRanges: [[0, 4]] as [number, number][],
  };

  it('is the title, with its marks', () => {
    expect(displayTitle({ ...base, title: 'Indexes in PostgreSQL' })).toEqual({
      text: 'Indexes in PostgreSQL',
      ranges: [[0, 4]],
    });
  });

  it('falls back to the address when the title is blank, and then has no marks', () => {
    expect(displayTitle({ ...base, title: '' })).toEqual({
      text: 'postgresql.org/docs/indexes',
      ranges: [],
    });
    expect(displayTitle({ ...base, title: '   ' }).text).toBe('postgresql.org/docs/indexes');
  });

  it('is "Untitled" with neither', () => {
    expect(displayTitle({ title: '', address: '', titleRanges: [] })).toEqual({
      text: 'Untitled',
      ranges: [],
    });
  });
});

describe('the address bar suggestion', () => {
  it('knows whether the page is open in the strip', () => {
    expect(isOpenInStrip({ tab: tab('strip') })).toBe(true);
    expect(isOpenInStrip({ tab: tab('shelf') })).toBe(false);
    expect(isOpenInStrip({ tab: tab('archive') })).toBe(false);
    expect(isOpenInStrip({ tab: null })).toBe(false);
  });

  it('switches to a strip tab, and otherwise goes there in the current tab', () => {
    expect(suggestionOpenFor({ tab: tab('strip') })).toEqual({
      target: 'switch',
      tabId: '0199f000-0000-7000-8000-000000000001',
    });
    expect(suggestionOpenFor({ tab: tab('shelf') })).toEqual({ target: 'current' });
    expect(suggestionOpenFor({ tab: tab('archive') })).toEqual({ target: 'current' });
    expect(suggestionOpenFor({ tab: null })).toEqual({ target: 'current' });
  });
});

describe('formatScore and scoreBreakdown', () => {
  it('rounds to two decimals', () => {
    expect(formatScore(3.14159)).toBe('3.14');
    expect(formatScore(0.5)).toBe('0.50');
    expect(formatScore(2)).toBe('2.00');
    expect(formatScore(1.005)).toBe('1.00');
  });

  it('never shows a negative zero or a number that is not one', () => {
    expect(formatScore(-0.001)).toBe('0.00');
    expect(formatScore(-0)).toBe('0.00');
    expect(formatScore(Number.NaN)).toBe('0.00');
    expect(formatScore(Number.POSITIVE_INFINITY)).toBe('0.00');
  });

  it('keeps a real negative', () => {
    expect(formatScore(-1.236)).toBe('-1.24');
  });

  it('lists the five weighted terms in the order they add up, and the score', () => {
    const view = scoreBreakdown({
      score: 2.456,
      breakdown: { text: 1, frecency: 0.6931, titleExact: 0.4, siteMatch: 0, state: 0.5 },
    });
    expect(view.rows).toEqual([
      { key: 'text', label: 'Text match', value: '1.00' },
      { key: 'frecency', label: 'Frecency', value: '0.69' },
      { key: 'titleExact', label: 'Title words', value: '0.40' },
      { key: 'siteMatch', label: 'Site', value: '0.00' },
      { key: 'state', label: 'Tab state', value: '0.50' },
    ]);
    expect(view.total).toBe('2.46');
  });
});

describe('emptyMessage and resultsAnnouncement', () => {
  it('says "No pages match" for a text search and "Nothing remembered yet" for the recent list', () => {
    expect(emptyMessage('text')).toBe('No pages match');
    expect(emptyMessage('recent')).toBe('Nothing remembered yet');
  });

  it('announces how many results the list has', () => {
    expect(resultsAnnouncement(0, 'text')).toBe('No pages match');
    expect(resultsAnnouncement(0, 'recent')).toBe('Nothing remembered yet');
    expect(resultsAnnouncement(1, 'text')).toBe('1 result');
    expect(resultsAnnouncement(12, 'recent')).toBe('12 results');
  });
});
