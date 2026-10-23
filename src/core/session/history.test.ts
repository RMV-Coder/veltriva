import { describe, expect, it } from 'vitest';

import { MAX_STORED_TITLE, MAX_STORED_URL } from '../../shared/contracts/data-rpc';
import {
  keptTitle,
  MAX_HISTORY_ENTRIES,
  MAX_HISTORY_TITLE,
  MAX_HISTORY_URL,
  restorableUrl,
  sanitizeEntries,
  sanitizeHistory,
  singleEntryHistory,
  stripTokenFragment,
} from './history';
import type { HistoryEntry } from './history';

const entry = (n: number, title = `Page ${String(n)}`) => ({
  url: `https://site.example/${String(n)}`,
  title,
});
const entries = (count: number) => Array.from({ length: count }, (_, n) => entry(n));

describe('the history limits', () => {
  it('match the data contract', () => {
    expect(MAX_HISTORY_URL).toBe(MAX_STORED_URL);
    expect(MAX_HISTORY_TITLE).toBe(MAX_STORED_TITLE);
  });

  it('keep 50 entries, the most the restore_state column holds', () => {
    expect(MAX_HISTORY_ENTRIES).toBe(50);
  });
});

describe('stripTokenFragment', () => {
  it.each([
    ['an OAuth implicit-flow token', 'https://app.example/cb#access_token=abc&token_type=bearer'],
    ['an id token', 'https://app.example/cb#id_token=abc.def.ghi'],
    ['a refresh token', 'https://app.example/cb#refresh_token=abc'],
    ['a plain token', 'https://app.example/cb#token=abc'],
    ['an authorization code', 'https://app.example/cb#code=abc&state=xyz'],
    ['a key', 'https://app.example/cb#key=abc'],
    ['an api key', 'https://app.example/cb#api_key=abc'],
    ['a signature', 'https://app.example/cb#signature=abc'],
    ['a session id', 'https://app.example/cb#sid=abc'],
    ['a password', 'https://app.example/cb#password=hunter2'],
    ['a token after other parameters', 'https://app.example/cb#state=xyz&access_token=abc'],
    ['a token after a semicolon', 'https://app.example/cb#state=xyz;access_token=abc'],
  ])('cuts the fragment that carries %s', (_name, url) => {
    expect(stripTokenFragment(url)).toBe('https://app.example/cb');
  });

  it('cuts a token that sits inside a hash route', () => {
    expect(stripTokenFragment('https://app.example/#/cb?code=abc&state=1')).toBe(
      'https://app.example/',
    );
    expect(stripTokenFragment('https://app.example/#/auth/callback?access_token=abc')).toBe(
      'https://app.example/',
    );
  });

  it('cuts a token written with a URL-encoded equals sign or name', () => {
    expect(stripTokenFragment('https://app.example/#access_token%3Dabc')).toBe(
      'https://app.example/',
    );
    expect(stripTokenFragment('https://app.example/#%2Fcb%3Fcode%3Dabc')).toBe(
      'https://app.example/',
    );
    expect(stripTokenFragment('https://app.example/#%61ccess_token=abc')).toBe(
      'https://app.example/',
    );
  });

  it('ignores the case of the parameter name', () => {
    expect(stripTokenFragment('https://app.example/#ACCESS_TOKEN=abc')).toBe(
      'https://app.example/',
    );
    expect(stripTokenFragment('https://app.example/#Id_Token=abc')).toBe('https://app.example/');
  });

  it('keeps the query when it cuts the fragment', () => {
    expect(stripTokenFragment('https://app.example/p?a=1&b=2#access_token=abc')).toBe(
      'https://app.example/p?a=1&b=2',
    );
  });

  it.each([
    'https://app.example/page#section',
    'https://app.example/#/inbox',
    'https://app.example/#/inbox/thread?folder=work',
    'https://app.example/#',
    'https://app.example/#codec=opus',
    'https://app.example/#monkey=1',
    'https://app.example/#tokenizer',
    'https://app.example/#page=3&sort=asc',
  ])('keeps the harmless fragment of %s', (url) => {
    expect(stripTokenFragment(url)).toBe(url);
  });

  it('leaves a URL without a fragment as it is, query tokens included', () => {
    // Only fragments are cut: tabs.url keeps the exact address, minus token-bearing fragments.
    expect(stripTokenFragment('https://app.example/page')).toBe('https://app.example/page');
    expect(stripTokenFragment('https://app.example/page?token=abc')).toBe(
      'https://app.example/page?token=abc',
    );
    expect(stripTokenFragment('')).toBe('');
  });

  it('only looks at the first hash, so a token anywhere after it is cut', () => {
    expect(stripTokenFragment('https://app.example/#/a#code=abc')).toBe('https://app.example/');
  });

  it('still recognises a token when the fragment has a malformed escape', () => {
    expect(stripTokenFragment('https://app.example/#%E0%A4%A&access_token=abc')).toBe(
      'https://app.example/',
    );
    expect(stripTokenFragment('https://app.example/#%E0%A4%A')).toBe(
      'https://app.example/#%E0%A4%A',
    );
  });

  it('returns text that is not a URL unchanged unless it has a token fragment', () => {
    expect(stripTokenFragment('not a url')).toBe('not a url');
    expect(stripTokenFragment('not a url#access_token=abc')).toBe('not a url');
  });
});

/** OAuth's callbacks with the credential in the fragment: a hash route, the implicit flow, OIDC. */
const HASH_ROUTE_FORMS = [
  'https://site.example/app?x=1#/cb?code=CODE-SECRET&state=STATE-SECRET',
  'https://site.example/app?x=1#access_token=ACCESS-SECRET&token_type=bearer',
  'https://site.example/app?x=1#id_token=ID-SECRET',
] as const;

describe('keptTitle', () => {
  it.each(HASH_ROUTE_FORMS)('drops the title Chromium makes from %s', (raw) => {
    const clean = restorableUrl(raw) ?? '';

    expect(clean).toBe('https://site.example/app?x=1');
    // Measured on Electron 45: the address without its scheme, fragment and all.
    expect(keptTitle(raw.slice('https://'.length), raw, clean)).toBe('');
    expect(keptTitle(raw, raw, clean)).toBe('');
  });

  it.each(HASH_ROUTE_FORMS)(
    'drops even a real title when the address %s was cut: it cannot tell them apart',
    (raw) => {
      expect(keptTitle('Signed in', raw, restorableUrl(raw) ?? '')).toBe('');
    },
  );

  it('drops the title of an address whose credentials were removed', () => {
    const raw = 'https://alice:PASS@site.example/p';

    expect(keptTitle('Private page', raw, restorableUrl(raw) ?? '')).toBe('');
  });

  it('drops a title that holds a token fragment even when the address was clean', () => {
    const url = 'https://site.example/app?x=1';

    expect(keptTitle('site.example/app?x=1#/cb?code=SECRET', url, url)).toBe('');
    expect(keptTitle('site.example/#access_token=SECRET', url, url)).toBe('');
  });

  it('keeps the title of an address that needed no cleaning, a plain # included', () => {
    const url = 'https://site.example/issues/42#comments';

    expect(keptTitle('Issue #42 · comments', url, url)).toBe('Issue #42 · comments');
    expect(keptTitle('site.example/issues/42#comments', url, url)).toBe(
      'site.example/issues/42#comments',
    );
    expect(keptTitle('', url, url)).toBe('');
  });

  it('cuts a long title to the limit', () => {
    const url = 'https://site.example/';

    expect(keptTitle('x'.repeat(2000), url, url)).toHaveLength(MAX_HISTORY_TITLE);
  });
});

describe('restorableUrl', () => {
  it.each([
    'http://site.example/',
    'https://site.example/path/page.html?q=1&r=2#section',
    'https://site.example:8443/a',
    'https://[::1]:3000/',
    'http://localhost:5173/',
    'file:///C:/Users/me/notes.html',
    'file:///home/me/notes.html',
  ])('accepts %s and returns it as it is', (url) => {
    expect(restorableUrl(url)).toBe(url);
  });

  it.each([
    ['an internal page', 'veltriva://newtab'],
    ['the app shell', 'app://shell/index.html'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a data: URL', 'data:text/html,<h1>hi</h1>'],
    ['about:blank', 'about:blank'],
    ['a chrome: URL', 'chrome://settings'],
    ['a chrome-error page', 'chrome-error://chromewebdata/'],
    ['a blob: URL', 'blob:https://site.example/3f2a'],
    ['a mailto: link', 'mailto:someone@example.com'],
    ['an ftp: URL', 'ftp://site.example/file'],
    ['a view-source: URL', 'view-source:https://site.example/'],
    ['another app’s link', 'slack://open'],
    ['a scheme in capitals that is still javascript', 'JAVASCRIPT:alert(1)'],
    ['text that is not a URL', 'not a url'],
    ['a relative path', '/just/a/path'],
    ['an empty string', ''],
  ])('refuses %s', (_name, url) => {
    expect(restorableUrl(url)).toBeNull();
  });

  it('accepts a scheme written in capitals and returns the text as written', () => {
    expect(restorableUrl('HTTPS://Site.Example/Path')).toBe('HTTPS://Site.Example/Path');
  });

  it('removes credentials typed into the address', () => {
    expect(restorableUrl('https://user:pass@site.example/path?q=1')).toBe(
      'https://site.example/path?q=1',
    );
    expect(restorableUrl('https://user@site.example/')).toBe('https://site.example/');
    expect(restorableUrl('http://:secret@site.example/')).toBe('http://site.example/');
  });

  it('removes a token fragment as well as the credentials', () => {
    expect(restorableUrl('https://user:pass@site.example/#access_token=abc')).toBe(
      'https://site.example/',
    );
  });

  it('cuts a token fragment', () => {
    expect(restorableUrl('https://site.example/cb#access_token=abc&state=1')).toBe(
      'https://site.example/cb',
    );
    expect(restorableUrl('https://site.example/#/cb?code=abc')).toBe('https://site.example/');
  });

  it('keeps a plain fragment', () => {
    expect(restorableUrl('https://site.example/page#section')).toBe(
      'https://site.example/page#section',
    );
  });

  it('refuses an address longer than the limit and accepts one exactly at it', () => {
    const prefix = 'https://site.example/';
    const atLimit = prefix + 'a'.repeat(MAX_HISTORY_URL - prefix.length);
    expect(atLimit).toHaveLength(MAX_HISTORY_URL);

    expect(restorableUrl(atLimit)).toBe(atLimit);
    expect(restorableUrl(atLimit + 'a')).toBeNull();
  });

  // The data contract refuses a restore_state URL over 65,536 characters, and one such entry
  // would make every later `session.save` fail validation.
  it('never returns an address longer than the limit', () => {
    const prefix = 'https://u:p@site.example/';
    const raw = prefix + 'é'.repeat(MAX_HISTORY_URL - prefix.length);
    expect(raw).toHaveLength(MAX_HISTORY_URL);

    // Dropping the credentials normalizes the address (`é` becomes `%C3%A9`), which is longer.
    expect(restorableUrl(raw)).toBeNull();
  });

  it('keeps an address whose cleaned form still fits, even when the raw one is at the limit', () => {
    const prefix = 'https://u:p@site.example/';
    const raw = prefix + 'a'.repeat(MAX_HISTORY_URL - prefix.length);
    expect(raw).toHaveLength(MAX_HISTORY_URL);

    const clean = restorableUrl(raw);

    expect(clean).toBe(`https://site.example/${'a'.repeat(MAX_HISTORY_URL - prefix.length)}`);
    expect(clean?.length).toBeLessThanOrEqual(MAX_HISTORY_URL);
  });

  it('refuses an address that normalizes to more than the limit, and so drops it from a history', () => {
    const prefix = 'https://u:p@site.example/';
    const long = prefix + 'é'.repeat(MAX_HISTORY_URL - prefix.length);

    const result = sanitizeHistory({
      index: 1,
      entries: [
        { url: 'https://site.example/a', title: 'A' },
        { url: long, title: 'Long' },
      ],
    });

    expect(result).toEqual({
      index: 0,
      entries: [{ url: 'https://site.example/a', title: 'A' }],
    });
  });
});

describe('sanitizeHistory', () => {
  it('keeps a clean history as it is', () => {
    const raw = {
      index: 1,
      entries: [entry(1, 'One'), entry(2, 'Two'), entry(3, 'Three')],
    };

    expect(sanitizeHistory(raw)).toEqual(raw);
  });

  it('refuses null', () => {
    expect(sanitizeHistory(null)).toBeNull();
  });

  it.each([
    ['NaN', Number.NaN],
    ['a fraction', 0.5],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('refuses an index that is %s', (_name, index) => {
    expect(sanitizeHistory({ index, entries: entries(3) })).toBeNull();
  });

  it('refuses an index that is not a number, which the type system cannot rule out here', () => {
    const raw = { index: '1', entries: entries(3) } as unknown as Parameters<
      typeof sanitizeHistory
    >[0];

    expect(sanitizeHistory(raw)).toBeNull();
  });

  it('refuses a history with no entries and one with no usable entry', () => {
    expect(sanitizeHistory({ index: 0, entries: [] })).toBeNull();
    expect(
      sanitizeHistory({
        index: 0,
        entries: [{ url: 'javascript:alert(1)', title: '' }, { url: 'about:blank' }, null],
      }),
    ).toBeNull();
  });

  it('drops entries that are not objects', () => {
    const result = sanitizeHistory({
      index: 3,
      entries: [null, 'https://site.example/str', 42, entry(1), undefined, ['x'], entry(2)],
    });

    expect(result?.entries.map((e) => e.url)).toEqual([
      'https://site.example/1',
      'https://site.example/2',
    ]);
  });

  it('drops entries whose URL is missing, not a string, or refused', () => {
    const result = sanitizeHistory({
      index: 0,
      entries: [
        entry(1),
        { title: 'no url' },
        { url: 42, title: 'number' },
        { url: null, title: 'null' },
        { url: 'veltriva://newtab', title: 'internal' },
        { url: 'data:text/html,x', title: 'data' },
        { url: '', title: 'empty' },
        entry(2),
      ],
    });

    expect(result?.entries.map((e) => e.url)).toEqual([
      'https://site.example/1',
      'https://site.example/2',
    ]);
  });

  it('cleans each URL (credentials removed, token fragments cut), and drops the title of one it cut', () => {
    const result = sanitizeHistory({
      index: 1,
      entries: [
        { url: 'https://user:pass@site.example/a', title: 'A' },
        { url: 'https://site.example/b#access_token=abc', title: 'B' },
        { url: 'https://site.example/c#section', title: 'C' },
      ],
    });

    expect(result).toEqual({
      index: 1,
      entries: [
        { url: 'https://site.example/a', title: '' },
        { url: 'https://site.example/b', title: '' },
        { url: 'https://site.example/c#section', title: 'C' },
      ],
    });
  });

  it.each(HASH_ROUTE_FORMS)(
    'keeps no trace of %s when the title is the address, as Chromium gives a page with none',
    (raw) => {
      const result = sanitizeHistory({
        index: 1,
        entries: [
          { url: 'https://site.example/', title: 'Home' },
          { url: raw, title: raw.slice('https://'.length) },
        ],
      });

      expect(result).toEqual({
        index: 1,
        entries: [
          { url: 'https://site.example/', title: 'Home' },
          { url: 'https://site.example/app?x=1', title: '' },
        ],
      });
      expect(JSON.stringify(result)).not.toMatch(/SECRET/u);
    },
  );

  it('drops a title that holds a token fragment when read back with a clean address', () => {
    // A save from before keptTitle: the address was cut, the title Chromium made was not.
    expect(
      sanitizeHistory({
        index: 0,
        entries: [
          {
            url: 'https://site.example/app?x=1',
            title: 'site.example/app?x=1#/cb?code=SECRET&state=S',
          },
        ],
      }),
    ).toEqual({ index: 0, entries: [{ url: 'https://site.example/app?x=1', title: '' }] });
  });

  it('keeps only url and title of an entry', () => {
    const result = sanitizeHistory({
      index: 0,
      entries: [{ url: 'https://site.example/', title: 'T', pageState: 'AAAA', extra: 1 }],
    });

    expect(result?.entries[0]).toStrictEqual({ url: 'https://site.example/', title: 'T' });
  });

  describe('titles', () => {
    it('cuts a title at 1,024 characters', () => {
      const result = sanitizeHistory({
        index: 0,
        entries: [
          { url: 'https://site.example/long', title: 'x'.repeat(5000) },
          { url: 'https://site.example/exact', title: 'y'.repeat(MAX_HISTORY_TITLE) },
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
      ['an array', ['x']],
    ])('uses an empty title when the title is %s', (_name, title) => {
      const result = sanitizeHistory({
        index: 0,
        entries: [{ url: 'https://site.example/', title }],
      });

      expect(result?.entries[0]?.title).toBe('');
    });

    it('keeps an empty title', () => {
      expect(singleEntryHistory('https://site.example/', '')?.entries[0]?.title).toBe('');
    });
  });

  describe('when the active entry is dropped', () => {
    const bad = { url: 'javascript:alert(1)', title: 'bad' };

    it('makes the nearest earlier entry active', () => {
      const result = sanitizeHistory({ index: 2, entries: [entry(0), entry(1), bad, entry(3)] });

      expect(result?.entries.map((e) => e.url)).toEqual([
        'https://site.example/0',
        'https://site.example/1',
        'https://site.example/3',
      ]);
      expect(result?.index).toBe(1);
    });

    it('skips over several dropped entries to the nearest earlier one that is kept', () => {
      const result = sanitizeHistory({ index: 3, entries: [entry(0), bad, bad, bad, entry(4)] });

      expect(result?.index).toBe(0);
      expect(result?.entries).toHaveLength(2);
    });

    it('makes the next later entry active when nothing earlier is kept', () => {
      const result = sanitizeHistory({ index: 0, entries: [bad, bad, entry(2), entry(3)] });

      expect(result?.index).toBe(0);
      expect(result?.entries[0]?.url).toBe('https://site.example/2');
    });

    it('keeps the active entry active, with its new position, when earlier ones are dropped', () => {
      const result = sanitizeHistory({
        index: 3,
        entries: [bad, entry(1), bad, entry(3), entry(4)],
      });

      expect(result?.index).toBe(1);
      expect(result?.entries[result.index]?.url).toBe('https://site.example/3');
    });
  });

  describe('the index', () => {
    it('makes the last entry active for an index past the end', () => {
      const result = sanitizeHistory({ index: 99, entries: entries(3) });

      expect(result?.index).toBe(2);
    });

    it('makes the first entry active for a negative index', () => {
      const result = sanitizeHistory({ index: -4, entries: entries(3) });

      expect(result?.index).toBe(0);
    });

    it('is always inside the entries, whatever was dropped', () => {
      const bad = { url: 'about:blank', title: '' };
      const raw = [bad, entry(1), bad, bad, entry(4), bad, entry(6), bad];

      for (let index = -2; index <= raw.length + 2; index += 1) {
        const result = sanitizeHistory({ index, entries: raw });

        expect(result).not.toBeNull();
        expect(result?.index).toBeGreaterThanOrEqual(0);
        expect(result?.index).toBeLessThan(result?.entries.length ?? 0);
      }
    });
  });

  describe('a history of more than 50 entries', () => {
    const urlAt = (n: number) => `https://site.example/${String(n)}`;

    it('keeps 50 and no more, exactly 50 when there are more to choose from', () => {
      for (const count of [51, 60, 100, 500]) {
        const result = sanitizeHistory({ index: count - 1, entries: entries(count) });

        expect(result?.entries).toHaveLength(MAX_HISTORY_ENTRIES);
      }
    });

    it('does not touch exactly 50', () => {
      const result = sanitizeHistory({ index: 25, entries: entries(50) });

      expect(result?.entries).toEqual(entries(50));
      expect(result?.index).toBe(25);
    });

    it('keeps the active entry, most of what is behind it and some of what is ahead', () => {
      const result = sanitizeHistory({ index: 100, entries: entries(120) });

      expect(result?.entries).toHaveLength(50);
      expect(result?.entries[result.index]?.url).toBe(urlAt(100));
      expect(result?.entries.map((e) => e.url)).toEqual(
        Array.from({ length: 50 }, (_, n) => urlAt(60 + n)),
      );
      // 40 behind, 9 ahead.
      expect(result?.index).toBe(40);
    });

    it('keeps the first 50 when the active entry is near the start', () => {
      const result = sanitizeHistory({ index: 3, entries: entries(120) });

      expect(result?.index).toBe(3);
      expect(result?.entries[0]?.url).toBe(urlAt(0));
      expect(result?.entries[49]?.url).toBe(urlAt(49));
    });

    it('keeps the last 50 when the active entry is the newest', () => {
      const result = sanitizeHistory({ index: 119, entries: entries(120) });

      expect(result?.index).toBe(49);
      expect(result?.entries[0]?.url).toBe(urlAt(70));
      expect(result?.entries[49]?.url).toBe(urlAt(119));
    });

    it('keeps the active entry for every possible index', () => {
      const raw = entries(77);

      for (let index = 0; index < raw.length; index += 1) {
        const result = sanitizeHistory({ index, entries: raw });

        expect(result?.entries).toHaveLength(50);
        expect(result?.entries[result.index]?.url).toBe(urlAt(index));
        // Mostly behind it: at least 40 behind unless the start of the history cuts that short.
        expect(result?.index).toBeGreaterThanOrEqual(Math.min(index, 40));
      }
    });

    it('counts the entries that are kept, not the ones it was given', () => {
      const bad = { url: 'about:blank', title: '' };
      // 60 given, 20 of them dropped: 40 are left, and all 40 stay.
      const raw = [...entries(40), ...Array.from({ length: 20 }, () => bad)];

      const result = sanitizeHistory({ index: 10, entries: raw });

      expect(result?.entries).toHaveLength(40);
      expect(result?.index).toBe(10);
    });

    it('trims after dropping bad entries, so the result is still 50', () => {
      const bad = { url: 'about:blank', title: '' };
      const raw = Array.from({ length: 120 }, (_, n) => (n % 4 === 0 ? bad : entry(n)));

      const result = sanitizeHistory({ index: 90, entries: raw });

      expect(result?.entries).toHaveLength(50);
      // Index 90 is a kept entry (90 % 4 is 2): it stays active.
      expect(result?.entries[result.index]?.url).toBe(urlAt(90));
    });
  });

  it('does not change what it was given', () => {
    const raw = {
      index: 1,
      entries: [{ url: 'https://user:pw@site.example/a#access_token=x', title: 'A' }, entry(2)],
    };
    const before = JSON.stringify(raw);

    sanitizeHistory(raw);

    expect(JSON.stringify(raw)).toBe(before);
  });

  it('is idempotent', () => {
    const once = sanitizeHistory({
      index: 70,
      entries: [
        ...entries(100),
        { url: 'https://user:pw@site.example/a#access_token=x', title: 't'.repeat(3000) },
      ],
    });

    expect(once).not.toBeNull();
    expect(sanitizeHistory(once)).toEqual(once);
  });
});

describe('singleEntryHistory', () => {
  it('makes a history of one entry', () => {
    expect(singleEntryHistory('https://site.example/a', 'A')).toEqual({
      index: 0,
      entries: [{ url: 'https://site.example/a', title: 'A' }],
    });
  });

  it('cleans the address like any history entry, and drops the title of one it cut', () => {
    expect(singleEntryHistory('https://user:pw@site.example/a#id_token=x', 'A')).toEqual({
      index: 0,
      entries: [{ url: 'https://site.example/a', title: '' }],
    });
  });

  it.each(['about:blank', 'javascript:alert(1)', 'veltriva://newtab', '', 'not a url'])(
    'is null for the address %j, which a tab must not restore',
    (url) => {
      expect(singleEntryHistory(url, 'T')).toBeNull();
    },
  );

  it('cuts a long title', () => {
    expect(
      singleEntryHistory('https://site.example/', 'x'.repeat(2000))?.entries[0]?.title,
    ).toHaveLength(MAX_HISTORY_TITLE);
  });
});

describe('sanitizeEntries', () => {
  interface Call {
    readonly entry: HistoryEntry;
    readonly raw: Readonly<Record<string, unknown>>;
    readonly unchanged: boolean;
  }

  /** `sanitizeEntries` with a hook that writes down what it is given and keeps the clean entry. */
  const recording = (input: Parameters<typeof sanitizeEntries>[0]) => {
    const calls: Call[] = [];
    const result = sanitizeEntries(input, (clean, raw, unchanged) => {
      calls.push({ entry: clean, raw, unchanged });
      return clean;
    });
    return { result, calls };
  };

  describe('the build hook', () => {
    it('gets the clean entry, the raw record and an unchanged flag for each kept entry', () => {
      const raw = { url: 'https://site.example/a', title: 'A', pageState: 'AAAA' };

      const { calls } = recording({ index: 0, entries: [raw] });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.entry).toStrictEqual({ url: 'https://site.example/a', title: 'A' });
      expect(calls[0]?.unchanged).toBe(true);
    });

    it('gets the very record it was given, with every field the clean entry leaves out', () => {
      const raw = { url: 'https://site.example/a', title: 'A', pageState: 'AAAA', extra: [1] };

      const { calls } = recording({ index: 0, entries: [raw] });

      expect(calls[0]?.raw).toBe(raw);
      expect(calls[0]?.raw.pageState).toBe('AAAA');
    });

    it('gets the clean address and leaves the original in the raw record', () => {
      const raw = { url: 'https://user:pw@site.example/a#access_token=x', title: 'A' };

      const { calls } = recording({ index: 0, entries: [raw] });

      expect(calls[0]?.entry.url).toBe('https://site.example/a');
      expect(calls[0]?.raw.url).toBe('https://user:pw@site.example/a#access_token=x');
    });

    it.each([
      ['a plain address', 'https://site.example/a', true],
      ['a path with a query', 'https://site.example/a?q=1&r=2', true],
      ['a harmless fragment', 'https://site.example/a#section', true],
      ['an empty fragment', 'https://site.example/#', true],
      ['a hash route without a token', 'https://site.example/#/inbox/thread?folder=work', true],
      [
        'a token-like name in the query, not the fragment',
        'https://site.example/a?token=abc',
        true,
      ],
      ['a scheme and host in capitals', 'HTTPS://Site.Example/Path', true],
      ['a port', 'https://site.example:8443/a', true],
      ['a local file', 'file:///C:/Users/me/notes.html', true],
      ['credentials', 'https://user:pass@site.example/a', false],
      ['a user name alone', 'https://user@site.example/a', false],
      ['a password alone', 'http://:secret@site.example/a', false],
      ['an access token in the fragment', 'https://site.example/a#access_token=abc', false],
      ['an authorization code in a hash route', 'https://site.example/#/cb?code=abc', false],
      ['a token with an encoded name', 'https://site.example/#%61ccess_token=abc', false],
      ['credentials and a token fragment', 'https://u:p@site.example/a#id_token=abc', false],
    ])('is told the URL is unchanged only if cleaning left %s alone', (_name, url, unchanged) => {
      const { calls } = recording({ index: 0, entries: [{ url, title: 'T' }] });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.unchanged).toBe(unchanged);
      expect(calls[0]?.entry.url === url).toBe(unchanged);
    });

    it('is told the URL is unchanged although the title was cut: only the address counts', () => {
      const raw = { url: 'https://site.example/a', title: 'x'.repeat(5000) };

      const { calls } = recording({ index: 0, entries: [raw] });

      expect(calls[0]?.unchanged).toBe(true);
      expect(calls[0]?.entry.title).toHaveLength(MAX_HISTORY_TITLE);
      expect(calls[0]?.raw.title).toHaveLength(5000);
    });

    it('is told the URL is unchanged although the title is not a string', () => {
      const raw = { url: 'https://site.example/a', title: 7 };

      const { calls } = recording({ index: 0, entries: [raw] });

      expect(calls[0]?.unchanged).toBe(true);
      expect(calls[0]?.entry.title).toBe('');
      expect(calls[0]?.raw.title).toBe(7);
    });

    it('is called once for each kept entry, in order, and never for a dropped one', () => {
      const { calls } = recording({
        index: 3,
        entries: [
          null,
          'https://site.example/string',
          42,
          entry(1),
          { url: 5, title: 'number' },
          { title: 'no url' },
          { url: 'javascript:alert(1)', title: 'bad' },
          { url: 'veltriva://newtab', title: 'internal' },
          { url: '', title: 'empty' },
          entry(2),
          undefined,
          entry(3),
        ],
      });

      expect(calls.map((call) => call.entry.url)).toEqual([
        'https://site.example/1',
        'https://site.example/2',
        'https://site.example/3',
      ]);
    });

    it('is not called when the index is not a whole number, and the result is null', () => {
      for (const index of [Number.NaN, 0.5, Number.POSITIVE_INFINITY]) {
        const { result, calls } = recording({ index, entries: entries(3) });

        expect(result).toBeNull();
        expect(calls).toHaveLength(0);
      }
    });

    it('is not called for a null history or one with no entries, and the result is null', () => {
      for (const input of [null, { index: 0, entries: [] }]) {
        const { result, calls } = recording(input);

        expect(result).toBeNull();
        expect(calls).toHaveLength(0);
      }
    });

    it('is not called when nothing in the history can be kept, and the result is null', () => {
      const { result, calls } = recording({
        index: 0,
        entries: [{ url: 'about:blank', title: '' }, null, { url: 'data:text/html,x' }],
      });

      expect(result).toBeNull();
      expect(calls).toHaveLength(0);
    });
  });

  describe('the entries it returns', () => {
    interface Tagged extends HistoryEntry {
      readonly tag: string;
      readonly unchanged: boolean;
    }

    it('are what the hook built, not the clean entries', () => {
      const result = sanitizeEntries<Tagged>(
        {
          index: 1,
          entries: [
            { url: 'https://site.example/a', title: 'A', tag: 'first' },
            { url: 'https://user:pw@site.example/b', title: 'B', tag: 'second' },
          ],
        },
        (clean, raw, unchanged) => ({
          ...clean,
          tag: typeof raw.tag === 'string' ? raw.tag : '',
          unchanged,
        }),
      );

      expect(result).toStrictEqual({
        index: 1,
        entries: [
          { url: 'https://site.example/a', title: 'A', tag: 'first', unchanged: true },
          { url: 'https://site.example/b', title: '', tag: 'second', unchanged: false },
        ],
      });
    });

    it('are the 50 around the active one, built by the hook, when there are more', () => {
      const raw = Array.from({ length: 120 }, (_, n) => ({ ...entry(n), n }));

      const result = sanitizeEntries<HistoryEntry & { readonly n: number }>(
        { index: 100, entries: raw },
        (clean, record) => ({ ...clean, n: typeof record.n === 'number' ? record.n : -1 }),
      );

      expect(result?.index).toBe(40);
      expect(result?.entries.map((e) => e.n)).toEqual(
        Array.from({ length: MAX_HISTORY_ENTRIES }, (_, n) => 60 + n),
      );
      expect(result?.entries[result.index]?.url).toBe('https://site.example/100');
    });

    it('have the active index of sanitizeHistory, whatever the hook builds', () => {
      const bad = { url: 'javascript:alert(1)', title: 'bad' };
      const inputs: Parameters<typeof sanitizeHistory>[0][] = [
        { index: 2, entries: [entry(0), entry(1), bad, entry(3)] },
        { index: 3, entries: [entry(0), bad, bad, bad, entry(4)] },
        { index: 0, entries: [bad, bad, entry(2), entry(3)] },
        { index: 3, entries: [bad, entry(1), bad, entry(3), entry(4)] },
        { index: 99, entries: entries(3) },
        { index: -4, entries: entries(3) },
        { index: 100, entries: entries(120) },
      ];

      for (const input of inputs) {
        const built = sanitizeEntries(input, (clean) => ({ ...clean, extra: true }));

        expect(built?.index).toBe(sanitizeHistory(input)?.index);
        expect(built?.entries.map(({ url, title }) => ({ url, title }))).toEqual(
          sanitizeHistory(input)?.entries,
        );
      }
    });
  });

  describe('sanitizeHistory, which is built on it', () => {
    it('is sanitizeEntries with a hook that keeps the clean entry', () => {
      const inputs: Parameters<typeof sanitizeHistory>[0][] = [
        null,
        { index: 0, entries: [] },
        { index: 1, entries: [entry(1, 'One'), entry(2, 'Two'), entry(3, 'Three')] },
        {
          index: 1,
          entries: [
            { url: 'https://user:pass@site.example/a', title: 'A' },
            { url: 'https://site.example/b#access_token=abc', title: 'B' },
            { url: 'https://site.example/c#section', title: 'C'.repeat(2000), pageState: 'AAAA' },
          ],
        },
        { index: 70, entries: entries(100) },
        { index: Number.NaN, entries: entries(2) },
      ];

      for (const input of inputs) {
        expect(sanitizeHistory(input)).toStrictEqual(sanitizeEntries(input, (clean) => clean));
      }
    });
  });
});
