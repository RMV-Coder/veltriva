import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { FRECENCY_HALF_LIFE_MS } from '../../core/search/frecency';
import { foldText, MIN_WORD_CHARS, parseSearchInput } from '../../core/search/query';
import type { DataInput, TabRow } from '../../shared/contracts/data-rpc';
import { historyHandlers } from './history';
import { CANDIDATES, searchHandlers } from './search';
import { tabHandlers } from './tabs';
import { WORKSPACE_ID, addWorkspace, callerFor, testId, useTestDatabase } from './test-database';

const T0 = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

/** A tab row showing `url`; the worker links it to its page. */
function tabRow(n: number, url: string, overrides: Partial<TabRow> = {}): TabRow {
  return {
    id: testId(100 + n),
    workspaceId: WORKSPACE_ID,
    placement: 'strip',
    position: n,
    pinned: false,
    userProtected: false,
    pageId: null,
    url,
    title: '',
    faviconId: null,
    restoreState: null,
    openerTabId: null,
    createdAt: T0,
    lastUsedAt: T0,
    lastUsedEngaged: 0,
    lastUsedActiveDay: 0,
    placementChangedAt: T0,
    archivedAt: null,
    archiveReason: null,
    closedAt: null,
    ...overrides,
  };
}

interface PageSpec {
  readonly title: string;
  readonly url: string;
  readonly visits?: number;
  readonly visitedAt?: number;
}

function siteOfUrl(url: string): string {
  const host = new URL(url).hostname;
  return host.split('.').slice(-2).join('.');
}

describe('search.query', () => {
  const database = useTestDatabase();
  const setup = () => {
    const db = database();
    addWorkspace(db);
    const call = callerFor({ ...historyHandlers(db), ...tabHandlers(db), ...searchHandlers(db) });
    /** Records `visits` visits to a page and settles its title; returns its id. */
    const addPage = ({ title, url, visits = 1, visitedAt = T0 }: PageSpec): number => {
      const host = new URL(url).hostname;
      let pageId: number | null = null;
      for (let visit = 0; visit < visits; visit += 1) {
        ({ pageId } = call('history.recordVisit', {
          page: { urlKey: url, url, host, site: siteOfUrl(url), title: '' },
          transition: 'link',
          visitedAt: visitedAt + visit,
          tabId: null,
        }));
      }
      if (pageId === null) {
        throw new Error('the page was not recorded');
      }
      call('history.updatePage', { pageId, title });
      return pageId;
    };
    const saveTabs = (tabs: TabRow[]) =>
      call('session.save', { tabs, deleteIds: [], documents: [] });
    const search = (
      query: string,
      options: Partial<Omit<DataInput<'search.query'>, 'query'>> = {},
    ) => call('search.query', { query, now: T0 + DAY, limit: 200, ...options });
    const titles = (query: string, options?: Parameters<typeof search>[1]) =>
      search(query, options).results.map((result) => result.title);
    return { db, call, addPage, saveTabs, search, titles };
  };

  describe('words, not syntax', () => {
    const CORPUS: readonly PageSpec[] = [
      { title: 'NEAR operators in full-text search', url: 'https://sqlite.org/fts5' },
      { title: 'Postgres index tuning', url: 'https://www.postgresql.org/docs/indexes' },
      { title: 'Title: a field guide', url: 'https://fieldguide.example/title' },
      { title: 'Café crème brûlée', url: 'https://recipes.example/creme' },
      { title: 'NOT a secret, really', url: 'https://notes.example/secret' },
      { title: '東京タワー visitor guide', url: 'https://tokyo.example/tower' },
      { title: 'e-mail and snake_case', url: 'https://style.example/naming' },
      { title: 'OR gates and AND gates', url: 'https://logic.example/gates' },
    ];

    /** FTS5's view of a page, near enough for Latin text: folded words of title, address and site. */
    const termsOf = (page: PageSpec): string[] =>
      foldText(`${page.title} ${page.url} ${siteOfUrl(page.url)}`)
        .split(/[^\p{L}\p{N}\p{Co}]+/u)
        .filter((term) => term.length > 0);
    /** The pages every word of 2+ characters starts a word of: what the search must return. */
    const expected = (query: string): string[] => {
      const { match } = parseSearchInput(query);
      if (match === null) {
        return [];
      }
      const words = [...match.matchAll(/"([^"]+)"\*/gu)].map(([, word = '']) => foldText(word));
      return CORPUS.filter((page) => {
        const terms = termsOf(page);
        return words.every((word) => terms.some((term) => term.startsWith(word)));
      })
        .map((page) => page.title)
        .sort();
    };

    it.each([
      ['NEAR(postgres index)', []],
      ['NEAR(postgres, 5)', []],
      ['near', ['NEAR operators in full-text search']],
      ['-postgres', ['Postgres index tuning']],
      ['postgres -index', ['Postgres index tuning']],
      ['postgres OR cafe', []],
      ['or gates', ['OR gates and AND gates']],
      ['AND', ['OR gates and AND gates', 'e-mail and snake_case']],
      ['NOT secret', ['NOT a secret, really']],
      ['"unterminated', []],
      ['"postgres" "index"', ['Postgres index tuning']],
      ['post*', ['Postgres index tuning']],
      ['^title', ['Title: a field guide']],
      ['title:guide', ['Title: a field guide']],
      ['{title url}: guide', []],
      ['{title}: guide', ['Title: a field guide']],
      ['(cafe OR tower) AND guide', []],
      ['+cafe', ['Café crème brûlée']],
      ['café', ['Café crème brûlée']],
      ['CREME brulee', ['Café crème brûlée']],
      ['東京', ['東京タワー visitor guide']],
      ['e-mail', ['e-mail and snake_case']],
      ['snake_case', ['e-mail and snake_case']],
      ['fts5', ['NEAR operators in full-text search']],
      ['postgresql.org', ['Postgres index tuning']],
      ['\u0000postgres\u0007', ['Postgres index tuning']],
      ['po​stgres', []],
      ["it's", []],
      ['\\postgres\\', ['Postgres index tuning']],
    ])('reads %j as words only', (query, titles) => {
      const { addPage, titles: found } = setup();
      for (const page of CORPUS) {
        addPage(page);
      }
      expect(found(query).sort()).toEqual([...titles].sort());
      expect(found(query).sort()).toEqual(expected(query));
    });

    it('never fails, and finds exactly the pages that hold every word, for any input', () => {
      const { addPage, search } = setup();
      for (const page of CORPUS) {
        addPage(page);
      }
      const pieces = [
        'postgres',
        'index',
        'guide',
        'cafe',
        'NEAR',
        'AND',
        'OR',
        'NOT',
        'title',
        '(',
        ')',
        '"',
        '*',
        '^',
        ':',
        '-',
        '+',
        '{',
        '}',
        ',',
        ' ',
        "'",
        '\\',
        '\u0000',
        '東京',
        '😀',
      ];
      fc.assert(
        fc.property(fc.array(fc.constantFrom(...pieces), { maxLength: 12 }), (parts) => {
          const query = parts.join('');
          const { mode, results } = search(query);
          expect(mode).toBe(parseSearchInput(query).match === null ? 'recent' : 'text');
          if (mode === 'text') {
            expect(results.map((result) => result.title).sort()).toEqual(expected(query));
          }
        }),
        { numRuns: 300 },
      );
    });
  });

  describe('short input', () => {
    it(`gets the recent-and-frequent list below ${String(MIN_WORD_CHARS)} characters`, () => {
      const { addPage, search } = setup();
      addPage({ title: 'Rarely', url: 'https://a.example/', visits: 1 });
      addPage({ title: 'Often', url: 'https://b.example/', visits: 6 });
      for (const query of ['', ' ', 'o', 'a b', '"']) {
        const { mode, results } = search(query);
        expect(mode).toBe('recent');
        expect(results.map((result) => result.title)).toEqual(['Often', 'Rarely']);
      }
    });

    it('orders the recent list by frecency decayed to now, newer beating more', () => {
      const { addPage, titles } = setup();
      addPage({ title: 'Old favourite', url: 'https://a.example/', visits: 4, visitedAt: T0 });
      addPage({
        title: 'This week',
        url: 'https://b.example/',
        visits: 2,
        visitedAt: T0 + 3 * FRECENCY_HALF_LIFE_MS,
      });
      expect(titles('', { now: T0 + 3 * FRECENCY_HALF_LIFE_MS + DAY })).toEqual([
        'This week',
        'Old favourite',
      ]);
    });

    it('offers the pages open in the strip even when their frecency is low', () => {
      const { addPage, saveTabs, search } = setup();
      for (let n = 0; n < CANDIDATES + 5; n += 1) {
        addPage({
          title: `Busy ${String(n)}`,
          url: `https://busy${String(n)}.example/`,
          visits: 3,
        });
      }
      addPage({ title: 'Quiet but open', url: 'https://quiet.example/', visits: 1 });
      saveTabs([tabRow(1, 'https://quiet.example/')]);
      const quiet = search('').results.find((result) => result.title === 'Quiet but open');
      expect(quiet?.tab).toEqual({ id: testId(101), placement: 'strip' });
    });
  });

  describe('tabs', () => {
    it('says which tab shows a result, and where it lives', () => {
      const { addPage, saveTabs, search } = setup();
      addPage({ title: 'Open one', url: 'https://open.example/' });
      addPage({ title: 'Sleeping one', url: 'https://sleep.example/' });
      addPage({ title: 'Archived one', url: 'https://archive.example/' });
      addPage({ title: 'Remembered one', url: 'https://memory.example/' });
      saveTabs([
        tabRow(1, 'https://open.example/'),
        tabRow(2, 'https://sleep.example/', { placement: 'shelf' }),
        tabRow(3, 'https://archive.example/', {
          placement: 'archive',
          archivedAt: T0,
          archiveReason: 'auto',
        }),
      ]);
      const tabs = Object.fromEntries(
        search('one').results.map((result) => [result.title, result.tab]),
      );
      expect(tabs).toEqual({
        'Open one': { id: testId(101), placement: 'strip' },
        'Sleeping one': { id: testId(102), placement: 'shelf' },
        'Archived one': { id: testId(103), placement: 'archive' },
        'Remembered one': null,
      });
    });

    it('never shows a closed tab: its page is only a memory', () => {
      const { addPage, saveTabs, search } = setup();
      addPage({ title: 'Closed page', url: 'https://closed.example/' });
      saveTabs([tabRow(1, 'https://closed.example/', { placement: 'closed', closedAt: T0 })]);
      const [result, ...others] = search('closed').results;
      expect(others).toEqual([]);
      expect(result?.tab).toBeNull();
    });

    it('shows a page once per tab that shows it', () => {
      const { addPage, saveTabs, search } = setup();
      addPage({ title: 'Twice', url: 'https://twice.example/' });
      saveTabs([
        tabRow(1, 'https://twice.example/'),
        tabRow(2, 'https://twice.example/', {
          placement: 'archive',
          archivedAt: T0,
          archiveReason: 'manual',
        }),
      ]);
      expect(search('twice').results.map((result) => result.tab?.placement)).toEqual([
        'strip',
        'archive',
      ]);
    });

    it('boosts an open tab over an archived one, and an archived one over a memory alone', () => {
      const { addPage, saveTabs, titles } = setup();
      addPage({ title: 'Rust book archived', url: 'https://a.example/rust' });
      addPage({ title: 'Rust book remembered', url: 'https://b.example/rust' });
      addPage({ title: 'Rust book open', url: 'https://c.example/rust' });
      saveTabs([
        tabRow(1, 'https://c.example/rust'),
        tabRow(2, 'https://a.example/rust', {
          placement: 'archive',
          archivedAt: T0,
          archiveReason: 'auto',
        }),
      ]);
      expect(titles('rust book')).toEqual([
        'Rust book open',
        'Rust book archived',
        'Rust book remembered',
      ]);
    });
  });

  describe('filters', () => {
    it('finds an archived tab behind more than 200 better matches', () => {
      const { addPage, saveTabs, search } = setup();
      for (let n = 0; n < CANDIDATES + 20; n += 1) {
        addPage({ title: `Alpha alpha alpha ${String(n)}`, url: `https://a${String(n)}.example/` });
      }
      addPage({ title: 'Notes', url: 'https://notes.example/alpha' });
      saveTabs([
        tabRow(1, 'https://notes.example/alpha', {
          placement: 'archive',
          archivedAt: T0,
          archiveReason: 'auto',
        }),
      ]);
      expect(search('alpha').results.some((result) => result.title === 'Notes')).toBe(false);
      const archived = search('alpha', { filter: { placement: 'archive' } }).results;
      expect(archived.map((result) => [result.title, result.tab?.placement])).toEqual([
        ['Notes', 'archive'],
      ]);
    });

    it('narrows to a placement in the recent list too', () => {
      const { addPage, saveTabs, titles } = setup();
      addPage({ title: 'Open', url: 'https://open.example/' });
      addPage({ title: 'Sleeping', url: 'https://sleep.example/' });
      saveTabs([
        tabRow(1, 'https://open.example/'),
        tabRow(2, 'https://sleep.example/', { placement: 'shelf' }),
      ]);
      expect(titles('', { filter: { placement: 'shelf' } })).toEqual(['Sleeping']);
      expect(titles('', { filter: { placement: 'strip' } })).toEqual(['Open']);
      expect(titles('', { filter: { placement: 'archive' } })).toEqual([]);
    });

    it('narrows to a site', () => {
      const { addPage, titles } = setup();
      addPage({ title: 'Docs on rust', url: 'https://doc.rust-lang.org/book' });
      addPage({ title: 'Blog on rust', url: 'https://blog.example/rust' });
      expect(titles('rust', { filter: { site: 'rust-lang.org' } })).toEqual(['Docs on rust']);
      expect(titles('', { filter: { site: 'example' } })).toEqual([]);
    });

    it('narrows to pages visited since a time, to the millisecond', () => {
      const { addPage, titles } = setup();
      addPage({ title: 'Yesterday', url: 'https://a.example/', visitedAt: T0 - DAY });
      addPage({ title: 'Today', url: 'https://b.example/', visitedAt: T0 });
      expect(titles('', { filter: { visitedSince: T0 } })).toEqual(['Today']);
      expect(titles('today', { filter: { visitedSince: T0 } })).toEqual(['Today']);
      expect(titles('today', { filter: { visitedSince: T0 + 1 } })).toEqual([]);
      expect(titles('yesterday', { filter: { visitedSince: T0 } })).toEqual([]);
    });
  });

  describe('results', () => {
    it('returns at most `limit`, best first', () => {
      const { addPage, search } = setup();
      for (let n = 0; n < 30; n += 1) {
        addPage({
          title: `Page ${String(n)}`,
          url: `https://p${String(n)}.example/`,
          visits: n + 1,
        });
      }
      const { results } = search('page', { limit: 5 });
      expect(results).toHaveLength(5);
      const scores = results.map((result) => result.score);
      expect(scores).toEqual([...scores].sort((a, b) => b - a));
    });

    it('carries each term of its score, which add up to it', () => {
      const { addPage, search } = setup();
      addPage({ title: 'GitHub pull requests', url: 'https://github.com/pulls', visits: 3 });
      const [result] = search('github pull').results;
      const { breakdown } = result ?? { breakdown: undefined };
      expect(breakdown).toBeDefined();
      if (result === undefined || breakdown === undefined) {
        return;
      }
      expect(breakdown.titleExact).toBe(0.4);
      expect(breakdown.siteMatch).toBe(0.3);
      expect(breakdown.text).toBe(1);
      expect(breakdown.bm25).toBeLessThan(0);
      expect(breakdown.frecencyNow).toBeGreaterThan(0);
      expect(
        breakdown.text +
          breakdown.frecency +
          breakdown.titleExact +
          breakdown.siteMatch +
          breakdown.state,
      ).toBeCloseTo(result.score, 12);
    });

    it('marks the title where the words start its words, as ranges, never as markup', () => {
      const { addPage, search } = setup();
      addPage({ title: '<b>Postgres</b> indexes', url: 'https://pg.example/' });
      const [result] = search('postgres ind').results;
      expect(result?.title).toBe('<b>Postgres</b> indexes');
      expect(result?.titleRanges).toEqual([
        [3, 11],
        [16, 19],
      ]);
    });
  });
});
