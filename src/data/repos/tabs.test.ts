import { describe, expect, it } from 'vitest';

import type { RestoreState, TabRow } from '../../shared/contracts/data-rpc';
import { tabHandlers } from './tabs';
import {
  WORKSPACE_ID,
  addWorkspace,
  callerFor,
  sqliteErrorCode,
  testId,
  useTestDatabase,
} from './test-database';

const T0 = 1_700_000_000_000;
const OTHER_WORKSPACE = testId(2);

/** A strip tab; `n` sets its id, position and URL. */
function tabRow(n: number, overrides: Partial<TabRow> = {}): TabRow {
  return {
    id: testId(100 + n),
    workspaceId: WORKSPACE_ID,
    placement: 'strip',
    position: n,
    pinned: false,
    userProtected: false,
    pageId: null,
    url: `https://example.com/${String(n)}`,
    title: `Tab ${String(n)}`,
    faviconId: null,
    restoreState: null,
    openerTabId: null,
    createdAt: T0,
    lastUsedAt: T0 + 10,
    lastUsedEngaged: 5000,
    lastUsedActiveDay: 19_700,
    placementChangedAt: T0 + 20,
    archivedAt: null,
    archiveReason: null,
    closedAt: null,
    ...overrides,
  };
}

const RESTORE_STATE: RestoreState = {
  v: 1,
  index: 1,
  entries: [
    { url: 'https://example.com/a', title: 'A' },
    { url: 'https://example.com/b', title: 'B' },
  ],
};

describe('tabs', () => {
  const database = useTestDatabase();
  const setup = () => {
    const db = database();
    addWorkspace(db);
    return { db, call: callerFor(tabHandlers(db)) };
  };
  const list = (call: ReturnType<typeof setup>['call'], placement: TabRow['placement'] = 'strip') =>
    call('tabs.list', { workspaceId: WORKSPACE_ID, placement, limit: 10_000 }).tabs;

  describe('tabs.list', () => {
    it('is empty for a workspace with no tabs', () => {
      const { call } = setup();

      expect(
        call('tabs.list', { workspaceId: WORKSPACE_ID, placement: 'strip', limit: 10 }),
      ).toEqual({ tabs: [] });
    });

    it('returns only the requested workspace and placement', () => {
      const { db, call } = setup();
      addWorkspace(db, OTHER_WORKSPACE);
      call('tabs.upsertMany', {
        tabs: [
          tabRow(1),
          tabRow(2, { placement: 'shelf' }),
          tabRow(3, { workspaceId: OTHER_WORKSPACE }),
        ],
      });

      expect(list(call).map((tab) => tab.id)).toEqual([testId(101)]);
      expect(list(call, 'shelf').map((tab) => tab.id)).toEqual([testId(102)]);
      expect(list(call, 'archive')).toEqual([]);
      expect(
        call('tabs.list', { workspaceId: OTHER_WORKSPACE, placement: 'strip', limit: 10 }).tabs,
      ).toHaveLength(1);
    });

    it('orders by position, then by id', () => {
      const { call } = setup();
      call('tabs.upsertMany', {
        tabs: [
          tabRow(1, { position: 2 }),
          tabRow(2, { position: 0 }),
          tabRow(4, { position: 1 }),
          tabRow(3, { position: 1 }),
        ],
      });

      expect(list(call).map((tab) => tab.id)).toEqual([
        testId(102),
        testId(103),
        testId(104),
        testId(101),
      ]);
    });

    it('returns no more than the limit, keeping the first positions', () => {
      const { call } = setup();
      call('tabs.upsertMany', { tabs: [tabRow(3), tabRow(1), tabRow(2), tabRow(4)] });

      const result = call('tabs.list', { workspaceId: WORKSPACE_ID, placement: 'strip', limit: 2 });

      expect(result.tabs.map((tab) => tab.position)).toEqual([1, 2]);
    });

    it('reads a stored back/forward stack back as an object', () => {
      const { db, call } = setup();
      call('tabs.upsertMany', { tabs: [tabRow(1, { restoreState: RESTORE_STATE })] });

      expect(list(call)[0]?.restoreState).toEqual(RESTORE_STATE);
      expect(db.prepare('SELECT restore_state FROM tabs').pluck().get()).toBe(
        JSON.stringify(RESTORE_STATE),
      );
    });

    it('returns restoreState null, not an error, for a stack that fails the schema', () => {
      const { db, call } = setup();
      call('tabs.upsertMany', {
        tabs: [tabRow(1, { restoreState: RESTORE_STATE }), tabRow(2), tabRow(3)],
      });
      const update = db.prepare('UPDATE tabs SET restore_state = ? WHERE id = ?');
      update.run(['{"v":2,"index":0,"entries":[]}', testId(101)]);
      update.run([
        '{"v":1,"index":3,"entries":[{"url":"https://a.example/","title":""}]}',
        testId(102),
      ]);
      update.run([
        '{"v":1,"index":0,"entries":[{"url":"https://a.example/","title":"","extra":1}]}',
        testId(103),
      ]);

      const tabs = list(call);

      expect(tabs.map((tab) => tab.restoreState)).toEqual([null, null, null]);
      expect(tabs.map((tab) => tab.url)).toEqual([
        'https://example.com/1',
        'https://example.com/2',
        'https://example.com/3',
      ]);
    });

    it('returns restoreState null for text that is not JSON at all', () => {
      const { db, call } = setup();
      call('tabs.upsertMany', { tabs: [tabRow(1), tabRow(2, { restoreState: RESTORE_STATE })] });
      // Only a database written with CHECK enforcement off can hold this.
      db.pragma('ignore_check_constraints = ON');
      db.prepare('UPDATE tabs SET restore_state = ? WHERE id = ?').run(['{not json', testId(101)]);
      db.pragma('ignore_check_constraints = OFF');

      const tabs = list(call);

      expect(tabs.map((tab) => tab.restoreState)).toEqual([null, RESTORE_STATE]);
    });
  });

  describe('tabs.upsertMany', () => {
    it('round-trips a strip tab with every field set', () => {
      const { db, call } = setup();
      db.exec(`INSERT INTO favicons (id, sha256, png, updated_at) VALUES (7, 'abc', x'89504e47', 1);
        INSERT INTO pages (id, url_key, url, host, site, first_visit_at, last_visit_at)
        VALUES (9, 'example.com/x', 'https://example.com/x', 'example.com', 'example.com', 1, 1)`);
      const tab = tabRow(1, {
        pinned: true,
        userProtected: true,
        pageId: 9,
        faviconId: 7,
        restoreState: RESTORE_STATE,
        openerTabId: testId(150),
        title: 'A title, with ünïcode and 😀',
      });

      expect(call('tabs.upsertMany', { tabs: [tab] })).toEqual({ count: 1 });

      expect(list(call)).toEqual([tab]);
    });

    it('round-trips archived and closed tabs and their reasons', () => {
      const { call } = setup();
      const archived = tabRow(1, {
        placement: 'archive',
        archivedAt: T0 + 5,
        archiveReason: 'auto',
      });
      const manual = tabRow(2, {
        placement: 'archive',
        archivedAt: T0 + 6,
        archiveReason: 'manual',
      });
      const closed = tabRow(3, { placement: 'closed', closedAt: T0 + 7 });

      call('tabs.upsertMany', { tabs: [archived, manual, closed] });

      expect(list(call, 'archive')).toEqual([archived, manual]);
      expect(list(call, 'closed')).toEqual([closed]);
    });

    it('keeps false booleans false and nullable columns null', () => {
      const { db, call } = setup();
      call('tabs.upsertMany', { tabs: [tabRow(1)] });

      const stored = db
        .prepare(
          `SELECT pinned, user_protected, page_id, favicon_id, restore_state, opener_tab_id,
                  archived_at, archive_reason, closed_at FROM tabs`,
        )
        .get();

      expect(stored).toEqual({
        pinned: 0,
        user_protected: 0,
        page_id: null,
        favicon_id: null,
        restore_state: null,
        opener_tab_id: null,
        archived_at: null,
        archive_reason: null,
        closed_at: null,
      });
      expect(list(call)[0]).toMatchObject({
        pinned: false,
        userProtected: false,
        restoreState: null,
      });
    });

    it('keeps timestamps up to the largest safe integer exact', () => {
      const { call } = setup();
      const tab = tabRow(1, {
        createdAt: Number.MAX_SAFE_INTEGER,
        lastUsedAt: Number.MAX_SAFE_INTEGER,
        lastUsedEngaged: Number.MAX_SAFE_INTEGER,
        placementChangedAt: Number.MAX_SAFE_INTEGER,
      });
      call('tabs.upsertMany', { tabs: [tab] });

      expect(list(call)).toEqual([tab]);
    });

    it('updates an existing row in place, every column', () => {
      const { db, call } = setup();
      addWorkspace(db, OTHER_WORKSPACE);
      db.exec(`INSERT INTO favicons (id, sha256, png, updated_at) VALUES (7, 'abc', x'89504e47', 1);
        INSERT INTO pages (id, url_key, url, host, site, first_visit_at, last_visit_at)
        VALUES (9, 'example.com/x', 'https://example.com/x', 'example.com', 'example.com', 1, 1)`);
      call('tabs.upsertMany', { tabs: [tabRow(1, { pinned: true, restoreState: RESTORE_STATE })] });
      const changed: TabRow = {
        id: testId(101),
        workspaceId: OTHER_WORKSPACE,
        placement: 'archive',
        position: 42,
        pinned: false,
        userProtected: true,
        pageId: 9,
        url: 'https://changed.example/',
        title: 'Changed',
        faviconId: 7,
        restoreState: null,
        openerTabId: testId(160),
        createdAt: T0 + 1,
        lastUsedAt: T0 + 2,
        lastUsedEngaged: 6000,
        lastUsedActiveDay: 19_701,
        placementChangedAt: T0 + 3,
        archivedAt: T0 + 4,
        archiveReason: 'manual',
        closedAt: T0 + 5,
      };

      expect(call('tabs.upsertMany', { tabs: [changed] })).toEqual({ count: 1 });

      expect(db.prepare('SELECT count(*) FROM tabs').pluck().get()).toBe(1);
      expect(
        call('tabs.list', { workspaceId: OTHER_WORKSPACE, placement: 'archive', limit: 10 }).tabs,
      ).toEqual([changed]);
      expect(db.prepare('SELECT restore_state FROM tabs').pluck().get()).toBeNull();
    });

    it('mixes inserts and updates in one call and counts every row it was given', () => {
      const { call } = setup();
      call('tabs.upsertMany', { tabs: [tabRow(1), tabRow(2)] });

      const result = call('tabs.upsertMany', {
        tabs: [tabRow(1, { title: 'Renamed' }), tabRow(3), tabRow(2, { position: 9 })],
      });

      expect(result).toEqual({ count: 3 });
      expect(list(call).map((tab) => [tab.id, tab.title, tab.position])).toEqual([
        [testId(101), 'Renamed', 1],
        [testId(103), 'Tab 3', 3],
        [testId(102), 'Tab 2', 9],
      ]);
    });

    it('writes nothing when one row of the batch is refused', () => {
      const { db, call } = setup();
      call('tabs.upsertMany', { tabs: [tabRow(1, { title: 'Before' })] });

      const code = sqliteErrorCode(() =>
        call('tabs.upsertMany', {
          tabs: [
            tabRow(1, { title: 'After' }),
            tabRow(2),
            tabRow(3, { placement: 'archive', archivedAt: null }),
            tabRow(4),
          ],
        }),
      );

      expect(code).toBe('SQLITE_CONSTRAINT_CHECK');
      expect(list(call).map((tab) => [tab.id, tab.title])).toEqual([[testId(101), 'Before']]);
      expect(db.inTransaction).toBe(false);
    });

    it('accepts a full batch of 1000 tabs', () => {
      const { call } = setup();
      const tabs = Array.from({ length: 1000 }, (_, n) => tabRow(n));

      expect(call('tabs.upsertMany', { tabs })).toEqual({ count: 1000 });

      expect(list(call)).toHaveLength(1000);
    });

    it.each([
      ['an archived tab without archivedAt', { placement: 'archive', archivedAt: null }],
      ['a closed tab without closedAt', { placement: 'closed', closedAt: null }],
      ['a pinned tab on the shelf', { pinned: true, placement: 'shelf' }],
      [
        'a pinned tab in the archive',
        { pinned: true, placement: 'archive', archivedAt: T0 + 1, archiveReason: 'manual' },
      ],
    ] as const)('refuses %s with a CHECK error', (_name, overrides) => {
      const { db, call } = setup();

      expect(sqliteErrorCode(() => call('tabs.upsertMany', { tabs: [tabRow(1, overrides)] }))).toBe(
        'SQLITE_CONSTRAINT_CHECK',
      );
      expect(db.prepare('SELECT count(*) FROM tabs').pluck().get()).toBe(0);
    });

    it('refuses a tab whose workspace does not exist', () => {
      const { call } = setup();

      expect(
        sqliteErrorCode(() =>
          call('tabs.upsertMany', { tabs: [tabRow(1, { workspaceId: testId(77) })] }),
        ),
      ).toBe('SQLITE_CONSTRAINT_FOREIGNKEY');
    });

    it('refuses a page or favicon that does not exist', () => {
      const { call } = setup();

      expect(
        sqliteErrorCode(() => call('tabs.upsertMany', { tabs: [tabRow(1, { pageId: 99 })] })),
      ).toBe('SQLITE_CONSTRAINT_FOREIGNKEY');
      expect(
        sqliteErrorCode(() => call('tabs.upsertMany', { tabs: [tabRow(1, { faviconId: 99 })] })),
      ).toBe('SQLITE_CONSTRAINT_FOREIGNKEY');
    });

    it('does not turn an update that breaks a CHECK into a replace', () => {
      const { call } = setup();
      call('tabs.upsertMany', { tabs: [tabRow(1, { pinned: true })] });

      const code = sqliteErrorCode(() =>
        call('tabs.upsertMany', { tabs: [tabRow(1, { pinned: true, placement: 'shelf' })] }),
      );

      expect(code).toBe('SQLITE_CONSTRAINT_CHECK');
      expect(list(call)[0]).toMatchObject({ pinned: true, placement: 'strip' });
    });
  });

  describe('tabs.deleteMany', () => {
    it('deletes the listed tabs and counts them', () => {
      const { call } = setup();
      call('tabs.upsertMany', { tabs: [tabRow(1), tabRow(2), tabRow(3)] });

      const result = call('tabs.deleteMany', { ids: [testId(101), testId(103)] });

      expect(result).toEqual({ count: 2 });
      expect(list(call).map((tab) => tab.id)).toEqual([testId(102)]);
    });

    it('counts only the tabs that existed', () => {
      const { call } = setup();
      call('tabs.upsertMany', { tabs: [tabRow(1)] });

      expect(call('tabs.deleteMany', { ids: [testId(101), testId(190), testId(191)] })).toEqual({
        count: 1,
      });
      expect(call('tabs.deleteMany', { ids: [testId(101)] })).toEqual({ count: 0 });
    });

    it('deletes a full batch of 1000 ids in one statement', () => {
      const { call } = setup();
      const tabs = Array.from({ length: 1001 }, (_, n) => tabRow(n));
      call('tabs.upsertMany', { tabs: tabs.slice(0, 1000) });
      call('tabs.upsertMany', { tabs: tabs.slice(1000) });

      const result = call('tabs.deleteMany', { ids: tabs.slice(0, 1000).map((tab) => tab.id) });

      expect(result).toEqual({ count: 1000 });
      expect(list(call).map((tab) => tab.id)).toEqual([testId(1100)]);
    });

    it('treats an id as data, never as SQL', () => {
      const { call } = setup();
      call('tabs.upsertMany', { tabs: [tabRow(1)] });
      const hostile = ["x') OR 1=1 --", '"]; DROP TABLE tabs; --'];

      // The contract refuses non-UUIDs before a handler runs; this proves the handler would too.
      const handlers = tabHandlers(database());
      const result = handlers['tabs.deleteMany']({ ids: hostile });

      expect(result).toEqual({ count: 0 });
      expect(list(call)).toHaveLength(1);
    });
  });
});
