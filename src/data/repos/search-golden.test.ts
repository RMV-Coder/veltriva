// The golden query set (assessment §5.4, §9.2): a small memory a person could have, and what they
// would expect to see first for queries they would type. Ranking v1's weights are judged against
// it; a change that breaks one of these is a ranking regression, or a deliberate change to the
// expectation, made here with a reason.
import { describe, expect, it } from 'vitest';

import type { VisitTransition } from '../../core/search/frecency';
import type { DataInput, SearchResult, TabRow } from '../../shared/contracts/data-rpc';
import { historyHandlers } from './history';
import { searchHandlers } from './search';
import { tabHandlers } from './tabs';
import { WORKSPACE_ID, addWorkspace, callerFor, testId, useTestDatabase } from './test-database';

const NOW = Date.UTC(2026, 9, 22, 12);
const DAY = 24 * 60 * 60 * 1000;

type Where = 'open' | 'sleeping' | 'archived' | 'none';

interface GoldenPage {
  readonly key: string;
  readonly title: string;
  readonly url: string;
  readonly site: string;
  /** Visits, one a day, the last `lastDaysAgo` days before NOW. */
  readonly visits: number;
  readonly lastDaysAgo: number;
  readonly transition?: VisitTransition;
  readonly where: Where;
}

const PAGES: readonly GoldenPage[] = [
  {
    key: 'pg-index-types',
    title: 'PostgreSQL: Documentation: 16: 11.2. Index Types',
    url: 'https://www.postgresql.org/docs/16/indexes-types.html',
    site: 'postgresql.org',
    visits: 6,
    lastDaysAgo: 2,
    where: 'open',
  },
  {
    key: 'explain-analyze',
    title: 'Understanding EXPLAIN ANALYZE in PostgreSQL',
    url: 'https://thoughtbot.com/blog/reading-an-explain-analyze-query-plan',
    site: 'thoughtbot.com',
    visits: 2,
    lastDaysAgo: 3,
    where: 'sleeping',
  },
  {
    key: 'index-luke',
    title: 'Use The Index, Luke: SQL indexing and tuning',
    url: 'https://use-the-index-luke.com/',
    site: 'use-the-index-luke.com',
    visits: 3,
    lastDaysAgo: 4,
    where: 'archived',
  },
  {
    key: 'so-postgres-index',
    title: 'How to create an index in Postgres - Stack Overflow',
    url: 'https://stackoverflow.com/questions/1108/how-to-create-an-index-in-postgres',
    site: 'stackoverflow.com',
    visits: 1,
    lastDaysAgo: 60,
    where: 'none',
  },
  {
    key: 'gh-rust',
    title: 'GitHub - rust-lang/rust: Empowering everyone to build reliable software',
    url: 'https://github.com/rust-lang/rust',
    site: 'github.com',
    visits: 10,
    lastDaysAgo: 1,
    where: 'open',
  },
  {
    key: 'rust-book',
    title: 'The Rust Programming Language',
    url: 'https://doc.rust-lang.org/book/',
    site: 'rust-lang.org',
    visits: 8,
    lastDaysAgo: 5,
    where: 'archived',
  },
  {
    key: 'rust-game',
    title: 'Rust (video game) - Wikipedia',
    url: 'https://en.wikipedia.org/wiki/Rust_(video_game)',
    site: 'wikipedia.org',
    visits: 1,
    lastDaysAgo: 200,
    where: 'none',
  },
  {
    key: 'rust-wiki',
    title: 'Rust - Wikipedia',
    url: 'https://en.wikipedia.org/wiki/Rust',
    site: 'wikipedia.org',
    visits: 1,
    lastDaysAgo: 100,
    where: 'none',
  },
  {
    key: 'gh-pulls',
    title: 'Pull requests',
    url: 'https://github.com/pulls',
    site: 'github.com',
    visits: 20,
    lastDaysAgo: 0,
    transition: 'typed',
    where: 'open',
  },
  {
    key: 'gmail',
    title: 'Inbox (3) - Gmail',
    url: 'https://mail.google.com/mail/u/0/',
    site: 'google.com',
    visits: 30,
    lastDaysAgo: 0,
    transition: 'typed',
    where: 'open',
  },
  {
    key: 'calendar',
    title: 'Google Calendar - Week of October 19',
    url: 'https://calendar.google.com/calendar/u/0/r/week',
    site: 'google.com',
    visits: 15,
    lastDaysAgo: 1,
    where: 'open',
  },
  {
    key: 'react-home',
    title: 'React: the library for web and native user interfaces',
    url: 'https://react.dev/',
    site: 'react.dev',
    visits: 5,
    lastDaysAgo: 10,
    where: 'archived',
  },
  {
    key: 'use-effect',
    title: 'useEffect – React',
    url: 'https://react.dev/reference/react/useEffect',
    site: 'react.dev',
    visits: 4,
    lastDaysAgo: 6,
    where: 'sleeping',
  },
  {
    key: 'hooks-legacy',
    title: 'Hooks at a Glance – React',
    url: 'https://legacy.reactjs.org/docs/hooks-overview.html',
    site: 'reactjs.org',
    visits: 1,
    lastDaysAgo: 300,
    where: 'none',
  },
  {
    key: 'cafe-flore',
    title: 'Café de Flore, Paris',
    url: 'https://cafedeflore.fr/',
    site: 'cafedeflore.fr',
    visits: 1,
    lastDaysAgo: 30,
    where: 'archived',
  },
  {
    key: 'tokyo-tower',
    title: '東京タワー Tokyo Tower travel guide',
    url: 'https://www.japan-guide.com/e/e3009.html',
    site: 'japan-guide.com',
    visits: 1,
    lastDaysAgo: 20,
    where: 'none',
  },
  {
    key: 'electron-45',
    title: 'Release electron v45.0.0',
    url: 'https://github.com/electron/electron/releases/tag/v45.0.0',
    site: 'github.com',
    visits: 2,
    lastDaysAgo: 0,
    where: 'sleeping',
  },
  {
    key: 'base-window',
    title: 'BaseWindow | Electron',
    url: 'https://www.electronjs.org/docs/latest/api/base-window',
    site: 'electronjs.org',
    visits: 3,
    lastDaysAgo: 7,
    where: 'archived',
  },
  {
    key: 'web-contents-view',
    title: 'WebContentsView | Electron',
    url: 'https://www.electronjs.org/docs/latest/api/web-contents-view',
    site: 'electronjs.org',
    visits: 3,
    lastDaysAgo: 7,
    where: 'archived',
  },
  {
    key: 'news',
    title: 'Hacker News',
    url: 'https://news.ycombinator.com/',
    site: 'ycombinator.com',
    visits: 12,
    lastDaysAgo: 1,
    where: 'none',
  },
];

const PLACEMENT: Readonly<Record<Exclude<Where, 'none'>, TabRow['placement']>> = {
  open: 'strip',
  sleeping: 'shelf',
  archived: 'archive',
};

describe('the golden query set', () => {
  const database = useTestDatabase();
  const setup = () => {
    const db = database();
    addWorkspace(db);
    const call = callerFor({ ...historyHandlers(db), ...tabHandlers(db), ...searchHandlers(db) });
    const keyOf = new Map<number, string>();
    const tabs: TabRow[] = [];
    PAGES.forEach((page, n) => {
      let pageId: number | null = null;
      for (let visit = page.visits - 1; visit >= 0; visit -= 1) {
        ({ pageId } = call('history.recordVisit', {
          page: {
            urlKey: page.url,
            url: page.url,
            host: new URL(page.url).hostname,
            site: page.site,
            title: '',
          },
          transition: page.transition ?? 'link',
          visitedAt: NOW - (page.lastDaysAgo + visit) * DAY,
          tabId: null,
        }));
      }
      if (pageId === null) {
        throw new Error(`${page.key} was not recorded`);
      }
      call('history.updatePage', { pageId, title: page.title });
      keyOf.set(pageId, page.key);
      if (page.where !== 'none') {
        const placement = PLACEMENT[page.where];
        tabs.push({
          id: testId(200 + n),
          workspaceId: WORKSPACE_ID,
          placement,
          position: n,
          pinned: false,
          userProtected: false,
          pageId: null,
          url: page.url,
          title: page.title,
          faviconId: null,
          restoreState: null,
          openerTabId: null,
          createdAt: NOW - 30 * DAY,
          lastUsedAt: NOW - page.lastDaysAgo * DAY,
          lastUsedEngaged: 0,
          lastUsedActiveDay: 0,
          placementChangedAt: NOW - page.lastDaysAgo * DAY,
          archivedAt: placement === 'archive' ? NOW - page.lastDaysAgo * DAY : null,
          archiveReason: placement === 'archive' ? 'auto' : null,
          closedAt: null,
        });
      }
    });
    call('session.save', { tabs, deleteIds: [], documents: [] });
    const search = (
      query: string,
      filter?: DataInput<'search.query'>['filter'],
    ): { keys: string[]; results: SearchResult[] } => {
      const { results } = call('search.query', {
        query,
        now: NOW,
        limit: 50,
        ...(filter === undefined ? {} : { filter }),
      });
      return { keys: results.map((result) => keyOf.get(result.pageId) ?? '?'), results };
    };
    return { search };
  };

  it.each([
    ['postgres index', 'pg-index-types'],
    ['explain analyze', 'explain-analyze'],
    ['index luke', 'index-luke'],
    ['rust book', 'rust-book'],
    ['github', 'gh-pulls'],
    ['gmail', 'gmail'],
    ['inbox', 'gmail'],
    ['cal', 'calendar'],
    ['calendar', 'calendar'],
    ['useeff', 'use-effect'],
    ['react hooks', 'hooks-legacy'],
    ['cafe', 'cafe-flore'],
    ['café flore', 'cafe-flore'],
    ['東京', 'tokyo-tower'],
    ['tokyo tower', 'tokyo-tower'],
    ['electron v45', 'electron-45'],
    ['basewin', 'base-window'],
    ['web contents view', 'web-contents-view'],
    ['wiki rust', 'rust-wiki'],
    ['hacker news', 'news'],
    ['pull', 'gh-pulls'],
  ])('puts what %j means first: %s', (query, first) => {
    const { search } = setup();
    expect(search(query).keys[0]).toBe(first);
  });

  it('finds every page about Postgres indexes, the open documentation first', () => {
    const { search } = setup();
    expect(search('postgres index').keys).toEqual(['pg-index-types', 'so-postgres-index']);
  });

  it('ranks the Rust the user works with above the video game and the encyclopedia', () => {
    const { search } = setup();
    const keys = search('rust').keys;
    expect(new Set(keys.slice(0, 2))).toEqual(new Set(['gh-rust', 'rust-book']));
    expect(keys.slice(-2).sort()).toEqual(['rust-game', 'rust-wiki']);
  });

  it('puts every GitHub page before any other for "github": the site is the word', () => {
    const { search } = setup();
    const found = search('github').results;
    const sites = found.map((result) => result.site);
    const firstOther = sites.findIndex((site) => site !== 'github.com');
    expect(firstOther === -1 ? sites.length : firstOther).toBe(
      sites.filter((site) => site === 'github.com').length,
    );
    expect(found[0]?.breakdown.siteMatch).toBe(0.3);
  });

  it('keeps the page that matches as the user types a word, from the third letter on', () => {
    const { search } = setup();
    // One letter: the recent-and-frequent list, where a title word starting with it counts.
    expect(search('p').keys[0]).toBe('gh-pulls');
    for (const typed of ['pos', 'post', 'postg', 'postgr', 'postgre', 'postgres']) {
      expect(search(typed).keys[0], typed).toBe('pg-index-types');
    }
  });

  it('opens with the pages the user lives in, when nothing is typed', () => {
    const { search } = setup();
    expect(search('').keys.slice(0, 3)).toEqual(['gmail', 'gh-pulls', 'calendar']);
  });

  it('finds an archived page by its own words, under the Archived filter', () => {
    const { search } = setup();
    expect(search('react', { placement: 'archive' }).keys).toEqual(['react-home']);
    expect(search('react', { placement: 'shelf' }).keys).toEqual(['use-effect']);
    expect(search('electron', { placement: 'archive' }).keys.sort()).toEqual([
      'base-window',
      'web-contents-view',
    ]);
  });

  it('narrows to what was visited today', () => {
    const { search } = setup();
    expect(search('', { visitedSince: NOW - DAY / 2 }).keys.sort()).toEqual([
      'electron-45',
      'gh-pulls',
      'gmail',
    ]);
  });

  // A known limit of word-start matching (FTS5 prefixes): a number inside a word, like the 45 of
  // v45.0.0, is not a word of its own, so "electron 45" finds nothing. Recorded, not hidden.
  it('does not find a number inside a word: "electron 45" misses v45.0.0', () => {
    const { search } = setup();
    expect(search('electron 45').keys).toEqual([]);
  });

  it('explains every result: its terms add up to its score', () => {
    const { search } = setup();
    for (const query of ['postgres index', 'rust', 'github', '', 'cafe']) {
      for (const { score, breakdown } of search(query).results) {
        const sum =
          breakdown.text +
          breakdown.frecency +
          breakdown.titleExact +
          breakdown.siteMatch +
          breakdown.state;
        expect(sum).toBeCloseTo(score, 12);
      }
    }
  });
});
