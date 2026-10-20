import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DataRecovery } from '../../shared/contracts/data-rpc';
import type { Logger } from '../platform/logger';
import { DataClientError } from './data-client';
import type { DataClient, DataReady } from './data-client';
import {
  DataLifecycle,
  HEARTBEAT_MS,
  IDLE_FOR_MAINTENANCE_S,
  MAINTENANCE_POLL_MS,
  MAINTENANCE_TIMEOUT_MS,
} from './data-lifecycle';

/** The part of DataClient the lifecycle uses, recording every call in order. */
class FakeClient {
  state: DataClient['state'] = 'starting';
  readonly calls: { method: string; input: unknown; timeoutMs?: number }[] = [];
  readonly log: string[] = [];
  respond: (method: string) => Promise<unknown> = () => Promise.resolve({});
  closeWith: () => Promise<void> = () => Promise.resolve();
  closedWithin: number[] = [];
  readonly ready: Promise<DataReady>;
  #resolve!: (ready: DataReady) => void;
  #reject!: (error: Error) => void;

  constructor() {
    this.ready = new Promise((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    this.ready.catch(() => undefined);
  }

  open(recovery: DataRecovery | null = null): void {
    this.state = 'ready';
    this.#resolve({ userVersion: 1, runId: 9, previousExit: 'clean', checked: 'none', recovery });
  }

  failToOpen(): void {
    this.state = 'failed';
    this.#reject(new DataClientError('db_newer'));
  }

  async call(
    method: string,
    input: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<unknown> {
    this.calls.push({ method, input, ...options });
    this.log.push(method);
    return this.respond(method);
  }

  async close(timeoutMs: number): Promise<void> {
    this.log.push('close');
    this.closedWithin.push(timeoutMs);
    await this.closeWith();
    this.state = 'closed';
  }
}

function silentLogger(): Logger & { readonly events: string[] } {
  const events: string[] = [];
  const record = (event: string): void => {
    events.push(event);
  };
  return { events, warn: record, error: record };
}

const NOW = Date.UTC(2026, 9, 21, 12);

describe('DataLifecycle', () => {
  let client: FakeClient;
  let logger: ReturnType<typeof silentLogger>;
  let idle: number;
  let recovered: DataRecovery[];
  let lifecycle: DataLifecycle;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    client = new FakeClient();
    logger = silentLogger();
    idle = 0;
    recovered = [];
    lifecycle = new DataLifecycle({
      client: client as unknown as DataClient,
      logger,
      idleSeconds: () => idle,
      onRecovered: (recovery) => recovered.push(recovery),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes a recovery on to the user once the database is open', async () => {
    const recovery: DataRecovery = { kind: 'reset', corruptFile: 'veltriva.db.corrupt-x' };
    client.open(recovery);
    await vi.advanceTimersByTimeAsync(0);
    expect(recovered).toEqual([recovery]);
    expect(logger.events).toContain('data.recovered');
  });

  it('says nothing when opening needed no recovery', async () => {
    client.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(recovered).toEqual([]);
  });

  it("moves the run's heartbeat every minute, with the run id and the time", async () => {
    client.open();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    const beats = client.calls.filter((call) => call.method === 'appRuns.heartbeat');
    expect(beats.map((call) => call.input)).toEqual([
      { id: 9, at: NOW + HEARTBEAT_MS },
      { id: 9, at: NOW + HEARTBEAT_MS * 2 },
    ]);
  });

  it('keeps beating when one heartbeat fails, and logs only its code', async () => {
    client.open();
    client.respond = () => Promise.reject(new DataClientError('timeout', 'appRuns.heartbeat'));
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(client.calls.filter((call) => call.method === 'appRuns.heartbeat')).toHaveLength(2);
    expect(logger.events.filter((event) => event === 'data.heartbeatFailed')).toHaveLength(2);
  });

  it('starts nothing when the database failed to open', async () => {
    client.failToOpen();
    await vi.advanceTimersByTimeAsync(MAINTENANCE_POLL_MS * 2);
    expect(client.calls).toEqual([]);
  });

  describe('upkeep', () => {
    it('runs only while the user has been away long enough', async () => {
      client.open();
      idle = IDLE_FOR_MAINTENANCE_S - 1;
      await vi.advanceTimersByTimeAsync(MAINTENANCE_POLL_MS);
      expect(client.calls.filter((call) => call.method === 'maintenance.run')).toEqual([]);

      idle = IDLE_FOR_MAINTENANCE_S;
      await vi.advanceTimersByTimeAsync(MAINTENANCE_POLL_MS);
      expect(client.calls.filter((call) => call.method === 'maintenance.run')).toEqual([
        {
          method: 'maintenance.run',
          input: { now: NOW + MAINTENANCE_POLL_MS * 2 },
          timeoutMs: MAINTENANCE_TIMEOUT_MS,
        },
      ]);
    });

    it('never overlaps a run still going', async () => {
      client.open();
      idle = IDLE_FOR_MAINTENANCE_S;
      let finish!: () => void;
      client.respond = (method) =>
        method === 'maintenance.run'
          ? new Promise((resolve) => {
              finish = () => {
                resolve({ check: 'ok', backup: 'done', backupFile: 'x.db' });
              };
            })
          : Promise.resolve({});
      await vi.advanceTimersByTimeAsync(MAINTENANCE_POLL_MS * 3);
      expect(client.calls.filter((call) => call.method === 'maintenance.run')).toHaveLength(1);
      finish();
      await vi.advanceTimersByTimeAsync(MAINTENANCE_POLL_MS);
      expect(client.calls.filter((call) => call.method === 'maintenance.run')).toHaveLength(2);
    });

    it('logs a failed check or backup by its outcome only', async () => {
      client.open();
      client.respond = () =>
        Promise.resolve({ check: 'failed', backup: 'skipped', backupFile: null });
      idle = IDLE_FOR_MAINTENANCE_S;
      await lifecycle.maintainIfIdle();
      expect(logger.events).toEqual(['data.maintenance']);
    });
  });

  describe('shutdown', () => {
    it('flushes, ends the run cleanly, then closes, within the cap', async () => {
      client.open();
      await vi.advanceTimersByTimeAsync(0);
      lifecycle.addFlush(async () => {
        client.log.push('flush');
        await Promise.resolve();
      });
      await expect(lifecycle.shutdown(3000)).resolves.toBe('closed');
      expect(client.log).toEqual(['flush', 'appRuns.end', 'close']);
      expect(client.calls.find((call) => call.method === 'appRuns.end')).toMatchObject({
        input: { id: 9, at: NOW, exitKind: 'clean' },
      });
      expect(client.closedWithin[0]).toBeLessThanOrEqual(3000);
    });

    it('stops the timers', async () => {
      client.open();
      await vi.advanceTimersByTimeAsync(0);
      await lifecycle.shutdown(3000);
      client.calls.length = 0;
      idle = IDLE_FOR_MAINTENANCE_S;
      await vi.advanceTimersByTimeAsync(MAINTENANCE_POLL_MS * 2);
      expect(client.calls).toEqual([]);
    });

    it('still ends and closes when a flush fails, and drops an unregistered flush', async () => {
      client.open();
      await vi.advanceTimersByTimeAsync(0);
      lifecycle.addFlush(() => Promise.reject(new Error('flush failed')));
      const removed = vi.fn(() => Promise.resolve());
      lifecycle.addFlush(removed)();
      await expect(lifecycle.shutdown(3000)).resolves.toBe('closed');
      expect(removed).not.toHaveBeenCalled();
      expect(client.log).toEqual(['appRuns.end', 'close']);
    });

    it('reports a timeout at the cap when the worker is stuck in a statement', async () => {
      client.open();
      await vi.advanceTimersByTimeAsync(0);
      client.closeWith = () => new Promise(() => undefined);
      const result = lifecycle.shutdown(3000);
      await vi.advanceTimersByTimeAsync(2999);
      let settled = false;
      void result.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toBe('timeout');
    });

    it("reports the client's own close timeout as a timeout too", async () => {
      client.open();
      await vi.advanceTimersByTimeAsync(0);
      client.closeWith = () => Promise.reject(new DataClientError('timeout', 'close'));
      await expect(lifecycle.shutdown(3000)).resolves.toBe('timeout');
    });

    it("doesn't end a run when the database never opened", async () => {
      client.failToOpen();
      await vi.advanceTimersByTimeAsync(0);
      await expect(lifecycle.shutdown(3000)).resolves.toBe('closed');
      expect(client.log).toEqual(['close']);
    });
  });
});
