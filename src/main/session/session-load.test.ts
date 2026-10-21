import { describe, expect, it } from 'vitest';

import { uuidv7 } from '../../core/id/uuidv7';
import { DATA_METHODS } from '../../shared/contracts/data-rpc';
import type {
  AppRunRow,
  DataInput,
  DataMethod,
  DataOutput,
  TabRow,
} from '../../shared/contracts/data-rpc';
import { DataClientError } from '../persistence/data-client';
import { CLOSED_TAB_RETENTION_MS, CLOSED_TABS_LOADED, loadSession } from './session-load';
import { SESSION_DOCUMENT, WINDOW_DOCUMENT } from './session-store';

const NOW = Date.UTC(2026, 9, 21, 12);
const T0 = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const id = (n: number): string => uuidv7(T0 + n, new Uint8Array(10).fill(n % 256));
const WORKSPACE = id(900);
const CANDIDATE = id(901);
const CURRENT_RUN = 7;

function row(n: number, overrides: Partial<TabRow> = {}): TabRow {
  return {
    id: id(n),
    workspaceId: WORKSPACE,
    placement: 'strip',
    position: n,
    pinned: false,
    userProtected: false,
    pageId: null,
    url: `https://site${String(n)}.example/`,
    title: `Tab ${String(n)}`,
    faviconId: null,
    restoreState: null,
    openerTabId: null,
    createdAt: T0 + n,
    lastUsedAt: T0 + n + 10,
    lastUsedEngaged: 0,
    lastUsedActiveDay: 0,
    placementChangedAt: T0 + n,
    archivedAt: null,
    archiveReason: null,
    closedAt: null,
    ...overrides,
  };
}

function closedRow(n: number, closedAt: number, overrides: Partial<TabRow> = {}): TabRow {
  return row(n, { placement: 'closed', closedAt, ...overrides });
}

function run(runId: number, overrides: Partial<AppRunRow> = {}): AppRunRow {
  return {
    id: runId,
    startedAt: T0,
    lastHeartbeatAt: T0 + 60_000,
    endedAt: T0 + 60_000,
    exitKind: 'clean',
    appVersion: '0.0.0',
    ...overrides,
  };
}

/** The data worker, as far as loading goes: serves what the test set, and checks every input. */
class FakeData {
  readonly calls: { method: DataMethod; input: unknown }[] = [];
  workspaceId = WORKSPACE;
  strip: TabRow[] = [];
  closedRows: TabRow[] = [];
  documents = new Map<string, unknown>();
  runs: AppRunRow[] = [run(CURRENT_RUN, { endedAt: null, exitKind: null })];
  /** Makes the call of this method fail. */
  failing: { method: DataMethod; error: unknown } | null = null;

  async call<M extends DataMethod>(method: M, input: DataInput<M>): Promise<DataOutput<M>> {
    this.calls.push({ method, input });
    // The real client refuses input its contract refuses.
    const parsed = DATA_METHODS[method].input.parse(input) as Record<string, unknown>;
    if (this.failing?.method === method) {
      throw this.failing.error;
    }
    await Promise.resolve();
    return this.answer(method, parsed) as DataOutput<M>;
  }

  methods(): DataMethod[] {
    return this.calls.map((call) => call.method);
  }

  inputOf<M extends DataMethod>(method: M): DataInput<M> {
    const found = this.calls.find((call) => call.method === method);
    if (found === undefined) {
      throw new Error(`${method} was not called`);
    }
    return found.input as DataInput<M>;
  }

  private answer(method: DataMethod, input: Record<string, unknown>): unknown {
    switch (method) {
      case 'workspaces.ensureDefault':
        return { id: this.workspaceId, created: false };
      case 'tabs.purgeClosed':
        return { count: 0 };
      case 'tabs.list':
        return { tabs: this.strip };
      case 'tabs.listClosed':
        return { tabs: this.closedRows };
      case 'appState.get':
        return { value: this.documents.get(String(input.key)) ?? null };
      case 'appRuns.recent':
        return { runs: this.runs };
      default:
        throw new Error(`unexpected call to ${method}`);
    }
  }
}

function load(data: FakeData, overrides: { now?: number; runId?: number } = {}) {
  return loadSession(data, {
    newWorkspaceId: CANDIDATE,
    now: NOW,
    runId: CURRENT_RUN,
    ...overrides,
  });
}

describe('loadSession', () => {
  describe('what it asks the database', () => {
    it('makes sure the default workspace exists, with the candidate id, the name and the time', async () => {
      const data = new FakeData();

      await load(data);

      expect(data.inputOf('workspaces.ensureDefault')).toEqual({
        candidateId: CANDIDATE,
        name: 'Default',
        now: NOW,
      });
    });

    it('purges closed tabs older than 7 days, as of now', async () => {
      const data = new FakeData();

      await load(data);

      expect(CLOSED_TAB_RETENTION_MS).toBe(7 * DAY);
      expect(data.inputOf('tabs.purgeClosed')).toEqual({ before: NOW - 7 * DAY, limit: 1000 });
    });

    it('does not purge before time zero', async () => {
      const data = new FakeData();

      await load(data, { now: 1000 });

      expect(data.inputOf('tabs.purgeClosed')).toEqual({ before: 0, limit: 1000 });
    });

    it('asks first for the workspace, then purges, and only then reads', async () => {
      const data = new FakeData();

      await load(data);

      expect(data.methods().slice(0, 2)).toEqual(['workspaces.ensureDefault', 'tabs.purgeClosed']);
      expect(data.methods().slice(2).sort()).toEqual([
        'appRuns.recent',
        'appState.get',
        'appState.get',
        'tabs.list',
        'tabs.listClosed',
      ]);
    });

    it("lists the workspace's strip, its newest closed tabs, both documents and the last runs", async () => {
      const data = new FakeData();
      data.workspaceId = id(950);

      await load(data);

      expect(data.inputOf('tabs.list')).toEqual({
        workspaceId: id(950),
        placement: 'strip',
        limit: 10_000,
      });
      expect(data.inputOf('tabs.listClosed')).toEqual({
        workspaceId: id(950),
        limit: CLOSED_TABS_LOADED,
      });
      expect(CLOSED_TABS_LOADED).toBe(100);
      const documents = data.calls
        .filter((call) => call.method === 'appState.get')
        .map((call) => (call.input as { key: string }).key);
      expect(documents.sort()).toEqual([SESSION_DOCUMENT, WINDOW_DOCUMENT].sort());
      expect(data.inputOf('appRuns.recent')).toEqual({ limit: 3 });
    });

    it('returns the workspace id the database gave, not the candidate', async () => {
      const data = new FakeData();
      data.workspaceId = id(950);

      expect((await load(data)).workspaceId).toBe(id(950));
    });
  });

  describe('tabs', () => {
    it('maps strip rows to session tabs, in the order the database gave', async () => {
      const data = new FakeData();
      data.strip = [
        row(1, {
          pinned: true,
          url: 'https://one.example/',
          title: 'One',
          createdAt: 11,
          lastUsedAt: 22,
        }),
        row(2),
      ];

      const { tabs } = await load(data);

      expect(tabs).toEqual([
        {
          id: id(1),
          pinned: true,
          url: 'https://one.example/',
          title: 'One',
          history: null,
          createdAt: 11,
          lastUsedAt: 22,
        },
        {
          id: id(2),
          pinned: false,
          url: 'https://site2.example/',
          title: 'Tab 2',
          history: null,
          createdAt: T0 + 2,
          lastUsedAt: T0 + 12,
        },
      ]);
    });

    it('is empty when the database has no tabs (a first start)', async () => {
      const session = await load(new FakeData());

      expect(session.tabs).toEqual([]);
      expect(session.closed).toEqual([]);
      expect(session.rows).toEqual([]);
      expect(session.selectedTabId).toBeNull();
      expect(session.window).toBeNull();
    });

    it('passes the stored back/forward stack on as the tab history', async () => {
      const data = new FakeData();
      data.strip = [
        row(1, {
          restoreState: {
            v: 1,
            index: 1,
            entries: [
              { url: 'https://site1.example/a', title: 'A' },
              { url: 'https://site1.example/b', title: 'B' },
            ],
          },
        }),
      ];

      const { tabs } = await load(data);

      expect(tabs[0]?.history).toEqual({
        index: 1,
        entries: [
          { url: 'https://site1.example/a', title: 'A' },
          { url: 'https://site1.example/b', title: 'B' },
        ],
      });
    });

    describe('sanitizing a history again, because the database is not trusted', () => {
      const withEntries = (index: number, urls: string[]): TabRow =>
        row(1, {
          restoreState: {
            v: 1,
            index,
            entries: urls.map((url, n) => ({ url, title: `Entry ${String(n)}` })),
          },
        });

      it('drops an entry that a tab must not restore, and keeps the rest', async () => {
        const data = new FakeData();
        data.strip = [
          withEntries(2, [
            'https://site1.example/a',
            'javascript:alert(1)',
            'https://site1.example/c',
          ]),
        ];

        const history = (await load(data)).tabs[0]?.history;

        expect(history?.entries.map((entry) => entry.url)).toEqual([
          'https://site1.example/a',
          'https://site1.example/c',
        ]);
        expect(history?.index).toBe(1);
      });

      it('moves the active entry to the nearest earlier one when that is the one dropped', async () => {
        const data = new FakeData();
        data.strip = [
          withEntries(1, [
            'https://site1.example/a',
            'veltriva://settings',
            'https://site1.example/c',
          ]),
        ];

        const history = (await load(data)).tabs[0]?.history;

        expect(history?.index).toBe(0);
        expect(history?.entries[history.index]?.url).toBe('https://site1.example/a');
      });

      it.each(['data:text/html,x', 'about:blank', 'chrome://settings', 'blob:https://a.example/1'])(
        'drops %s',
        async (url) => {
          const data = new FakeData();
          data.strip = [withEntries(0, ['https://site1.example/a', url])];

          const history = (await load(data)).tabs[0]?.history;

          expect(history?.entries).toHaveLength(1);
        },
      );

      it('removes credentials and token fragments from entries', async () => {
        const data = new FakeData();
        data.strip = [
          withEntries(1, [
            'https://user:SECRET@site1.example/a',
            'https://site1.example/b#access_token=SECRET',
          ]),
        ];

        const history = (await load(data)).tabs[0]?.history;

        expect(history?.entries.map((entry) => entry.url)).toEqual([
          'https://site1.example/a',
          'https://site1.example/b',
        ]);
      });

      it('gives a tab no history when none of its entries is usable, and keeps the tab', async () => {
        const data = new FakeData();
        data.strip = [withEntries(0, ['javascript:alert(1)', 'about:blank'])];

        const { tabs } = await load(data);

        expect(tabs).toHaveLength(1);
        expect(tabs[0]).toMatchObject({ id: id(1), url: 'https://site1.example/', history: null });
      });

      it('does the same for a closed tab', async () => {
        const data = new FakeData();
        data.closedRows = [
          closedRow(2, T0, {
            restoreState: {
              v: 1,
              index: 0,
              entries: [
                { url: 'javascript:alert(1)', title: '' },
                { url: 'https://site2.example/', title: 'Two' },
              ],
            },
          }),
        ];

        const { closed } = await load(data);

        expect(closed[0]?.history).toEqual({
          index: 0,
          entries: [{ url: 'https://site2.example/', title: 'Two' }],
        });
      });
    });
  });

  describe('closed tabs', () => {
    it('maps closed rows to closed tabs, newest first as the database gave them', async () => {
      const data = new FakeData();
      data.closedRows = [
        closedRow(3, T0 + 300, { pinned: false, title: 'Newest' }),
        closedRow(2, T0 + 200),
      ];

      const { closed } = await load(data);

      expect(closed).toEqual([
        {
          id: id(3),
          pinned: false,
          url: 'https://site3.example/',
          title: 'Newest',
          history: null,
          createdAt: T0 + 3,
          lastUsedAt: T0 + 13,
          closedAt: T0 + 300,
          index: 0,
        },
        expect.objectContaining({ id: id(2), closedAt: T0 + 200, index: 0 }),
      ]);
    });

    it('leaves out a closed row that has no closedAt, which the schema should not allow', async () => {
      const data = new FakeData();
      data.closedRows = [closedRow(2, T0), row(3, { placement: 'closed', closedAt: null })];

      const { closed } = await load(data);

      expect(closed.map((tab) => tab.id)).toEqual([id(2)]);
    });
  });

  describe('rows', () => {
    it('holds every row read, strip first, for the session store', async () => {
      const data = new FakeData();
      data.strip = [row(1), row(2)];
      data.closedRows = [closedRow(3, T0), closedRow(4, T0 - 1)];

      const { rows } = await load(data);

      expect(rows).toEqual([...data.strip, ...data.closedRows]);
    });

    it('holds the rows as stored, not as sanitized', async () => {
      const data = new FakeData();
      const stored = row(1, {
        restoreState: {
          v: 1,
          index: 0,
          entries: [
            { url: 'javascript:alert(1)', title: '' },
            { url: 'https://site1.example/', title: '' },
          ],
        },
      });
      data.strip = [stored];

      const { rows } = await load(data);

      // So the first flush sees that the database differs from the clean session and rewrites it.
      expect(rows).toEqual([stored]);
    });
  });

  describe('the selected tab', () => {
    const selectedWith = async (value: unknown): Promise<string | null> => {
      const data = new FakeData();
      if (value !== undefined) {
        data.documents.set(SESSION_DOCUMENT, value);
      }
      return (await load(data)).selectedTabId;
    };

    it('is the selectedTabId of the session document', async () => {
      expect(await selectedWith({ selectedTabId: id(5) })).toBe(id(5));
    });

    it('is null when there is no session document', async () => {
      expect(await selectedWith(undefined)).toBeNull();
    });

    it('is null when the document says no tab was selected', async () => {
      expect(await selectedWith({ selectedTabId: null })).toBeNull();
    });

    it.each([
      ['a string', 'some-tab'],
      ['an empty string', ''],
      ['an id that is not a UUID', 'not-a-uuid'],
      ['a UUID of another version', '3f2504e0-4f89-41d3-9a0c-0305e82c3301'],
      ['an upper-case UUID', id(5).toUpperCase()],
      ['a UUID with something around it', ` ${id(5)} `],
      ['a number', 12],
      ['an object', { id: id(5) }],
      ['an array', [id(5)]],
      ['a boolean', true],
    ])('is null when selectedTabId is %s', async (_name, selectedTabId) => {
      expect(await selectedWith({ selectedTabId })).toBeNull();
    });

    it.each([
      ['a string', 'selected'],
      ['a number', 5],
      ['an array', [id(5)]],
      ['true', true],
      ['an empty object', {}],
    ])('is null when the document is %s', async (_name, document) => {
      expect(await selectedWith(document)).toBeNull();
    });

    it('does not check that the tab exists: restoreSession falls back to the first tab', async () => {
      const data = new FakeData();
      data.strip = [row(1)];
      data.documents.set(SESSION_DOCUMENT, { selectedTabId: id(77) });

      expect((await load(data)).selectedTabId).toBe(id(77));
    });
  });

  describe('the window', () => {
    it('is the window document when it is well formed', async () => {
      const data = new FakeData();
      data.documents.set(WINDOW_DOCUMENT, {
        x: -1800,
        y: 100,
        width: 1200,
        height: 800,
        maximized: true,
      });

      expect((await load(data)).window).toEqual({
        x: -1800,
        y: 100,
        width: 1200,
        height: 800,
        maximized: true,
      });
    });

    it.each([
      ['missing', undefined],
      ['not an object', 'window'],
      ['missing a field', { x: 0, y: 0, width: 100, height: 100 }],
      ['fractional', { x: 0.5, y: 0, width: 100, height: 100, maximized: false }],
      ['huge', { x: 0, y: 0, width: 1e9, height: 100, maximized: false }],
      ['an array', [0, 0, 100, 100, false]],
    ])('is null when the document is %s', async (_name, document) => {
      const data = new FakeData();
      if (document !== undefined) {
        data.documents.set(WINDOW_DOCUMENT, document);
      }

      expect((await load(data)).window).toBeNull();
    });
  });

  describe('previous runs', () => {
    it('leaves out the current run and maps the fields crash-loop detection needs', async () => {
      const data = new FakeData();
      data.runs = [
        run(CURRENT_RUN, { startedAt: T0 + 3000, endedAt: null, exitKind: null }),
        run(6, { startedAt: T0 + 2000, endedAt: T0 + 2500, exitKind: 'crash' }),
        run(5, { startedAt: T0 + 1000, endedAt: T0 + 1900, exitKind: 'clean' }),
      ];

      const { previousRuns } = await load(data);

      expect(previousRuns).toEqual([
        { startedAt: T0 + 2000, endedAt: T0 + 2500, exitKind: 'crash' },
        { startedAt: T0 + 1000, endedAt: T0 + 1900, exitKind: 'clean' },
      ]);
    });

    it('keeps the order, newest first, and the nulls of a run that never ended', async () => {
      const data = new FakeData();
      data.runs = [
        run(CURRENT_RUN),
        run(6, { startedAt: T0 + 2, endedAt: null, exitKind: null }),
        run(5, { startedAt: T0 + 1 }),
      ];

      const { previousRuns } = await load(data);

      expect(previousRuns.map((entry) => entry.startedAt)).toEqual([T0 + 2, T0 + 1]);
      expect(previousRuns[0]).toEqual({ startedAt: T0 + 2, endedAt: null, exitKind: null });
    });

    it('has only the three newest runs to start from, so two previous ones at most', async () => {
      const data = new FakeData();
      data.runs = [run(CURRENT_RUN), run(6), run(5)];

      expect((await load(data)).previousRuns).toHaveLength(2);
    });

    it('is empty on a first start, when the only run is this one', async () => {
      const data = new FakeData();
      data.runs = [run(CURRENT_RUN)];

      expect((await load(data)).previousRuns).toEqual([]);
    });

    it('keeps every run when the current one is not listed', async () => {
      const data = new FakeData();
      data.runs = [run(6), run(5), run(4)];

      expect((await load(data)).previousRuns).toHaveLength(3);
    });

    it('uses the run id it was given', async () => {
      const data = new FakeData();
      data.runs = [run(9), run(8), run(7)];

      const { previousRuns } = await load(data, { runId: 9 });

      expect(previousRuns).toHaveLength(2);
    });

    it('carries no run id, heartbeat or version on', async () => {
      const data = new FakeData();
      data.runs = [run(CURRENT_RUN), run(6)];

      const [previous] = (await load(data)).previousRuns;

      expect(Object.keys(previous ?? {}).sort()).toEqual(['endedAt', 'exitKind', 'startedAt']);
    });
  });

  describe('when the database fails', () => {
    it.each([
      'workspaces.ensureDefault',
      'tabs.purgeClosed',
      'tabs.list',
      'tabs.listClosed',
      'appState.get',
      'appRuns.recent',
    ] as const)('rejects with the error when %s fails', async (method) => {
      const data = new FakeData();
      data.failing = { method, error: new DataClientError('timeout', method) };

      await expect(load(data)).rejects.toMatchObject({ name: 'DataClientError', code: 'timeout' });
    });

    it('does not read anything once the workspace could not be made', async () => {
      const data = new FakeData();
      data.failing = {
        method: 'workspaces.ensureDefault',
        error: new DataClientError('worker_gone'),
      };

      await expect(load(data)).rejects.toThrow();

      expect(data.methods()).toEqual(['workspaces.ensureDefault']);
    });
  });
});
