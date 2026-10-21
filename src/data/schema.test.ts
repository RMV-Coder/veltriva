// The schema itself, through raw SQL on a database opened the way the worker opens it: the FTS5
// triggers, the frecency index, and the constraints the repositories lean on (migration 0001).
import { describe, expect, it } from 'vitest';

import type { DatabaseConnection } from 'better-sqlite3/win32-x64';

import {
  WORKSPACE_ID,
  addWorkspace,
  sqliteErrorCode,
  testId,
  useTestDatabase,
} from './repos/test-database';

describe('migration 0001 schema', () => {
  const database = useTestDatabase();

  /** The default url keeps the title's words out of the url, which the index also covers. */
  let pageCount = 0;
  const nextKey = () => {
    pageCount += 1;
    return `page-${String(pageCount)}`;
  };
  function addPage(db: DatabaseConnection, title: string, key = nextKey()): number {
    const result = db
      .prepare(
        `INSERT INTO pages (url_key, url, host, site, title, first_visit_at, last_visit_at)
         VALUES (?, ?, 'example.com', 'example.com', ?, 1, 1)`,
      )
      .run([key, `https://example.com/${key}`, title]);
    return Number(result.lastInsertRowid);
  }

  function addFavicon(db: DatabaseConnection, id: number): void {
    db.prepare(
      "INSERT INTO favicons (id, sha256, bytes, updated_at) VALUES (?, ?, x'89504e47', 1)",
    ).run([id, `sha-${String(id)}`]);
  }

  function addTab(db: DatabaseConnection, overrides: { pageId?: number; faviconId?: number } = {}) {
    db.prepare(
      `INSERT INTO tabs (id, workspace_id, placement, page_id, url, favicon_id, created_at,
                         last_used_at, last_used_engaged, last_used_active_day, placement_changed_at)
       VALUES (?, ?, 'strip', ?, 'https://example.com/', ?, 1, 1, 1, 1, 1)`,
    ).run([testId(100), WORKSPACE_ID, overrides.pageId ?? null, overrides.faviconId ?? null]);
  }

  const matches = (db: DatabaseConnection, query: string) =>
    db
      .prepare('SELECT rowid FROM pages_fts WHERE pages_fts MATCH ? ORDER BY rowid')
      .pluck()
      .all([query]);
  const totalChanges = (db: DatabaseConnection) =>
    db.prepare('SELECT total_changes()').pluck().get() as number;

  describe('full-text index', () => {
    it('finds a page by a prefix of a word in its title', () => {
      const db = database();
      const id = addPage(db, 'PostgreSQL indexing guide');
      addPage(db, 'Cooking with cast iron');

      expect(matches(db, '"postgre"*')).toEqual([id]);
      expect(matches(db, '"indexing"* "guide"*')).toEqual([id]);
      expect(matches(db, '"mongo"*')).toEqual([]);
    });

    it('finds a page by its url and by its site', () => {
      const db = database();
      const id = addPage(db, 'Plain title', 'unique-path');

      expect(matches(db, '"unique"*')).toEqual([id]);
      expect(matches(db, '"example"*')).toEqual([id]);
    });

    it('re-indexes when the title changes: the old word is gone, the new one found', () => {
      const db = database();
      const id = addPage(db, 'PostgreSQL indexing guide');

      db.prepare("UPDATE pages SET title = 'MySQL tuning notes' WHERE id = ?").run([id]);

      expect(matches(db, '"postgre"*')).toEqual([]);
      expect(matches(db, '"mysql"*')).toEqual([id]);
    });

    it('does not re-index when only visit_count, frecency or frecency_at change', () => {
      const db = database();
      const id = addPage(db, 'PostgreSQL indexing guide');
      const update = (sql: string) => {
        const before = totalChanges(db);
        db.prepare(sql).run([id]);
        return totalChanges(db) - before;
      };

      const counters = update(
        'UPDATE pages SET visit_count = 5, frecency = 3.5, frecency_at = 99 WHERE id = ?',
      );
      const title = update("UPDATE pages SET title = 'Another title' WHERE id = ?");

      expect(counters).toBe(1);
      expect(title).toBeGreaterThan(1);
      expect(matches(db, '"another"*')).toEqual([id]);
    });

    it('drops a page from the index when it is deleted', () => {
      const db = database();
      const id = addPage(db, 'PostgreSQL indexing guide');
      const keep = addPage(db, 'PostgreSQL replication');

      db.prepare('DELETE FROM pages WHERE id = ?').run([id]);

      expect(matches(db, '"postgre"*')).toEqual([keep]);
    });

    it('stays consistent with the pages table through all of the above', () => {
      const db = database();
      const first = addPage(db, 'PostgreSQL indexing guide');
      const second = addPage(db, 'Cooking with cast iron');
      db.prepare("UPDATE pages SET title = 'Cooking with copper' WHERE id = ?").run([second]);
      db.prepare('UPDATE pages SET visit_count = visit_count + 1 WHERE id = ?').run([first]);
      db.prepare('DELETE FROM pages WHERE id = ?').run([first]);

      expect(() =>
        db.prepare("INSERT INTO pages_fts(pages_fts) VALUES ('integrity-check')").run(),
      ).not.toThrow();
      expect(() =>
        db.prepare("INSERT INTO pages_fts(pages_fts, rank) VALUES ('integrity-check', 1)").run(),
      ).not.toThrow();
    });

    it('has secure-delete on, so deleted terms really disappear', () => {
      const db = database();

      expect(
        db.prepare("SELECT v FROM pages_fts_config WHERE k = 'secure-delete'").pluck().get(),
      ).toBe(1);
    });
  });

  describe('frecency index', () => {
    it('serves the recent-and-frequent listing, ordered by the decayed score', () => {
      const db = database();

      const plan = db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT id FROM pages
           ORDER BY log2(frecency) + frecency_at / 2592000000.0 DESC LIMIT 200`,
        )
        .all() as { detail: string }[];

      expect(plan.map((step) => step.detail).join('\n')).toContain('pages_frecency_idx');
    });
  });

  describe('constraints', () => {
    it("accepts 'allow' and 'block' as a permission decision and refuses 'deny'", () => {
      const db = database();
      const insert = db.prepare(
        'INSERT INTO permission_decisions (origin, permission, decision, updated_at) VALUES (?, ?, ?, 1)',
      );

      expect(
        sqliteErrorCode(() => insert.run(['https://a.example', 'camera', 'allow'])),
      ).toBeUndefined();
      expect(
        sqliteErrorCode(() => insert.run(['https://a.example', 'microphone', 'block'])),
      ).toBeUndefined();
      expect(sqliteErrorCode(() => insert.run(['https://a.example', 'geolocation', 'deny']))).toBe(
        'SQLITE_CONSTRAINT_CHECK',
      );
    });

    it('is STRICT: text in an integer column is refused', () => {
      const db = database();

      expect(
        sqliteErrorCode(() =>
          db
            .prepare(
              'INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
            )
            .run([testId(1), 'Main', 'yesterday', 1]),
        ),
      ).toBe('SQLITE_CONSTRAINT_DATATYPE');
    });

    it('accepts only the listed visit transitions', () => {
      const db = database();
      const pageId = addPage(db, 'A page');
      const insert = db.prepare(
        'INSERT INTO visits (page_id, visited_at, transition) VALUES (?, 1, ?)',
      );

      for (const transition of [
        'link',
        'typed',
        'reload',
        'back_forward',
        'redirect',
        'restore',
        'generated',
        'other',
      ]) {
        expect(sqliteErrorCode(() => insert.run([pageId, transition]))).toBeUndefined();
      }
      expect(sqliteErrorCode(() => insert.run([pageId, 'teleport']))).toBe(
        'SQLITE_CONSTRAINT_CHECK',
      );
    });

    it('refuses an app_state or settings document that is not valid JSON', () => {
      const db = database();
      const state = db.prepare('INSERT INTO app_state (key, json) VALUES (?, ?)');
      const settings = db.prepare('INSERT INTO settings (id, json) VALUES (1, ?)');

      expect(sqliteErrorCode(() => state.run(['session', '{"a":']))).toBe(
        'SQLITE_CONSTRAINT_CHECK',
      );
      expect(sqliteErrorCode(() => state.run(['session', 'not json']))).toBe(
        'SQLITE_CONSTRAINT_CHECK',
      );
      expect(sqliteErrorCode(() => settings.run(['{theme: dark}']))).toBe(
        'SQLITE_CONSTRAINT_CHECK',
      );
      expect(sqliteErrorCode(() => state.run(['session', '{"a":1}']))).toBeUndefined();
      expect(sqliteErrorCode(() => settings.run(['{"theme":"dark"}']))).toBeUndefined();
    });

    it('allows one settings row only, with id 1', () => {
      const db = database();

      expect(
        sqliteErrorCode(() => db.prepare("INSERT INTO settings (id, json) VALUES (2, '{}')").run()),
      ).toBe('SQLITE_CONSTRAINT_CHECK');
    });

    it('refuses a tab whose restore_state is not valid JSON', () => {
      const db = database();
      addWorkspace(db);

      expect(
        sqliteErrorCode(() =>
          db
            .prepare(
              `INSERT INTO tabs (id, workspace_id, placement, url, restore_state, created_at,
                                 last_used_at, last_used_engaged, last_used_active_day,
                                 placement_changed_at)
               VALUES (?, ?, 'strip', 'https://example.com/', '{broken', 1, 1, 1, 1, 1)`,
            )
            .run([testId(100), WORKSPACE_ID]),
        ),
      ).toBe('SQLITE_CONSTRAINT_CHECK');
    });
  });

  describe('foreign keys', () => {
    it("deletes a page's visits with it", () => {
      const db = database();
      const pageId = addPage(db, 'A page');
      const otherId = addPage(db, 'Another page');
      const insert = db.prepare(
        "INSERT INTO visits (page_id, visited_at, transition) VALUES (?, 1, 'link')",
      );
      insert.run([pageId]);
      insert.run([pageId]);
      insert.run([otherId]);

      db.prepare('DELETE FROM pages WHERE id = ?').run([pageId]);

      expect(db.prepare('SELECT page_id FROM visits').pluck().all()).toEqual([otherId]);
    });

    it('clears favicon_id on pages and tabs when the favicon is deleted', () => {
      const db = database();
      addWorkspace(db);
      addFavicon(db, 7);
      const pageId = addPage(db, 'A page');
      db.prepare('UPDATE pages SET favicon_id = 7 WHERE id = ?').run([pageId]);
      addTab(db, { faviconId: 7 });

      db.prepare('DELETE FROM favicons WHERE id = 7').run();

      expect(db.prepare('SELECT favicon_id FROM pages').pluck().get()).toBeNull();
      expect(db.prepare('SELECT favicon_id FROM tabs').pluck().get()).toBeNull();
      expect(db.prepare('SELECT count(*) FROM pages').pluck().get()).toBe(1);
      expect(db.prepare('SELECT count(*) FROM tabs').pluck().get()).toBe(1);
    });

    it('keeps a tab when its page is deleted, with page_id cleared', () => {
      const db = database();
      addWorkspace(db);
      const pageId = addPage(db, 'A page');
      addTab(db, { pageId });

      db.prepare('DELETE FROM pages WHERE id = ?').run([pageId]);

      expect(db.prepare('SELECT page_id FROM tabs').pluck().get()).toBeNull();
      expect(db.prepare('SELECT count(*) FROM tabs').pluck().get()).toBe(1);
    });

    it("deletes a workspace's tabs with it", () => {
      const db = database();
      addWorkspace(db);
      addTab(db);

      db.prepare('DELETE FROM workspaces WHERE id = ?').run([WORKSPACE_ID]);

      expect(db.prepare('SELECT count(*) FROM tabs').pluck().get()).toBe(0);
    });

    it('refuses a tab for a workspace that does not exist', () => {
      const db = database();

      expect(
        sqliteErrorCode(() => {
          addTab(db);
        }),
      ).toBe('SQLITE_CONSTRAINT_FOREIGNKEY');
    });
  });
});
