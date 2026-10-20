// Turns one incoming message into at most one reply (ADR-0005 §5's order, applied to the data
// worker): parse the envelope, check the method, parse the input strictly, run the handler, and
// answer with a value or an error code. It's separate from the thread plumbing in ./worker.ts so
// tests can drive it directly.
import type { DatabaseConnection } from 'better-sqlite3/win32-x64';

import type { DataMessage, DataOutput } from '../shared/contracts/data-rpc';
import { DATA_METHODS, dataRequestSchema, isDataMethod } from '../shared/contracts/data-rpc';
import { toErrorInfo } from './errors';
import type { RepositoryHandlers } from './handlers';

export interface DataServerContext {
  readonly db: DatabaseConnection;
  readonly latestVersion: number;
  /** The worker's threadId (0 would mean main's thread, which must never happen). */
  readonly threadId: number;
}

export interface HandledMessage {
  readonly reply: DataMessage | null;
  /** The connection is closed: the worker should stop listening and exit. */
  readonly closed: boolean;
}

export interface DataServer {
  handle(message: unknown): HandledMessage;
}

export function createDataServer(
  context: DataServerContext,
  repositories: RepositoryHandlers,
): DataServer {
  const { db } = context;
  let closed = false;

  const info = (): DataOutput<'db.info'> => {
    const read = (pragma: string): unknown => db.pragma(pragma, { simple: true });
    const int = (pragma: string): number => {
      const value = read(pragma);
      return typeof value === 'number' ? value : -1;
    };
    const sqliteVersion = db.prepare('SELECT sqlite_version()').pluck().get();
    const journalMode = read('journal_mode');
    return {
      userVersion: int('user_version'),
      latestVersion: context.latestVersion,
      sqliteVersion: typeof sqliteVersion === 'string' ? sqliteVersion : '',
      journalMode: typeof journalMode === 'string' ? journalMode : '',
      autoVacuum: int('auto_vacuum'),
      synchronous: int('synchronous'),
      foreignKeys: int('foreign_keys'),
      secureDelete: int('secure_delete'),
      busyTimeout: int('busy_timeout'),
      tempStore: int('temp_store'),
      cacheSize: int('cache_size'),
      threadId: context.threadId,
    };
  };

  return {
    handle(message) {
      const request = dataRequestSchema.safeParse(message);
      if (!request.success) {
        // Without a valid envelope there is no id to answer; main's per-call timeout covers it.
        return { reply: null, closed };
      }
      const { id, method } = request.data;
      const fail = (error: unknown): HandledMessage => ({
        reply: { kind: 'response', id, ok: false, error: toErrorInfo(error) },
        closed,
      });
      if (closed) {
        return {
          reply: { kind: 'response', id, ok: false, error: { code: 'closed' } },
          closed,
        };
      }
      if (!isDataMethod(method)) {
        return {
          reply: { kind: 'response', id, ok: false, error: { code: 'unknown_method' } },
          closed,
        };
      }
      const input = DATA_METHODS[method].input.safeParse(request.data.input);
      if (!input.success) {
        return {
          reply: { kind: 'response', id, ok: false, error: { code: 'invalid_input' } },
          closed,
        };
      }
      try {
        let value: unknown;
        if (method === 'db.info') {
          value = info();
        } else if (method === 'db.close') {
          closed = true;
          db.close();
          value = {};
        } else {
          const handler = repositories[method] as (input: unknown) => unknown;
          value = handler(input.data);
        }
        return { reply: { kind: 'response', id, ok: true, value }, closed };
      } catch (error) {
        return fail(error);
      }
    },
  };
}
