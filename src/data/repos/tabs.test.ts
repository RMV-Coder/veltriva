import { describe, expect, it } from 'vitest';

import { DATA_METHODS } from '../../shared/contracts/data-rpc';
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

// M2.2a: the session's persistence. `session.save` is the one write the session store makes, and
// `tabs.listClosed` and `tabs.purgeClosed` serve Recently closed and its 7-day retention.
describe('session persistence', () => {
  const database = useTestDatabase();
  const setup = () => {
    const db = database();
    addWorkspace(db);
    return { db, call: callerFor(tabHandlers(db)) };
  };
  const list = (call: ReturnType<typeof setup>['call'], placement: TabRow['placement'] = 'strip') =>
    call('tabs.list', { workspaceId: WORKSPACE_ID, placement, limit: 10_000 }).tabs;
  const listClosed = (call: ReturnType<typeof setup>['call'], limit = 1000) =>
    call('tabs.listClosed', { workspaceId: WORKSPACE_ID, limit }).tabs;
  const ids = (tabs: readonly TabRow[]) => tabs.map((tab) => tab.id);
  /** A closed tab, as the session store writes one. */
  const closedRow = (n: number, closedAt: number, overrides: Partial<TabRow> = {}): TabRow =>
    tabRow(n, {
      placement: 'closed',
      position: 0,
      closedAt,
      placementChangedAt: closedAt,
      ...overrides,
    });
  /** Every app_state document, parsed, by key. */
  const documents = (db: ReturnType<typeof database>): Record<string, unknown> =>
    Object.fromEntries(
      (
        db.prepare('SELECT key, json FROM app_state ORDER BY key').all() as {
          key: string;
          json: string;
        }[]
      ).map(({ key, json }) => [key, JSON.parse(json) as unknown]),
    );
  const WINDOW = { x: 10, y: 20, width: 1200, height: 800, maximized: false };
  const DAY = 24 * 60 * 60 * 1000;

  describe('session.save', () => {
    it('writes rows, deletes ids and writes documents in one call', () => {
      const { db, call } = setup();
      call('tabs.upsertMany', { tabs: [tabRow(1), tabRow(2), tabRow(3)] });

      const result = call('session.save', {
        tabs: [tabRow(2, { title: 'Renamed', position: 5 }), tabRow(4)],
        deleteIds: [testId(101), testId(190)],
        documents: [
          { key: 'session', value: { selectedTabId: testId(104) } },
          { key: 'window', value: WINDOW },
        ],
      });

      // Two rows written and one row deleted; the id that was never there is not counted.
      expect(result).toEqual({ count: 3 });
      expect(list(call).map((tab) => [tab.id, tab.title, tab.position])).toEqual([
        [testId(103), 'Tab 3', 3],
        [testId(104), 'Tab 4', 4],
        [testId(102), 'Renamed', 5],
      ]);
      expect(documents(db)).toEqual({
        session: { selectedTabId: testId(104) },
        window: WINDOW,
      });
    });

    it('does nothing for an empty save', () => {
      const { db, call } = setup();
      call('tabs.upsertMany', { tabs: [tabRow(1)] });

      expect(call('session.save', { tabs: [], deleteIds: [], documents: [] })).toEqual({
        count: 0,
      });

      expect(list(call)).toHaveLength(1);
      expect(documents(db)).toEqual({});
    });

    it('writes documents alone, as JSON text, and replaces one that is there', () => {
      const { db, call } = setup();
      call('session.save', {
        tabs: [],
        deleteIds: [],
        documents: [{ key: 'session', value: { selectedTabId: null } }],
      });

      call('session.save', {
        tabs: [],
        deleteIds: [],
        documents: [{ key: 'session', value: { selectedTabId: testId(105) } }],
      });

      expect(db.prepare('SELECT key, json FROM app_state').all()).toEqual([
        { key: 'session', json: `{"selectedTabId":"${testId(105)}"}` },
      ]);
    });

    it('leaves the other documents alone', () => {
      const { db, call } = setup();
      db.prepare('INSERT INTO app_state (key, json) VALUES (?, ?)').run([
        'client_hints',
        '{"a":1}',
      ]);

      call('session.save', {
        tabs: [],
        deleteIds: [],
        documents: [{ key: 'window', value: WINDOW }],
      });

      expect(documents(db)).toEqual({ client_hints: { a: 1 }, window: WINDOW });
    });

    it('stores rows exactly as tabs.upsertMany does: strip, closed, with a back/forward stack', () => {
      const { call } = setup();
      const strip = tabRow(1, { pinned: true, restoreState: RESTORE_STATE });
      const closed = closedRow(2, T0 + 500, { restoreState: RESTORE_STATE });

      call('session.save', { tabs: [strip, closed], deleteIds: [], documents: [] });

      expect(list(call)).toEqual([strip]);
      expect(list(call, 'closed')).toEqual([closed]);
    });

    it('moves a tab between the strip and Recently closed in place, without duplicating it', () => {
      const { db, call } = setup();
      call('session.save', { tabs: [tabRow(1)], deleteIds: [], documents: [] });

      call('session.save', {
        tabs: [closedRow(1, T0 + 900)],
        deleteIds: [],
        documents: [],
      });
      expect(list(call)).toEqual([]);
      expect(ids(listClosed(call))).toEqual([testId(101)]);

      call('session.save', { tabs: [tabRow(1)], deleteIds: [], documents: [] });
      expect(ids(list(call))).toEqual([testId(101)]);
      expect(listClosed(call)).toEqual([]);
      expect(db.prepare('SELECT count(*) FROM tabs').pluck().get()).toBe(1);
    });

    it('deletes strip and closed rows alike', () => {
      const { call } = setup();
      call('tabs.upsertMany', { tabs: [tabRow(1), tabRow(2), closedRow(3, T0 + 1)] });

      const result = call('session.save', {
        tabs: [],
        deleteIds: [testId(101), testId(103)],
        documents: [],
      });

      expect(result).toEqual({ count: 2 });
      expect(ids(list(call))).toEqual([testId(102)]);
      expect(listClosed(call)).toEqual([]);
    });

    it('writes and deletes a full batch of 1000 each in one call', () => {
      const { call } = setup();
      const old = Array.from({ length: 1000 }, (_, n) => tabRow(n));
      call('tabs.upsertMany', { tabs: old });
      const fresh = Array.from({ length: 1000 }, (_, n) => tabRow(2000 + n));

      const result = call('session.save', {
        tabs: fresh,
        deleteIds: old.map((tab) => tab.id),
        documents: [{ key: 'session', value: { selectedTabId: fresh[0]?.id ?? null } }],
      });

      expect(result).toEqual({ count: 2000 });
      expect(ids(list(call))).toEqual(ids(fresh));
    });

    describe('atomicity', () => {
      it('writes nothing, no document either, when a row among them breaks a CHECK', () => {
        const { db, call } = setup();
        call('tabs.upsertMany', { tabs: [tabRow(1, { title: 'Before' })] });
        call('session.save', {
          tabs: [],
          deleteIds: [],
          documents: [{ key: 'session', value: { selectedTabId: 'before' } }],
        });

        const code = sqliteErrorCode(() =>
          call('session.save', {
            tabs: [tabRow(2), tabRow(3, { placement: 'archive', archivedAt: null }), tabRow(4)],
            deleteIds: [testId(101)],
            documents: [
              { key: 'session', value: { selectedTabId: 'after' } },
              { key: 'window', value: WINDOW },
            ],
          }),
        );

        expect(code).toBe('SQLITE_CONSTRAINT_CHECK');
        // The good rows before the bad one, the deletion and both documents are all undone.
        expect(list(call).map((tab) => [tab.id, tab.title])).toEqual([[testId(101), 'Before']]);
        expect(documents(db)).toEqual({ session: { selectedTabId: 'before' } });
        expect(db.inTransaction).toBe(false);
      });

      it('writes nothing when a row names a workspace that does not exist', () => {
        const { db, call } = setup();

        const code = sqliteErrorCode(() =>
          call('session.save', {
            tabs: [tabRow(1), tabRow(2, { workspaceId: testId(77) })],
            deleteIds: [],
            documents: [{ key: 'session', value: { selectedTabId: null } }],
          }),
        );

        expect(code).toBe('SQLITE_CONSTRAINT_FOREIGNKEY');
        expect(list(call)).toEqual([]);
        expect(documents(db)).toEqual({});
      });

      it('writes nothing when an updated row would break a CHECK, and keeps the old row', () => {
        const { db, call } = setup();
        call('tabs.upsertMany', { tabs: [tabRow(1, { pinned: true })] });

        const code = sqliteErrorCode(() =>
          call('session.save', {
            tabs: [tabRow(1, { pinned: true, placement: 'shelf' })],
            deleteIds: [],
            documents: [{ key: 'window', value: WINDOW }],
          }),
        );

        expect(code).toBe('SQLITE_CONSTRAINT_CHECK');
        expect(list(call)[0]).toMatchObject({ pinned: true, placement: 'strip' });
        expect(documents(db)).toEqual({});
      });

      it('works again after a failed save', () => {
        const { db, call } = setup();
        sqliteErrorCode(() =>
          call('session.save', {
            tabs: [tabRow(1, { placement: 'closed', closedAt: null })],
            deleteIds: [],
            documents: [],
          }),
        );

        const result = call('session.save', {
          tabs: [tabRow(1)],
          deleteIds: [],
          documents: [{ key: 'session', value: { selectedTabId: testId(101) } }],
        });

        expect(result).toEqual({ count: 1 });
        expect(db.inTransaction).toBe(false);
        expect(ids(list(call))).toEqual([testId(101)]);
      });
    });

    describe('the contract', () => {
      const input = DATA_METHODS['session.save'].input;
      const valid = { tabs: [], deleteIds: [], documents: [] };
      const document = (key: string, value: unknown = { a: 1 }) => ({ key, value });

      it('accepts an empty save and a normal one', () => {
        expect(input.safeParse(valid).success).toBe(true);
        expect(
          input.safeParse({
            tabs: [tabRow(1)],
            deleteIds: [testId(102)],
            documents: [document('session'), document('window')],
          }).success,
        ).toBe(true);
      });

      it('refuses the reserved key maintenance, which belongs to the data worker', () => {
        const { db, call } = setup();
        const save = {
          ...valid,
          documents: [{ key: 'maintenance', value: { lastBackupAt: 1 } }],
        };

        expect(input.safeParse(save).success).toBe(false);
        expect(() => call('session.save', save)).toThrow();
        expect(documents(db)).toEqual({});
      });

      it('refuses a save with the reserved key among good documents', () => {
        const save = {
          ...valid,
          documents: [document('session'), document('maintenance'), document('window')],
        };

        expect(input.safeParse(save).success).toBe(false);
      });

      it.each([
        ['an upper-case key', 'Session'],
        ['a key that starts with a digit', '1session'],
        ['an empty key', ''],
        ['a key with a space', 'my session'],
        ['a key with a slash', 'a/b'],
        ['a key with a dash', 'my-session'],
        ['a key of 65 characters', `a${'b'.repeat(64)}`],
      ])('refuses %s', (_name, key) => {
        expect(input.safeParse({ ...valid, documents: [document(key)] }).success).toBe(false);
      });

      it('accepts a key of 64 characters, and dots and underscores', () => {
        expect(
          input.safeParse({
            ...valid,
            documents: [document(`a${'b'.repeat(63)}`), document('client_hints.v2')],
          }).success,
        ).toBe(true);
      });

      it('allows at most 4 documents', () => {
        const four = ['a', 'b', 'c', 'd'].map((key) => document(key));

        expect(input.safeParse({ ...valid, documents: four }).success).toBe(true);
        expect(input.safeParse({ ...valid, documents: [...four, document('e')] }).success).toBe(
          false,
        );
      });

      it('refuses a null document, which would read back as a missing one', () => {
        expect(input.safeParse({ ...valid, documents: [document('session', null)] }).success).toBe(
          false,
        );
      });

      it('refuses a document over a million characters, and accepts one just under', () => {
        // JSON.stringify adds the two quotes of a string.
        const under = 'x'.repeat(1_048_576 - 2);
        const over = 'x'.repeat(1_048_576 - 1);

        expect(input.safeParse({ ...valid, documents: [document('big', under)] }).success).toBe(
          true,
        );
        expect(input.safeParse({ ...valid, documents: [document('big', over)] }).success).toBe(
          false,
        );
      });

      it('allows at most 1000 rows and 1000 deletions', () => {
        const rows = (count: number) => Array.from({ length: count }, (_, n) => tabRow(n));
        const deletions = (count: number) =>
          Array.from({ length: count }, (_, n) => testId(5000 + n));

        expect(input.safeParse({ ...valid, tabs: rows(1000) }).success).toBe(true);
        expect(input.safeParse({ ...valid, tabs: rows(1001) }).success).toBe(false);
        expect(input.safeParse({ ...valid, deleteIds: deletions(1000) }).success).toBe(true);
        expect(input.safeParse({ ...valid, deleteIds: deletions(1001) }).success).toBe(false);
      });

      it('refuses ids that are not UUIDv7, and unknown or missing fields', () => {
        expect(input.safeParse({ ...valid, deleteIds: ['not-a-uuid'] }).success).toBe(false);
        expect(input.safeParse({ ...valid, deleteIds: ["x') OR 1=1 --"] }).success).toBe(false);
        expect(input.safeParse({ ...valid, extra: true }).success).toBe(false);
        expect(input.safeParse({ tabs: [], deleteIds: [] }).success).toBe(false);
      });

      it('refuses a row that is not a tab row', () => {
        const withTab = (tab: unknown) => input.safeParse({ ...valid, tabs: [tab] }).success;

        expect(withTab({ ...tabRow(1), placement: 'nowhere' })).toBe(false);
        expect(withTab({ ...tabRow(1), url: '' })).toBe(false);
        expect(
          withTab({
            ...tabRow(1),
            restoreState: { v: 1, index: 3, entries: RESTORE_STATE.entries },
          }),
        ).toBe(false);
      });

      it('refuses a restore stack of more than 50 entries', () => {
        const entries = Array.from({ length: 51 }, (_, n) => ({
          url: `https://example.com/${String(n)}`,
          title: '',
        }));
        const withEntries = (list: typeof entries) =>
          input.safeParse({
            ...valid,
            tabs: [tabRow(1, { restoreState: { v: 1, index: 0, entries: list } })],
          }).success;

        expect(withEntries(entries)).toBe(false);
        expect(withEntries(entries.slice(0, 50))).toBe(true);
      });
    });
  });

  describe('tabs.listClosed', () => {
    it('is empty when no tab was closed', () => {
      const { call } = setup();
      call('tabs.upsertMany', { tabs: [tabRow(1)] });

      expect(listClosed(call)).toEqual([]);
    });

    it('lists closed tabs newest first, by closedAt', () => {
      const { call } = setup();
      call('tabs.upsertMany', {
        tabs: [closedRow(1, T0 + 100), closedRow(2, T0 + 300), closedRow(3, T0 + 200)],
      });

      expect(ids(listClosed(call))).toEqual([testId(102), testId(103), testId(101)]);
    });

    it('orders tabs closed at the same moment by id, the newest id first', () => {
      const { call } = setup();
      call('tabs.upsertMany', {
        tabs: [closedRow(1, T0 + 100), closedRow(3, T0 + 100), closedRow(2, T0 + 100)],
      });

      expect(ids(listClosed(call))).toEqual([testId(103), testId(102), testId(101)]);
    });

    it('lists only closed tabs: not the strip, the shelf or the archive', () => {
      const { call } = setup();
      call('tabs.upsertMany', {
        tabs: [
          tabRow(1),
          tabRow(2, { placement: 'shelf' }),
          tabRow(3, { placement: 'archive', archivedAt: T0 + 1, archiveReason: 'auto' }),
          // A strip tab that carries a stale closedAt is still a strip tab.
          tabRow(4, { closedAt: T0 + 50 }),
          closedRow(5, T0 + 100),
        ],
      });

      expect(ids(listClosed(call))).toEqual([testId(105)]);
    });

    it('lists only the workspace asked for', () => {
      const { db, call } = setup();
      addWorkspace(db, OTHER_WORKSPACE);
      call('tabs.upsertMany', {
        tabs: [closedRow(1, T0 + 100), closedRow(2, T0 + 200, { workspaceId: OTHER_WORKSPACE })],
      });

      expect(ids(listClosed(call))).toEqual([testId(101)]);
      expect(
        ids(call('tabs.listClosed', { workspaceId: OTHER_WORKSPACE, limit: 10 }).tabs),
      ).toEqual([testId(102)]);
    });

    it('honours the limit and keeps the newest', () => {
      const { call } = setup();
      call('tabs.upsertMany', {
        tabs: [1, 2, 3, 4, 5].map((n) => closedRow(n, T0 + n * 100)),
      });

      expect(ids(listClosed(call, 2))).toEqual([testId(105), testId(104)]);
      expect(listClosed(call, 1)).toHaveLength(1);
      expect(listClosed(call, 1000)).toHaveLength(5);
    });

    it('returns the whole row, with the back/forward stack as an object', () => {
      const { call } = setup();
      const closed = closedRow(1, T0 + 100, { restoreState: RESTORE_STATE, title: 'Gone' });
      call('tabs.upsertMany', { tabs: [closed] });

      expect(listClosed(call)).toEqual([closed]);
    });

    it('returns a stack that fails the schema as null, not an error', () => {
      const { db, call } = setup();
      call('tabs.upsertMany', { tabs: [closedRow(1, T0 + 100, { restoreState: RESTORE_STATE })] });
      db.prepare('UPDATE tabs SET restore_state = ?').run(['{"v":9}']);

      expect(listClosed(call)[0]?.restoreState).toBeNull();
    });

    it('refuses a limit of 0, one over 1000, and one that is not a whole number', () => {
      const input = DATA_METHODS['tabs.listClosed'].input;

      expect(input.safeParse({ workspaceId: WORKSPACE_ID, limit: 0 }).success).toBe(false);
      expect(input.safeParse({ workspaceId: WORKSPACE_ID, limit: 1001 }).success).toBe(false);
      expect(input.safeParse({ workspaceId: WORKSPACE_ID, limit: 1.5 }).success).toBe(false);
      expect(input.safeParse({ workspaceId: WORKSPACE_ID, limit: 1000 }).success).toBe(true);
    });
  });

  describe('tabs.purgeClosed', () => {
    it('deletes closed tabs closed before the time, and keeps the others', () => {
      const { call } = setup();
      call('tabs.upsertMany', {
        tabs: [closedRow(1, T0 + 100), closedRow(2, T0 + 200), closedRow(3, T0 + 300)],
      });

      const result = call('tabs.purgeClosed', { before: T0 + 250, limit: 1000 });

      expect(result).toEqual({ count: 2 });
      expect(ids(listClosed(call))).toEqual([testId(103)]);
    });

    it('keeps a tab closed exactly at the time: before means strictly before', () => {
      const { call } = setup();
      call('tabs.upsertMany', { tabs: [closedRow(1, T0 + 100), closedRow(2, T0 + 101)] });

      expect(call('tabs.purgeClosed', { before: T0 + 100, limit: 10 })).toEqual({ count: 0 });
      expect(call('tabs.purgeClosed', { before: T0 + 101, limit: 10 })).toEqual({ count: 1 });
      expect(ids(listClosed(call))).toEqual([testId(102)]);
    });

    it('counts 0 when nothing is old enough, or nothing is closed', () => {
      const { call } = setup();
      expect(call('tabs.purgeClosed', { before: T0 + 1_000_000, limit: 10 })).toEqual({ count: 0 });

      call('tabs.upsertMany', { tabs: [closedRow(1, T0 + 100)] });

      expect(call('tabs.purgeClosed', { before: T0, limit: 10 })).toEqual({ count: 0 });
      expect(listClosed(call)).toHaveLength(1);
    });

    it('leaves strip, shelf and archive tabs alone, whatever their closedAt', () => {
      const { call } = setup();
      call('tabs.upsertMany', {
        tabs: [
          tabRow(1, { closedAt: T0 + 1 }),
          tabRow(2, { placement: 'shelf', closedAt: T0 + 1 }),
          tabRow(3, {
            placement: 'archive',
            archivedAt: T0 + 1,
            archiveReason: 'manual',
            closedAt: T0 + 1,
          }),
          tabRow(4),
          closedRow(5, T0 + 1),
        ],
      });

      const result = call('tabs.purgeClosed', { before: T0 + 1_000_000, limit: 1000 });

      expect(result).toEqual({ count: 1 });
      expect(ids(list(call))).toEqual([testId(101), testId(104)]);
      expect(ids(list(call, 'shelf'))).toEqual([testId(102)]);
      expect(ids(list(call, 'archive'))).toEqual([testId(103)]);
    });

    it('deletes at most `limit` tabs, the oldest first', () => {
      const { call } = setup();
      call('tabs.upsertMany', {
        tabs: [
          closedRow(1, T0 + 500),
          closedRow(2, T0 + 100),
          closedRow(3, T0 + 400),
          closedRow(4, T0 + 200),
          closedRow(5, T0 + 300),
        ],
      });

      const result = call('tabs.purgeClosed', { before: T0 + 1000, limit: 2 });

      expect(result).toEqual({ count: 2 });
      // The two oldest (100, 200) went; the three newest stay, newest first.
      expect(ids(listClosed(call))).toEqual([testId(101), testId(103), testId(105)]);
    });

    it('can be repeated until nothing is left', () => {
      const { call } = setup();
      call('tabs.upsertMany', {
        tabs: Array.from({ length: 7 }, (_, n) => closedRow(n, T0 + n)),
      });

      const counts: number[] = [];
      for (let round = 0; round < 5; round += 1) {
        counts.push(call('tabs.purgeClosed', { before: T0 + 100, limit: 3 }).count);
      }

      expect(counts).toEqual([3, 3, 1, 0, 0]);
      expect(listClosed(call)).toEqual([]);
    });

    it('purges the closed tabs of every workspace', () => {
      const { db, call } = setup();
      addWorkspace(db, OTHER_WORKSPACE);
      call('tabs.upsertMany', {
        tabs: [closedRow(1, T0 + 1), closedRow(2, T0 + 1, { workspaceId: OTHER_WORKSPACE })],
      });

      expect(call('tabs.purgeClosed', { before: T0 + 100, limit: 10 })).toEqual({ count: 2 });
    });

    it('does not touch app_state or the workspace', () => {
      const { db, call } = setup();
      call('session.save', {
        tabs: [closedRow(1, T0 + 1)],
        deleteIds: [],
        documents: [{ key: 'session', value: { selectedTabId: null } }],
      });

      call('tabs.purgeClosed', { before: T0 + 100, limit: 10 });

      expect(documents(db)).toEqual({ session: { selectedTabId: null } });
      expect(db.prepare('SELECT count(*) FROM workspaces').pluck().get()).toBe(1);
    });

    it('refuses a limit of 0 or over 1000, and a time that is not a whole non-negative number', () => {
      const input = DATA_METHODS['tabs.purgeClosed'].input;

      expect(input.safeParse({ before: T0, limit: 0 }).success).toBe(false);
      expect(input.safeParse({ before: T0, limit: 1001 }).success).toBe(false);
      expect(input.safeParse({ before: -1, limit: 10 }).success).toBe(false);
      expect(input.safeParse({ before: 1.5, limit: 10 }).success).toBe(false);
      expect(input.safeParse({ before: 0, limit: 1000 }).success).toBe(true);
    });
  });

  describe('a session through all three', () => {
    it('saves the strip and Recently closed, then purges what is older than 7 days', () => {
      const { db, call } = setup();
      const now = T0 + 30 * DAY;
      call('session.save', {
        tabs: [
          tabRow(1, { pinned: true }),
          tabRow(2, { position: 1, restoreState: RESTORE_STATE }),
          closedRow(3, now - 8 * DAY),
          closedRow(4, now - 7 * DAY + 1000),
          closedRow(5, now - 1000),
        ],
        deleteIds: [],
        documents: [
          { key: 'session', value: { selectedTabId: testId(102) } },
          { key: 'window', value: WINDOW },
        ],
      });

      const purged = call('tabs.purgeClosed', { before: now - 7 * DAY, limit: 1000 });

      expect(purged).toEqual({ count: 1 });
      expect(ids(list(call))).toEqual([testId(101), testId(102)]);
      expect(ids(listClosed(call))).toEqual([testId(105), testId(104)]);
      expect(documents(db)).toEqual({
        session: { selectedTabId: testId(102) },
        window: WINDOW,
      });
    });
  });
});
