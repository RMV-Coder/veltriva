import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DatabaseConnection } from 'better-sqlite3/win32-x64';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { UUID_V7_PATTERN } from '../../core/id/uuidv7';
import { frecencyAfterVisit } from '../../core/search/frecency';
import { historyUrl } from '../../core/url/hygiene';
import { pageRowSchema } from '../../shared/contracts/data-rpc';
import { openDatabase } from '../database';
import {
  DATASET_NOW,
  generateSearchDataset,
  seedSearchDatabase,
  type SearchDataset,
} from './search-dataset';

const PAGES = 1000;

describe('generateSearchDataset', () => {
  it('gives the same dataset for the same options', () => {
    const options = { pages: 300, tabs: 50 };
    expect(generateSearchDataset(options)).toEqual(generateSearchDataset(options));
  });

  it('gives different titles for a different seed', () => {
    const titles = (seed: number): string[] =>
      generateSearchDataset({ pages: 300, seed }).pages.map((page) => page.title);
    expect(titles(1)).not.toEqual(titles(2));
  });

  it('makes exactly the pages asked for, each keyed the way the app keys its URL', () => {
    const { pages } = generateSearchDataset({ pages: PAGES });
    expect(pages).toHaveLength(PAGES);
    expect(new Set(pages.map((page) => page.urlKey)).size).toBe(PAGES);
    for (const page of pages) {
      const history = historyUrl(page.url);
      expect(history?.urlKey).toBe(page.urlKey);
      expect(history?.url).toBe(page.url);
      expect(page.host).toBe(new URL(page.url).hostname);
    }
  });

  it('makes min(tabs, pages) tabs, none in the strip, each on a distinct page', () => {
    const many = generateSearchDataset({ pages: PAGES });
    expect(many.tabs).toHaveLength(300);
    expect(many.tabs.map((tab) => tab.placement)).not.toContain('strip');
    expect(new Set(many.tabs.map((tab) => tab.page)).size).toBe(many.tabs.length);

    const few = generateSearchDataset({ pages: 40, tabs: 300 });
    expect(few.tabs).toHaveLength(40);
    expect(new Set(few.tabs.map((tab) => tab.page)).size).toBe(40);
  });

  it('gives every page its visits in time order, and summary fields that agree with them', () => {
    const { pages } = generateSearchDataset({ pages: PAGES });
    for (const page of pages) {
      const times = page.visits.map((visit) => visit.visitedAt);
      expect(times).toEqual([...times].sort((a, b) => a - b));
      expect(page.visits.length).toBeGreaterThanOrEqual(1);
      expect(page.visits.length).toBeLessThanOrEqual(60);
      expect(page.visitCount).toBe(page.visits.length);
      expect(page.firstVisitAt).toBe(times[0]);
      expect(page.lastVisitAt).toBe(times.at(-1));
      expect(page.frecencyAt).toBe(page.lastVisitAt);
      expect(page.typedCount).toBe(
        page.visits.filter((visit) => visit.transition === 'typed').length,
      );
    }
  });

  it('gives every page the frecency that folding its visits through the app gives', () => {
    const { pages } = generateSearchDataset({ pages: PAGES });
    for (const page of pages) {
      let frecency = 0;
      let at = page.firstVisitAt;
      for (const visit of page.visits) {
        frecency = frecencyAfterVisit(frecency, at, visit.visitedAt, visit.transition);
        at = visit.visitedAt;
      }
      expect(page.frecency).toBe(frecency);
    }
  });

  it('gives every page a row the data contract accepts', () => {
    const { pages } = generateSearchDataset({ pages: PAGES });
    for (const [index, page] of pages.entries()) {
      const row = {
        id: index + 1,
        urlKey: page.urlKey,
        url: page.url,
        host: page.host,
        site: page.site,
        title: page.title,
        faviconId: null,
        firstVisitAt: page.firstVisitAt,
        lastVisitAt: page.lastVisitAt,
        visitCount: page.visitCount,
        typedCount: page.typedCount,
        frecency: page.frecency,
        frecencyAt: page.frecencyAt,
      };
      expect(pageRowSchema.parse(row)).toEqual(row);
    }
  });

  it('gives every tab a UUIDv7, ordered stamps, and the fields its placement needs', () => {
    const { workspaceId, pages, tabs } = generateSearchDataset({ pages: PAGES });
    expect(workspaceId).toMatch(UUID_V7_PATTERN);
    expect(new Set(tabs.map((tab) => tab.id)).size).toBe(tabs.length);
    for (const tab of tabs) {
      expect(tab.id).toMatch(UUID_V7_PATTERN);
      expect(tab.page).toBeLessThan(pages.length);
      expect(tab.lastUsedAt).toBeGreaterThanOrEqual(tab.createdAt);
      expect(tab.placementChangedAt).toBeGreaterThanOrEqual(tab.lastUsedAt);
      expect(tab.placementChangedAt).toBeLessThanOrEqual(DATASET_NOW);
      expect(tab.archivedAt).toBe(tab.placement === 'archive' ? tab.placementChangedAt : null);
      expect(tab.closedAt).toBe(tab.placement === 'closed' ? tab.placementChangedAt : null);
      expect(tab.archiveReason === null).toBe(tab.placement !== 'archive');
    }
    for (const placement of ['shelf', 'archive', 'closed'] as const) {
      const positions = tabs
        .filter((tab) => tab.placement === placement)
        .map((tab) => tab.position);
      expect(positions).toEqual(positions.map((_, index) => index));
    }
  });
});

describe('seedSearchDatabase', () => {
  const dataset: SearchDataset = generateSearchDataset({ pages: PAGES });
  const visitCount = dataset.pages.reduce((sum, page) => sum + page.visits.length, 0);
  let folder = '';
  let connection: DatabaseConnection | undefined;

  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), 'veltriva-dataset-'));
    const file = join(folder, 'veltriva.db');
    await seedSearchDatabase(file, dataset);
    connection = (await openDatabase({ file, backupDir: join(folder, 'backups') })).db;
  });
  afterAll(() => {
    connection?.close();
    rmSync(folder, { recursive: true, force: true });
  });

  /** The seeded database that beforeAll opened. */
  function db(): DatabaseConnection {
    if (connection === undefined) throw new Error('beforeAll opens the database');
    return connection;
  }
  function scalar(sql: string): unknown {
    return db().prepare(sql).pluck().get();
  }

  it('writes one row per workspace, page, visit and tab', () => {
    expect(scalar('SELECT count(*) FROM workspaces')).toBe(1);
    expect(scalar('SELECT count(*) FROM pages')).toBe(PAGES);
    expect(scalar('SELECT count(*) FROM visits')).toBe(visitCount);
    expect(scalar('SELECT count(*) FROM tabs')).toBe(dataset.tabs.length);
  });

  it('reads every page back as the dataset has it, with ids 1 to N in order', () => {
    const rows = db()
      .prepare(
        `SELECT id, url_key AS urlKey, url, host, site, title,
                first_visit_at AS firstVisitAt, last_visit_at AS lastVisitAt,
                visit_count AS visitCount, typed_count AS typedCount,
                frecency, frecency_at AS frecencyAt
         FROM pages ORDER BY id`,
      )
      .all();
    expect(rows).toEqual(
      dataset.pages.map((page, index) => ({
        id: index + 1,
        urlKey: page.urlKey,
        url: page.url,
        host: page.host,
        site: page.site,
        title: page.title,
        firstVisitAt: page.firstVisitAt,
        lastVisitAt: page.lastVisitAt,
        visitCount: page.visitCount,
        typedCount: page.typedCount,
        frecency: page.frecency,
        frecencyAt: page.frecencyAt,
      })),
    );
  });

  it('reads every visit back in page order, with its page id and no tab', () => {
    const rows = db()
      .prepare(
        'SELECT page_id AS pageId, visited_at AS visitedAt, transition, tab_id AS tabId FROM visits ORDER BY id',
      )
      .all();
    expect(rows).toEqual(
      dataset.pages.flatMap((page, index) =>
        page.visits.map((visit) => ({
          pageId: index + 1,
          visitedAt: visit.visitedAt,
          transition: visit.transition,
          tabId: null,
        })),
      ),
    );
  });

  it("points every tab at its page, with the page's url and title", () => {
    expect(scalar('SELECT count(*) FROM tabs WHERE page_id IS NULL')).toBe(0);
    expect(
      scalar(
        'SELECT count(*) FROM tabs t JOIN pages p ON p.id = t.page_id AND t.url = p.url AND t.title = p.title',
      ),
    ).toBe(dataset.tabs.length);
  });

  it('indexes the pages for full-text search', () => {
    expect(
      scalar(`SELECT count(*) FROM pages_fts WHERE pages_fts MATCH '"postgres"*'`),
    ).toBeGreaterThan(0);
  });

  it("passes SQLite's own checks: quick_check, and the full-text index against its table", () => {
    expect(db().pragma('quick_check', { simple: true })).toBe('ok');
    expect(() =>
      db().exec("INSERT INTO pages_fts(pages_fts, rank) VALUES ('integrity-check', 1)"),
    ).not.toThrow();
  });
});
