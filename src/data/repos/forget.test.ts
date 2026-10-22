// Clearing data (M5.2, assessment §5.7). The deletion tests the phase asks for: the rows are gone,
// the full-text index has no hit, the database and WAL files shrink, and a deleted page's unique
// word is in neither file's raw bytes once the deletion has checkpointed. A real database file,
// opened and migrated as the worker does it.
import { readFileSync, statSync } from 'node:fs';

import type { DatabaseConnection } from 'better-sqlite3/win32-x64';
import { describe, expect, it } from 'vitest';

import { frecencyAfterVisit } from '../../core/search/frecency';
import { siteOf } from '../../core/url/site';
import { forgetHandlers } from './forget';
import { historyHandlers } from './history';
import { addWorkspace, callerFor, testId, useTestDatabase, WORKSPACE_ID } from './test-database';

const HOUR = 60 * 60 * 1000;
const T0 = 1_790_000_000_000;

describe('memory.forget (M5.2)', () => {
  const database = useTestDatabase();
  const forget = () => callerFor(forgetHandlers(database()));
  const history = () => callerFor(historyHandlers(database()));

  /** One visit to a page on `host`, at `at`; its page's id. */
  function visit(
    path: string,
    at: number,
    options: { host?: string; title?: string; transition?: 'link' | 'typed' | 'redirect' } = {},
  ): number {
    const host = options.host ?? 'example.com';
    const url = `https://${host}${path}`;
    const { pageId } = history()('history.recordVisit', {
      page: { urlKey: url, url, host, site: siteOf(url) ?? host, title: '' },
      transition: options.transition ?? 'link',
      visitedAt: at,
      tabId: null,
    });
    if (pageId === null) {
      throw new Error('not recorded');
    }
    if (options.title !== undefined) {
      history()('history.updatePage', { pageId, title: options.title });
    }
    return pageId;
  }

  /** A tab row as the session store writes one. */
  function tab(
    n: number,
    url: string,
    placement: 'strip' | 'archive' | 'closed',
    at: number,
  ): string {
    const db = database();
    if (db.prepare('SELECT count(*) FROM workspaces').pluck().get() === 0) {
      addWorkspace(db);
    }
    const id = testId(n);
    db.prepare(
      `INSERT INTO tabs (id, workspace_id, placement, position, url, title, created_at,
         last_used_at, last_used_engaged, last_used_active_day, placement_changed_at,
         archived_at, archive_reason, closed_at)
       VALUES (?, ?, ?, 0, ?, 'A tab', ?, ?, 0, 0, ?, ?, ?, ?)`,
    ).run([
      id,
      WORKSPACE_ID,
      placement,
      url,
      at,
      at,
      at,
      placement === 'archive' ? at : null,
      placement === 'archive' ? 'auto' : null,
      placement === 'closed' ? at : null,
    ]);
    return id;
  }

  const count = (table: string): unknown =>
    database().prepare(`SELECT count(*) FROM ${table}`).pluck().get();
  const tabIds = (): string[] =>
    database().prepare('SELECT id FROM tabs ORDER BY id').pluck().all() as string[];
  const ftsHits = (word: string): unknown[] =>
    database()
      .prepare('SELECT rowid FROM pages_fts WHERE pages_fts MATCH ?')
      .pluck()
      .all([`"${word}"*`]);
  const integrity = (db: DatabaseConnection): void => {
    db.exec("INSERT INTO pages_fts(pages_fts) VALUES ('integrity-check')");
    expect(db.pragma('quick_check', { simple: true })).toBe('ok');
  };

  describe('one entry', () => {
    it('removes the page, its visits and its index entries, and the archived tab named; nothing else', () => {
      const gone = visit('/gone', T0, { title: 'Quokkaforget page' });
      visit('/gone', T0 + 1);
      const kept = visit('/kept', T0, { title: 'Wombatkeep page' });
      const archived = tab(1, 'https://example.com/gone', 'archive', T0);
      const open = tab(2, 'https://example.com/gone', 'strip', T0);

      const counts = forget()('memory.forget', {
        scope: 'pages',
        pageIds: [gone],
        tabIds: [archived, open],
      });

      expect(counts).toEqual({ pages: 1, visits: 2, tabs: 1, favicons: 0, origins: [] });
      expect(database().prepare('SELECT id FROM pages').pluck().all()).toEqual([kept]);
      expect(count('visits')).toBe(1);
      // An open tab is the user's, not a record: it stays.
      expect(tabIds()).toEqual([open]);
      expect(ftsHits('quokkaforget')).toEqual([]);
      expect(ftsHits('wombatkeep')).toEqual([kept]);
      integrity(database());
    });

    it('answers with nothing removed for a page that is already gone', () => {
      expect(forget()('memory.forget', { scope: 'pages', pageIds: [123], tabIds: [] })).toEqual({
        pages: 0,
        visits: 0,
        tabs: 0,
        favicons: 0,
        origins: [],
      });
    });
  });

  describe('a site', () => {
    it('removes every page of the site and its archived and recently closed tabs; an open tab stays', () => {
      visit('/a', T0, { host: 'news.example.org', title: 'Pangolinsite one' });
      visit('/b', T0, { host: 'example.org', title: 'Pangolinsite two' });
      const other = visit('/c', T0, { host: 'example.com', title: 'Other site' });
      tab(1, 'https://news.example.org/a', 'archive', T0);
      tab(2, 'https://example.org/b', 'closed', T0);
      const open = tab(3, 'https://example.org/b', 'strip', T0);
      const otherArchived = tab(4, 'https://example.com/c', 'archive', T0);

      const counts = forget()('memory.forget', { scope: 'site', site: 'example.org' });

      expect(counts).toMatchObject({ pages: 2, visits: 2, tabs: 2 });
      // The addresses whose storage main clears too: the pages' and the tabs'.
      expect(counts.origins).toEqual(['https://example.org', 'https://news.example.org']);
      expect(database().prepare('SELECT id FROM pages').pluck().all()).toEqual([other]);
      expect(tabIds().sort()).toEqual([open, otherArchived].sort());
      expect(ftsHits('pangolinsite')).toEqual([]);
      integrity(database());
    });
  });

  describe('a time range', () => {
    it('removes the visits since then; a page left with none goes, one with older visits is counted again', () => {
      const recent = visit('/recent', T0 + 2 * HOUR, { title: 'Recentonly' });
      const mixed = visit('/mixed', T0, { transition: 'typed' });
      visit('/mixed', T0 + HOUR / 2);
      visit('/mixed', T0 + 2 * HOUR);
      const old = visit('/old', T0);

      const counts = forget()('memory.forget', {
        scope: 'since',
        since: T0 + HOUR,
        memory: true,
        tabs: false,
      });

      expect(counts).toMatchObject({ pages: 1, visits: 2 });
      const ids = database().prepare('SELECT id FROM pages ORDER BY id').pluck().all();
      expect(ids).toEqual([mixed, old]);
      expect(ids).not.toContain(recent);
      const row = database()
        .prepare(
          `SELECT visit_count AS visits, typed_count AS typed, first_visit_at AS first,
             last_visit_at AS last, frecency, frecency_at AS frecencyAt FROM pages WHERE id = ?`,
        )
        .get([mixed]);
      const replayed = frecencyAfterVisit(
        frecencyAfterVisit(0, T0, T0, 'typed'),
        T0,
        T0 + HOUR / 2,
        'link',
      );
      expect(row).toEqual({
        visits: 2,
        typed: 1,
        first: T0,
        last: T0 + HOUR / 2,
        frecency: replayed,
        frecencyAt: T0 + HOUR / 2,
      });
      expect(ftsHits('recentonly')).toEqual([]);
      integrity(database());
    });

    it('leaves a page with no visits at all alone: one an archived tab keeps after retention', () => {
      const kept = visit('/archived', T0);
      database().prepare('DELETE FROM visits').run();

      forget()('memory.forget', { scope: 'since', since: T0 - HOUR, memory: true, tabs: false });

      expect(database().prepare('SELECT id FROM pages').pluck().all()).toEqual([kept]);
    });

    it('removes the tabs archived or closed since then, when asked, and never an open one', () => {
      const oldArchived = tab(1, 'https://example.com/1', 'archive', T0);
      tab(2, 'https://example.com/2', 'archive', T0 + 2 * HOUR);
      tab(3, 'https://example.com/3', 'closed', T0 + 2 * HOUR);
      const oldClosed = tab(4, 'https://example.com/4', 'closed', T0);
      const open = tab(5, 'https://example.com/5', 'strip', T0 + 2 * HOUR);

      const counts = forget()('memory.forget', {
        scope: 'since',
        since: T0 + HOUR,
        memory: false,
        tabs: true,
      });

      expect(counts.tabs).toBe(2);
      expect(tabIds().sort()).toEqual([oldArchived, oldClosed, open].sort());
    });

    it('since 0 is everything: every page and visit, and every archived and closed tab', () => {
      visit('/a', T0);
      visit('/b', T0 + HOUR, { host: 'example.org' });
      tab(1, 'https://example.com/a', 'archive', T0);
      tab(2, 'https://example.com/b', 'closed', T0);
      const open = tab(3, 'https://example.com/a', 'strip', T0);

      const counts = forget()('memory.forget', {
        scope: 'since',
        since: 0,
        memory: true,
        tabs: true,
      });

      expect(counts).toEqual({ pages: 2, visits: 2, tabs: 2, favicons: 0, origins: [] });
      expect(count('pages')).toBe(0);
      expect(count('visits')).toBe(0);
      expect(tabIds()).toEqual([open]);
      integrity(database());
    });
  });

  it('removes an icon nothing shows any more, and keeps one still shown', () => {
    const db = database();
    db.prepare(
      "INSERT INTO favicons (id, sha256, bytes, mime, updated_at) VALUES (1, 'a', x'89504e47', 'image/png', 1), (2, 'b', x'89504e47', 'image/png', 1)",
    ).run();
    const gone = visit('/gone', T0);
    const kept = visit('/kept', T0);
    history()('history.updatePage', { pageId: gone, faviconId: 1 });
    history()('history.updatePage', { pageId: kept, faviconId: 2 });

    const counts = forget()('memory.forget', { scope: 'pages', pageIds: [gone], tabIds: [] });

    expect(counts.favicons).toBe(1);
    expect(db.prepare('SELECT id FROM favicons').pluck().all()).toEqual([2]);
  });

  describe('what is left on disk', () => {
    const UNIQUE = 'Xylophonequetzalvanish';
    /** The database file and its WAL, as raw bytes. */
    const files = (db: DatabaseConnection): { db: Buffer; wal: Buffer } => {
      const read = (path: string): Buffer => {
        try {
          return readFileSync(path);
        } catch {
          return Buffer.alloc(0);
        }
      };
      return { db: read(db.name), wal: read(`${db.name}-wal`) };
    };
    const size = (path: string): number => {
      try {
        return statSync(path).size;
      } catch {
        return 0;
      }
    };

    it("a deleted page's unique word is in neither file's raw bytes once the deletion has checkpointed", () => {
      const db = database();
      const page = visit('/secret', T0, { title: `${UNIQUE} report` });
      visit('/other', T0, { title: 'Ordinary page' });
      db.pragma('wal_checkpoint(TRUNCATE)');
      // The word is really on disk first, in the page and in the index.
      expect(files(db).db.includes(UNIQUE)).toBe(true);
      expect(files(db).db.includes(UNIQUE.toLowerCase())).toBe(true);

      forget()('memory.forget', { scope: 'pages', pageIds: [page], tabIds: [] });

      const after = files(db);
      expect(after.db.includes(UNIQUE)).toBe(false);
      expect(after.db.includes(UNIQUE.toLowerCase())).toBe(false);
      expect(after.wal.includes(UNIQUE)).toBe(false);
      expect(after.wal.includes(UNIQUE.toLowerCase())).toBe(false);
      expect(files(db).db.includes('Ordinary page')).toBe(true);
    });

    it('the database and its WAL shrink: the WAL is emptied and the freed pages given back', () => {
      const db = database();
      for (let n = 0; n < 1500; n += 1) {
        visit(`/bulk/${String(n)}`, T0 + n, {
          title: `Bulk page ${String(n)} ${'lorem ipsum dolor sit amet '.repeat(20)}`,
        });
      }
      db.pragma('wal_checkpoint(TRUNCATE)');
      // More visits, so the WAL holds something too.
      for (let n = 0; n < 50; n += 1) {
        visit(`/bulk/${String(n)}`, T0 + 10_000 + n);
      }
      const dbBefore = size(db.name);
      const walBefore = size(`${db.name}-wal`);
      expect(walBefore).toBeGreaterThan(0);

      forget()('memory.forget', { scope: 'since', since: 0, memory: true, tabs: true });

      const dbAfter = size(db.name);
      expect(size(`${db.name}-wal`)).toBe(0);
      // Most of the file was these pages and their index.
      expect(dbAfter).toBeLessThan(dbBefore / 2);
      expect(db.pragma('freelist_count', { simple: true })).toBe(0);
      integrity(db);
    });
  });
});
