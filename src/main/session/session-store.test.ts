import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { uuidv7 } from '../../core/id/uuidv7';
import type { SavedWindow } from '../../core/layout/window-bounds';
import type { TabHistory } from '../../core/session/history';
import { DATA_METHODS, MAX_BATCH, tabRowSchema } from '../../shared/contracts/data-rpc';
import type { DataInput, TabRow } from '../../shared/contracts/data-rpc';
import { DataClientError } from '../persistence/data-client';
import type { DataClient } from '../persistence/data-client';
import type { Logger } from '../platform/logger';
import type {
  ClosedTab,
  SessionTab,
  TabId,
  TabRuntime,
  TabRuntimeEvents,
} from '../tabs/tab-manager';
import { SESSION_NEW_TAB_URL, TabManager } from '../tabs/tab-manager';
import { loadSession } from './session-load';
import {
  FLUSH_DELAY_MS,
  SESSION_DOCUMENT,
  STRUCTURAL_FLUSH_DELAY_MS,
  SessionStore,
  WINDOW_DOCUMENT,
} from './session-store';
import type { SessionSource } from './session-store';

const NOW = Date.UTC(2026, 9, 21, 12);
const T0 = 1_700_000_000_000;
const WORKSPACE = uuidv7(T0 - 5000, new Uint8Array(10).fill(7));

/** A UUIDv7 for tab `n`, as the app makes them: valid, unique and sorted by `n`. */
const id = (n: number): TabId => uuidv7(T0 + n, new Uint8Array(10).fill(n % 256));

type Save = DataInput<'session.save'>;

function tab(n: number, overrides: Partial<SessionTab> = {}): SessionTab {
  const url = `https://site${String(n)}.example/`;
  return {
    id: id(n),
    pinned: false,
    url,
    title: `Tab ${String(n)}`,
    history: { index: 0, entries: [{ url, title: `Tab ${String(n)}` }] },
    createdAt: T0,
    lastUsedAt: T0 + 10,
    // Day 1 is the engagement clock's first (M3.2); Phase 2 rows held 0, rewritten once.
    lastUsedActiveDay: 1,
    ...overrides,
  };
}

function closed(n: number, overrides: Partial<ClosedTab> = {}): ClosedTab {
  return { ...tab(n), closedAt: T0 + 5000, index: 0, ...overrides };
}

/** What TabManager is to the store: whatever the test sets. */
class FakeSource implements SessionSource {
  strip: SessionTab[] = [];
  closed: ClosedTab[] = [];

  selected: TabId | null = null;
  /** How often the (costly) full read of the strip was asked for. */
  sessionTabsReads = 0;
  /** When set, reading the strip's rows throws it, as a bug in TabManager would. */
  readError: Error | null = null;

  tabs(): readonly { id: TabId; pinned: boolean }[] {
    return this.strip;
  }
  sessionTabs(): readonly SessionTab[] {
    this.sessionTabsReads += 1;
    if (this.readError !== null) {
      throw this.readError;
    }
    return this.strip;
  }
  closedTabs(): readonly ClosedTab[] {
    return this.closed;
  }
  selectedTabId(): TabId | null {
    return this.selected;
  }
}

/** The data client's `call`, recording each one; `failures` are thrown by the next calls in turn. */
class FakeData {
  readonly calls: { method: string; input: unknown }[] = [];
  /** Thrown by the next calls, one each; `undefined` lets that call succeed. */
  failures: (Error | undefined)[] = [];
  /** When set, each call waits for it first (to hold a write in flight). */
  gate: Promise<void> | null = null;
  inFlight = 0;
  maxInFlight = 0;
  /** What the contract said about each session.save input it refused. */
  readonly contractViolations: string[] = [];

  async call(method: string, input: unknown): Promise<unknown> {
    this.calls.push({ method, input });
    if (method === 'session.save') {
      const parsed = DATA_METHODS['session.save'].input.safeParse(input);
      if (!parsed.success) {
        this.contractViolations.push(parsed.error.message);
      }
    }
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.gate !== null) {
        await this.gate;
      }
      const failure = this.failures.shift();
      if (failure !== undefined) {
        throw failure;
      }
      return { count: 0 };
    } finally {
      this.inFlight -= 1;
    }
  }

  get saves(): Save[] {
    return this.calls
      .filter((call) => call.method === 'session.save')
      .map((call) => call.input as Save);
  }
}

function recordingLogger() {
  const events: { level: 'warn' | 'error'; event: string; fields: unknown }[] = [];
  const logger: Logger = {
    warn: (event, fields) => {
      events.push({ level: 'warn', event, fields });
    },
    error: (event, fields) => {
      events.push({ level: 'error', event, fields });
    },
  };
  return { logger, events };
}

/** Every FakeData a test made, so the contract is checked for all of them after the test. */
const harnesses: FakeData[] = [];

/** Rows as the database returns them: through the contract's schema, keys in its order. */
const asDatabaseRows = (rows: readonly TabRow[]): TabRow[] =>
  rows.map((row) => tabRowSchema.parse(Object.fromEntries(Object.entries(row).reverse())));

/** What loadSession reads: the strip and closed rows, and the app_state documents. */
function databaseWith(
  rows: readonly TabRow[],
  documents: Readonly<Record<string, unknown>>,
): Pick<DataClient, 'call'> {
  const answer = (method: string, input: unknown): unknown => {
    switch (method) {
      case 'workspaces.ensureDefault':
        return { id: WORKSPACE, created: false };
      case 'tabs.purgeClosed':
        return { count: 0 };
      case 'tabs.list':
        return {
          tabs: rows.filter((row) => row.placement === (input as { placement: string }).placement),
        };
      case 'tabs.listArchived':
        return {
          tabs: rows
            .filter((row) => row.placement === 'archive')
            .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)),
        };
      case 'tabs.countArchived':
        return { count: rows.filter((row) => row.placement === 'archive').length };
      case 'tabs.listClosed':
        return { tabs: rows.filter((row) => row.placement === 'closed') };
      case 'appState.get':
        return { value: documents[(input as { key: string }).key] ?? null };
      case 'appRuns.recent':
        return { runs: [] };
      default:
        throw new Error(`unexpected call to ${method}`);
    }
  };
  return {
    call: (method: string, input: unknown) => Promise.resolve(answer(method, input)),
  } as unknown as Pick<DataClient, 'call'>;
}

/** A runtime that, like a real one after restore(), reports the stack it was given. */
class EchoRuntime implements TabRuntime {
  stack: TabHistory | null = null;
  readonly calls: string[] = [];

  constructor(readonly events: TabRuntimeEvents) {}

  load(url: string): void {
    this.calls.push(`load:${url}`);
  }
  goBack(): void {
    this.calls.push('back');
  }
  goForward(): void {
    this.calls.push('forward');
  }
  reload(): void {
    this.calls.push('reload');
  }
  stop(): void {
    this.calls.push('stop');
  }
  find(): number {
    this.calls.push('find');
    return 1;
  }
  stopFind(): void {
    this.calls.push('stopFind');
  }
  zoomFactor(): number {
    return 1;
  }
  setZoomFactor(): void {
    this.calls.push('zoom');
  }
  toggleDevTools(): void {
    this.calls.push('devtools');
  }
  exitFullscreen(): void {
    this.calls.push('exitFullscreen');
  }
  show(): void {
    this.calls.push('show');
  }
  hide(): void {
    this.calls.push('hide');
  }
  focus(): void {
    this.calls.push('focus');
  }
  destroy(): void {
    this.calls.push('destroy');
  }
  restore(history: TabHistory): void {
    this.stack = history;
  }
  history(): TabHistory | null {
    return this.stack;
  }
  // The discard and freeze of M3.1 (tab-manager-model.test.ts covers them): never used here.
  showHidden(): void {
    this.calls.push('showHidden');
  }
  ping(): Promise<unknown> {
    return Promise.reject(new Error('not used in these tests'));
  }
  probe(): Promise<unknown> {
    return Promise.reject(new Error('not used in these tests'));
  }
  snapshot(): null {
    return null;
  }
  closeForDiscard(): Promise<'closed'> {
    return Promise.reject(new Error('not used in these tests'));
  }
  freeze(): Promise<void> {
    return Promise.reject(new Error('not used in these tests'));
  }
  thaw(): void {
    this.calls.push('thaw');
  }
}

function setup(
  initial: {
    readonly tabs?: SessionTab[];
    readonly closed?: ClosedTab[];
    readonly selected?: TabId | null;
    readonly loaded?: TabRow[];
  } = {},
) {
  const source = new FakeSource();
  source.strip = initial.tabs ?? [];
  source.closed = initial.closed ?? [];
  source.selected = initial.selected ?? null;
  const data = new FakeData();
  harnesses.push(data);
  const { logger, events } = recordingLogger();
  const store = new SessionStore({
    source,
    data: data as unknown as Pick<DataClient, 'call'>,
    workspaceId: WORKSPACE,
    logger,
    ...(initial.loaded === undefined ? {} : { loaded: initial.loaded }),
  });
  return { source, data, store, events };
}

/** Writes the first state, so later tests of one change start from rows already saved. */
async function settle(harness: ReturnType<typeof setup>, window?: SavedWindow): Promise<void> {
  if (window !== undefined) {
    harness.store.windowChanged(window);
  }
  await harness.store.flush();
  harness.data.calls.length = 0;
}

const WINDOW: SavedWindow = { x: 10, y: 20, width: 1200, height: 800, maximized: false };

describe('SessionStore', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });

  afterEach(() => {
    vi.useRealTimers();
    // Every session.save any test made must be input the data worker's contract accepts. The
    // real client refuses what its contract refuses, so a violation is a save that never lands.
    const violations = harnesses.flatMap((data) => data.contractViolations);
    harnesses.length = 0;
    expect(violations).toEqual([]);
  });

  /** The same check, at a point in a test: every save so far parses with the contract. */
  const checkContract = (data: FakeData): void => {
    for (const save of data.saves) {
      expect(() => DATA_METHODS['session.save'].input.parse(save)).not.toThrow();
    }
  };

  describe('when it writes', () => {
    it('writes nothing until it is told something changed', async () => {
      const { data } = setup({ tabs: [tab(1)], selected: id(1) });

      await vi.advanceTimersByTimeAsync(60_000);

      expect(data.calls).toEqual([]);
    });

    it('flushes a title-only change after 1 second', async () => {
      const harness = setup({ tabs: [tab(1), tab(2)], selected: id(1) });
      await settle(harness);
      harness.source.strip = [tab(1, { title: 'Renamed' }), tab(2)];

      harness.store.changed();
      await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS - 1);
      expect(harness.data.saves).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);

      expect(harness.data.saves).toHaveLength(1);
      checkContract(harness.data);
    });

    it.each([
      [
        'a tab opened',
        (source: FakeSource) => {
          source.strip = [...source.strip, tab(3)];
        },
      ],
      [
        'a tab closed',
        (source: FakeSource) => {
          source.closed = [closed(2)];
          source.strip = [tab(1)];
        },
      ],
      [
        'a tab moved',
        (source: FakeSource) => {
          source.strip = [tab(2), tab(1)];
        },
      ],
      [
        'a tab pinned',
        (source: FakeSource) => {
          source.strip = [tab(1), tab(2, { pinned: true })];
        },
      ],
      [
        'the selection changed',
        (source: FakeSource) => {
          source.selected = id(2);
        },
      ],
    ])('flushes %s after 250 milliseconds', async (_name, change) => {
      const harness = setup({ tabs: [tab(1), tab(2)], selected: id(1) });
      await settle(harness);
      change(harness.source);

      harness.store.changed();
      await vi.advanceTimersByTimeAsync(STRUCTURAL_FLUSH_DELAY_MS - 1);
      expect(harness.data.saves).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);

      expect(harness.data.saves).toHaveLength(1);
      checkContract(harness.data);
    });

    it('uses the delays the assessment gives: 1 s, and 250 ms for a structural change', () => {
      expect(FLUSH_DELAY_MS).toBe(1000);
      expect(STRUCTURAL_FLUSH_DELAY_MS).toBe(250);
    });

    it('coalesces several changes into one save', async () => {
      const harness = setup({ tabs: [tab(1)], selected: id(1) });
      await settle(harness);

      harness.source.strip = [tab(1, { title: 'One' })];
      harness.store.changed();
      await vi.advanceTimersByTimeAsync(100);
      harness.source.strip = [tab(1, { title: 'Two' }), tab(2)];
      harness.store.changed();
      await vi.advanceTimersByTimeAsync(100);
      harness.source.strip = [tab(1, { title: 'Three' }), tab(2, { title: 'Second' })];
      harness.store.changed();
      await vi.advanceTimersByTimeAsync(5000);

      expect(harness.data.saves).toHaveLength(1);
      expect(harness.data.saves[0]?.tabs.map((row) => [row.id, row.title])).toEqual([
        [id(1), 'Three'],
        [id(2), 'Second'],
      ]);
    });

    it('lets a structural change pull a pending title flush forward', async () => {
      const harness = setup({ tabs: [tab(1)], selected: id(1) });
      await settle(harness);
      harness.source.strip = [tab(1, { title: 'Soon' })];
      harness.store.changed();
      await vi.advanceTimersByTimeAsync(100);

      harness.source.strip = [tab(1, { title: 'Soon' }), tab(2)];
      harness.store.changed();
      // 250 ms after the structural change, not 1 s after the first one.
      await vi.advanceTimersByTimeAsync(STRUCTURAL_FLUSH_DELAY_MS);

      expect(harness.data.saves).toHaveLength(1);
      expect(harness.data.saves[0]?.tabs).toHaveLength(2);
    });

    it('does not push a pending flush later when more changes arrive', async () => {
      const harness = setup({ tabs: [tab(1)], selected: id(1) });
      await settle(harness);

      for (const title of ['a', 'b', 'c']) {
        harness.source.strip = [tab(1, { title })];
        harness.store.changed();
        await vi.advanceTimersByTimeAsync(400);
      }
      // 1,200 ms since the first change: its flush already happened at 1,000.
      expect(harness.data.saves).toHaveLength(1);
      expect(harness.data.saves[0]?.tabs[0]?.title).toBe('c');
    });

    it('writes nothing when a flush finds nothing changed', async () => {
      const harness = setup({ tabs: [tab(1)], selected: id(1) });
      await settle(harness);

      harness.store.changed();
      await vi.advanceTimersByTimeAsync(5000);

      expect(harness.data.calls).toEqual([]);
    });

    it('flush() writes at once and cancels the pending timer', async () => {
      const harness = setup({ tabs: [tab(1)], selected: id(1) });
      await settle(harness);
      harness.source.strip = [tab(1, { title: 'Now' })];
      harness.store.changed();

      await harness.store.flush();
      expect(harness.data.saves).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5000);

      expect(harness.data.saves).toHaveLength(1);
    });

    it('writes the session document on the first flush even when there are no tabs', async () => {
      const harness = setup();

      harness.store.changed();
      await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);

      expect(harness.data.saves).toEqual([
        {
          tabs: [],
          deleteIds: [],
          documents: [{ key: SESSION_DOCUMENT, value: { selectedTabId: null } }],
        },
      ]);
      checkContract(harness.data);
    });
  });

  describe('telling a structural change apart', () => {
    it('reads only ids and pins on each change, not the stack of every tab', async () => {
      const harness = setup({ tabs: [tab(1), tab(2)], selected: id(1) });
      expect(harness.source.sessionTabsReads).toBe(0);

      for (let change = 0; change < 20; change += 1) {
        harness.store.changed();
      }
      expect(harness.source.sessionTabsReads).toBe(0);

      await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
      // The rows are read once, by the flush.
      expect(harness.source.sessionTabsReads).toBe(1);
    });

    it('still sees a tab that is pinned, opened or moved without reading the stacks', async () => {
      const harness = setup({ tabs: [tab(1), tab(2)], selected: id(1) });
      await settle(harness);
      const readsAfterSettle = harness.source.sessionTabsReads;

      harness.source.strip = [tab(1), tab(2, { pinned: true })];
      harness.store.changed();
      await vi.advanceTimersByTimeAsync(STRUCTURAL_FLUSH_DELAY_MS - 1);
      expect(harness.data.saves).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);

      expect(harness.data.saves).toHaveLength(1);
      expect(harness.source.sessionTabsReads).toBe(readsAfterSettle + 1);
    });
  });

  describe('when the session can not be read', () => {
    it('logs session.readFailed without any detail, and does not reject flush()', async () => {
      const harness = setup({ tabs: [tab(1)], selected: id(1) });
      harness.source.readError = new Error('boom reading https://private.example/secret');

      await expect(harness.store.flush()).resolves.toBeUndefined();

      expect(harness.events).toEqual([
        { level: 'error', event: 'session.readFailed', fields: undefined },
      ]);
      expect(harness.data.calls).toEqual([]);
      expect(JSON.stringify(harness.events)).not.toContain('private.example');
    });

    it('is no unhandled rejection when the timer is what flushes', async () => {
      const harness = setup({ tabs: [tab(1)], selected: id(1) });
      harness.source.readError = new Error('boom');

      harness.store.changed();
      await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);

      expect(harness.events.map((entry) => entry.event)).toEqual(['session.readFailed']);
      expect(harness.data.calls).toEqual([]);
    });

    it('writes everything on the next change once the source reads again', async () => {
      const harness = setup({ tabs: [tab(1), tab(2)], selected: id(1) });
      harness.source.readError = new Error('boom');
      await harness.store.flush();

      harness.source.readError = null;
      harness.store.changed();
      await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);

      expect(harness.data.saves).toHaveLength(1);
      expect(harness.data.saves[0]?.tabs.map((row) => row.id)).toEqual([id(1), id(2)]);
      expect(harness.data.saves[0]?.documents).toHaveLength(1);
    });

    it('keeps what was written: a failed read deletes nothing', async () => {
      const harness = setup({ tabs: [tab(1), tab(2)], selected: id(1) });
      await settle(harness);
      harness.source.readError = new Error('boom');

      await harness.store.flush();
      harness.source.readError = null;
      await harness.store.flush();

      expect(harness.data.calls).toEqual([]);
    });

    it('does not read at all once frozen: the captured state is written', async () => {
      const harness = setup({ tabs: [tab(1)], selected: id(1) });
      harness.store.freeze();
      harness.source.readError = new Error('boom');

      await harness.store.flush();

      expect(harness.events).toEqual([]);
      expect(harness.data.saves[0]?.tabs.map((row) => row.id)).toEqual([id(1)]);
    });
  });

  describe('what a save holds', () => {
    it('sends a strip tab as a full row, at its position', async () => {
      const harness = setup({
        tabs: [tab(1, { pinned: true }), tab(2, { lastUsedAt: T0 + 99 })],
        selected: id(2),
      });

      await harness.store.flush();

      const [first, second] = harness.data.saves[0]?.tabs ?? [];
      expect(first).toEqual({
        id: id(1),
        workspaceId: WORKSPACE,
        placement: 'strip',
        position: 0,
        pinned: true,
        userProtected: false,
        pageId: null,
        url: 'https://site1.example/',
        title: 'Tab 1',
        faviconId: null,
        restoreState: {
          v: 1,
          index: 0,
          entries: [{ url: 'https://site1.example/', title: 'Tab 1' }],
        },
        openerTabId: null,
        createdAt: T0,
        lastUsedAt: T0 + 10,
        lastUsedEngaged: 0,
        lastUsedActiveDay: 1,
        placementChangedAt: T0,
        archivedAt: null,
        archiveReason: null,
        closedAt: null,
      });
      expect(second).toMatchObject({ id: id(2), position: 1, lastUsedAt: T0 + 99 });
      checkContract(harness.data);
    });

    it('saves whole milliseconds when the engaged clock stamped a fraction (found by E2E, M3.4)', async () => {
      const harness = setup({
        tabs: [tab(1, { lastUsedAt: T0 + 0.75, lastUsedEngaged: 1234.567 })],
        selected: id(1),
      });

      await harness.store.flush();

      expect(harness.data.saves[0]?.tabs[0]).toMatchObject({
        lastUsedAt: T0,
        lastUsedEngaged: 1234,
      });
      // The row passes the data contract: one fraction used to make the whole save fail.
      checkContract(harness.data);
    });

    it('gives positions in strip order, which is the order the source lists', async () => {
      const harness = setup({ tabs: [tab(3), tab(1), tab(2)], selected: id(3) });

      await harness.store.flush();

      expect(harness.data.saves[0]?.tabs.map((row) => [row.id, row.position])).toEqual([
        [id(3), 0],
        [id(1), 1],
        [id(2), 2],
      ]);
    });

    it('sends a closed tab as a closed row: unpinned, with its closedAt', async () => {
      const harness = setup({
        tabs: [tab(1)],
        closed: [closed(2, { pinned: true, closedAt: T0 + 7777, index: 4 })],
        selected: id(1),
      });

      await harness.store.flush();

      const rows = harness.data.saves[0]?.tabs ?? [];
      expect(rows.find((row) => row.id === id(2))).toMatchObject({
        placement: 'closed',
        // Where it was in the strip, for Ctrl+Shift+T after a restart.
        position: 4,
        // The schema allows a pin only in the strip.
        pinned: false,
        closedAt: T0 + 7777,
        placementChangedAt: T0 + 7777,
        archivedAt: null,
        archiveReason: null,
      });
      expect(rows.find((row) => row.id === id(1))).toMatchObject({
        placement: 'strip',
        closedAt: null,
      });
      checkContract(harness.data);
    });

    it('sends the back/forward stack as restoreState, and null for a tab without one', async () => {
      const history: TabHistory = {
        index: 1,
        entries: [
          { url: 'https://site1.example/a', title: 'A' },
          { url: 'https://site1.example/b', title: 'B' },
        ],
      };
      const harness = setup({
        tabs: [tab(1, { history }), tab(2, { url: SESSION_NEW_TAB_URL, title: '', history: null })],
        selected: id(1),
      });

      await harness.store.flush();

      const rows = harness.data.saves[0]?.tabs ?? [];
      expect(rows[0]?.restoreState).toEqual({ v: 1, index: 1, entries: history.entries });
      expect(rows[1]).toMatchObject({ url: SESSION_NEW_TAB_URL, restoreState: null });
      checkContract(harness.data);
    });

    it('stores a new-tab page as its own address and never as an empty url', async () => {
      const harness = setup({
        tabs: [tab(1, { url: SESSION_NEW_TAB_URL, title: '', history: null })],
        selected: id(1),
      });

      await harness.store.flush();

      expect(harness.data.saves[0]?.tabs[0]?.url).toBe('veltriva://newtab');
    });

    describe('the address', () => {
      const urlSaved = async (url: string): Promise<string | undefined> => {
        const harness = setup({ tabs: [tab(1, { url })], selected: id(1) });
        await harness.store.flush();
        checkContract(harness.data);
        return harness.data.saves[0]?.tabs[0]?.url;
      };

      it('has its credentials removed', async () => {
        expect(await urlSaved('https://user:secret@site1.example/path?q=1')).toBe(
          'https://site1.example/path?q=1',
        );
      });

      it('has a token fragment cut', async () => {
        expect(await urlSaved('https://site1.example/cb#access_token=SECRET&state=1')).toBe(
          'https://site1.example/cb',
        );
        expect(await urlSaved('https://site1.example/#/cb?code=SECRET')).toBe(
          'https://site1.example/',
        );
      });

      it('has both removed together', async () => {
        const result = await urlSaved('https://user:secret@site1.example/p#id_token=SECRET');

        expect(result).toBe('https://site1.example/p');
      });

      it('keeps a harmless fragment and the query', async () => {
        expect(await urlSaved('https://site1.example/a?x=1&y=2#section')).toBe(
          'https://site1.example/a?x=1&y=2#section',
        );
      });

      it.each([
        'about:blank',
        'data:text/html,<p>hi</p>#access_token=SECRET',
        'javascript:alert(1)',
        'chrome://settings',
        'blob:https://site1.example/1',
        'ftp://user:SECRET@site1.example/file',
        'veltriva://settings',
        'not a url',
      ])('saves the address a restore would refuse, %s, as a new-tab page', async (url) => {
        // Restoring it would open a new-tab page anyway; nothing unsafe reaches the file.
        expect(await urlSaved(url)).toBe(SESSION_NEW_TAB_URL);
      });

      it('saves such a tab with no title and no stack, whatever it had', async () => {
        const harness = setup({
          tabs: [
            tab(1, {
              url: 'about:blank',
              title: 'A page title',
              history: {
                index: 0,
                entries: [{ url: 'https://site1.example/', title: 'Stack' }],
              },
            }),
          ],
          selected: id(1),
        });

        await harness.store.flush();

        expect(harness.data.saves[0]?.tabs[0]).toMatchObject({
          url: SESSION_NEW_TAB_URL,
          title: '',
          restoreState: null,
          placement: 'strip',
          position: 0,
        });
        expect(JSON.stringify(harness.data.saves)).not.toContain('A page title');
        checkContract(harness.data);
      });

      it('does the same for a closed tab', async () => {
        const harness = setup({
          tabs: [tab(1)],
          closed: [closed(2, { url: 'javascript:alert(1)', title: 'Gone' })],
          selected: id(1),
        });

        await harness.store.flush();

        const row = harness.data.saves[0]?.tabs.find((candidate) => candidate.id === id(2));
        expect(row).toMatchObject({
          placement: 'closed',
          url: SESSION_NEW_TAB_URL,
          title: '',
          restoreState: null,
        });
        checkContract(harness.data);
      });

      it('keeps the title and stack of a tab whose address is fine', async () => {
        const harness = setup({ tabs: [tab(1, { title: 'Kept' })], selected: id(1) });

        await harness.store.flush();

        expect(harness.data.saves[0]?.tabs[0]).toMatchObject({
          url: 'https://site1.example/',
          title: 'Kept',
          restoreState: { v: 1, index: 0 },
        });
      });

      it('never lets a secret into any column of a row', async () => {
        const harness = setup({
          tabs: [
            tab(1, {
              url: 'https://user:SECRET@site1.example/p#access_token=SECRET',
              history: {
                index: 0,
                entries: [{ url: 'https://site1.example/p', title: 'Title' }],
              },
            }),
          ],
          selected: id(1),
        });

        await harness.store.flush();

        expect(JSON.stringify(harness.data.saves)).not.toContain('SECRET');
      });

      it('saves a tab whose address is empty or over the limit as a new-tab page, not leaving it out', async () => {
        const prefix = 'https://u:p@site4.example/';
        const harness = setup({
          tabs: [
            tab(2, { url: '' }),
            tab(1),
            tab(3, { url: `https://site3.example/${'x'.repeat(70_000)}` }),
            // Short enough as it came, but longer once normalized without its credentials.
            tab(4, { url: prefix + 'é'.repeat(65_536 - prefix.length) }),
          ],
          selected: id(1),
        });

        await harness.store.flush();

        // Every tab keeps its place in the strip.
        expect(
          harness.data.saves[0]?.tabs.map((row) => [
            row.id,
            row.position,
            row.url,
            row.restoreState,
          ]),
        ).toEqual([
          [id(2), 0, SESSION_NEW_TAB_URL, null],
          [id(1), 1, 'https://site1.example/', expect.anything()],
          [id(3), 2, SESSION_NEW_TAB_URL, null],
          [id(4), 3, SESSION_NEW_TAB_URL, null],
        ]);
        checkContract(harness.data);
      });

      it('does not delete a tab that became a new-tab page, only updates its row', async () => {
        const harness = setup({ tabs: [tab(1), tab(2)], selected: id(1) });
        await settle(harness);

        harness.source.strip = [tab(1), tab(2, { url: 'about:blank' })];
        harness.store.changed();
        await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);

        expect(harness.data.saves[0]?.deleteIds).toEqual([]);
        expect(harness.data.saves[0]?.tabs).toEqual([
          expect.objectContaining({ id: id(2), url: SESSION_NEW_TAB_URL, title: '' }),
        ]);
      });

      it('accepts an address of exactly 65,536 characters', async () => {
        const prefix = 'https://site1.example/';
        const url = prefix + 'x'.repeat(65_536 - prefix.length);
        const harness = setup({
          tabs: [tab(1, { url, history: null })],
          selected: id(1),
        });

        await harness.store.flush();

        expect(harness.data.saves[0]?.tabs[0]?.url).toBe(url);
        checkContract(harness.data);
      });
    });
  });

  describe('only what changed', () => {
    it('sends only the rows that changed since the last write', async () => {
      const harness = setup({ tabs: [tab(1), tab(2), tab(3)], selected: id(1) });
      await harness.store.flush();
      expect(harness.data.saves[0]?.tabs).toHaveLength(3);

      harness.source.strip = [tab(1), tab(2, { title: 'Changed' }), tab(3)];
      harness.store.changed();
      await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);

      expect(harness.data.saves).toHaveLength(2);
      expect(harness.data.saves[1]?.tabs.map((row) => [row.id, row.title])).toEqual([
        [id(2), 'Changed'],
      ]);
      expect(harness.data.saves[1]?.deleteIds).toEqual([]);
      checkContract(harness.data);
    });

    it('sends a tab whose history changed, and one whose position changed', async () => {
      const harness = setup({ tabs: [tab(1), tab(2)], selected: id(1) });
      await settle(harness);

      harness.source.strip = [
        tab(2),
        tab(1, {
          history: {
            index: 1,
            entries: [
              { url: 'https://site1.example/', title: 'Tab 1' },
              { url: 'https://site1.example/next', title: 'Next' },
            ],
          },
        }),
      ];
      harness.store.changed();
      await vi.advanceTimersByTimeAsync(STRUCTURAL_FLUSH_DELAY_MS);

      expect(harness.data.saves[0]?.tabs.map((row) => [row.id, row.position])).toEqual([
        [id(2), 0],
        [id(1), 1],
      ]);
    });

    it('does not send a row again once it is written', async () => {
      const harness = setup({ tabs: [tab(1)], selected: id(1) });
      await harness.store.flush();

      await harness.store.flush();

      expect(harness.data.saves).toHaveLength(1);
    });

    describe('rows the database already had (loaded)', () => {
      /** The rows as the database returns them: keys in the contract's order. */
      const asRead = (rows: readonly TabRow[]): TabRow[] =>
        rows.map((row) => tabRowSchema.parse(Object.fromEntries(Object.entries(row).reverse())));

      const writtenRows = async (tabs: SessionTab[], closedTabs: ClosedTab[] = []) => {
        const first = setup({ tabs, closed: closedTabs, selected: id(1) });
        await first.store.flush();
        return asRead(first.data.saves[0]?.tabs ?? []);
      };

      it('are not sent again if unchanged, so a start writes no tab rows', async () => {
        const tabs = [tab(1), tab(2, { pinned: true })];
        const closedTabs = [closed(3)];
        const loaded = await writtenRows(tabs, closedTabs);
        const harness = setup({ tabs, closed: closedTabs, selected: id(1), loaded });

        harness.store.changed();
        await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);

        // Only the session document, which the database may not match yet.
        expect(harness.data.saves).toEqual([
          {
            tabs: [],
            deleteIds: [],
            documents: [{ key: SESSION_DOCUMENT, value: { selectedTabId: id(1) } }],
          },
        ]);
      });

      it('are sent when they differ from the source', async () => {
        const loaded = await writtenRows([tab(1), tab(2)]);
        const harness = setup({
          tabs: [tab(1), tab(2, { title: 'After restore' })],
          selected: id(1),
          loaded,
        });

        harness.store.changed();
        await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);

        expect(harness.data.saves[0]?.tabs.map((row) => [row.id, row.title])).toEqual([
          [id(2), 'After restore'],
        ]);
      });

      it('are deleted when the source no longer has them (restoreSession dropped a duplicate)', async () => {
        const loaded = await writtenRows([tab(1), tab(2)]);
        const harness = setup({ tabs: [tab(1)], selected: id(1), loaded });

        harness.store.changed();
        await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);

        expect(harness.data.saves[0]).toMatchObject({ tabs: [], deleteIds: [id(2)] });
      });

      it('are not deleted when they are now closed tabs, only updated', async () => {
        const loaded = await writtenRows([tab(1), tab(2)]);
        const harness = setup({ tabs: [tab(1)], closed: [closed(2)], selected: id(1), loaded });

        harness.store.changed();
        await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);

        expect(harness.data.saves[0]?.deleteIds).toEqual([]);
        expect(harness.data.saves[0]?.tabs.map((row) => [row.id, row.placement])).toEqual([
          [id(2), 'closed'],
        ]);
      });
    });
  });

  describe('a tab that goes away', () => {
    it('is in deleteIds when it is gone from both the strip and Recently closed', async () => {
      const harness = setup({ tabs: [tab(1), tab(2)], selected: id(1) });
      await settle(harness);

      harness.source.strip = [tab(1)];
      harness.store.changed();
      await vi.advanceTimersByTimeAsync(STRUCTURAL_FLUSH_DELAY_MS);

      expect(harness.data.saves).toHaveLength(1);
      expect(harness.data.saves[0]).toMatchObject({ tabs: [], deleteIds: [id(2)] });
      checkContract(harness.data);
    });

    it('is deleted once, not on every later flush', async () => {
      const harness = setup({ tabs: [tab(1), tab(2)], selected: id(1) });
      await settle(harness);
      harness.source.strip = [tab(1)];
      harness.store.changed();
      await vi.advanceTimersByTimeAsync(STRUCTURAL_FLUSH_DELAY_MS);

      harness.source.strip = [tab(1, { title: 'Later' })];
      harness.store.changed();
      await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);

      expect(harness.data.saves.map((save) => save.deleteIds)).toEqual([[id(2)], []]);
    });

    it('is written as a closed row, and not deleted, when it was closed', async () => {
      const harness = setup({ tabs: [tab(1), tab(2)], selected: id(1) });
      await settle(harness);

      harness.source.strip = [tab(1)];
      harness.source.closed = [closed(2, { closedAt: T0 + 6000 })];
      harness.store.changed();
      await vi.advanceTimersByTimeAsync(STRUCTURAL_FLUSH_DELAY_MS);

      expect(harness.data.saves[0]?.deleteIds).toEqual([]);
      expect(harness.data.saves[0]?.tabs).toEqual([
        expect.objectContaining({ id: id(2), placement: 'closed', closedAt: T0 + 6000 }),
      ]);
    });

    it('is written back as a strip row when a closed tab is reopened', async () => {
      const harness = setup({ tabs: [tab(1)], closed: [closed(2)], selected: id(1) });
      await settle(harness);

      harness.source.strip = [tab(1), tab(2)];
      harness.source.closed = [];
      harness.source.selected = id(2);
      harness.store.changed();
      await vi.advanceTimersByTimeAsync(STRUCTURAL_FLUSH_DELAY_MS);

      expect(harness.data.saves[0]?.deleteIds).toEqual([]);
      expect(harness.data.saves[0]?.tabs).toEqual([
        expect.objectContaining({ id: id(2), placement: 'strip', position: 1, closedAt: null }),
      ]);
    });

    it('is deleted when the oldest closed tab falls off the list of 100', async () => {
      const harness = setup({
        tabs: [tab(1)],
        closed: [closed(2, { closedAt: T0 + 2 }), closed(3, { closedAt: T0 + 1 })],
        selected: id(1),
      });
      await settle(harness);

      harness.source.closed = [closed(2, { closedAt: T0 + 2 })];
      harness.store.changed();
      await vi.advanceTimersByTimeAsync(STRUCTURAL_FLUSH_DELAY_MS);

      expect(harness.data.saves[0]?.deleteIds).toEqual([id(3)]);
    });
  });

  describe('the documents', () => {
    it('carries the selected tab in the session document, on the first flush', async () => {
      const harness = setup({ tabs: [tab(1), tab(2)], selected: id(2) });

      await harness.store.flush();

      expect(harness.data.saves[0]?.documents).toEqual([
        { key: SESSION_DOCUMENT, value: { selectedTabId: id(2) } },
      ]);
    });

    it('sends the session document only when it changes', async () => {
      const harness = setup({ tabs: [tab(1), tab(2)], selected: id(1) });
      await settle(harness);

      harness.source.strip = [tab(1, { title: 'Title only' }), tab(2)];
      harness.store.changed();
      await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
      expect(harness.data.saves[0]?.documents).toEqual([]);

      harness.source.selected = id(2);
      harness.store.changed();
      await vi.advanceTimersByTimeAsync(STRUCTURAL_FLUSH_DELAY_MS);
      expect(harness.data.saves[1]?.documents).toEqual([
        { key: SESSION_DOCUMENT, value: { selectedTabId: id(2) } },
      ]);
      expect(harness.data.saves[1]?.tabs).toEqual([]);
      checkContract(harness.data);
    });

    it('sends a window document when the window changes', async () => {
      const harness = setup({ tabs: [tab(1)], selected: id(1) });
      await settle(harness);

      harness.store.windowChanged(WINDOW);
      await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS - 1);
      expect(harness.data.saves).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);

      expect(harness.data.saves).toEqual([
        { tabs: [], deleteIds: [], documents: [{ key: WINDOW_DOCUMENT, value: WINDOW }] },
      ]);
      checkContract(harness.data);
    });

    it('sends the window document only when the window is different', async () => {
      const harness = setup({ tabs: [tab(1)], selected: id(1) });
      await settle(harness, WINDOW);

      harness.store.windowChanged({ ...WINDOW });
      await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
      expect(harness.data.saves).toHaveLength(0);

      harness.store.windowChanged({ ...WINDOW, maximized: true });
      await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
      expect(harness.data.saves).toEqual([
        {
          tabs: [],
          deleteIds: [],
          documents: [{ key: WINDOW_DOCUMENT, value: { ...WINDOW, maximized: true } }],
        },
      ]);
    });

    it('sends both documents in one save on the first flush after a window change', async () => {
      const harness = setup({ tabs: [tab(1)], selected: id(1) });

      harness.store.windowChanged(WINDOW);
      await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);

      expect(harness.data.saves).toHaveLength(1);
      expect(harness.data.saves[0]?.documents.map((document) => document.key)).toEqual([
        SESSION_DOCUMENT,
        WINDOW_DOCUMENT,
      ]);
      checkContract(harness.data);
    });

    it('batches a stream of window moves into one save', async () => {
      const harness = setup({ tabs: [tab(1)], selected: id(1) });
      await settle(harness);

      for (let x = 0; x < 20; x += 1) {
        harness.store.windowChanged({ ...WINDOW, x });
        await vi.advanceTimersByTimeAsync(20);
      }
      await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);

      expect(harness.data.saves).toHaveLength(1);
      expect(harness.data.saves[0]?.documents).toEqual([
        { key: WINDOW_DOCUMENT, value: { ...WINDOW, x: 19 } },
      ]);
    });
  });

  describe('a save that fails', () => {
    it('is logged with its code only, and the rows are sent again later', async () => {
      const harness = setup({ tabs: [tab(1), tab(2)], selected: id(1) });
      harness.data.failures = [new DataClientError('timeout', 'session.save')];

      harness.store.changed();
      await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);

      expect(harness.events).toEqual([
        { level: 'warn', event: 'session.saveFailed', fields: { code: 'timeout' } },
      ]);
      expect(harness.data.saves).toHaveLength(1);

      // The retry carries everything the first attempt did.
      await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
      expect(harness.data.saves).toHaveLength(2);
      expect(harness.data.saves[1]).toEqual(harness.data.saves[0]);
      expect(harness.events).toHaveLength(1);
      checkContract(harness.data);
    });

    it('marks nothing as written, so later changes still resend the failed rows', async () => {
      const harness = setup({ tabs: [tab(1), tab(2)], selected: id(1) });
      harness.data.failures = [new DataClientError('sqlite', 'SQLITE_BUSY')];
      await harness.store.flush();
      harness.data.calls.length = 0;

      harness.source.strip = [tab(1, { title: 'Changed' }), tab(2)];
      await harness.store.flush();

      // Both rows: tab 2 never reached the database.
      expect(harness.data.saves[0]?.tabs.map((row) => row.id)).toEqual([id(1), id(2)]);
      expect(harness.data.saves[0]?.documents).toHaveLength(1);
    });

    it('keeps retrying every second while it keeps failing', async () => {
      const harness = setup({ tabs: [tab(1)], selected: id(1) });
      harness.data.failures = [
        new DataClientError('busy'),
        new DataClientError('busy'),
        new DataClientError('busy'),
      ];

      harness.store.changed();
      await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS * 5);

      expect(harness.data.saves).toHaveLength(4);
      expect(harness.events.map((entry) => entry.event)).toEqual([
        'session.saveFailed',
        'session.saveFailed',
        'session.saveFailed',
      ]);
    });

    it('is logged as internal when the error has no code', async () => {
      const harness = setup({ tabs: [tab(1)], selected: id(1) });
      harness.data.failures = [new Error('boom with https://secret.example/ in it')];

      await harness.store.flush();

      expect(harness.events).toEqual([
        { level: 'warn', event: 'session.saveFailed', fields: { code: 'internal' } },
      ]);
    });

    it('is logged with the code of any error that carries one', async () => {
      const harness = setup({ tabs: [tab(1)], selected: id(1) });
      harness.data.failures = [Object.assign(new Error('x'), { code: 'invalid_input' })];

      await harness.store.flush();

      expect(harness.events[0]?.fields).toEqual({ code: 'invalid_input' });
    });

    it('does not reject flush(), which shutdown waits on', async () => {
      const harness = setup({ tabs: [tab(1)], selected: id(1) });
      harness.data.failures = [new DataClientError('worker_gone')];

      await expect(harness.store.flush()).resolves.toBeUndefined();
    });

    it('writes the rest after a failure in the middle of a split save', async () => {
      const tabs = Array.from({ length: 2500 }, (_, n) => tab(n));
      const harness = setup({ tabs, selected: id(0) });
      // The first part is written, the second fails.
      harness.data.failures = [undefined, new DataClientError('timeout')];

      await harness.store.flush();
      expect(harness.data.saves.map((save) => save.tabs.length)).toEqual([1000, 1000]);
      harness.data.calls.length = 0;
      await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);

      // The retry holds what was not written, and the documents, in its last part.
      expect(harness.data.saves.map((save) => save.tabs.length)).toEqual([1000, 500]);
      expect(harness.data.saves.map((save) => save.documents.length)).toEqual([0, 1]);
      expect(harness.data.saves[0]?.tabs[0]?.id).toBe(id(1000));
    });
  });

  describe('a save of many rows', () => {
    it('splits more than 1,000 changed rows into several calls, with documents only in the last', async () => {
      const tabs = Array.from({ length: 2300 }, (_, n) => tab(n));
      const harness = setup({ tabs, selected: id(0) });
      harness.store.windowChanged(WINDOW);

      await harness.store.flush();

      expect(harness.data.saves.map((save) => save.tabs.length)).toEqual([1000, 1000, 300]);
      expect(harness.data.saves.map((save) => save.documents.length)).toEqual([0, 0, 2]);
      expect(harness.data.saves.every((save) => save.deleteIds.length === 0)).toBe(true);
      // Every row exactly once, in strip order.
      expect(harness.data.saves.flatMap((save) => save.tabs.map((row) => row.position))).toEqual(
        tabs.map((_, position) => position),
      );
      checkContract(harness.data);
    });

    it('sends exactly 1,000 rows in one call', async () => {
      const tabs = Array.from({ length: MAX_BATCH }, (_, n) => tab(n));
      const harness = setup({ tabs, selected: id(0) });

      await harness.store.flush();

      expect(harness.data.saves).toHaveLength(1);
      expect(harness.data.saves[0]?.tabs).toHaveLength(MAX_BATCH);
      expect(harness.data.saves[0]?.documents).toHaveLength(1);
      checkContract(harness.data);
    });

    it('splits more than 1,000 deletions too, and pairs them with rows', async () => {
      const tabs = Array.from({ length: 1500 }, (_, n) => tab(n));
      const harness = setup({ tabs, selected: id(0) });
      await settle(harness);

      // 300 tabs stay (with new titles) and 1,200 go: 300 changed rows beside 1,200 deletions.
      harness.source.strip = tabs.slice(0, 300).map((row) => ({ ...row, title: 'New' }));
      harness.store.changed();
      await vi.advanceTimersByTimeAsync(STRUCTURAL_FLUSH_DELAY_MS);

      expect(harness.data.saves.map((save) => [save.tabs.length, save.deleteIds.length])).toEqual([
        [300, 1000],
        [0, 200],
      ]);
      expect(harness.data.saves.map((save) => save.documents.length)).toEqual([0, 0]);
      checkContract(harness.data);
    });

    it('writes a 50-entry history for each of many tabs within the contract', async () => {
      const tabs = Array.from({ length: 200 }, (_, n) =>
        tab(n, {
          history: {
            index: 49,
            entries: Array.from({ length: 50 }, (_, entry) => ({
              url: `https://site${String(n)}.example/${String(entry)}`,
              title: `Entry ${String(entry)}`,
            })),
          },
        }),
      );
      const harness = setup({
        tabs,
        closed: [closed(900, { pinned: true })],
        selected: id(5),
      });

      await harness.store.flush();

      expect(harness.data.saves).toHaveLength(1);
      expect(harness.data.saves[0]?.tabs[3]?.restoreState?.entries).toHaveLength(50);
      checkContract(harness.data);
    });
  });

  describe('flush()', () => {
    it('runs one write at a time, in order', async () => {
      const harness = setup({ tabs: [tab(1)], selected: id(1) });
      let release: () => void = () => undefined;
      harness.data.gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const first = harness.store.flush();
      harness.source.strip = [tab(1, { title: 'Second write' })];
      const second = harness.store.flush();
      await vi.advanceTimersByTimeAsync(0);
      // The second waits for the first.
      expect(harness.data.calls).toHaveLength(1);
      harness.data.gate = null;
      release();
      await Promise.all([first, second]);

      expect(harness.data.maxInFlight).toBe(1);
      expect(harness.data.saves).toHaveLength(2);
      expect(harness.data.saves[0]?.tabs[0]?.title).toBe('Tab 1');
      expect(harness.data.saves[1]?.tabs.map((row) => row.title)).toEqual(['Second write']);
    });

    it('writes nothing for a second flush that finds the first wrote it all', async () => {
      const harness = setup({ tabs: [tab(1)], selected: id(1) });

      await Promise.all([harness.store.flush(), harness.store.flush(), harness.store.flush()]);

      expect(harness.data.saves).toHaveLength(1);
    });
  });

  describe('freeze()', () => {
    it('captures the session as it is and ignores every later change', async () => {
      const harness = setup({ tabs: [tab(1), tab(2)], selected: id(2) });
      harness.store.freeze();

      // The window closes and TabManager tears every tab down: the source now reports nothing.
      harness.source.strip = [];
      harness.source.closed = [closed(1), closed(2)];
      harness.source.selected = null;
      harness.store.changed();
      harness.store.windowChanged(WINDOW);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(harness.data.calls).toEqual([]);
      await harness.store.flush();

      expect(harness.data.saves).toHaveLength(1);
      expect(harness.data.saves[0]?.tabs.map((row) => [row.id, row.placement])).toEqual([
        [id(1), 'strip'],
        [id(2), 'strip'],
      ]);
      expect(harness.data.saves[0]?.deleteIds).toEqual([]);
      expect(harness.data.saves[0]?.documents).toEqual([
        { key: SESSION_DOCUMENT, value: { selectedTabId: id(2) } },
      ]);
      checkContract(harness.data);
    });

    it('does not delete the rows of tabs that closed only because the window did', async () => {
      const harness = setup({ tabs: [tab(1), tab(2)], selected: id(1) });
      await settle(harness);
      harness.store.freeze();
      harness.source.strip = [];

      await harness.store.flush();

      // Nothing changed from the frozen state to what is written: no call, so no delete.
      expect(harness.data.calls).toEqual([]);
    });

    it('writes the changes made before the freeze', async () => {
      const harness = setup({ tabs: [tab(1)], selected: id(1) });
      await settle(harness);
      harness.source.strip = [tab(1, { title: 'Last words' })];
      harness.store.changed();
      harness.store.freeze();
      harness.source.strip = [];

      await harness.store.flush();

      expect(harness.data.saves[0]?.tabs.map((row) => row.title)).toEqual(['Last words']);
    });

    it('makes a timer that was already pending write the frozen state', async () => {
      const harness = setup({ tabs: [tab(1), tab(2)], selected: id(1) });
      harness.store.changed();
      harness.store.freeze();
      harness.source.strip = [];

      await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);

      expect(harness.data.saves).toHaveLength(1);
      expect(harness.data.saves[0]?.tabs.map((row) => row.id)).toEqual([id(1), id(2)]);
      expect(harness.data.saves[0]?.deleteIds).toEqual([]);
    });

    it('keeps the first capture when called again', async () => {
      const harness = setup({ tabs: [tab(1)], selected: id(1) });
      harness.store.freeze();
      harness.source.strip = [tab(1), tab(2)];

      harness.store.freeze();
      await harness.store.flush();

      expect(harness.data.saves[0]?.tabs.map((row) => row.id)).toEqual([id(1)]);
    });

    it('does not retry a failed final write, because the app is quitting', async () => {
      const harness = setup({ tabs: [tab(1)], selected: id(1) });
      harness.store.freeze();
      harness.data.failures = [new DataClientError('timeout')];

      await harness.store.flush();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(harness.data.saves).toHaveLength(1);
      expect(harness.events.map((entry) => entry.event)).toEqual(['session.saveFailed']);
    });

    it('can be flushed again by the caller after a failure', async () => {
      const harness = setup({ tabs: [tab(1)], selected: id(1) });
      harness.store.freeze();
      harness.data.failures = [new DataClientError('timeout')];
      await harness.store.flush();

      await harness.store.flush();

      expect(harness.data.saves).toHaveLength(2);
      expect(harness.data.saves[1]).toEqual(harness.data.saves[0]);
    });
  });

  describe('with the real TabManager and a session loaded from rows', () => {
    const history1: TabHistory = {
      index: 1,
      entries: [
        { url: 'https://site1.example/a', title: 'A' },
        { url: 'https://site1.example/', title: 'Tab 1' },
        { url: 'https://site1.example/c', title: 'C' },
      ],
    };

    /** A run that saved a session, and the next one that loads it back and restores it. */
    const restart = async () => {
      const first = setup({
        tabs: [
          tab(2, { pinned: true }),
          tab(1, { history: history1 }),
          tab(3, { url: SESSION_NEW_TAB_URL, title: '', history: null }),
        ],
        closed: [closed(4, { closedAt: T0 + 9000 })],
        selected: id(1),
      });
      await first.store.flush();
      const saves = first.data.saves;
      const rows = asDatabaseRows(saves.flatMap((save) => save.tabs));
      const documents = Object.fromEntries(
        saves.flatMap((save) => save.documents).map(({ key, value }) => [key, value]),
      );
      const loaded = await loadSession(databaseWith(rows, documents), {
        newWorkspaceId: WORKSPACE,
        now: NOW,
        runId: 1,
      });

      const runtimes: EchoRuntime[] = [];
      // TabManager reports its changes to a store that needs the manager as its source.
      const wired: { store?: SessionStore } = {};
      const manager = new TabManager({
        createRuntime: (_tabId, events) => {
          const runtime = new EchoRuntime(events);
          runtimes.push(runtime);
          return runtime;
        },
        newId: () => id(5000 + runtimes.length),
        onChange: () => {
          wired.store?.changed();
        },
        now: () => NOW,
      });
      manager.restoreSession({
        tabs: loaded.tabs,
        selectedTabId: loaded.selectedTabId,
        closed: loaded.closed,
        loadSelected: true,
      });
      const data = new FakeData();
      harnesses.push(data);
      const store = new SessionStore({
        source: manager,
        data: data as unknown as Pick<DataClient, 'call'>,
        workspaceId: loaded.workspaceId,
        logger: recordingLogger().logger,
        loaded: loaded.rows,
      });
      wired.store = store;
      return { manager, runtimes, store, data };
    };

    const rowsById = (saves: readonly Save[]) =>
      new Map(saves.flatMap((save) => save.tabs).map((row) => [row.id, row]));

    it('writes no tab rows when the restored session has not changed, only the session document', async () => {
      const { store, data } = await restart();

      store.changed();
      await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);

      expect(data.saves).toEqual([
        {
          tabs: [],
          deleteIds: [],
          documents: [{ key: SESSION_DOCUMENT, value: { selectedTabId: id(1) } }],
        },
      ]);
    });

    it('restores only the selected tab, with the stack it had', async () => {
      const { runtimes, manager } = await restart();

      expect(runtimes).toHaveLength(1);
      expect(runtimes[0]?.stack).toEqual(history1);
      expect(manager.tabs().map((tab) => tab.id)).toEqual([id(2), id(1), id(3)]);
    });

    it('writes a tab closed after the restore as a closed row with its stack, then back as a strip row', async () => {
      const { manager, data } = await restart();
      await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
      data.calls.length = 0;

      manager.close(id(1));
      await vi.advanceTimersByTimeAsync(STRUCTURAL_FLUSH_DELAY_MS);

      const afterClose = rowsById(data.saves);
      expect(afterClose.get(id(1))).toMatchObject({
        placement: 'closed',
        pinned: false,
        closedAt: NOW,
        restoreState: { v: 1, ...history1 },
      });
      // The new-tab page that took the selection moved up and was used just now.
      expect(afterClose.get(id(3))).toMatchObject({
        placement: 'strip',
        position: 1,
        lastUsedAt: NOW,
      });
      expect(afterClose.has(id(2))).toBe(false);
      expect(data.saves[0]?.deleteIds).toEqual([]);
      expect(data.saves[0]?.documents).toEqual([
        { key: SESSION_DOCUMENT, value: { selectedTabId: id(3) } },
      ]);
      data.calls.length = 0;

      manager.reopenClosed();
      await vi.advanceTimersByTimeAsync(STRUCTURAL_FLUSH_DELAY_MS);

      expect(rowsById(data.saves).get(id(1))).toMatchObject({
        placement: 'strip',
        position: 1,
        closedAt: null,
        restoreState: { v: 1, ...history1 },
      });
      expect(data.saves[0]?.deleteIds).toEqual([]);
    });

    it('never writes a credential or token from what a page committed or its history holds', async () => {
      const { runtimes, data } = await restart();
      await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
      data.calls.length = 0;
      const runtime = runtimes[0];

      runtime?.events.committed({
        url: 'https://user:PASSWORD@site1.example/cb#access_token=SECRET',
        sameDocument: false,
        canGoBack: true,
        canGoForward: false,
      });
      runtime?.events.titleChanged('Callback');
      if (runtime !== undefined) {
        runtime.stack = {
          index: 1,
          entries: [
            { url: 'https://site1.example/a#id_token=SECRET', title: 'A' },
            {
              url: 'https://user:PASSWORD@site1.example/cb#access_token=SECRET',
              title: 'Callback',
            },
          ],
        };
      }
      await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);

      const row = rowsById(data.saves).get(id(1));
      expect(row).toMatchObject({
        url: 'https://site1.example/cb',
        title: 'Callback',
        restoreState: {
          v: 1,
          index: 1,
          entries: [
            { url: 'https://site1.example/a', title: 'A' },
            { url: 'https://site1.example/cb', title: 'Callback' },
          ],
        },
      });
      expect(JSON.stringify(data.saves)).not.toMatch(/SECRET|PASSWORD/);
    });
  });

  describe('workspace', () => {
    it('puts the workspace id in every row', async () => {
      const harness = setup({ tabs: [tab(1), tab(2)], closed: [closed(3)], selected: id(1) });

      await harness.store.flush();

      expect(harness.data.saves[0]?.tabs.map((row) => row.workspaceId)).toEqual([
        WORKSPACE,
        WORKSPACE,
        WORKSPACE,
      ]);
    });
  });
});
