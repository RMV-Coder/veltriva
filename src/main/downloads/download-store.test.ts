import { describe, expect, it, vi } from 'vitest';

import { uuidv7 } from '../../core/id/uuidv7';
import { DATA_METHODS } from '../../shared/contracts/data-rpc';
import type { DataInput, DataMethod, DownloadRow } from '../../shared/contracts/data-rpc';
import { DataClientError } from '../persistence/data-client';
import { MAX_LISTED_DOWNLOADS } from './download-manager';
import { createDownloadStore, loadDownloads } from './download-store';

const id = uuidv7(1_700_000_000_000, new Uint8Array(10).fill(7));
const row: DownloadRow = {
  id,
  fileName: 'report.pdf',
  path: 'C:\\Users\\me\\Downloads\\report.pdf',
  url: 'https://files.example/report.pdf',
  site: 'example.com',
  state: 'completed',
  dangerous: false,
  confirmed: true,
  receivedBytes: 10,
  totalBytes: 10,
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_001_000,
};

/** A data client that, like the real one, refuses input its method's schema refuses. */
function setup(answer: (method: string, input: unknown) => unknown = () => ({})) {
  const calls: { method: string; input: unknown }[] = [];
  const call = vi.fn((method: DataMethod, input: unknown) => {
    DATA_METHODS[method].input.parse(input);
    calls.push({ method, input });
    try {
      return Promise.resolve(answer(method, input));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('failed'));
    }
  });
  const logger = { warn: vi.fn(), error: vi.fn() };
  const data = { call: call as never };
  return { calls, call, logger, data, store: createDownloadStore({ data, logger }) };
}

/** Lets every promise the store started settle. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('createDownloadStore', () => {
  it('upserts, deletes and clears through the data worker, in the order asked', async () => {
    const { calls, store, logger } = setup();
    store.upsert(row);
    store.remove(id);
    store.clear();
    await settle();
    expect(calls).toEqual([
      { method: 'downloads.upsert', input: row },
      { method: 'downloads.delete', input: { id } },
      { method: 'downloads.clear', input: {} },
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs a failed write by its code, and never rejects', async () => {
    const { store, logger } = setup(() => {
      throw new DataClientError('sqlite', 'SQLITE_FULL');
    });
    store.upsert(row);
    store.remove(id);
    store.clear();
    await settle();
    expect(logger.warn.mock.calls).toEqual([
      ['downloads.writeFailed', { method: 'downloads.upsert', code: 'sqlite' }],
      ['downloads.writeFailed', { method: 'downloads.delete', code: 'sqlite' }],
      ['downloads.writeFailed', { method: 'downloads.clear', code: 'sqlite' }],
    ]);
    // Neither the row nor its detail: the address and the path are the user's.
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('files.example');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('SQLITE_FULL');
  });

  it.each(['closed', 'worker_gone', 'open_failed', 'db_newer', 'db_foreign', 'migration_failed'])(
    'says nothing when the database is not there (%s)',
    async (code) => {
      const { store, logger } = setup(() => {
        throw new DataClientError(code as never);
      });
      store.upsert(row);
      store.remove(id);
      store.clear();
      await settle();
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );

  it.each(['timeout', 'busy', 'invalid_input', 'sqlite'])('reports %s', async (code) => {
    const { store, logger } = setup(() => {
      throw new DataClientError(code as never);
    });
    store.upsert(row);
    await settle();
    expect(logger.warn).toHaveBeenCalledWith('downloads.writeFailed', {
      method: 'downloads.upsert',
      code,
    });
  });

  it('reports an error that is not the client’s as internal', async () => {
    const { store, logger } = setup(() => {
      throw new TypeError('boom');
    });
    store.upsert(row);
    await settle();
    expect(logger.warn).toHaveBeenCalledWith('downloads.writeFailed', {
      method: 'downloads.upsert',
      code: 'internal',
    });
  });

  it('survives a client that throws at once, or answers with no promise', async () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const throwing = createDownloadStore({
      data: {
        call: () => {
          throw new Error('no client');
        },
      },
      logger,
    });
    expect(() => {
      throwing.upsert(row);
      throwing.remove(id);
      throwing.clear();
    }).not.toThrow();
    const silent = createDownloadStore({ data: { call: (() => undefined) as never }, logger });
    expect(() => {
      silent.upsert(row);
    }).not.toThrow();
    await settle();
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });
});

describe('loadDownloads', () => {
  it('lists the stored downloads, newest first, up to the number the list holds', async () => {
    const { call, data, logger } = setup(() => ({ downloads: [row] }));
    await expect(loadDownloads({ data, logger })).resolves.toEqual([row]);
    expect(call).toHaveBeenCalledWith('downloads.list', { limit: MAX_LISTED_DOWNLOADS });
    await loadDownloads({ data, logger, limit: 5 });
    expect(call).toHaveBeenLastCalledWith('downloads.list', {
      limit: 5,
    } satisfies DataInput<'downloads.list'>);
  });

  it('answers an empty list, and says why by code, when it cannot read', async () => {
    const failing = setup(() => {
      throw new DataClientError('timeout', 'downloads.list');
    });
    await expect(loadDownloads({ data: failing.data, logger: failing.logger })).resolves.toEqual(
      [],
    );
    expect(failing.logger.warn).toHaveBeenCalledWith('downloads.readFailed', {
      method: 'downloads.list',
      code: 'timeout',
    });
  });

  it('answers an empty list, silently, when the database is not there', async () => {
    const gone = setup(() => {
      throw new DataClientError('db_newer');
    });
    await expect(loadDownloads({ data: gone.data, logger: gone.logger })).resolves.toEqual([]);
    expect(gone.logger.warn).not.toHaveBeenCalled();
  });
});
