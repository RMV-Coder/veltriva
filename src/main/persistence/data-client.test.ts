import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DataRequest } from '../../shared/contracts/data-rpc';
import type { Logger } from '../platform/logger';
import { DataClient, DataClientError } from './data-client';
import type { WorkerPort } from './data-client';

class FakeWorker extends EventEmitter implements WorkerPort {
  readonly sent: DataRequest[] = [];
  terminated = false;

  postMessage(message: DataRequest): void {
    this.sent.push(message);
  }

  async terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(1);
  }

  /** The worker's messages, as worker_threads delivers them. */
  reply(message: unknown): void {
    this.emit('message', message);
  }

  ready(): void {
    this.reply({ kind: 'ready', ...READY });
  }

  respond(index: number, value: unknown): void {
    const request = this.sent[index];
    if (request === undefined) {
      throw new Error(`no request ${String(index)}`);
    }
    this.reply({ kind: 'response', id: request.id, ok: true, value });
  }
}

function recordingLogger(): Logger & { readonly events: string[] } {
  const events: string[] = [];
  const record = (event: string): void => {
    events.push(event);
  };
  return { events, warn: record, error: record };
}

const READY = {
  userVersion: 1,
  runId: 4,
  previousExit: 'clean',
  checked: 'none',
  recovery: null,
} as const;

const INFO = {
  userVersion: 1,
  latestVersion: 1,
  sqliteVersion: '3.53.4',
  journalMode: 'wal',
  autoVacuum: 2,
  synchronous: 1,
  foreignKeys: 1,
  secureDelete: 1,
  busyTimeout: 5000,
  tempStore: 2,
  cacheSize: -16000,
  threadId: 1,
};

/** Lets the client's awaits run (its sends happen after `ready` resolves). */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe('DataClient', () => {
  let worker: FakeWorker;
  let logger: ReturnType<typeof recordingLogger>;
  let client: DataClient;

  beforeEach(() => {
    vi.useFakeTimers();
    worker = new FakeWorker();
    logger = recordingLogger();
    client = new DataClient(worker, { logger, defaultTimeoutMs: 1000, maxInFlight: 3 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends nothing until the worker is ready, then a request with an id and the parsed input', async () => {
    const result = client.call('appState.get', { key: 'session' });
    await settle();
    expect(worker.sent).toEqual([]);

    worker.ready();
    await settle();
    expect(worker.sent).toEqual([
      { kind: 'request', id: 1, method: 'appState.get', input: { key: 'session' } },
    ]);
    worker.respond(0, { value: { selected: null } });
    await expect(result).resolves.toEqual({ value: { selected: null } });
    expect(client.state).toBe('ready');
  });

  it('gives every call its own id and matches answers by id, in any order', async () => {
    worker.ready();
    const first = client.call('appState.get', { key: 'a' });
    const second = client.call('appState.get', { key: 'b' });
    await settle();
    expect(worker.sent.map((request) => request.id)).toEqual([1, 2]);
    worker.respond(1, { value: 2 });
    worker.respond(0, { value: 1 });
    await expect(first).resolves.toEqual({ value: 1 });
    await expect(second).resolves.toEqual({ value: 2 });
  });

  it('refuses input its own contract refuses, before sending anything', async () => {
    worker.ready();
    await expect(client.call('appState.get', { key: 'Not A Key' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(
      client.call('tabs.list', { workspaceId: 'x', placement: 'strip', limit: 10 }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    // Unknown keys too: every input schema is strict.
    await expect(
      client.call('appState.get', { key: 'session', extra: 1 } as never),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(worker.sent).toEqual([]);
    expect(logger.events).toContain('data.invalidInput');
  });

  it('caps every list it asks for', async () => {
    worker.ready();
    await expect(client.call('appRuns.recent', { limit: 101 })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(client.call('downloads.list', { limit: 0 })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it("checks every answer against the method's output schema", async () => {
    worker.ready();
    const result = client.call('db.info', {});
    await settle();
    worker.respond(0, { ...INFO, extra: true });
    await expect(result).rejects.toMatchObject({ code: 'invalid_output', detail: 'db.info' });
    expect(logger.events).toContain('data.invalidOutput');

    const valid = client.call('db.info', {});
    await settle();
    worker.respond(1, INFO);
    await expect(valid).resolves.toEqual(INFO);
  });

  it("passes on the worker's error code and detail", async () => {
    worker.ready();
    const result = client.call('appState.delete', { key: 'session' });
    await settle();
    worker.reply({
      kind: 'response',
      id: 1,
      ok: false,
      error: { code: 'sqlite', detail: 'SQLITE_FULL' },
    });
    const error: unknown = await result.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DataClientError);
    expect(error).toMatchObject({ code: 'sqlite', detail: 'SQLITE_FULL' });
  });

  it('times a call out, and drops its late answer', async () => {
    worker.ready();
    const result = client.call('appState.get', { key: 'session' }, { timeoutMs: 200 });
    const rejected = expect(result).rejects.toMatchObject({ code: 'timeout' });
    await settle();
    await vi.advanceTimersByTimeAsync(200);
    await rejected;
    expect(logger.events).toContain('data.timeout');

    worker.respond(0, { value: null });
    // A later call still works and gets its own answer.
    const next = client.call('appState.get', { key: 'session' });
    await settle();
    worker.respond(1, { value: 7 });
    await expect(next).resolves.toEqual({ value: 7 });
  });

  it('counts the wait for the worker to be ready against the timeout', async () => {
    const result = client.call('appState.get', { key: 'session' }, { timeoutMs: 300 });
    const rejected = expect(result).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(400);
    worker.ready();
    await rejected;
    expect(worker.sent).toEqual([]);
  });

  it('refuses calls beyond the in-flight cap', async () => {
    worker.ready();
    const calls = [1, 2, 3].map((n) => client.call('appState.get', { key: `k${String(n)}` }));
    await settle();
    await expect(client.call('appState.get', { key: 'k4' })).rejects.toMatchObject({
      code: 'busy',
    });
    worker.respond(0, { value: null });
    worker.respond(1, { value: null });
    worker.respond(2, { value: null });
    await Promise.all(calls);
  });

  it('fails every call when opening the database failed', async () => {
    const pending = client.call('appState.get', { key: 'session' });
    worker.reply({ kind: 'fatal', error: { code: 'db_newer', detail: '2 > 1' } });
    await expect(client.ready).rejects.toMatchObject({ code: 'db_newer' });
    await expect(pending).rejects.toMatchObject({ code: 'db_newer', detail: '2 > 1' });
    await expect(client.call('appState.get', { key: 'session' })).rejects.toMatchObject({
      code: 'db_newer',
    });
    expect(client.state).toBe('failed');
    expect(logger.events).toContain('data.openFailed');
  });

  it('fails calls in flight when the worker crashes or exits', async () => {
    worker.ready();
    const pending = client.call('appState.get', { key: 'session' });
    await settle();
    worker.emit('error', new Error('boom'));
    await expect(pending).rejects.toMatchObject({ code: 'worker_gone' });
    expect(logger.events).toContain('data.workerError');

    const other = new FakeWorker();
    const second = new DataClient(other, { logger });
    other.ready();
    const lost = second.call('appState.get', { key: 'session' });
    await settle();
    other.emit('exit', 1);
    await expect(lost).rejects.toMatchObject({ code: 'worker_gone', detail: 'exit 1' });
    expect(second.state).toBe('failed');
  });

  it('ignores a malformed message, and its call times out', async () => {
    worker.ready();
    const result = client.call('appState.get', { key: 'session' });
    const rejected = expect(result).rejects.toMatchObject({ code: 'timeout' });
    await settle();
    worker.reply({ kind: 'response', id: 1, ok: 'yes' });
    worker.reply('not an object');
    expect(logger.events.filter((event) => event === 'data.badMessage')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
  });

  it('keeps db.close for close()', async () => {
    worker.ready();
    await expect(client.call('db.close', {})).rejects.toMatchObject({ code: 'invalid_input' });
    expect(worker.sent).toEqual([]);
  });

  describe('close', () => {
    it('answers calls sent before it, then closes and waits for the thread to exit', async () => {
      worker.ready();
      const before = client.call('appState.get', { key: 'session' });
      await settle();
      const closed = client.close(3000);
      expect(worker.sent.map((request) => request.method)).toEqual(['appState.get', 'db.close']);
      expect(client.state).toBe('closing');
      await expect(client.call('appState.get', { key: 'session' })).rejects.toMatchObject({
        code: 'closed',
      });

      worker.respond(0, { value: null });
      worker.respond(1, {});
      await settle();
      worker.emit('exit', 0);
      await closed;
      await expect(before).resolves.toEqual({ value: null });
      expect(client.state).toBe('closed');
      expect(logger.events).not.toContain('data.workerExit');
    });

    it('gives up at its deadline when the worker is stuck in a statement', async () => {
      worker.ready();
      const closed = client.close(3000);
      const rejected = expect(closed).rejects.toMatchObject({ code: 'timeout' });
      await vi.advanceTimersByTimeAsync(3000);
      await rejected;
    });

    it('waits for a database still opening, within the same deadline', async () => {
      const closed = client.close(3000);
      await vi.advanceTimersByTimeAsync(500);
      expect(worker.sent).toEqual([]);
      worker.ready();
      await settle();
      expect(worker.sent.map((request) => request.method)).toEqual(['db.close']);
      worker.respond(0, {});
      worker.emit('exit', 0);
      await closed;
    });

    it('returns at once when the worker already failed', async () => {
      worker.reply({ kind: 'fatal', error: { code: 'open_failed' } });
      await client.close(3000);
      expect(worker.sent).toEqual([]);
    });

    it("doesn't hang when the thread dies before answering", async () => {
      worker.ready();
      const closed = client.close(3000);
      worker.emit('exit', 1);
      await expect(closed).rejects.toMatchObject({ code: 'closed' });
      expect(client.state).toBe('closed');
    });
  });
});
