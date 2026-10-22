import { describe, expect, it } from 'vitest';

import { MAX_HISTORY_ENTRIES, MAX_HISTORY_TITLE, sanitizeHistory } from '../session/history';
import type { TabHistory } from '../session/history';
import {
  MAX_PAGE_STATE_PER_TAB,
  restorableSnapshot,
  sameStack,
  withoutPageState,
} from './snapshot';
import type { NavigationSnapshot } from './snapshot';

const urlAt = (n: number) => `https://site.example/${String(n)}`;
const titleAt = (n: number) => `Page ${String(n)}`;

/** What Chromium reports for entry `n`, with `extra` fields (a page state, say) on top. */
const chromium = (n: number, extra: Record<string, unknown> = {}) => ({
  url: urlAt(n),
  title: titleAt(n),
  ...extra,
});
/** The same entry once it has been cleaned and has no page state. */
const plain = (n: number) => ({ url: urlAt(n), title: titleAt(n) });
const withState = (n: number, pageState: string) => ({ ...plain(n), pageState });

const chromiumEntries = (count: number, pageState?: (n: number) => string) =>
  Array.from({ length: count }, (_, n) =>
    chromium(n, pageState ? { pageState: pageState(n) } : {}),
  );

/** A page state of `length` characters. */
const state = (length: number) => 'x'.repeat(length);

const BAD = { url: 'javascript:alert(1)', title: 'bad' };

describe('MAX_PAGE_STATE_PER_TAB', () => {
  it('is 256 KiB of characters', () => {
    expect(MAX_PAGE_STATE_PER_TAB).toBe(262_144);
  });
});

describe('restorableSnapshot', () => {
  describe('with input that is not a history', () => {
    it('is null for null', () => {
      expect(restorableSnapshot(null)).toBeNull();
    });

    it('is null for no entries', () => {
      expect(restorableSnapshot({ index: 0, entries: [] })).toBeNull();
    });

    it('is null when no entry is usable', () => {
      expect(
        restorableSnapshot({
          index: 0,
          entries: [null, undefined, 42, 'https://site.example/', ['x'], { url: 7 }, BAD],
        }),
      ).toBeNull();
    });

    it.each([
      ['NaN', Number.NaN],
      ['a fraction', 1.5],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
    ])('is null when the index is %s', (_name, index) => {
      expect(restorableSnapshot({ index, entries: chromiumEntries(3) })).toBeNull();
    });

    it('is null when the index is not a number', () => {
      const garbage = { index: '1', entries: chromiumEntries(3) } as unknown as Parameters<
        typeof restorableSnapshot
      >[0];

      expect(restorableSnapshot(garbage)).toBeNull();
    });

    it('drops entries that are not objects and keeps the rest', () => {
      const result = restorableSnapshot({
        index: 4,
        entries: [null, chromium(1, { pageState: 'AAAA' }), 7, 'str', chromium(2)],
      });

      expect(result).toStrictEqual({ index: 1, entries: [withState(1, 'AAAA'), plain(2)] });
    });
  });

  describe('with a clean history', () => {
    it('keeps the entries and the page state of each', () => {
      const result = restorableSnapshot({
        index: 1,
        entries: [
          chromium(0, { pageState: 'AAAA' }),
          chromium(1, { pageState: 'BBBB' }),
          chromium(2),
        ],
      });

      expect(result).toStrictEqual({
        index: 1,
        entries: [withState(0, 'AAAA'), withState(1, 'BBBB'), plain(2)],
      });
    });

    it('keeps a history without any page state as plain entries', () => {
      const result = restorableSnapshot({ index: 0, entries: chromiumEntries(2) });

      expect(result).toStrictEqual({ index: 0, entries: [plain(0), plain(1)] });
    });

    it('keeps only url, title and page state of an entry', () => {
      const result = restorableSnapshot({
        index: 0,
        entries: [
          chromium(0, { pageState: 'AAAA', navigationEntryIndex: 4, referrer: { url: 'x' } }),
        ],
      });

      expect(result?.entries[0]).toStrictEqual(withState(0, 'AAAA'));
    });

    it('does not change what it was given, and returns entries of its own', () => {
      const given = {
        index: 1,
        entries: [
          chromium(0, { pageState: 'AAAA' }),
          { url: 'https://user:pw@site.example/1#access_token=x', title: 't', pageState: 'BB' },
        ],
      };
      const before = JSON.stringify(given);

      const result = restorableSnapshot(given);

      expect(JSON.stringify(given)).toBe(before);
      expect(result?.entries[0]).not.toBe(given.entries[0]);
    });

    it('is idempotent: a snapshot that was cleaned once comes through unchanged', () => {
      const once = restorableSnapshot({
        index: 70,
        entries: [
          ...chromiumEntries(100, (n) => `S${String(n)}`),
          { url: 'https://user:pw@site.example/z#access_token=x', title: 't'.repeat(3000) },
          BAD,
        ],
      });

      expect(once).not.toBeNull();
      expect(restorableSnapshot(once)).toStrictEqual(once);
    });
  });

  describe('filters like sanitizeHistory', () => {
    it('keeps only http, https and file entries', () => {
      const result = restorableSnapshot({
        index: 0,
        entries: [
          { url: 'http://site.example/', title: 'http', pageState: 'A' },
          { url: 'https://site.example/', title: 'https', pageState: 'B' },
          { url: 'file:///C:/notes.html', title: 'file', pageState: 'C' },
          { url: 'veltriva://newtab', title: 'internal', pageState: 'D' },
          { url: 'about:blank', title: 'blank', pageState: 'E' },
          { url: 'data:text/html,x', title: 'data', pageState: 'F' },
          { url: 'javascript:alert(1)', title: 'js', pageState: 'G' },
          { url: 'blob:https://site.example/1', title: 'blob', pageState: 'H' },
          { url: 'chrome-error://chromewebdata/', title: 'error', pageState: 'I' },
        ],
      });

      expect(result?.entries.map((e) => e.title)).toEqual(['http', 'https', 'file']);
      expect(result?.entries.map((e) => e.pageState)).toEqual(['A', 'B', 'C']);
    });

    it('drops an entry whose URL is missing, not a string or empty', () => {
      const result = restorableSnapshot({
        index: 0,
        entries: [
          chromium(1),
          { title: 'no url', pageState: 'A' },
          { url: 5, title: 'number', pageState: 'A' },
          { url: '', title: 'empty', pageState: 'A' },
          chromium(2),
        ],
      });

      expect(result?.entries.map((e) => e.url)).toEqual([urlAt(1), urlAt(2)]);
    });

    it('removes credentials from the address', () => {
      const result = restorableSnapshot({
        index: 0,
        entries: [{ url: 'https://user:pass@site.example/a?q=1', title: 'A' }],
      });

      expect(result?.entries[0]?.url).toBe('https://site.example/a?q=1');
    });

    it('cuts a fragment that carries a token', () => {
      const result = restorableSnapshot({
        index: 0,
        entries: [
          { url: 'https://site.example/cb#access_token=abc&state=1', title: 'A' },
          { url: 'https://site.example/#/cb?code=abc', title: 'B' },
        ],
      });

      expect(result?.entries.map((e) => e.url)).toEqual([
        'https://site.example/cb',
        'https://site.example/',
      ]);
    });

    it('keeps a harmless fragment', () => {
      const result = restorableSnapshot({
        index: 0,
        entries: [{ url: 'https://site.example/page#section', title: 'A' }],
      });

      expect(result?.entries[0]?.url).toBe('https://site.example/page#section');
    });

    it('cuts a title at 1,024 characters', () => {
      const result = restorableSnapshot({
        index: 0,
        entries: [
          { url: urlAt(0), title: 'x'.repeat(5000) },
          { url: urlAt(1), title: 'y'.repeat(MAX_HISTORY_TITLE) },
        ],
      });

      expect(result?.entries[0]?.title).toHaveLength(MAX_HISTORY_TITLE);
      expect(result?.entries[1]?.title).toBe('y'.repeat(MAX_HISTORY_TITLE));
    });

    it.each([
      ['missing', undefined],
      ['null', null],
      ['a number', 7],
      ['an object', { text: 'x' }],
    ])('uses an empty title when the title is %s', (_name, title) => {
      const result = restorableSnapshot({ index: 0, entries: [{ url: urlAt(0), title }] });

      expect(result?.entries[0]?.title).toBe('');
    });

    it('is exactly sanitizeHistory once page state is taken away, for a range of inputs', () => {
      const inputs: Parameters<typeof restorableSnapshot>[0][] = [
        { index: 1, entries: chromiumEntries(3, (n) => `S${String(n)}`) },
        { index: 2, entries: [chromium(0), chromium(1), BAD, chromium(3)] },
        { index: 3, entries: [chromium(0), BAD, BAD, BAD, chromium(4)] },
        { index: 0, entries: [BAD, BAD, chromium(2), chromium(3)] },
        { index: 99, entries: chromiumEntries(3) },
        { index: -4, entries: chromiumEntries(3) },
        { index: 100, entries: chromiumEntries(120, () => 'S') },
        { index: 3, entries: chromiumEntries(120, () => 'S') },
        { index: 119, entries: chromiumEntries(120, () => 'S') },
        {
          index: 1,
          entries: [
            { url: 'https://user:pass@site.example/a', title: 'A', pageState: 'A' },
            { url: 'https://site.example/b#access_token=abc', title: 'B', pageState: 'B' },
            { url: 'https://site.example/c#section', title: 'C'.repeat(2000), pageState: 'C' },
          ],
        },
        { index: 0, entries: [BAD, null, 5] },
        { index: Number.NaN, entries: chromiumEntries(2) },
        { index: 0, entries: [] },
        null,
      ];

      for (const input of inputs) {
        const snapshot = restorableSnapshot(input);

        expect(snapshot === null ? null : withoutPageState(snapshot)).toStrictEqual(
          sanitizeHistory(input),
        );
      }
    });
  });

  describe('at most 50 entries, around the active one', () => {
    it('keeps 50 and no more', () => {
      for (const count of [51, 60, 100, 500]) {
        const result = restorableSnapshot({ index: count - 1, entries: chromiumEntries(count) });

        expect(result?.entries).toHaveLength(MAX_HISTORY_ENTRIES);
      }
    });

    it('keeps the active entry, 40 behind it and the rest ahead, with their page state', () => {
      const result = restorableSnapshot({
        index: 100,
        entries: chromiumEntries(120, (n) => `S${String(n)}`),
      });

      expect(result?.index).toBe(40);
      expect(result?.entries.map((e) => e.url)).toEqual(
        Array.from({ length: 50 }, (_, n) => urlAt(60 + n)),
      );
      expect(result?.entries.map((e) => e.pageState)).toEqual(
        Array.from({ length: 50 }, (_, n) => `S${String(60 + n)}`),
      );
    });

    it('keeps the first 50 when the active entry is near the start', () => {
      const result = restorableSnapshot({ index: 3, entries: chromiumEntries(120) });

      expect(result?.index).toBe(3);
      expect(result?.entries[0]?.url).toBe(urlAt(0));
      expect(result?.entries[49]?.url).toBe(urlAt(49));
    });

    it('keeps the last 50 when the active entry is the newest', () => {
      const result = restorableSnapshot({ index: 119, entries: chromiumEntries(120) });

      expect(result?.index).toBe(49);
      expect(result?.entries[0]?.url).toBe(urlAt(70));
    });

    it('counts the entries that are kept, not the ones it was given', () => {
      const result = restorableSnapshot({
        index: 10,
        entries: [...chromiumEntries(40), ...Array.from({ length: 20 }, () => BAD)],
      });

      expect(result?.entries).toHaveLength(40);
      expect(result?.index).toBe(10);
    });
  });

  describe('the active index', () => {
    it('moves to the nearest earlier entry that is kept when the active one is dropped', () => {
      const result = restorableSnapshot({
        index: 2,
        entries: [chromium(0), chromium(1), BAD, chromium(3)],
      });

      expect(result?.index).toBe(1);
      expect(result?.entries.map((e) => e.url)).toEqual([urlAt(0), urlAt(1), urlAt(3)]);
    });

    it('skips several dropped entries', () => {
      const result = restorableSnapshot({
        index: 3,
        entries: [chromium(0), BAD, BAD, BAD, chromium(4)],
      });

      expect(result?.index).toBe(0);
      expect(result?.entries).toHaveLength(2);
    });

    it('moves to the first later entry when nothing earlier is kept', () => {
      const result = restorableSnapshot({
        index: 1,
        entries: [BAD, BAD, chromium(2), chromium(3)],
      });

      expect(result?.index).toBe(0);
      expect(result?.entries[0]?.url).toBe(urlAt(2));
    });

    it('follows the active entry to its new position when earlier ones are dropped', () => {
      const result = restorableSnapshot({
        index: 3,
        entries: [BAD, chromium(1), BAD, chromium(3, { pageState: 'ACTIVE' }), chromium(4)],
      });

      expect(result?.index).toBe(1);
      expect(result?.entries[result.index]).toStrictEqual(withState(3, 'ACTIVE'));
    });

    it('is the last entry for an index past the end, and the first for a negative one', () => {
      expect(restorableSnapshot({ index: 99, entries: chromiumEntries(3) })?.index).toBe(2);
      expect(restorableSnapshot({ index: -4, entries: chromiumEntries(3) })?.index).toBe(0);
    });
  });

  describe('the page state of an entry', () => {
    it('is kept when the URL came through unchanged', () => {
      const result = restorableSnapshot({
        index: 0,
        entries: [chromium(0, { pageState: 'AAAA' })],
      });

      expect(result?.entries[0]?.pageState).toBe('AAAA');
    });

    it.each([
      ['credentials in the address', 'https://user:pass@site.example/a', 'https://site.example/a'],
      ['a user name in the address', 'https://user@site.example/a', 'https://site.example/a'],
      ['a token fragment', 'https://site.example/b#access_token=abc', 'https://site.example/b'],
      [
        'a token fragment in a hash route',
        'https://site.example/#/cb?code=abc',
        'https://site.example/',
      ],
      [
        'credentials and a token',
        'https://u:p@site.example/c#id_token=abc',
        'https://site.example/c',
      ],
    ])(
      'is dropped when cleaning removed %s: it belongs to another document',
      (_name, url, clean) => {
        const result = restorableSnapshot({
          index: 0,
          entries: [{ url, title: 'T', pageState: 'AAAA' }],
        });

        expect(result).toStrictEqual({ index: 0, entries: [{ url: clean, title: 'T' }] });
      },
    );

    it.each([
      ['a plain fragment', 'https://site.example/page#section'],
      ['an empty fragment', 'https://site.example/#'],
      ['a hash route without a token', 'https://site.example/#/inbox/thread?folder=work'],
      ['a query string with a token-like name', 'https://site.example/p?token=abc'],
      ['an upper-case scheme and host', 'HTTPS://Site.Example/Path'],
      ['a port', 'https://site.example:8443/a'],
      ['a local file', 'file:///C:/Users/me/notes.html'],
      ['http', 'http://site.example/'],
    ])('is kept for %s, which cleaning leaves alone', (_name, url) => {
      const result = restorableSnapshot({
        index: 0,
        entries: [{ url, title: 'T', pageState: 'AAAA' }],
      });

      expect(result?.entries[0]).toStrictEqual({ url, title: 'T', pageState: 'AAAA' });
    });

    it('is dropped only for the entry whose URL changed, not for its neighbours', () => {
      const result = restorableSnapshot({
        index: 1,
        entries: [
          chromium(0, { pageState: 'A' }),
          { url: 'https://user:pw@site.example/1', title: 'one', pageState: 'B' },
          chromium(2, { pageState: 'C' }),
        ],
      });

      expect(result?.entries).toStrictEqual([
        withState(0, 'A'),
        { url: 'https://site.example/1', title: 'one' },
        withState(2, 'C'),
      ]);
    });

    it('is dropped when it is the empty string, which restore() rejects', () => {
      const result = restorableSnapshot({
        index: 0,
        entries: [chromium(0, { pageState: '' })],
      });

      expect(result?.entries[0]).toStrictEqual(plain(0));
      expect(result?.entries[0]).not.toHaveProperty('pageState');
    });

    it.each([
      ['undefined', undefined],
      ['null', null],
      ['a number', 12],
      ['zero', 0],
      ['true', true],
      ['an object', { data: 'AAAA' }],
      ['an array of strings', ['AAAA']],
      ['a function', () => 'AAAA'],
    ])('is dropped when it is %s, not a string', (_name, pageState) => {
      const result = restorableSnapshot({ index: 0, entries: [chromium(0, { pageState })] });

      expect(result?.entries[0]).toStrictEqual(plain(0));
      expect(result?.entries[0]).not.toHaveProperty('pageState');
    });

    it('is kept whatever the characters, as long as the string is not empty', () => {
      const result = restorableSnapshot({
        index: 0,
        entries: [chromium(0, { pageState: ' ' }), chromium(1, { pageState: 'AAAA/+==' })],
      });

      expect(result?.entries.map((e) => e.pageState)).toEqual([' ', 'AAAA/+==']);
    });

    it('is dropped with its entry when the entry itself is dropped', () => {
      const result = restorableSnapshot({
        index: 0,
        entries: [{ ...BAD, pageState: state(100) }, chromium(1, { pageState: 'AAAA' })],
      });

      expect(result?.entries).toStrictEqual([withState(1, 'AAAA')]);
    });
  });

  describe('the page state of a whole tab (MAX_PAGE_STATE_PER_TAB)', () => {
    const cap = MAX_PAGE_STATE_PER_TAB;

    it('is all kept when it adds up to exactly the cap', () => {
      const result = restorableSnapshot({
        index: 0,
        entries: [
          chromium(0, { pageState: state(cap - 10) }),
          chromium(1, { pageState: state(10) }),
        ],
      });

      expect(result?.entries.map((e) => e.pageState?.length)).toEqual([cap - 10, 10]);
    });

    it('is cut to the active entry when it adds up to one more than the cap', () => {
      const entries = [
        chromium(0, { pageState: state(cap - 10) }),
        chromium(1, { pageState: state(11) }),
      ];

      const first = restorableSnapshot({ index: 0, entries });
      const second = restorableSnapshot({ index: 1, entries });

      expect(first?.entries).toStrictEqual([withState(0, state(cap - 10)), plain(1)]);
      expect(second?.entries).toStrictEqual([plain(0), withState(1, state(11))]);
    });

    it('keeps the index when it cuts', () => {
      const result = restorableSnapshot({
        index: 2,
        entries: [
          chromium(0, { pageState: state(cap) }),
          chromium(1, { pageState: state(cap) }),
          chromium(2, { pageState: state(5) }),
        ],
      });

      expect(result?.index).toBe(2);
      expect(result?.entries).toHaveLength(3);
    });

    it('keeps an active entry whose state is exactly the cap, and drops every other', () => {
      const result = restorableSnapshot({
        index: 1,
        entries: [chromium(0, { pageState: 'A' }), chromium(1, { pageState: state(cap) })],
      });

      expect(result?.entries).toStrictEqual([plain(0), withState(1, state(cap))]);
    });

    it('drops the active state too when it alone is over the cap', () => {
      const result = restorableSnapshot({
        index: 0,
        entries: [chromium(0, { pageState: state(cap + 1) }), chromium(1)],
      });

      expect(result).toStrictEqual({ index: 0, entries: [plain(0), plain(1)] });
    });

    it('drops every state when the active entry has none and the others are over the cap', () => {
      const result = restorableSnapshot({
        index: 2,
        entries: [
          chromium(0, { pageState: state(cap) }),
          chromium(1, { pageState: state(1) }),
          chromium(2),
        ],
      });

      expect(result).toStrictEqual({ index: 2, entries: [plain(0), plain(1), plain(2)] });
    });

    it('cuts to the entry that became active when the requested one was dropped', () => {
      const result = restorableSnapshot({
        index: 1,
        entries: [
          chromium(0, { pageState: state(200_000) }),
          BAD,
          chromium(2, { pageState: state(100_000) }),
        ],
      });

      expect(result?.index).toBe(0);
      expect(result?.entries).toStrictEqual([withState(0, state(200_000)), plain(2)]);
    });

    it('leaves only url and title on the entries it cuts', () => {
      const result = restorableSnapshot({
        index: 0,
        entries: [chromium(0, { pageState: 'A' }), chromium(1, { pageState: state(cap) })],
      });

      expect(Object.keys(result?.entries[1] ?? {}).sort()).toEqual(['title', 'url']);
    });

    it('counts only the entries that are kept: a dropped entry does not use up the cap', () => {
      const result = restorableSnapshot({
        index: 0,
        entries: [
          { ...BAD, pageState: state(cap * 2) },
          chromium(1, { pageState: state(100) }),
          chromium(2, { pageState: state(100) }),
        ],
      });

      expect(result?.entries.map((e) => e.pageState?.length)).toEqual([100, 100]);
    });

    it('counts only states that were kept: an entry whose URL changed does not use up the cap', () => {
      const result = restorableSnapshot({
        index: 0,
        entries: [
          { url: 'https://user:pw@site.example/0', title: 'T', pageState: state(cap * 2) },
          chromium(1, { pageState: state(100) }),
          chromium(2, { pageState: state(100) }),
        ],
      });

      expect(result?.entries.map((e) => e.pageState?.length)).toEqual([undefined, 100, 100]);
    });

    it('counts only the 50 entries that stay, not the ones trimmed away', () => {
      // 120 entries of 5,242 characters are 629,040 in all, but the 50 that stay are 262,100.
      const each = Math.floor(cap / MAX_HISTORY_ENTRIES);
      expect(each * MAX_HISTORY_ENTRIES).toBeLessThanOrEqual(cap);
      expect(each * 120).toBeGreaterThan(cap);

      const result = restorableSnapshot({
        index: 119,
        entries: chromiumEntries(120, () => state(each)),
      });

      expect(result?.entries).toHaveLength(MAX_HISTORY_ENTRIES);
      expect(result?.entries.every((e) => e.pageState?.length === each)).toBe(true);
    });

    it('cuts the 50 entries that stay when they are over the cap on their own', () => {
      const each = Math.floor(cap / MAX_HISTORY_ENTRIES) + 1;

      const result = restorableSnapshot({
        index: 119,
        entries: chromiumEntries(120, () => state(each)),
      });

      expect(result?.entries).toHaveLength(MAX_HISTORY_ENTRIES);
      expect(result?.entries.filter((e) => e.pageState !== undefined)).toHaveLength(1);
      expect(result?.entries[result.index]?.pageState).toHaveLength(each);
    });
  });
});

describe('withoutPageState', () => {
  const snapshot: NavigationSnapshot = {
    index: 1,
    entries: [withState(0, 'AAAA'), withState(1, 'BBBB'), plain(2)],
  };

  it('keeps the index and the url and title of each entry, and nothing else', () => {
    expect(withoutPageState(snapshot)).toStrictEqual({
      index: 1,
      entries: [plain(0), plain(1), plain(2)],
    });
  });

  it('leaves no pageState key, not even an undefined one', () => {
    for (const entry of withoutPageState(snapshot).entries) {
      expect(Object.keys(entry).sort()).toEqual(['title', 'url']);
    }
    expect(JSON.stringify(withoutPageState(snapshot))).not.toContain('pageState');
  });

  it('keeps only url and title of an entry, whatever else it carries', () => {
    const carrying = { url: urlAt(0), title: 'T', pageState: 'AAAA', extra: 1 };

    expect(withoutPageState({ index: 0, entries: [carrying] }).entries[0]).toStrictEqual({
      url: urlAt(0),
      title: 'T',
    });
  });

  it('does not change the snapshot it was given', () => {
    const before = JSON.stringify(snapshot);

    const result = withoutPageState(snapshot);

    expect(JSON.stringify(snapshot)).toBe(before);
    expect(result.entries[0]).not.toBe(snapshot.entries[0]);
    expect(snapshot.entries[0]?.pageState).toBe('AAAA');
  });

  it('handles a snapshot with no entries', () => {
    expect(withoutPageState({ index: 0, entries: [] })).toStrictEqual({ index: 0, entries: [] });
  });

  it('makes a history that sanitizeHistory leaves as it is', () => {
    const history = withoutPageState(snapshot);

    expect(sanitizeHistory(history)).toStrictEqual(history);
  });

  it('is what the session stores for a snapshot that restorableSnapshot made', () => {
    const made = restorableSnapshot({
      index: 1,
      entries: [chromium(0, { pageState: 'A' }), chromium(1, { pageState: 'B' })],
    });

    expect(made && withoutPageState(made)).toStrictEqual({
      index: 1,
      entries: [plain(0), plain(1)],
    });
  });
});

describe('sameStack', () => {
  const snapshot: NavigationSnapshot = {
    index: 1,
    entries: [withState(0, 'AAAA'), withState(1, 'BBBB'), plain(2)],
  };
  const history: TabHistory = { index: 1, entries: [plain(0), plain(1), plain(2)] };

  it('is true for the same entries and the same active one', () => {
    expect(sameStack(snapshot, history)).toBe(true);
  });

  it('is true for a snapshot and its own history without page state', () => {
    expect(sameStack(snapshot, withoutPageState(snapshot))).toBe(true);
  });

  it('ignores page state: it is true whether or not the snapshot has some', () => {
    expect(sameStack({ index: 1, entries: history.entries }, history)).toBe(true);
    expect(sameStack(snapshot, history)).toBe(true);
  });

  it('is false when the active index differs', () => {
    expect(sameStack({ ...snapshot, index: 0 }, history)).toBe(false);
    expect(sameStack(snapshot, { ...history, index: 2 })).toBe(false);
  });

  it('is false when the snapshot has more entries', () => {
    expect(sameStack({ ...snapshot, entries: [...snapshot.entries, plain(3)] }, history)).toBe(
      false,
    );
  });

  it('is false when the history has more entries', () => {
    expect(sameStack(snapshot, { ...history, entries: [...history.entries, plain(3)] })).toBe(
      false,
    );
  });

  it('is false when the history has fewer entries and the rest are equal', () => {
    expect(sameStack(snapshot, { ...history, entries: history.entries.slice(0, 2) })).toBe(false);
    expect(sameStack({ ...snapshot, entries: snapshot.entries.slice(0, 2) }, history)).toBe(false);
  });

  it('is false when a url differs, in any position', () => {
    for (let at = 0; at < 3; at += 1) {
      const entries = history.entries.map((e, n) => (n === at ? { ...e, url: urlAt(99) } : e));

      expect(sameStack(snapshot, { ...history, entries })).toBe(false);
    }
  });

  it('is false when a title differs, in any position', () => {
    for (let at = 0; at < 3; at += 1) {
      const entries = history.entries.map((e, n) => (n === at ? { ...e, title: 'Other' } : e));

      expect(sameStack(snapshot, { ...history, entries })).toBe(false);
    }
  });

  it('compares exactly: a case or whitespace difference counts', () => {
    const entries = [plain(0), { url: urlAt(1).toUpperCase(), title: titleAt(1) }, plain(2)];

    expect(sameStack(snapshot, { ...history, entries })).toBe(false);
    expect(
      sameStack(snapshot, {
        ...history,
        entries: [plain(0), { url: urlAt(1), title: `${titleAt(1)} ` }, plain(2)],
      }),
    ).toBe(false);
  });

  it('is false for the same urls in another order', () => {
    expect(
      sameStack(snapshot, {
        ...history,
        entries: [plain(1), plain(0), plain(2)],
      }),
    ).toBe(false);
  });

  it('is true for two empty stacks at the same index', () => {
    expect(sameStack({ index: 0, entries: [] }, { index: 0, entries: [] })).toBe(true);
    expect(sameStack({ index: 0, entries: [] }, { index: 1, entries: [] })).toBe(false);
  });

  it('is false for a stack and an empty one', () => {
    expect(sameStack(snapshot, { index: 1, entries: [] })).toBe(false);
    expect(sameStack({ index: 1, entries: [] }, history)).toBe(false);
  });
});
