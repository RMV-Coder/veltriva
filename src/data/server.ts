// Turns one incoming message into at most one reply (ADR-0005 §5's order, applied to the data
// worker): parse the envelope, check the method, parse the input strictly, run the handler, and
// answer with a value or an error code. It's separate from the thread plumbing in ./worker.ts so
// tests can drive it directly.
//
// Most methods answer at once. Two are asynchronous: `maintenance.run` (a backup is stepped, and
// other requests are served between its steps) and `db.close`, which first stops that backup.
import type { DatabaseConnection } from 'better-sqlite3/win32-x64';

import type { DataMessage, DataOutput } from '../shared/contracts/data-rpc';
import { DATA_METHODS, dataRequestSchema, isDataMethod } from '../shared/contracts/data-rpc';
import { toErrorInfo } from './errors';
import { DATA_WRITES } from './handlers';
import type { HandlerInput, RepositoryHandlers } from './handlers';
import { isCorruption, markNeedsCheck } from './integrity';
import type { Maintenance } from './maintenance';

export interface DataServerContext {
  readonly db: DatabaseConnection;
  /** The database file: a corruption error leaves its "needs a check" marker (./integrity.ts). */
  readonly file: string;
  readonly latestVersion: number;
  /** The worker's threadId (0 would mean main's thread, which must never happen). */
  readonly threadId: number;
  readonly maintenance: Maintenance;
}

export interface HandledMessage {
  readonly reply: DataMessage | null;
  /** The connection is closed: the worker should stop listening and exit. */
  readonly closed: boolean;
}

export interface DataServer {
  /** A plain object for most methods; a promise for `maintenance.run` and `db.close`. */
  handle(message: unknown): HandledMessage | Promise<HandledMessage>;
}

export function createDataServer(
  context: DataServerContext,
  repositories: RepositoryHandlers,
): DataServer {
  const { db, maintenance } = context;
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
      const answer = (value: unknown): HandledMessage => ({
        reply: { kind: 'response', id, ok: true, value },
        closed,
      });
      const fail = (error: unknown): HandledMessage => {
        if (isCorruption(error)) {
          // SQLite found damage while serving: the next start checks the whole file.
          markNeedsCheck(context.file);
        }
        return { reply: { kind: 'response', id, ok: false, error: toErrorInfo(error) }, closed };
      };
      const refuse = (code: 'closed' | 'unknown_method' | 'invalid_input'): HandledMessage => ({
        reply: { kind: 'response', id, ok: false, error: { code } },
        closed,
      });

      if (closed) {
        return refuse('closed');
      }
      if (!isDataMethod(method)) {
        return refuse('unknown_method');
      }
      const parsed = DATA_METHODS[method].input.safeParse(request.data.input);
      if (!parsed.success) {
        return refuse('invalid_input');
      }
      const input: unknown = parsed.data;
      try {
        switch (method) {
          case 'db.info':
            return answer(info());
          case 'db.close':
            closed = true;
            return maintenance.stop().then(() => {
              db.close();
              return answer({});
            }, fail);
          case 'maintenance.status':
            return answer(maintenance.status());
          case 'maintenance.run': {
            const { now, visitRetentionDays } = input as HandlerInput<'maintenance.run'>;
            return maintenance.run(now, visitRetentionDays).then(answer, fail);
          }
          default: {
            const handler = repositories[method] as (input: unknown) => unknown;
            const value = handler(input);
            if (DATA_WRITES.has(method)) {
              maintenance.noteWrite();
            }
            return answer(value);
          }
        }
      } catch (error) {
        return fail(error);
      }
    },
  };
}
