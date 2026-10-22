import { describe, expect, it } from 'vitest';

import {
  ROWS_PER_PAGE,
  archiveCountText,
  archiveSummary,
  archivedDescription,
  archivedLabel,
  archivedMeta,
  archivedRowText,
  countsLine,
  isSectionExpanded,
  relativeTime,
  rowWindow,
  tabCount,
} from './placement-display';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;

describe('countsLine', () => {
  it('is the sidebar summary of assessment §4.13', () => {
    expect(countsLine({ sleeping: 12, archivedToday: 3 })).toBe('Sleeping 12 · Archived today 3');
  });

  it('shows zeros: nothing moved is also something to know', () => {
    expect(countsLine({ sleeping: 0, archivedToday: 0 })).toBe('Sleeping 0 · Archived today 0');
  });

  it('shows a thousand tabs in full', () => {
    expect(countsLine({ sleeping: 1204, archivedToday: 37 })).toBe(
      'Sleeping 1204 · Archived today 37',
    );
  });
});

describe('archiveSummary', () => {
  it("gives today's number and the total", () => {
    expect(archiveSummary({ archived: 41, archivedToday: 3 })).toBe(
      'Archived today 3 · 41 in total',
    );
    expect(archiveSummary({ archived: 0, archivedToday: 0 })).toBe('Archived today 0 · 0 in total');
  });
});

describe('tabCount and archiveCountText', () => {
  it('says "1 tab" and "n tabs"', () => {
    expect(tabCount(0)).toBe('0 tabs');
    expect(tabCount(1)).toBe('1 tab');
    expect(tabCount(12)).toBe('12 tabs');
  });

  it('reads the Archive count in words', () => {
    expect(archiveCountText({ archived: 41, archivedToday: 3 })).toBe(
      '41 tabs in total, 3 archived today',
    );
    expect(archiveCountText({ archived: 1, archivedToday: 0 })).toBe(
      '1 tab in total, 0 archived today',
    );
  });
});

describe('isSectionExpanded', () => {
  it('follows the fallback until the user chooses', () => {
    expect(isSectionExpanded(null, true)).toBe(true);
    expect(isSectionExpanded(null, false)).toBe(false);
  });

  it('follows the user once they chose, whatever the fallback says', () => {
    expect(isSectionExpanded(false, true)).toBe(false);
    expect(isSectionExpanded(true, false)).toBe(true);
  });
});

describe('rowWindow', () => {
  it('shows everything of a short list', () => {
    expect(rowWindow(12, ROWS_PER_PAGE)).toEqual({ shown: 12, remaining: 0, step: 0 });
    expect(rowWindow(0, ROWS_PER_PAGE)).toEqual({ shown: 0, remaining: 0, step: 0 });
  });

  it('cuts a long list at the limit and offers a page more', () => {
    expect(rowWindow(1500, ROWS_PER_PAGE)).toEqual({
      shown: ROWS_PER_PAGE,
      remaining: 1500 - ROWS_PER_PAGE,
      step: ROWS_PER_PAGE,
    });
  });

  it('offers only what is left when less than a page remains', () => {
    expect(rowWindow(250, ROWS_PER_PAGE)).toEqual({
      shown: ROWS_PER_PAGE,
      remaining: 50,
      step: 50,
    });
  });

  it('follows the list when it shrinks below the limit, and ignores a negative limit', () => {
    expect(rowWindow(3, 400)).toEqual({ shown: 3, remaining: 0, step: 0 });
    expect(rowWindow(3, -5)).toEqual({ shown: 0, remaining: 3, step: 3 });
  });
});

describe('relativeTime', () => {
  it('is "just now" for the first minute, and for a clock set back', () => {
    expect(relativeTime(NOW, NOW)).toBe('just now');
    expect(relativeTime(NOW - 59_999, NOW)).toBe('just now');
    expect(relativeTime(NOW + 5 * MINUTE, NOW)).toBe('just now');
  });

  it('counts whole minutes, hours and days, rounded down', () => {
    expect(relativeTime(NOW - MINUTE, NOW)).toBe('1 min ago');
    expect(relativeTime(NOW - 59 * MINUTE - 59_000, NOW)).toBe('59 min ago');
    expect(relativeTime(NOW - HOUR, NOW)).toBe('1 h ago');
    expect(relativeTime(NOW - 2 * HOUR - 30 * MINUTE, NOW)).toBe('2 h ago');
    expect(relativeTime(NOW - 23 * HOUR - 59 * MINUTE, NOW)).toBe('23 h ago');
    expect(relativeTime(NOW - DAY, NOW)).toBe('1 d ago');
    expect(relativeTime(NOW - 29 * DAY - 23 * HOUR, NOW)).toBe('29 d ago');
  });

  it('moves on to months and years for old tabs', () => {
    expect(relativeTime(NOW - 30 * DAY, NOW)).toBe('1 mo ago');
    expect(relativeTime(NOW - 364 * DAY, NOW)).toBe('12 mo ago');
    expect(relativeTime(NOW - 365 * DAY, NOW)).toBe('1 y ago');
    expect(relativeTime(NOW - 800 * DAY, NOW)).toBe('2 y ago');
  });

  it('spells the units out for a screen reader', () => {
    expect(relativeTime(NOW - MINUTE, NOW, 'long')).toBe('1 minute ago');
    expect(relativeTime(NOW - 5 * MINUTE, NOW, 'long')).toBe('5 minutes ago');
    expect(relativeTime(NOW - 2 * HOUR, NOW, 'long')).toBe('2 hours ago');
    expect(relativeTime(NOW - DAY, NOW, 'long')).toBe('1 day ago');
    expect(relativeTime(NOW - 3 * DAY, NOW, 'long')).toBe('3 days ago');
    expect(relativeTime(NOW - 60 * DAY, NOW, 'long')).toBe('2 months ago');
    expect(relativeTime(NOW - 400 * DAY, NOW, 'long')).toBe('1 year ago');
    expect(relativeTime(NOW, NOW, 'long')).toBe('just now');
  });

  it('does not print "NaN" when a time is not a number', () => {
    expect(relativeTime(Number.NaN, NOW)).toBe('just now');
  });
});

describe('archivedMeta and archivedDescription', () => {
  it('gives when and who, for automation and for the user', () => {
    expect(archivedMeta({ archivedAt: NOW - 2 * HOUR, reason: 'auto' }, NOW)).toBe(
      '2 h ago · by automation',
    );
    expect(archivedMeta({ archivedAt: NOW - 3 * DAY, reason: 'manual' }, NOW)).toBe(
      '3 d ago · by you',
    );
  });

  it('says it in words for a screen reader', () => {
    expect(archivedDescription({ archivedAt: NOW - 2 * HOUR, reason: 'auto' }, NOW)).toBe(
      'Archived 2 hours ago by automation',
    );
    expect(archivedDescription({ archivedAt: NOW, reason: 'manual' }, NOW)).toBe(
      'Archived just now by you',
    );
  });
});

describe('archivedLabel', () => {
  const archived = { title: 'Example Domain', address: { text: 'example.com' } };

  it('prefers the title, then the address, then "Untitled"', () => {
    expect(archivedLabel(archived)).toBe('Example Domain');
    expect(archivedLabel({ ...archived, title: '  ' })).toBe('example.com');
    expect(archivedLabel({ title: '', address: { text: ' ' } })).toBe('Untitled');
  });

  it('trims the title and leaves its text as it is', () => {
    expect(archivedLabel({ ...archived, title: '  <b>Hi</b> ' })).toBe('<b>Hi</b>');
  });
});

describe('archivedRowText', () => {
  const archived = {
    title: 'Example Domain',
    address: { text: 'example.com' },
    archivedAt: NOW - 2 * HOUR,
    reason: 'auto',
  } as const;

  it('gives the label, when and who, a tooltip and a description', () => {
    expect(archivedRowText(archived, NOW)).toEqual({
      label: 'Example Domain',
      meta: '2 h ago · by automation',
      tooltip:
        'Example Domain\nArchived 2 hours ago by automation — click to bring it back to Tabs',
      description: 'Archived 2 hours ago by automation. Click to bring it back to Tabs',
    });
  });

  it('says when the user archived it, and still labels a tab without a title', () => {
    const text = archivedRowText(
      { ...archived, title: '', reason: 'manual', archivedAt: NOW - 3 * DAY },
      NOW,
    );
    expect(text.label).toBe('example.com');
    expect(text.meta).toBe('3 d ago · by you');
    expect(text.tooltip).toBe(
      'example.com\nArchived 3 days ago by you — click to bring it back to Tabs',
    );
  });

  it("folds a page title's line breaks so it cannot add a line of its own", () => {
    const text = archivedRowText({ ...archived, title: 'Hi\nArchived by you ' }, NOW);
    expect(text.tooltip.split('\n')).toHaveLength(2);
    expect(text.tooltip.startsWith('Hi Archived by you\nArchived ')).toBe(true);
  });
});
