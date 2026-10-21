import { describe, expect, it } from 'vitest';

import { FRECENCY_HALF_LIFE_MS } from '../../core/search/frecency';
import type { VisitTransition } from '../../core/search/frecency';
import type { DataInput } from '../../shared/contracts/data-rpc';
import { faviconHandlers } from './favicons';
import { historyHandlers } from './history';
import { callerFor, sqliteErrorCode, testId, useTestDatabase } from './test-database';

const T0 = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const TAB = testId(50);
type RecordVisit = DataInput<'history.recordVisit'>;

/** A visit to page `n`, of the kind main sends: its title not known yet. */
function visit(
  n: number,
  overrides: Partial<Omit<RecordVisit, 'page'>> & { page?: Partial<RecordVisit['page']> } = {},
): RecordVisit {
  const { page, ...rest } = overrides;
  return {
    page: {
      urlKey: `https://site${String(n)}.example/a`,
      url: `https://site${String(n)}.example/a`,
      host: `site${String(n)}.example`,
      site: `site${String(n)}.example`,
      title: '',
      ...page,
    },
    transition: 'link',
    visitedAt: T0,
    tabId: TAB,
    ...rest,
  };
}

describe('history', () => {
  const database = useTestDatabase();
  const setup = () => {
    const db = database();
    const handlers = { ...historyHandlers(db), ...faviconHandlers(db) };
    const call = callerFor(handlers);
    /**
     * A favicon row for a page to point at, and its id. The one place this file uses the favicon
     * repository: a page only needs an icon to exist.
     */
    const addIcon = (variant = 1): number => {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, variant]).toString(
        'base64',
      );
      return call('favicons.put', { bytes: png, mime: 'image/png', at: T0 }).id;
    };
    const pages = () => call('history.pages', { limit: 1000 }).pages;
    const onlyPage = () => {
      const [first, ...others] = pages();
      expect(others).toEqual([]);
      if (first === undefined) {
        throw new Error('expected one page');
      }
      return first;
    };
    const visits = (pageId: number, limit = 1000) =>
      call('history.visits', { pageId, limit }).visits;
    const rawVisits = () => db.prepare('SELECT COUNT(*) FROM visits').pluck().get() as number;
    const exclude = (site: string, protect = 0, excludeMemory = 1) => {
      db.prepare(
        'INSERT INTO site_rules (site, protect, exclude_memory, created_at) VALUES (?, ?, ?, ?)',
      ).run([site, protect, excludeMemory, T0]);
    };
    const searchRowids = (term: string) =>
      db
        .prepare('SELECT rowid FROM pages_fts WHERE pages_fts MATCH ?')
        .pluck()
        .all([term]) as number[];
    const checkIndex = () => {
      // Throws SQLITE_CORRUPT_VTAB when the index and the table disagree.
      db.exec("INSERT INTO pages_fts(pages_fts, rank) VALUES ('integrity-check', 1)");
    };
    return {
      db,
      call,
      addIcon,
      pages,
      onlyPage,
      visits,
      rawVisits,
      exclude,
      searchRowids,
      checkIndex,
    };
  };

  describe('history.recordVisit: a page seen for the first time', () => {
    it('creates the page with its counts, its times and its frecency', () => {
      const { call, onlyPage } = setup();

      const { pageId } = call('history.recordVisit', visit(1, { visitedAt: T0 }));

      expect(pageId).toBeGreaterThan(0);
      expect(onlyPage()).toEqual({
        id: pageId,
        urlKey: 'https://site1.example/a',
        url: 'https://site1.example/a',
        host: 'site1.example',
        site: 'site1.example',
        title: '',
        faviconId: null,
        firstVisitAt: T0,
        lastVisitAt: T0,
        visitCount: 1,
        typedCount: 0,
        frecency: 1,
        frecencyAt: T0,
      });
    });

    it('adds the visit, with its tab, its time and its transition', () => {
      const { call, visits } = setup();

      const { pageId } = call('history.recordVisit', visit(1, { visitedAt: T0 + 5, tabId: TAB }));

      expect(visits(pageId as number)).toEqual([
        { id: expect.any(Number) as number, visitedAt: T0 + 5, transition: 'link', tabId: TAB },
      ]);
    });

    it('stores a visit from no tab with a null tab id', () => {
      const { call, visits, db } = setup();

      const { pageId } = call('history.recordVisit', visit(1, { tabId: null }));

      expect(visits(pageId as number)[0]?.tabId).toBeNull();
      expect(db.prepare('SELECT tab_id FROM visits').pluck().get()).toBeNull();
    });

    it('keeps the title it is given, since a visit with one fills an empty title', () => {
      const { call, onlyPage } = setup();

      call('history.recordVisit', visit(1, { page: { title: 'First title' } }));

      expect(onlyPage().title).toBe('First title');
    });

    it('round-trips Unicode in the address and the title', () => {
      const { call, onlyPage } = setup();

      call(
        'history.recordVisit',
        visit(1, {
          page: {
            urlKey: 'https://xn--bcher-kva.de/%C3%BC',
            url: 'https://xn--bcher-kva.de/%C3%BC?q=%F0%9F%98%80',
            title: 'Bücher 😀 日本語',
          },
        }),
      );

      expect(onlyPage()).toMatchObject({
        url: 'https://xn--bcher-kva.de/%C3%BC?q=%F0%9F%98%80',
        title: 'Bücher 😀 日本語',
      });
    });

    it('gives each page its own id, and each key its own page', () => {
      const { call, pages } = setup();

      const a = call('history.recordVisit', visit(1)).pageId;
      const b = call('history.recordVisit', visit(2)).pageId;

      expect(a).not.toBe(b);
      expect(pages()).toHaveLength(2);
    });
  });

  describe('history.recordVisit: visit_count and typed_count', () => {
    it.each<[VisitTransition, number, number]>([
      ['link', 1, 0],
      ['generated', 1, 0],
      ['back_forward', 1, 0],
      ['restore', 1, 0],
      ['reload', 1, 0],
      ['other', 1, 0],
      ['typed', 1, 1],
      ['redirect', 0, 0],
    ])('a first %s visit counts %s visit(s) and %s typed', (transition, visits, typed) => {
      const { call, onlyPage, rawVisits } = setup();

      call('history.recordVisit', visit(1, { transition }));

      expect(onlyPage()).toMatchObject({ visitCount: visits, typedCount: typed });
      // The visit itself is kept either way: a redirect's hop is a visit, not counted.
      expect(rawVisits()).toBe(1);
    });

    it('counts each later visit by the same rules', () => {
      const { call, onlyPage } = setup();
      const sequence: VisitTransition[] = [
        'link',
        'typed',
        'redirect',
        'reload',
        'typed',
        'redirect',
      ];

      sequence.forEach((transition, index) => {
        call('history.recordVisit', visit(1, { transition, visitedAt: T0 + index }));
      });

      expect(onlyPage()).toMatchObject({ visitCount: 4, typedCount: 2 });
    });

    it('does not count a redirect, though it is a row in the visit list', () => {
      const { call, onlyPage, visits } = setup();
      const first = call(
        'history.recordVisit',
        visit(1, { transition: 'redirect', visitedAt: T0 }),
      );
      call('history.recordVisit', visit(1, { transition: 'link', visitedAt: T0 + 1 }));

      expect(onlyPage()).toMatchObject({ visitCount: 1, typedCount: 0 });
      expect(visits(first.pageId as number).map((entry) => entry.transition)).toEqual([
        'link',
        'redirect',
      ]);
    });

    it('counts a typed visit in both counts', () => {
      const { call, onlyPage } = setup();

      call('history.recordVisit', visit(1, { transition: 'typed' }));
      call('history.recordVisit', visit(1, { transition: 'typed', visitedAt: T0 + 1 }));
      call('history.recordVisit', visit(1, { transition: 'link', visitedAt: T0 + 2 }));

      expect(onlyPage()).toMatchObject({ visitCount: 3, typedCount: 2 });
    });

    it('finds the page by its key: the same key is one page however the rest differs', () => {
      const { call, pages } = setup();

      const first = call('history.recordVisit', visit(1, { visitedAt: T0 }));
      const second = call(
        'history.recordVisit',
        visit(1, {
          visitedAt: T0 + 1,
          page: { url: 'https://site1.example/a#section', host: 'SITE1.example' },
        }),
      );

      expect(second.pageId).toBe(first.pageId);
      expect(pages()).toHaveLength(1);
    });

    it('updates the address shown, the host and the site to the latest visit', () => {
      const { call, onlyPage } = setup();
      call('history.recordVisit', visit(1, { visitedAt: T0 }));

      call(
        'history.recordVisit',
        visit(1, {
          visitedAt: T0 + 1,
          page: {
            url: 'https://site1.example/a#later',
            host: 'www.site1.example',
            site: 'site1.example',
          },
        }),
      );

      expect(onlyPage()).toMatchObject({
        url: 'https://site1.example/a#later',
        host: 'www.site1.example',
        site: 'site1.example',
        urlKey: 'https://site1.example/a',
      });
    });
  });

  describe('history.recordVisit: frecency', () => {
    it.each<[VisitTransition, number]>([
      ['typed', 2],
      ['link', 1],
      ['generated', 1],
      ['restore', 0.5],
      ['back_forward', 0.5],
      ['other', 0.5],
      ['reload', 0],
      ['redirect', 0],
    ])('a first %s visit scores %s', (transition, score) => {
      const { call, onlyPage } = setup();

      call('history.recordVisit', visit(1, { transition, visitedAt: T0 }));

      expect(onlyPage()).toMatchObject({ frecency: score, frecencyAt: T0 });
    });

    it('adds the weight of a visit made at once, without decay', () => {
      const { call, onlyPage } = setup();

      call('history.recordVisit', visit(1, { transition: 'link', visitedAt: T0 }));
      call('history.recordVisit', visit(1, { transition: 'typed', visitedAt: T0 }));

      expect(onlyPage()).toMatchObject({ frecency: 3, frecencyAt: T0 });
    });

    it('decays the stored score to the time of the visit before adding the weight', () => {
      const { call, onlyPage } = setup();
      call('history.recordVisit', visit(1, { transition: 'typed', visitedAt: T0 }));

      // One half-life later: 2 -> 1, and a link adds 1.
      call(
        'history.recordVisit',
        visit(1, { transition: 'link', visitedAt: T0 + FRECENCY_HALF_LIFE_MS }),
      );

      expect(onlyPage()).toMatchObject({ frecency: 2, frecencyAt: T0 + FRECENCY_HALF_LIFE_MS });
    });

    it('keeps decaying across a run of visits', () => {
      const { call, onlyPage } = setup();

      call('history.recordVisit', visit(1, { transition: 'link', visitedAt: T0 }));
      call(
        'history.recordVisit',
        visit(1, { transition: 'reload', visitedAt: T0 + FRECENCY_HALF_LIFE_MS }),
      );
      expect(onlyPage().frecency).toBe(0.5);

      call(
        'history.recordVisit',
        visit(1, { transition: 'reload', visitedAt: T0 + 2 * FRECENCY_HALF_LIFE_MS }),
      );
      expect(onlyPage().frecency).toBe(0.25);
    });

    it('lets a reload or a redirect decay the score but add nothing', () => {
      const { call, onlyPage } = setup();
      call('history.recordVisit', visit(1, { transition: 'typed', visitedAt: T0 }));

      call('history.recordVisit', visit(1, { transition: 'redirect', visitedAt: T0 + DAY }));

      const { frecency, frecencyAt } = onlyPage();
      expect(frecency).toBeCloseTo(2 * 2 ** (-1 / 30), 12);
      expect(frecencyAt).toBe(T0 + DAY);
    });

    it('scores a page seen often above one seen once, as of the same moment', () => {
      const { call, pages } = setup();
      for (let day = 0; day < 5; day += 1) {
        call('history.recordVisit', visit(1, { visitedAt: T0 + day * DAY }));
      }
      call('history.recordVisit', visit(2, { visitedAt: T0 + 4 * DAY }));

      const byUrl = new Map(pages().map((row) => [row.host, row.frecency]));

      expect(byUrl.get('site1.example') ?? 0).toBeGreaterThan(byUrl.get('site2.example') ?? 0);
    });
  });

  describe('history.recordVisit: a clock that went back', () => {
    it('never moves the first or the last visit time the wrong way', () => {
      const { call, onlyPage } = setup();
      call('history.recordVisit', visit(1, { visitedAt: T0 }));

      call('history.recordVisit', visit(1, { visitedAt: T0 - DAY }));

      const row = onlyPage();
      expect(row.firstVisitAt).toBe(T0 - DAY);
      expect(row.lastVisitAt).toBe(T0);
      expect(row.firstVisitAt).toBeLessThanOrEqual(row.lastVisitAt);
    });

    it('keeps the later frecency time, and decays nothing for an earlier visit', () => {
      const { call, onlyPage } = setup();
      call('history.recordVisit', visit(1, { transition: 'link', visitedAt: T0 }));

      call('history.recordVisit', visit(1, { transition: 'link', visitedAt: T0 - 10 * DAY }));

      expect(onlyPage()).toMatchObject({ frecency: 2, frecencyAt: T0 });
    });

    it('does not grow a score for a reload that arrives before the last visit', () => {
      const { call, onlyPage } = setup();
      call('history.recordVisit', visit(1, { transition: 'typed', visitedAt: T0 }));

      call('history.recordVisit', visit(1, { transition: 'reload', visitedAt: T0 - 5 * DAY }));

      expect(onlyPage().frecency).toBe(2);
    });

    it('keeps every time monotonic over any order of visits', () => {
      const { call, onlyPage } = setup();
      const times = [T0 + 5 * DAY, T0, T0 + 9 * DAY, T0 - 2 * DAY, T0 + 9 * DAY, T0 + DAY];

      for (const visitedAt of times) {
        call('history.recordVisit', visit(1, { visitedAt }));
        const row = onlyPage();
        expect(row.firstVisitAt).toBeLessThanOrEqual(row.lastVisitAt);
        expect(row.frecencyAt).toBeGreaterThanOrEqual(row.firstVisitAt);
      }

      const row = onlyPage();
      expect(row.firstVisitAt).toBe(T0 - 2 * DAY);
      expect(row.lastVisitAt).toBe(T0 + 9 * DAY);
      expect(row.frecencyAt).toBe(T0 + 9 * DAY);
    });

    it('lists the visits by their own times, whatever order they were recorded in', () => {
      const { call, visits } = setup();
      const first = call('history.recordVisit', visit(1, { visitedAt: T0 + 2 * DAY }));
      call('history.recordVisit', visit(1, { visitedAt: T0 }));
      call('history.recordVisit', visit(1, { visitedAt: T0 + DAY }));

      expect(visits(first.pageId as number).map((entry) => entry.visitedAt)).toEqual([
        T0 + 2 * DAY,
        T0 + DAY,
        T0,
      ]);
    });
  });

  describe('history.recordVisit: the title', () => {
    it('fills an empty title from a visit that has one', () => {
      const { call, onlyPage } = setup();
      call('history.recordVisit', visit(1, { visitedAt: T0 }));

      call('history.recordVisit', visit(1, { visitedAt: T0 + 1, page: { title: 'Filled' } }));

      expect(onlyPage().title).toBe('Filled');
    });

    it('never replaces a title that is there: a commit carries the previous page’s', () => {
      const { call, onlyPage } = setup();
      call('history.recordVisit', visit(1, { visitedAt: T0, page: { title: 'Settled' } }));

      call('history.recordVisit', visit(1, { visitedAt: T0 + 1, page: { title: 'Stale' } }));
      call('history.recordVisit', visit(1, { visitedAt: T0 + 2, page: { title: '' } }));

      expect(onlyPage().title).toBe('Settled');
    });

    it('leaves an empty title empty when the visit has none', () => {
      const { call, onlyPage } = setup();

      call('history.recordVisit', visit(1, { visitedAt: T0 }));
      call('history.recordVisit', visit(1, { visitedAt: T0 + 1 }));

      expect(onlyPage().title).toBe('');
    });

    it('keeps a title set by updatePage over later visits', () => {
      const { call, onlyPage } = setup();
      const { pageId } = call('history.recordVisit', visit(1));
      call('history.updatePage', { pageId: pageId as number, title: 'From the page' });

      call(
        'history.recordVisit',
        visit(1, { visitedAt: T0 + 1, page: { title: 'Previous page' } }),
      );

      expect(onlyPage().title).toBe('From the page');
    });
  });

  describe('history.recordVisit: a site excluded from the memory', () => {
    it('records nothing and answers with a null page id', () => {
      const { call, exclude, pages, rawVisits } = setup();
      exclude('site1.example');

      const answer = call('history.recordVisit', visit(1));

      expect(answer).toEqual({ pageId: null });
      expect(pages()).toEqual([]);
      expect(rawVisits()).toBe(0);
    });

    it('excludes by the site, whatever the host or the page', () => {
      const { call, exclude, pages } = setup();
      exclude('bank.example');

      const answers = ['www.bank.example', 'login.bank.example', 'bank.example'].map((host) =>
        call(
          'history.recordVisit',
          visit(1, {
            page: {
              urlKey: `https://${host}/p`,
              url: `https://${host}/p`,
              host,
              site: 'bank.example',
            },
          }),
        ),
      );

      expect(answers).toEqual([{ pageId: null }, { pageId: null }, { pageId: null }]);
      expect(pages()).toEqual([]);
    });

    it('records other sites as usual, even one that only looks like it', () => {
      const { call, exclude, pages } = setup();
      exclude('bank.example');

      const other = call(
        'history.recordVisit',
        visit(1, { page: { site: 'notbank.example', host: 'notbank.example' } }),
      );
      const similar = call(
        'history.recordVisit',
        visit(2, { page: { site: 'bank.example.evil', host: 'bank.example.evil' } }),
      );

      expect(other.pageId).not.toBeNull();
      expect(similar.pageId).not.toBeNull();
      expect(pages()).toHaveLength(2);
    });

    it('is not excluded by a rule that only protects the site', () => {
      const { call, exclude, pages } = setup();
      exclude('site1.example', 1, 0);

      const { pageId } = call('history.recordVisit', visit(1));

      expect(pageId).not.toBeNull();
      expect(pages()).toHaveLength(1);
    });

    it('is excluded by a rule that both protects and excludes', () => {
      const { call, exclude, pages } = setup();
      exclude('site1.example', 1, 1);

      expect(call('history.recordVisit', visit(1)).pageId).toBeNull();
      expect(pages()).toEqual([]);
    });

    it('stops recording a page that was recorded before the rule, and leaves what it has', () => {
      const { call, exclude, onlyPage, rawVisits } = setup();
      call('history.recordVisit', visit(1, { visitedAt: T0 }));
      exclude('site1.example');

      const answer = call('history.recordVisit', visit(1, { visitedAt: T0 + DAY }));

      expect(answer.pageId).toBeNull();
      expect(onlyPage()).toMatchObject({ visitCount: 1, lastVisitAt: T0 });
      expect(rawVisits()).toBe(1);
    });

    it('does not index anything for an excluded page', () => {
      const { call, exclude, searchRowids, checkIndex } = setup();
      exclude('site1.example');

      call('history.recordVisit', visit(1, { page: { title: 'Secret ledger' } }));

      expect(searchRowids('ledger')).toEqual([]);
      checkIndex();
    });
  });

  describe('history.recordVisit: atomic', () => {
    it('creates neither the page nor the visit when adding the visit fails', () => {
      const { call, db, pages, rawVisits } = setup();
      db.exec(
        "CREATE TRIGGER refuse_visit BEFORE INSERT ON visits BEGIN SELECT RAISE(ABORT, 'refused'); END",
      );

      expect(() => call('history.recordVisit', visit(1))).toThrow('refused');

      expect(pages()).toEqual([]);
      expect(rawVisits()).toBe(0);
    });

    it('moves no count, time or score of an existing page when adding the visit fails', () => {
      const { call, db, onlyPage, rawVisits } = setup();
      call('history.recordVisit', visit(1, { visitedAt: T0, transition: 'typed' }));
      const before = onlyPage();
      db.exec(
        "CREATE TRIGGER refuse_visit BEFORE INSERT ON visits BEGIN SELECT RAISE(ABORT, 'refused'); END",
      );

      expect(() =>
        call('history.recordVisit', visit(1, { visitedAt: T0 + DAY, transition: 'typed' })),
      ).toThrow('refused');

      expect(onlyPage()).toEqual(before);
      expect(rawVisits()).toBe(1);
    });

    it('leaves the index agreeing with the table after a failed visit', () => {
      const { call, db, searchRowids, checkIndex } = setup();
      call('history.recordVisit', visit(1, { page: { title: 'Kept' } }));
      db.exec(
        "CREATE TRIGGER refuse_visit BEFORE INSERT ON visits BEGIN SELECT RAISE(ABORT, 'refused'); END",
      );

      expect(() => call('history.recordVisit', visit(2, { page: { title: 'Lost' } }))).toThrow(
        'refused',
      );

      expect(searchRowids('lost')).toEqual([]);
      expect(searchRowids('kept')).toHaveLength(1);
      checkIndex();
    });
  });

  describe('history.updatePage', () => {
    it('sets the title alone', () => {
      const { call, onlyPage } = setup();
      const { pageId } = call('history.recordVisit', visit(1));

      const answer = call('history.updatePage', { pageId: pageId as number, title: 'A title' });

      expect(answer).toEqual({ count: 1 });
      expect(onlyPage()).toMatchObject({ title: 'A title', faviconId: null });
    });

    it('sets the icon alone, and leaves the title', () => {
      const { call, onlyPage, addIcon } = setup();
      const { pageId } = call('history.recordVisit', visit(1, { page: { title: 'Kept' } }));
      const id = addIcon();

      const answer = call('history.updatePage', { pageId: pageId as number, faviconId: id });

      expect(answer).toEqual({ count: 1 });
      expect(onlyPage()).toMatchObject({ title: 'Kept', faviconId: id });
    });

    it('sets both at once', () => {
      const { call, onlyPage, addIcon } = setup();
      const { pageId } = call('history.recordVisit', visit(1));
      const id = addIcon();

      const answer = call('history.updatePage', {
        pageId: pageId as number,
        title: 'Both',
        faviconId: id,
      });

      expect(answer).toEqual({ count: 1 });
      expect(onlyPage()).toMatchObject({ title: 'Both', faviconId: id });
    });

    it('changes nothing, and counts nothing, when given neither', () => {
      const { call, onlyPage } = setup();
      const { pageId } = call('history.recordVisit', visit(1, { page: { title: 'Same' } }));
      const before = onlyPage();

      const answer = call('history.updatePage', { pageId: pageId as number });

      expect(answer).toEqual({ count: 0 });
      expect(onlyPage()).toEqual(before);
    });

    it('replaces a title that is there, and can set it back to empty', () => {
      const { call, onlyPage } = setup();
      const { pageId } = call('history.recordVisit', visit(1, { page: { title: 'Old' } }));

      call('history.updatePage', { pageId: pageId as number, title: 'New' });
      expect(onlyPage().title).toBe('New');

      call('history.updatePage', { pageId: pageId as number, title: '' });
      expect(onlyPage().title).toBe('');
    });

    it('replaces the icon with another', () => {
      const { call, onlyPage, addIcon } = setup();
      const { pageId } = call('history.recordVisit', visit(1));
      const first = addIcon(1);
      const second = addIcon(2);

      call('history.updatePage', { pageId: pageId as number, faviconId: first });
      call('history.updatePage', { pageId: pageId as number, faviconId: second });

      expect(second).not.toBe(first);
      expect(onlyPage().faviconId).toBe(second);
    });

    it('counts a page that is not there as nothing, for a title, an icon or both', () => {
      const { call, pages, addIcon } = setup();
      const id = addIcon();

      expect(call('history.updatePage', { pageId: 999, title: 'x' })).toEqual({ count: 0 });
      expect(call('history.updatePage', { pageId: 999, faviconId: id })).toEqual({ count: 0 });
      expect(call('history.updatePage', { pageId: 999, title: 'x', faviconId: id })).toEqual({
        count: 0,
      });
      expect(call('history.updatePage', { pageId: 999 })).toEqual({ count: 0 });
      expect(pages()).toEqual([]);
    });

    it('leaves other pages alone', () => {
      const { call, pages } = setup();
      const a = call('history.recordVisit', visit(1, { page: { title: 'A' } }));
      call('history.recordVisit', visit(2, { page: { title: 'B' } }));

      call('history.updatePage', { pageId: a.pageId as number, title: 'A2' });

      expect(
        pages()
          .map((row) => row.title)
          .sort(),
      ).toEqual(['A2', 'B']);
    });

    it('refuses an icon that is not there, and then changes nothing, not even the title', () => {
      const { call, db, onlyPage } = setup();
      const { pageId } = call('history.recordVisit', visit(1, { page: { title: 'Before' } }));

      const code = sqliteErrorCode(() =>
        call('history.updatePage', { pageId: pageId as number, title: 'After', faviconId: 999 }),
      );

      expect(code).toBe('SQLITE_CONSTRAINT_FOREIGNKEY');
      expect(onlyPage()).toMatchObject({ title: 'Before', faviconId: null });
      expect(db.prepare('SELECT COUNT(*) FROM favicons').pluck().get()).toBe(0);
    });

    it('does not touch the counts, the times or the score', () => {
      const { call, onlyPage } = setup();
      const { pageId } = call('history.recordVisit', visit(1, { transition: 'typed' }));
      const before = onlyPage();

      call('history.updatePage', { pageId: pageId as number, title: 'Settled' });

      expect(onlyPage()).toEqual({ ...before, title: 'Settled' });
    });
  });

  describe('history.pages', () => {
    it('is empty before any visit', () => {
      expect(setup().call('history.pages', { limit: 10 })).toEqual({ pages: [] });
    });

    it('lists the most recently visited first', () => {
      const { call, pages } = setup();
      call('history.recordVisit', visit(1, { visitedAt: T0 + 10 }));
      call('history.recordVisit', visit(2, { visitedAt: T0 + 30 }));
      call('history.recordVisit', visit(3, { visitedAt: T0 + 20 }));

      expect(pages().map((row) => row.host)).toEqual([
        'site2.example',
        'site3.example',
        'site1.example',
      ]);
    });

    it('moves a page to the top when it is visited again', () => {
      const { call, pages } = setup();
      call('history.recordVisit', visit(1, { visitedAt: T0 }));
      call('history.recordVisit', visit(2, { visitedAt: T0 + 10 }));

      call('history.recordVisit', visit(1, { visitedAt: T0 + 20 }));

      expect(pages().map((row) => row.host)).toEqual(['site1.example', 'site2.example']);
    });

    it('breaks a tie in time by the newer page first', () => {
      const { call, pages } = setup();
      const a = call('history.recordVisit', visit(1, { visitedAt: T0 }));
      const b = call('history.recordVisit', visit(2, { visitedAt: T0 }));
      const c = call('history.recordVisit', visit(3, { visitedAt: T0 }));

      expect(pages().map((row) => row.id)).toEqual([c.pageId, b.pageId, a.pageId]);
    });

    it('returns no more than the limit, keeping the most recent', () => {
      const { call } = setup();
      for (let n = 1; n <= 5; n += 1) {
        call('history.recordVisit', visit(n, { visitedAt: T0 + n }));
      }

      const { pages } = call('history.pages', { limit: 2 });

      expect(pages.map((row) => row.host)).toEqual(['site5.example', 'site4.example']);
    });

    it('returns every page when the limit is more than there are', () => {
      const { call } = setup();
      call('history.recordVisit', visit(1));

      expect(call('history.pages', { limit: 1000 }).pages).toHaveLength(1);
    });
  });

  describe('history.visits', () => {
    it('is empty for a page with no visits, and for one that is not there', () => {
      const { call } = setup();

      expect(call('history.visits', { pageId: 1, limit: 10 })).toEqual({ visits: [] });
      expect(call('history.visits', { pageId: 999_999, limit: 10 })).toEqual({ visits: [] });
    });

    it('lists the newest visit first, with its transition and tab', () => {
      const { call, visits } = setup();
      const other = testId(51);
      const { pageId } = call(
        'history.recordVisit',
        visit(1, { visitedAt: T0, transition: 'typed', tabId: TAB }),
      );
      call(
        'history.recordVisit',
        visit(1, { visitedAt: T0 + 10, transition: 'reload', tabId: other }),
      );
      call(
        'history.recordVisit',
        visit(1, { visitedAt: T0 + 20, transition: 'redirect', tabId: null }),
      );

      expect(visits(pageId as number)).toEqual([
        {
          id: expect.any(Number) as number,
          visitedAt: T0 + 20,
          transition: 'redirect',
          tabId: null,
        },
        {
          id: expect.any(Number) as number,
          visitedAt: T0 + 10,
          transition: 'reload',
          tabId: other,
        },
        { id: expect.any(Number) as number, visitedAt: T0, transition: 'typed', tabId: TAB },
      ]);
    });

    it('breaks a tie in time by the later visit first', () => {
      const { call, visits } = setup();
      const { pageId } = call(
        'history.recordVisit',
        visit(1, { visitedAt: T0, transition: 'link' }),
      );
      call('history.recordVisit', visit(1, { visitedAt: T0, transition: 'typed' }));
      call('history.recordVisit', visit(1, { visitedAt: T0, transition: 'reload' }));

      expect(visits(pageId as number).map((entry) => entry.transition)).toEqual([
        'reload',
        'typed',
        'link',
      ]);
    });

    it('returns no more than the limit, keeping the newest', () => {
      const { call, visits } = setup();
      const { pageId } = call('history.recordVisit', visit(1, { visitedAt: T0 }));
      for (let n = 1; n <= 4; n += 1) {
        call('history.recordVisit', visit(1, { visitedAt: T0 + n }));
      }

      expect(visits(pageId as number, 2).map((entry) => entry.visitedAt)).toEqual([T0 + 4, T0 + 3]);
    });

    it('gives only the visits of the page asked for', () => {
      const { call, visits } = setup();
      const a = call('history.recordVisit', visit(1, { visitedAt: T0 }));
      const b = call('history.recordVisit', visit(2, { visitedAt: T0 + 1 }));
      call('history.recordVisit', visit(2, { visitedAt: T0 + 2 }));

      expect(visits(a.pageId as number)).toHaveLength(1);
      expect(visits(b.pageId as number)).toHaveLength(2);
    });

    it('keeps the visits of a page past the counts: a redirect is listed, though not counted', () => {
      const { call, visits, onlyPage } = setup();
      const { pageId } = call('history.recordVisit', visit(1, { transition: 'redirect' }));

      expect(visits(pageId as number)).toHaveLength(1);
      expect(onlyPage().visitCount).toBe(0);
    });
  });

  describe('the search index', () => {
    it('finds a new page by its title, its address and its site', () => {
      const { call, searchRowids } = setup();
      const { pageId } = call(
        'history.recordVisit',
        visit(1, {
          page: { title: 'Quarterly Budget', url: 'https://finance.example/reports/q3' },
        }),
      );

      expect(searchRowids('budget')).toEqual([pageId]);
      expect(searchRowids('reports')).toEqual([pageId]);
      expect(searchRowids('site1')).toEqual([pageId]);
    });

    it('finds a title that arrives from a visit that filled an empty one', () => {
      const { call, searchRowids, checkIndex } = setup();
      const { pageId } = call('history.recordVisit', visit(1));
      expect(searchRowids('kestrel')).toEqual([]);

      call('history.recordVisit', visit(1, { visitedAt: T0 + 1, page: { title: 'Kestrel' } }));

      expect(searchRowids('kestrel')).toEqual([pageId]);
      checkIndex();
    });

    it('finds the new title and no longer the old one after updatePage', () => {
      const { call, searchRowids, checkIndex } = setup();
      const { pageId } = call('history.recordVisit', visit(1, { page: { title: 'Heron' } }));

      call('history.updatePage', { pageId: pageId as number, title: 'Osprey' });

      expect(searchRowids('heron')).toEqual([]);
      expect(searchRowids('osprey')).toEqual([pageId]);
      checkIndex();
    });

    it('finds the address a revisit changed, and no longer the old one', () => {
      const { call, searchRowids, checkIndex } = setup();
      const { pageId } = call(
        'history.recordVisit',
        visit(1, { page: { url: 'https://site1.example/oldpath' } }),
      );

      call(
        'history.recordVisit',
        visit(1, { visitedAt: T0 + 1, page: { url: 'https://site1.example/newpath' } }),
      );

      expect(searchRowids('oldpath')).toEqual([]);
      expect(searchRowids('newpath')).toEqual([pageId]);
      checkIndex();
    });

    it('stays consistent over many visits and updates, which is what the full check asks', () => {
      const { call, checkIndex, searchRowids } = setup();
      for (let round = 0; round < 5; round += 1) {
        for (let n = 1; n <= 4; n += 1) {
          const { pageId } = call(
            'history.recordVisit',
            visit(n, {
              visitedAt: T0 + round * 10 + n,
              page: { title: round === 0 ? '' : `T${String(n)}` },
            }),
          );
          if (round % 2 === 0) {
            call('history.updatePage', {
              pageId: pageId as number,
              title: `Round${String(round)}x${String(n)}`,
            });
          }
        }
      }

      checkIndex();
      expect(searchRowids('round4x1')).toHaveLength(1);
      expect(searchRowids('round3x1')).toEqual([]);
    });

    it('does not re-index for a visit that changes no text, and stays consistent', () => {
      const { call, checkIndex, searchRowids } = setup();
      const { pageId } = call('history.recordVisit', visit(1, { page: { title: 'Stable title' } }));

      for (let n = 1; n <= 3; n += 1) {
        call('history.recordVisit', visit(1, { visitedAt: T0 + n, page: { title: 'Ignored' } }));
      }

      expect(searchRowids('stable')).toEqual([pageId]);
      expect(searchRowids('ignored')).toEqual([]);
      checkIndex();
    });
  });
});
