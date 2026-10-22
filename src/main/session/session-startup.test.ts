import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UUID_V7_PATTERN, uuidv7 } from '../../core/id/uuidv7';
import type { AppRunRow, DataMethod, TabRow } from '../../shared/contracts/data-rpc';
import { DataClientError } from '../persistence/data-client';
import type { DataClient, DataReady } from '../persistence/data-client';
import type { Logger } from '../platform/logger';
import { SESSION_LOAD_DEADLINE_MS, readSessionAtStartup } from './session-startup';

const NOW = Date.UTC(2026, 9, 21, 12);
const T0 = 1_700_000_000_000;
const RUN_ID = 12;
const WORKSPACE = uuidv7(T0, new Uint8Array(10).fill(3));
const TAB_ID = uuidv7(T0 + 1, new Uint8Array(10).fill(4));

function ready(overrides: Partial<DataReady> = {}): DataReady {
  return {
    userVersion: 1,
    runId: RUN_ID,
    previousExit: 'clean',
    checked: 'none',
    recovery: null,
    ...overrides,
  };
}

function run(
  id: number,
  startedAt: number,
  lastedMs: number,
  exitKind: 'clean' | 'crash',
): AppRunRow {
  return {
    id,
    startedAt,
    lastHeartbeatAt: startedAt + lastedMs,
    endedAt: startedAt + lastedMs,
    exitKind,
    appVersion: '0.0.0',
  };
}

/** The current run, which has not ended, then the earlier ones, newest first. */
function runsWith(...earlier: AppRunRow[]): AppRunRow[] {
  return [{ ...run(RUN_ID, NOW, 0, 'clean'), endedAt: null, exitKind: null }, ...earlier];
}

const tabRow: TabRow = {
  id: TAB_ID,
  workspaceId: WORKSPACE,
  placement: 'strip',
  position: 0,
  pinned: false,
  userProtected: false,
  pageId: null,
  url: 'https://site.example/',
  title: 'Site',
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
};

/** The part of DataClient the startup read uses: `ready`, and `call` answering what loading asks. */
class FakeClient {
  readonly calls: { method: DataMethod; input: unknown }[] = [];
  runs: AppRunRow[] = runsWith();
  strip: TabRow[] = [tabRow];
  failing: { method: DataMethod; error: unknown } | null = null;
  readonly ready: Promise<DataReady>;
  readonly #resolve: (value: DataReady) => void;
  readonly #reject: (error: unknown) => void;

  constructor() {
    const { promise, resolve, reject } = Promise.withResolvers<DataReady>();
    this.ready = promise;
    this.#resolve = resolve;
    this.#reject = reject;
    // The test may never wait on `ready` (a timeout): that is not an unhandled rejection.
    promise.catch(() => undefined);
  }

  open(value: DataReady = ready()): void {
    this.#resolve(value);
  }

  failToOpen(error: unknown): void {
    this.#reject(error);
  }

  async call(method: DataMethod, input: unknown): Promise<unknown> {
    this.calls.push({ method, input });
    await Promise.resolve();
    if (this.failing?.method === method) {
      throw this.failing.error;
    }
    switch (method) {
      case 'workspaces.ensureDefault':
        return { id: WORKSPACE, created: false };
      case 'tabs.purgeClosed':
        return { count: 0 };
      case 'tabs.list':
        return { tabs: (input as { placement?: string }).placement === 'shelf' ? [] : this.strip };
      case 'tabs.listArchived':
        return { tabs: [] };
      case 'tabs.countArchived':
        return { count: 0 };
      case 'tabs.listClosed':
        return { tabs: [] };
      case 'appState.get':
        return { value: null };
      case 'appRuns.recent':
        return { runs: this.runs };
      default:
        throw new Error(`unexpected call to ${method}`);
    }
  }

  asData(): Pick<DataClient, 'call' | 'ready'> {
    return this as unknown as Pick<DataClient, 'call' | 'ready'>;
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

describe('readSessionAtStartup', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('a normal start', () => {
    it('resolves with the database state, the loaded session, and no safe mode', async () => {
      const client = new FakeClient();
      const { logger, events } = recordingLogger();
      client.open(ready({ previousExit: 'clean' }));

      const startup = await readSessionAtStartup(client.asData(), logger);

      expect(startup?.ready).toEqual(ready());
      expect(startup?.safeMode).toBe(false);
      expect(startup?.loaded.workspaceId).toBe(WORKSPACE);
      expect(startup?.loaded.tabs.map((tab) => tab.id)).toEqual([TAB_ID]);
      expect(events).toEqual([]);
    });

    it('waits for the database to be ready before it asks anything', async () => {
      const client = new FakeClient();
      const { logger } = recordingLogger();

      const pending = readSessionAtStartup(client.asData(), logger);
      await vi.advanceTimersByTimeAsync(1000);
      expect(client.calls).toEqual([]);
      client.open();
      await pending;

      expect(client.calls.length).toBeGreaterThan(0);
    });

    it('proposes a new workspace id that is a UUIDv7 stamped with the time, and passes the time', async () => {
      const client = new FakeClient();
      client.open();

      await readSessionAtStartup(client.asData(), recordingLogger().logger);

      const input = client.calls.find((call) => call.method === 'workspaces.ensureDefault')
        ?.input as {
        candidateId: string;
        name: string;
        now: number;
      };
      expect(input.candidateId).toMatch(UUID_V7_PATTERN);
      expect(input.candidateId.replaceAll('-', '').slice(0, 12)).toBe(
        NOW.toString(16).padStart(12, '0'),
      );
      expect(input).toMatchObject({ name: 'Default', now: NOW });
    });

    it('proposes a different id on every start', async () => {
      const candidates: string[] = [];
      for (let start = 0; start < 3; start += 1) {
        const client = new FakeClient();
        client.open();
        await readSessionAtStartup(client.asData(), recordingLogger().logger);
        candidates.push(
          (
            client.calls.find((call) => call.method === 'workspaces.ensureDefault')?.input as {
              candidateId: string;
            }
          ).candidateId,
        );
      }

      expect(new Set(candidates).size).toBe(3);
    });

    it('leaves no timer behind once it has resolved', async () => {
      const client = new FakeClient();
      client.open();

      await readSessionAtStartup(client.asData(), recordingLogger().logger);

      expect(vi.getTimerCount()).toBe(0);
    });

    it('does not log a timeout when the load finishes in time, however long the app then runs', async () => {
      const client = new FakeClient();
      const { logger, events } = recordingLogger();
      client.open();

      await readSessionAtStartup(client.asData(), logger);
      await vi.advanceTimersByTimeAsync(SESSION_LOAD_DEADLINE_MS * 3);

      expect(events).toEqual([]);
    });
  });

  describe('safe mode', () => {
    const crash = (id: number, startedAt: number, lastedMs: number) =>
      run(id, startedAt, lastedMs, 'crash');
    const clean = (id: number, startedAt: number, lastedMs: number) =>
      run(id, startedAt, lastedMs, 'clean');

    const safeModeFor = async (runs: AppRunRow[]): Promise<boolean | undefined> => {
      const client = new FakeClient();
      client.runs = runs;
      client.open();
      return (await readSessionAtStartup(client.asData(), recordingLogger().logger))?.safeMode;
    };

    it('is on after two crashes in a row, each soon after it started', async () => {
      expect(
        await safeModeFor(runsWith(crash(11, NOW - 60_000, 5000), crash(10, NOW - 120_000, 5000))),
      ).toBe(true);
    });

    it('is off with only one earlier run', async () => {
      expect(await safeModeFor(runsWith(crash(11, NOW - 60_000, 5000)))).toBe(false);
    });

    it('is off on a first start', async () => {
      expect(await safeModeFor(runsWith())).toBe(false);
    });

    it('is off when one of the last two runs ended cleanly', async () => {
      expect(
        await safeModeFor(runsWith(crash(11, NOW - 60_000, 5000), clean(10, NOW - 120_000, 5000))),
      ).toBe(false);
      expect(
        await safeModeFor(runsWith(clean(11, NOW - 60_000, 5000), crash(10, NOW - 120_000, 5000))),
      ).toBe(false);
    });

    it('is off when a crash came a minute or more after the start', async () => {
      expect(
        await safeModeFor(
          runsWith(crash(11, NOW - 600_000, 60_000), crash(10, NOW - 900_000, 5000)),
        ),
      ).toBe(false);
    });

    it('does not count the current run, which has not ended, as a crash', async () => {
      // Only the two earlier runs matter; the current one (no end, no exit kind) is dropped.
      expect(
        await safeModeFor(runsWith(crash(11, NOW - 60_000, 100), clean(10, NOW - 120_000, 100))),
      ).toBe(false);
    });

    it('uses the run id the database reported to tell which run is the current one', async () => {
      const client = new FakeClient();
      // Three crashes; the newest is this run (id 12). Without dropping it there would be a loop of
      // three. With it dropped, the two before it are a loop too, and a run with another id is kept.
      client.runs = [
        crash(RUN_ID, NOW, 0),
        crash(11, NOW - 60_000, 100),
        clean(10, NOW - 120_000, 100),
      ];
      client.open(ready({ runId: RUN_ID }));

      const startup = await readSessionAtStartup(client.asData(), recordingLogger().logger);

      expect(startup?.loaded.previousRuns.map((entry) => entry.exitKind)).toEqual([
        'crash',
        'clean',
      ]);
      expect(startup?.safeMode).toBe(false);
    });

    it('still loads the tabs, so that they come back unloaded', async () => {
      const client = new FakeClient();
      client.runs = runsWith(crash(11, NOW - 60_000, 5000), crash(10, NOW - 120_000, 5000));
      client.open();

      const startup = await readSessionAtStartup(client.asData(), recordingLogger().logger);

      expect(startup?.safeMode).toBe(true);
      expect(startup?.loaded.tabs).toHaveLength(1);
    });
  });

  describe('when the session can not be read', () => {
    it('resolves null and logs the code when the database failed to open', async () => {
      const client = new FakeClient();
      const { logger, events } = recordingLogger();
      client.failToOpen(new DataClientError('db_newer', 'user_version 9'));

      const startup = await readSessionAtStartup(client.asData(), logger);

      expect(startup).toBeNull();
      expect(events).toEqual([
        { level: 'error', event: 'session.loadFailed', fields: { code: 'db_newer' } },
      ]);
      expect(client.calls).toEqual([]);
    });

    it.each([
      'workspaces.ensureDefault',
      'tabs.purgeClosed',
      'tabs.list',
      'appRuns.recent',
    ] as const)('resolves null and logs the code when %s fails', async (method) => {
      const client = new FakeClient();
      const { logger, events } = recordingLogger();
      client.failing = { method, error: new DataClientError('timeout', method) };
      client.open();

      const startup = await readSessionAtStartup(client.asData(), logger);

      expect(startup).toBeNull();
      expect(events).toEqual([
        { level: 'error', event: 'session.loadFailed', fields: { code: 'timeout' } },
      ]);
    });

    it('logs internal, and never the message, for an error that is not the data client’s', async () => {
      const client = new FakeClient();
      const { logger, events } = recordingLogger();
      client.failing = {
        method: 'tabs.list',
        error: new Error('could not read https://private.example/secret'),
      };
      client.open();

      const startup = await readSessionAtStartup(client.asData(), logger);

      expect(startup).toBeNull();
      expect(events).toEqual([
        { level: 'error', event: 'session.loadFailed', fields: { code: 'internal' } },
      ]);
      expect(JSON.stringify(events)).not.toContain('private.example');
    });

    it('leaves no timer behind after a failure', async () => {
      const client = new FakeClient();
      client.failToOpen(new DataClientError('open_failed'));

      await readSessionAtStartup(client.asData(), recordingLogger().logger);

      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('the deadline', () => {
    it('is 10 seconds', () => {
      expect(SESSION_LOAD_DEADLINE_MS).toBe(10_000);
    });

    it('resolves null and logs session.loadTimedOut when the database is never ready', async () => {
      const client = new FakeClient();
      const { logger, events } = recordingLogger();

      const pending = readSessionAtStartup(client.asData(), logger);
      await vi.advanceTimersByTimeAsync(SESSION_LOAD_DEADLINE_MS - 1);
      expect(events).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);

      await expect(pending).resolves.toBeNull();
      expect(events).toEqual([
        {
          level: 'error',
          event: 'session.loadTimedOut',
          fields: { deadlineMs: SESSION_LOAD_DEADLINE_MS },
        },
      ]);
    });

    it('honours a deadline it is given', async () => {
      const client = new FakeClient();
      const { logger, events } = recordingLogger();

      const pending = readSessionAtStartup(client.asData(), logger, 500);
      await vi.advanceTimersByTimeAsync(499);
      expect(events).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);

      await expect(pending).resolves.toBeNull();
      expect(events[0]).toMatchObject({
        event: 'session.loadTimedOut',
        fields: { deadlineMs: 500 },
      });
    });

    it('applies to a call that never answers too', async () => {
      const client = new FakeClient();
      const { logger, events } = recordingLogger();
      client.call = () => new Promise<never>(() => undefined);
      client.open();

      const pending = readSessionAtStartup(client.asData(), logger);
      await vi.advanceTimersByTimeAsync(SESSION_LOAD_DEADLINE_MS);

      await expect(pending).resolves.toBeNull();
      expect(events.map((entry) => entry.event)).toEqual(['session.loadTimedOut']);
    });

    it('is not an error when the database becomes ready after it: nothing more is logged', async () => {
      const client = new FakeClient();
      const { logger, events } = recordingLogger();
      const pending = readSessionAtStartup(client.asData(), logger, 1000);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(pending).resolves.toBeNull();

      client.open();
      await vi.advanceTimersByTimeAsync(5000);

      expect(events.map((entry) => entry.event)).toEqual(['session.loadTimedOut']);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('does not fire when the load finishes just before it', async () => {
      const client = new FakeClient();
      const { logger, events } = recordingLogger();
      const pending = readSessionAtStartup(client.asData(), logger, 1000);
      await vi.advanceTimersByTimeAsync(999);
      client.open();

      const startup = await pending;

      expect(startup).not.toBeNull();
      await vi.advanceTimersByTimeAsync(5000);
      expect(events).toEqual([]);
    });
  });
});
