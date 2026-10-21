import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClientHintOptIns } from '../../core/net/client-hints';
import { uuidv7 } from '../../core/id/uuidv7';
import { DATA_METHODS, DATA_ERROR_CODES } from '../../shared/contracts/data-rpc';
import type { DataErrorCode, DataMethod, DownloadRow } from '../../shared/contracts/data-rpc';
import { DEFAULT_SETTINGS } from '../../shared/contracts/settings';
import { DataClientError } from './data-client';
import {
  CLIENT_HINTS_DOCUMENT,
  CLIENT_HINTS_WRITE_DELAY_MS,
  ClientHintsWriter,
  EMPTY_STORED_STATE,
  STORED_STATE_DEADLINE_MS,
  decisionWriters,
  isDataUnavailable,
  readStoredState,
} from './stored-state';

const T0 = 1_700_000_000_000;

const UNAVAILABLE: DataErrorCode[] = [
  'closed',
  'worker_gone',
  'open_failed',
  'db_newer',
  'db_foreign',
  'migration_failed',
];
const AVAILABLE: DataErrorCode[] = DATA_ERROR_CODES.filter((code) => !UNAVAILABLE.includes(code));

const download: DownloadRow = {
  id: uuidv7(T0, new Uint8Array(10).fill(7)),
  fileName: 'report.pdf',
  path: 'C:\\Users\\me\\Downloads\\report.pdf',
  url: 'https://files.example/report.pdf',
  site: 'example.com',
  state: 'completed',
  dangerous: false,
  confirmed: true,
  receivedBytes: 10,
  totalBytes: 10,
  startedAt: T0,
  endedAt: T0 + 1000,
};

interface Call {
  readonly method: string;
  readonly input: unknown;
}

type Responder = (method: DataMethod, input: unknown) => unknown;

/**
 * A data client that, like the real one, refuses input its method's schema refuses. `respond`
 * answers with a value (or a promise), or throws what the call rejects with.
 */
function setup(respond: Responder = () => ({})) {
  const calls: Call[] = [];
  const call = vi.fn((method: DataMethod, input: unknown) => {
    DATA_METHODS[method].input.parse(input);
    calls.push({ method, input });
    try {
      return Promise.resolve(respond(method, input));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('failed'));
    }
  });
  const logger = { warn: vi.fn(), error: vi.fn() };
  return { call, calls, logger, data: { call: call as never } };
}

/** Answers each of the four startup reads with what the database would hold. */
function database(
  overrides: Partial<{
    settings: unknown;
    decisions: unknown[];
    clientHints: unknown;
    downloads: unknown[];
  }> = {},
): Responder {
  return (method) => {
    switch (method) {
      case 'settings.get':
        return { value: 'settings' in overrides ? overrides.settings : null };
      case 'permissions.list':
        return { decisions: overrides.decisions ?? [] };
      case 'appState.get':
        return { value: 'clientHints' in overrides ? overrides.clientHints : null };
      case 'downloads.list':
        return { downloads: overrides.downloads ?? [] };
      default:
        return {};
    }
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('isDataUnavailable', () => {
  it.each(UNAVAILABLE)('is true for a DataClientError of %s: the database is not there', (code) => {
    expect(isDataUnavailable(new DataClientError(code))).toBe(true);
    expect(isDataUnavailable(new DataClientError(code, 'detail'))).toBe(true);
  });

  it.each(AVAILABLE)('is false for a DataClientError of %s: the database failed a call', (code) => {
    expect(isDataUnavailable(new DataClientError(code))).toBe(false);
  });

  it.each([
    ['a plain Error', new Error('closed')],
    ['a plain object with a code', { code: 'closed' }],
    ['a string', 'closed'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 7],
  ])('is false for %s', (_what, error) => {
    expect(isDataUnavailable(error)).toBe(false);
  });

  it('names exactly six of the contract’s codes', () => {
    expect(UNAVAILABLE).toHaveLength(6);
    expect(DATA_ERROR_CODES.filter((code) => isDataUnavailable(new DataClientError(code)))).toEqual(
      UNAVAILABLE.toSorted((a, b) => DATA_ERROR_CODES.indexOf(a) - DATA_ERROR_CODES.indexOf(b)),
    );
  });
});

describe('readStoredState: what it reads', () => {
  it('asks for the settings, the permissions, the client hints and the downloads', async () => {
    const { data, calls, logger } = setup(database());

    await readStoredState(data, logger, { downloads: 100 });

    expect(calls).toEqual(
      expect.arrayContaining([
        { method: 'settings.get', input: {} },
        { method: 'permissions.list', input: { limit: 10_000 } },
        { method: 'appState.get', input: { key: 'client_hints' } },
        { method: 'downloads.list', input: { limit: 100 } },
      ]),
    );
    expect(calls).toHaveLength(4);
  });

  it('starts all four reads at once, not one after the other', () => {
    const never = new Promise(() => undefined);
    const { data, calls, logger } = setup(() => never);

    void readStoredState(data, logger, { downloads: 100 });

    // Nothing has resolved, and every call is already out.
    expect(calls).toHaveLength(4);
  });

  it('asks for as many downloads as it is told', async () => {
    const { data, calls, logger } = setup(database());

    await readStoredState(data, logger, { downloads: 37 });

    expect(calls.find((entry) => entry.method === 'downloads.list')?.input).toEqual({ limit: 37 });
  });

  it('is the defaults and nothing else for an empty database', async () => {
    const { data, logger } = setup(database());

    const state = await readStoredState(data, logger, { downloads: 100 });

    expect(state).toEqual({
      settings: DEFAULT_SETTINGS,
      decisions: [],
      alwaysAllowed: [],
      clientHints: null,
      downloads: [],
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('parses the settings document, and gives what it holds', async () => {
    const { data, logger } = setup(
      database({
        settings: {
          search: { template: 'https://search.example/?q={searchTerms}' },
          history: { retentionDays: 30 },
        },
      }),
    );

    const state = await readStoredState(data, logger, { downloads: 100 });

    expect(state.settings).toEqual({
      search: { template: 'https://search.example/?q={searchTerms}' },
      history: { retentionDays: 30 },
    });
  });

  it('gives the defaults for a settings document that is damaged, field by field', async () => {
    const { data, logger } = setup(
      database({
        settings: { search: { template: 'javascript:1' }, history: { retentionDays: 14 } },
      }),
    );

    const state = await readStoredState(data, logger, { downloads: 100 });

    expect(state.settings).toEqual({
      search: DEFAULT_SETTINGS.search,
      history: { retentionDays: 14 },
    });
  });

  it('hands the client hints document on as it is, unchecked', async () => {
    const document = { v: 1, origins: { 'https://example.com': ['sec-ch-ua-arch'] } };
    const { data, logger } = setup(database({ clientHints: document }));

    const state = await readStoredState(data, logger, { downloads: 100 });

    expect(state.clientHints).toEqual(document);
  });

  it('hands the downloads on, newest first as the worker listed them', async () => {
    const { data, logger } = setup(
      database({
        downloads: [download, { ...download, id: uuidv7(T0, new Uint8Array(10).fill(8)) }],
      }),
    );

    const state = await readStoredState(data, logger, { downloads: 100 });

    expect(state.downloads).toHaveLength(2);
    expect(state.downloads[0]).toEqual(download);
  });
});

describe('readStoredState: permission rows', () => {
  const row = (origin: string, permission: string, decision: 'allow' | 'block') => ({
    origin,
    permission,
    decision,
    updatedAt: T0,
  });

  it('keeps the decisions of prompted permissions, allow and block, as stored', async () => {
    const rows = [
      row('https://a.example', 'camera', 'allow'),
      row('https://a.example', 'microphone', 'block'),
      row('https://b.example', 'geolocation', 'allow'),
    ];
    const { data, logger } = setup(database({ decisions: rows }));

    const state = await readStoredState(data, logger, { downloads: 100 });

    expect(state.decisions).toEqual(rows);
    expect(state.alwaysAllowed).toEqual([]);
  });

  it('splits an external protocol’s always-allow row into the site and the scheme', async () => {
    const { data, logger } = setup(
      database({ decisions: [row('https://zoom.example', 'protocol:zoommtg', 'allow')] }),
    );

    const state = await readStoredState(data, logger, { downloads: 100 });

    expect(state.alwaysAllowed).toEqual([{ site: 'https://zoom.example', scheme: 'zoommtg' }]);
    expect(state.decisions).toEqual([]);
  });

  it('keeps a scheme with the characters a scheme may have', async () => {
    const { data, logger } = setup(
      database({ decisions: [row('https://a.example', 'protocol:web+custom.app-1', 'allow')] }),
    );

    const state = await readStoredState(data, logger, { downloads: 100 });

    expect(state.alwaysAllowed).toEqual([
      { site: 'https://a.example', scheme: 'web+custom.app-1' },
    ]);
  });

  it('ignores a protocol row that is a block: only an always-allow is stored for a protocol', async () => {
    const { data, logger } = setup(
      database({ decisions: [row('https://zoom.example', 'protocol:zoommtg', 'block')] }),
    );

    const state = await readStoredState(data, logger, { downloads: 100 });

    expect(state.alwaysAllowed).toEqual([]);
    expect(state.decisions).toEqual([]);
  });

  it('puts a protocol row in the decisions never, and a permission row in the always-allowed never', async () => {
    const rows = [
      row('https://a.example', 'protocol:mailto', 'allow'),
      row('https://a.example', 'camera', 'allow'),
      row('https://b.example', 'protocol:zoommtg', 'allow'),
      row('https://b.example', 'protocol:slack', 'block'),
      row('https://b.example', 'notifications', 'block'),
    ];
    const { data, logger } = setup(database({ decisions: rows }));

    const state = await readStoredState(data, logger, { downloads: 100 });

    expect(state.decisions.map((entry) => entry.permission)).toEqual(['camera', 'notifications']);
    expect(state.alwaysAllowed).toEqual([
      { site: 'https://a.example', scheme: 'mailto' },
      { site: 'https://b.example', scheme: 'zoommtg' },
    ]);
  });

  it('passes a permission name it does not know through, for the decisions to skip', async () => {
    const rows = [row('https://a.example', 'midi', 'allow')];
    const { data, logger } = setup(database({ decisions: rows }));

    const state = await readStoredState(data, logger, { downloads: 100 });

    expect(state.decisions).toEqual(rows);
  });

  it('keeps the order of the rows', async () => {
    const rows = ['camera', 'geolocation', 'microphone', 'notifications'].map((permission) =>
      row('https://a.example', permission, 'allow'),
    );
    const { data, logger } = setup(database({ decisions: rows }));

    const state = await readStoredState(data, logger, { downloads: 100 });

    expect(state.decisions.map((entry) => entry.permission)).toEqual([
      'camera',
      'geolocation',
      'microphone',
      'notifications',
    ]);
  });
});

describe('readStoredState: each read falls back alone', () => {
  /** The database, except for one method that fails. */
  const failing = (method: DataMethod, error: Error): Responder => {
    const rest = database({
      settings: { history: { retentionDays: 30 } },
      decisions: [
        { origin: 'https://a.example', permission: 'camera', decision: 'allow', updatedAt: T0 },
        {
          origin: 'https://z.example',
          permission: 'protocol:zoommtg',
          decision: 'allow',
          updatedAt: T0,
        },
      ],
      clientHints: { v: 1, origins: {} },
      downloads: [download],
    });
    return (called, input) => {
      if (called === method) {
        throw error;
      }
      return rest(called, input);
    };
  };

  it('falls back to the default settings, and reads the rest', async () => {
    const { data, logger } = setup(failing('settings.get', new DataClientError('sqlite')));

    const state = await readStoredState(data, logger, { downloads: 100 });

    expect(state.settings).toEqual(DEFAULT_SETTINGS);
    expect(state.decisions).toHaveLength(1);
    expect(state.alwaysAllowed).toHaveLength(1);
    expect(state.clientHints).toEqual({ v: 1, origins: {} });
    expect(state.downloads).toEqual([download]);
  });

  it('falls back to no decisions and no always-allows, and reads the rest', async () => {
    const { data, logger } = setup(failing('permissions.list', new DataClientError('timeout')));

    const state = await readStoredState(data, logger, { downloads: 100 });

    expect(state.settings.history.retentionDays).toBe(30);
    expect(state.decisions).toEqual([]);
    expect(state.alwaysAllowed).toEqual([]);
    expect(state.clientHints).toEqual({ v: 1, origins: {} });
    expect(state.downloads).toEqual([download]);
  });

  it('falls back to no client hints, and reads the rest', async () => {
    const { data, logger } = setup(failing('appState.get', new DataClientError('sqlite')));

    const state = await readStoredState(data, logger, { downloads: 100 });

    expect(state.clientHints).toBeNull();
    expect(state.settings.history.retentionDays).toBe(30);
    expect(state.decisions).toHaveLength(1);
    expect(state.downloads).toEqual([download]);
  });

  it('falls back to no downloads, and reads the rest', async () => {
    const { data, logger } = setup(failing('downloads.list', new DataClientError('busy')));

    const state = await readStoredState(data, logger, { downloads: 100 });

    expect(state.downloads).toEqual([]);
    expect(state.settings.history.retentionDays).toBe(30);
    expect(state.decisions).toHaveLength(1);
    expect(state.clientHints).toEqual({ v: 1, origins: {} });
  });

  it('is the empty state when every read fails, which is what an unreadable database means', async () => {
    const { data, logger } = setup(() => {
      throw new DataClientError('sqlite');
    });

    const state = await readStoredState(data, logger, { downloads: 100 });

    expect(state).toEqual(EMPTY_STORED_STATE);
  });

  it.each([
    ['settings.get', 'settings'],
    ['permissions.list', 'permissions'],
    ['appState.get', 'clientHints'],
    ['downloads.list', 'downloads'],
  ] as const)('logs a failed %s as %s, with the code', async (method, what) => {
    const { data, logger } = setup(failing(method, new DataClientError('timeout', 'detail')));

    await readStoredState(data, logger, { downloads: 100 });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('storedState.readFailed', { what, code: 'timeout' });
  });

  it('logs an error that is not the client’s as internal, without its message', async () => {
    const { data, logger } = setup(
      failing('settings.get', new Error('boom: C:\\Users\\me\\secret.db')),
    );

    await readStoredState(data, logger, { downloads: 100 });

    expect(logger.warn).toHaveBeenCalledWith('storedState.readFailed', {
      what: 'settings',
      code: 'internal',
    });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret');
  });

  it.each(UNAVAILABLE)('says nothing when the database is not there (%s)', async (code) => {
    const { data, logger } = setup(() => {
      throw new DataClientError(code);
    });

    const state = await readStoredState(data, logger, { downloads: 100 });

    expect(state).toEqual(EMPTY_STORED_STATE);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs each of two failures, and says nothing for a third that is the database being gone', async () => {
    const { data, logger } = setup((method) => {
      if (method === 'settings.get') {
        throw new DataClientError('sqlite');
      }
      if (method === 'permissions.list') {
        throw new DataClientError('busy');
      }
      if (method === 'appState.get') {
        throw new DataClientError('closed');
      }
      return { downloads: [] };
    });

    await readStoredState(data, logger, { downloads: 100 });

    expect(logger.warn.mock.calls).toEqual(
      expect.arrayContaining([
        ['storedState.readFailed', { what: 'settings', code: 'sqlite' }],
        ['storedState.readFailed', { what: 'permissions', code: 'busy' }],
      ]),
    );
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('never rejects, whatever the reads do', async () => {
    const { data, logger } = setup(() => {
      throw new Error('anything');
    });

    await expect(readStoredState(data, logger, { downloads: 100 })).resolves.toBeDefined();
  });
});

describe('readStoredState: the deadline', () => {
  const never = () => new Promise(() => undefined);

  it('gives the empty state when the database has not answered by the deadline', async () => {
    const { data, logger } = setup(never);

    const reading = readStoredState(data, logger, { downloads: 100, deadlineMs: 500 });
    await vi.advanceTimersByTimeAsync(500);

    await expect(reading).resolves.toBe(EMPTY_STORED_STATE);
  });

  it('waits the whole deadline: not a moment less', async () => {
    const { data, logger } = setup(never);
    let state: unknown;
    void readStoredState(data, logger, { downloads: 100, deadlineMs: 500 }).then((value) => {
      state = value;
    });

    await vi.advanceTimersByTimeAsync(499);
    expect(state).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    expect(state).toBe(EMPTY_STORED_STATE);
  });

  it('is 3 seconds when no deadline is given', async () => {
    expect(STORED_STATE_DEADLINE_MS).toBe(3000);
    const { data, logger } = setup(never);
    let state: unknown;
    void readStoredState(data, logger, { downloads: 100 }).then((value) => {
      state = value;
    });

    await vi.advanceTimersByTimeAsync(2999);
    expect(state).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    expect(state).toBe(EMPTY_STORED_STATE);
  });

  it('logs the timeout, with the deadline that was given', async () => {
    const { data, logger } = setup(never);

    void readStoredState(data, logger, { downloads: 100, deadlineMs: 750 });
    await vi.advanceTimersByTimeAsync(750);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('storedState.timedOut', { deadlineMs: 750 });
  });

  // Regression: with no deadline given, the timeout log said `deadlineMs: undefined` instead of
  // the 3000 that applied.
  it('logs the default deadline when none was given', async () => {
    const { data, logger } = setup(never);

    void readStoredState(data, logger, { downloads: 100 });
    await vi.advanceTimersByTimeAsync(STORED_STATE_DEADLINE_MS);

    expect(logger.warn).toHaveBeenCalledWith('storedState.timedOut', {
      deadlineMs: STORED_STATE_DEADLINE_MS,
    });
  });

  it('gives the empty state if even one of the reads is still out at the deadline', async () => {
    const { data, logger } = setup((method) =>
      method === 'downloads.list'
        ? never()
        : database({ settings: { history: { retentionDays: 30 } } })(method, {}),
    );

    const reading = readStoredState(data, logger, { downloads: 100, deadlineMs: 500 });
    await vi.advanceTimersByTimeAsync(500);

    await expect(reading).resolves.toBe(EMPTY_STORED_STATE);
  });

  it('is not triggered when the reads are done in time, and leaves no timer behind', async () => {
    const { data, logger } = setup(database());

    await readStoredState(data, logger, { downloads: 100, deadlineMs: 500 });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(logger.warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is not triggered when every read has failed, which is also an answer', async () => {
    const { data, logger } = setup(() => {
      throw new DataClientError('closed');
    });

    await readStoredState(data, logger, { downloads: 100, deadlineMs: 500 });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(logger.warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the empty state, even if the reads come back after the deadline', async () => {
    let release: (value: unknown) => void = () => undefined;
    const slow = new Promise((resolve) => {
      release = resolve;
    });
    const { data, logger } = setup((method) =>
      method === 'settings.get' ? slow : database()(method, {}),
    );
    const reading = readStoredState(data, logger, { downloads: 100, deadlineMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    const state = await reading;

    release({ value: { history: { retentionDays: 30 } } });
    await vi.advanceTimersByTimeAsync(0);

    expect(state).toBe(EMPTY_STORED_STATE);
  });

  it('is the defaults: the empty state holds what a fresh install starts with', () => {
    expect(EMPTY_STORED_STATE).toEqual({
      settings: DEFAULT_SETTINGS,
      decisions: [],
      alwaysAllowed: [],
      clientHints: null,
      downloads: [],
    });
  });
});

describe('decisionWriters', () => {
  it('writes a permission decision with the time of the decision', async () => {
    const { data, calls, logger } = setup();
    const { permission } = decisionWriters(data, logger, () => T0 + 42);

    permission('https://a.example', 'camera', 'allow');
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toEqual([
      {
        method: 'permissions.set',
        input: {
          origin: 'https://a.example',
          permission: 'camera',
          decision: 'allow',
          updatedAt: T0 + 42,
        },
      },
    ]);
  });

  it.each(['camera', 'microphone', 'geolocation', 'notifications', 'clipboard-read'] as const)(
    'writes a block of %s',
    async (name) => {
      const { data, calls, logger } = setup();
      const { permission } = decisionWriters(data, logger);

      permission('https://a.example:8443', name, 'block');
      await vi.advanceTimersByTimeAsync(0);

      expect(calls[0]?.input).toMatchObject({
        origin: 'https://a.example:8443',
        permission: name,
        decision: 'block',
      });
    },
  );

  it('writes an external protocol’s always-allow as protocol:<scheme>, an allow', async () => {
    const { data, calls, logger } = setup();
    const { alwaysAllow } = decisionWriters(data, logger, () => T0);

    alwaysAllow('https://zoom.example', 'zoommtg');
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toEqual([
      {
        method: 'permissions.set',
        input: {
          origin: 'https://zoom.example',
          permission: 'protocol:zoommtg',
          decision: 'allow',
          updatedAt: T0,
        },
      },
    ]);
  });

  it('reads the clock for each write', async () => {
    const { data, calls, logger } = setup();
    let now = T0;
    const { permission, alwaysAllow } = decisionWriters(data, logger, () => now);

    permission('https://a.example', 'camera', 'allow');
    now += 1000;
    alwaysAllow('https://a.example', 'mailto');
    await vi.advanceTimersByTimeAsync(0);

    expect(calls.map((entry) => (entry.input as { updatedAt: number }).updatedAt)).toEqual([
      T0,
      T0 + 1000,
    ]);
  });

  it('uses the system clock when none is given', async () => {
    const { data, calls, logger } = setup();
    const { permission } = decisionWriters(data, logger);

    permission('https://a.example', 'camera', 'allow');
    await vi.advanceTimersByTimeAsync(0);

    expect((calls[0]?.input as { updatedAt: number }).updatedAt).toBe(T0);
  });

  it('writes each decision of a call as its own write', async () => {
    const { data, calls, logger } = setup();
    const { permission } = decisionWriters(data, logger);

    permission('https://a.example', 'camera', 'allow');
    permission('https://a.example', 'microphone', 'allow');
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toHaveLength(2);
  });

  it.each(AVAILABLE.filter((code) => code !== 'invalid_input'))(
    'logs a failed write by its code (%s)',
    async (code) => {
      const { data, logger } = setup(() => {
        throw new DataClientError(code, 'detail');
      });
      const { permission, alwaysAllow } = decisionWriters(data, logger);

      permission('https://a.example', 'camera', 'allow');
      alwaysAllow('https://a.example', 'mailto');
      await vi.advanceTimersByTimeAsync(0);

      expect(logger.warn.mock.calls).toEqual([
        ['storedState.writeFailed', { what: 'permission', code }],
        ['storedState.writeFailed', { what: 'permission', code }],
      ]);
    },
  );

  it.each(UNAVAILABLE)('says nothing when the database is not there (%s)', async (code) => {
    const { data, logger } = setup(() => {
      throw new DataClientError(code);
    });
    const { permission } = decisionWriters(data, logger);

    permission('https://a.example', 'camera', 'allow');
    await vi.advanceTimersByTimeAsync(0);

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs an error that is not the client’s as internal, without the origin', async () => {
    const { data, logger } = setup(() => {
      throw new Error('boom at https://a.example');
    });
    const { permission } = decisionWriters(data, logger);

    permission('https://a.example', 'camera', 'allow');
    await vi.advanceTimersByTimeAsync(0);

    expect(logger.warn).toHaveBeenCalledWith('storedState.writeFailed', {
      what: 'permission',
      code: 'internal',
    });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('a.example');
  });

  it('never throws, and returns before the write is done', async () => {
    const { data, logger } = setup(() => {
      throw new DataClientError('sqlite');
    });
    const writers = decisionWriters(data, logger);
    const permission = writers.permission as (...args: unknown[]) => unknown;
    const alwaysAllow = writers.alwaysAllow as (...args: unknown[]) => unknown;

    // Neither hands back the write, which nobody waits for.
    expect(permission('https://a.example', 'camera', 'allow')).toBeUndefined();
    expect(alwaysAllow('https://a.example', 'mailto')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
  });
});

describe('ClientHintsWriter', () => {
  function writer(respond: Responder = () => ({})) {
    const { data, calls, logger } = setup(respond);
    const optIns = new ClientHintOptIns();
    const document = vi.fn(() => optIns.toDocument());
    const hints = new ClientHintsWriter({ data, logger, document });
    return { hints, calls, logger, document, optIns };
  }

  it('writes after 5 seconds, not before, as one appState.set of the client_hints document', async () => {
    expect(CLIENT_HINTS_WRITE_DELAY_MS).toBe(5000);
    expect(CLIENT_HINTS_DOCUMENT).toBe('client_hints');
    const { hints, calls, optIns } = writer();
    optIns.remember('https://example.com/', 'Sec-CH-UA-Arch');

    hints.changed();
    await vi.advanceTimersByTimeAsync(CLIENT_HINTS_WRITE_DELAY_MS - 1);
    expect(calls).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([
      {
        method: 'appState.set',
        input: {
          key: 'client_hints',
          value: { v: 1, origins: { 'https://example.com': ['sec-ch-ua-arch'] } },
        },
      },
    ]);
  });

  it('writes a burst of changes once, and the document as it is at the end', async () => {
    const { hints, calls, optIns } = writer();

    optIns.remember('https://a.example/', 'Sec-CH-UA-Arch');
    hints.changed();
    await vi.advanceTimersByTimeAsync(3000);
    optIns.remember('https://b.example/', 'Sec-CH-UA-Model');
    hints.changed();
    await vi.advanceTimersByTimeAsync(1999);
    optIns.remember('https://c.example/', 'Sec-CH-UA-Bitness');
    hints.changed();
    await vi.advanceTimersByTimeAsync(1);

    expect(calls).toHaveLength(1);
    const { value } = calls[0]?.input as { value: { origins: Record<string, string[]> } };
    expect(Object.keys(value.origins)).toEqual([
      'https://a.example',
      'https://b.example',
      'https://c.example',
    ]);
  });

  it('does not push the write back with each change: the wait is from the first one', async () => {
    const { hints, calls } = writer();

    hints.changed();
    await vi.advanceTimersByTimeAsync(4000);
    hints.changed();
    await vi.advanceTimersByTimeAsync(1000);

    expect(calls).toHaveLength(1);
  });

  it('asks for the document when it writes, not when the change was made', async () => {
    const { hints, document } = writer();

    hints.changed();
    hints.changed();
    expect(document).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(CLIENT_HINTS_WRITE_DELAY_MS);
    expect(document).toHaveBeenCalledTimes(1);
  });

  it('writes again for a change after a write, 5 seconds later', async () => {
    const { hints, calls } = writer();
    hints.changed();
    await vi.advanceTimersByTimeAsync(CLIENT_HINTS_WRITE_DELAY_MS);
    expect(calls).toHaveLength(1);

    hints.changed();
    await vi.advanceTimersByTimeAsync(CLIENT_HINTS_WRITE_DELAY_MS - 1);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
  });

  it('writes nothing when nothing changed', async () => {
    const { hints, calls } = writer();

    await vi.advanceTimersByTimeAsync(60_000);
    await hints.flush();

    expect(calls).toEqual([]);
  });

  it('leaves no timer behind after it has written', async () => {
    const { hints } = writer();
    hints.changed();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(CLIENT_HINTS_WRITE_DELAY_MS);

    expect(vi.getTimerCount()).toBe(0);
  });

  describe('flush', () => {
    it('writes at once when a change is waiting, and not again when the wait would have ended', async () => {
      const { hints, calls } = writer();
      hints.changed();

      await hints.flush();
      expect(calls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(CLIENT_HINTS_WRITE_DELAY_MS * 2);
      expect(calls).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('writes nothing when nothing is dirty, and can be called twice', async () => {
      const { hints, calls } = writer();
      hints.changed();

      await hints.flush();
      await hints.flush();

      expect(calls).toHaveLength(1);
    });

    it('does not write after a write that the timer made', async () => {
      const { hints, calls } = writer();
      hints.changed();
      await vi.advanceTimersByTimeAsync(CLIENT_HINTS_WRITE_DELAY_MS);

      await hints.flush();

      expect(calls).toHaveLength(1);
    });

    it('returns only when the write is done', async () => {
      let release: (value: unknown) => void = () => undefined;
      const { hints } = writer(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      hints.changed();
      let done = false;

      const flushing = hints.flush().then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(false);

      release({});
      await flushing;
      expect(done).toBe(true);
    });

    it('writes a change made while an earlier write was out, after it, as the next one', async () => {
      let release: (value: unknown) => void = () => undefined;
      const { hints, calls } = writer(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      hints.changed();
      const first = hints.flush();
      await vi.advanceTimersByTimeAsync(0);

      hints.changed();
      release({});
      await first;
      expect(calls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(CLIENT_HINTS_WRITE_DELAY_MS);
      expect(calls).toHaveLength(2);
    });
  });

  describe('when a write fails', () => {
    it.each(AVAILABLE.filter((code) => code !== 'invalid_input'))(
      'logs it by its code (%s), and does not throw',
      async (code) => {
        const { hints, logger } = writer(() => {
          throw new DataClientError(code, 'detail');
        });
        hints.changed();

        await expect(hints.flush()).resolves.toBeUndefined();

        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith('storedState.writeFailed', {
          what: 'clientHints',
          code,
        });
      },
    );

    it.each(UNAVAILABLE)('says nothing when the database is not there (%s)', async (code) => {
      const { hints, logger } = writer(() => {
        throw new DataClientError(code);
      });
      hints.changed();

      await hints.flush();

      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('logs an error that is not the client’s as internal', async () => {
      const { hints, logger } = writer(() => {
        throw new Error('boom');
      });
      hints.changed();

      await hints.flush();

      expect(logger.warn).toHaveBeenCalledWith('storedState.writeFailed', {
        what: 'clientHints',
        code: 'internal',
      });
    });

    it('logs from the timer too, without anything rejecting', async () => {
      const { hints, logger } = writer(() => {
        throw new DataClientError('sqlite');
      });
      hints.changed();

      await vi.advanceTimersByTimeAsync(CLIENT_HINTS_WRITE_DELAY_MS);

      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('drops the change: the next flush writes nothing, and the next change writes again', async () => {
      let failures = 1;
      const { hints, calls } = writer(() => {
        if (failures > 0) {
          failures -= 1;
          throw new DataClientError('sqlite');
        }
        return {};
      });
      hints.changed();
      await hints.flush();
      expect(calls).toHaveLength(1);

      await hints.flush();
      expect(calls).toHaveLength(1);

      hints.changed();
      await hints.flush();
      expect(calls).toHaveLength(2);
    });
  });
});
