// Main's side of the data worker's RPC (ADR-0004, contract in src/shared/contracts/data-rpc.ts).
// Main never runs SQL: it sends a method name and input, and gets back a value that has passed the
// method's output schema, or a DataClientError with a code.
//
// Each call has its own timeout, which starts when the call is made. A timeout only stops main
// waiting: the statement may still be running in the worker, because SQLite statements can't be
// interrupted (S5). The worker answers in order, so a late answer is matched by id and dropped.
import type {
  DataErrorCode,
  DataMethod,
  DataOutput,
  DataRequest,
} from '../../shared/contracts/data-rpc';
import { DATA_METHODS, dataMessageSchema } from '../../shared/contracts/data-rpc';
import type { DataInput } from '../../shared/contracts/data-rpc';
import type { Logger } from '../platform/logger';

/** The part of a worker_threads Worker the client uses (a fake one in tests). */
export interface WorkerPort {
  postMessage(message: DataRequest): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (exitCode: number) => void): unknown;
  terminate(): Promise<number>;
}

export class DataClientError extends Error {
  readonly code: DataErrorCode;
  readonly detail: string | undefined;

  constructor(code: DataErrorCode, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'DataClientError';
    this.code = code;
    this.detail = detail;
  }
}

export const DEFAULT_CALL_TIMEOUT_MS = 5000;
/** Calls waiting for an answer, at most. More means something upstream is looping. */
export const MAX_IN_FLIGHT = 256;

export interface DataClientOptions {
  readonly logger: Logger;
  readonly defaultTimeoutMs?: number;
  readonly maxInFlight?: number;
}

export interface CallOptions {
  readonly timeoutMs?: number;
}

type State = 'starting' | 'ready' | 'failed' | 'closing' | 'closed';

interface Pending {
  readonly method: DataMethod;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: DataClientError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class DataClient {
  readonly #worker: WorkerPort;
  readonly #logger: Logger;
  readonly #defaultTimeoutMs: number;
  readonly #maxInFlight: number;
  readonly #pending = new Map<number, Pending>();
  readonly #ready: Promise<{ readonly userVersion: number }>;
  #resolveReady!: (info: { readonly userVersion: number }) => void;
  #rejectReady!: (error: DataClientError) => void;
  #state: State = 'starting';
  #failure: DataClientError | null = null;
  #nextId = 1;
  #exited: Promise<void>;
  #onExit!: () => void;

  constructor(worker: WorkerPort, options: DataClientOptions) {
    this.#worker = worker;
    this.#logger = options.logger;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.#maxInFlight = options.maxInFlight ?? MAX_IN_FLIGHT;
    this.#ready = new Promise((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    // Nobody may be waiting on `ready` when the worker fails; the failure is logged instead.
    this.#ready.catch(() => undefined);
    this.#exited = new Promise((resolve) => {
      this.#onExit = resolve;
    });

    worker.on('message', (message) => {
      this.#receive(message);
    });
    worker.on('error', (error) => {
      // An uncaught exception in the worker. Its message could quote data, so only its name is
      // logged (logger.ts privacy rule).
      this.#logger.error('data.workerError', { name: error.name });
      this.#fail(new DataClientError('worker_gone', 'error'));
    });
    worker.on('exit', (exitCode) => {
      this.#onExit();
      if (this.#state === 'closing' || this.#state === 'closed') {
        this.#state = 'closed';
        // The thread died before answering `db.close` (or a call sent just before it).
        this.#rejectAll(new DataClientError('closed'));
        return;
      }
      if (this.#state !== 'failed') {
        this.#logger.error('data.workerExit', { exitCode });
      }
      this.#fail(new DataClientError('worker_gone', `exit ${String(exitCode)}`));
    });
  }

  /** Resolves once the database is open and migrated; rejects if opening failed. */
  get ready(): Promise<{ readonly userVersion: number }> {
    return this.#ready;
  }

  get state(): State {
    return this.#state;
  }

  async call<M extends DataMethod>(
    method: M,
    input: DataInput<M>,
    options: CallOptions = {},
  ): Promise<DataOutput<M>> {
    if (method === 'db.close') {
      throw new DataClientError('invalid_input', 'use close()');
    }
    const parsed = DATA_METHODS[method].input.safeParse(input);
    if (!parsed.success) {
      // A caller bug: main built input its own contract refuses.
      this.#logger.error('data.invalidInput', { method });
      throw new DataClientError('invalid_input');
    }
    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;
    return this.#send(method, parsed.data, timeoutMs, true) as Promise<DataOutput<M>>;
  }

  /**
   * Asks the worker to close the database, then waits for the thread to exit, within
   * `timeoutMs` overall. Rejects with `timeout` if it doesn't make it: the caller then decides
   * (on quit, ADR-0004 item 5: hard-exit, because a running statement can't be stopped).
   */
  async close(timeoutMs: number): Promise<void> {
    if (this.#state === 'closed' || this.#state === 'failed') {
      return;
    }
    if (this.#state === 'closing') {
      throw new DataClientError('closed');
    }
    const deadline = Date.now() + timeoutMs;
    const remaining = (): number => Math.max(0, deadline - Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new DataClientError('timeout', 'close'));
      }, timeoutMs);
    });
    try {
      if (this.#state === 'starting') {
        // Opening (a migration, its backup) is one long task in the worker; close after it.
        await Promise.race([this.#ready.catch(() => undefined), expired]);
        if (this.state !== 'ready') {
          return;
        }
      }
      // Calls already sent are answered first: the worker handles messages in order.
      const closing = this.#send('db.close', {}, remaining(), false);
      // If `expired` wins the race below, this call's own timer rejects it later, unobserved.
      closing.catch(() => undefined);
      this.#state = 'closing';
      await Promise.race([closing, expired]);
      await Promise.race([this.#exited, expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  async #send(
    method: DataMethod,
    input: unknown,
    timeoutMs: number,
    waitForReady: boolean,
  ): Promise<unknown> {
    const startedAt = Date.now();
    if (waitForReady && this.#state === 'starting') {
      await this.#ready.catch(() => undefined);
    }
    if (this.#state !== 'ready') {
      throw this.#failure ?? new DataClientError('closed');
    }
    if (this.#pending.size >= this.#maxInFlight) {
      this.#logger.warn('data.busy', { method });
      throw new DataClientError('busy');
    }
    const left = timeoutMs - (Date.now() - startedAt);
    if (left <= 0) {
      throw new DataClientError('timeout', method);
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        this.#logger.warn('data.timeout', { method, timeoutMs });
        reject(new DataClientError('timeout', method));
      }, left);
      this.#pending.set(id, { method, resolve, reject, timer });
      this.#worker.postMessage({ kind: 'request', id, method, input });
    });
  }

  #receive(raw: unknown): void {
    const parsed = dataMessageSchema.safeParse(raw);
    if (!parsed.success) {
      // A bug in the worker. The call it belonged to, if any, times out.
      this.#logger.error('data.badMessage');
      return;
    }
    const message = parsed.data;
    switch (message.kind) {
      case 'ready':
        if (this.#state === 'starting') {
          this.#state = 'ready';
          this.#resolveReady({ userVersion: message.userVersion });
        }
        return;
      case 'fatal': {
        this.#logger.error('data.openFailed', {
          code: message.error.code,
          detail: message.error.detail,
        });
        this.#fail(new DataClientError(message.error.code, message.error.detail));
        return;
      }
      case 'response': {
        const pending = this.#pending.get(message.id);
        if (pending === undefined) {
          return; // Answered after its timeout.
        }
        this.#pending.delete(message.id);
        clearTimeout(pending.timer);
        if (!message.ok) {
          pending.reject(new DataClientError(message.error.code, message.error.detail));
          return;
        }
        const output = DATA_METHODS[pending.method].output.safeParse(message.value);
        if (!output.success) {
          this.#logger.error('data.invalidOutput', { method: pending.method });
          pending.reject(new DataClientError('invalid_output', pending.method));
          return;
        }
        pending.resolve(output.data);
      }
    }
  }

  #fail(error: DataClientError): void {
    if (this.#state === 'failed' || this.#state === 'closed') {
      return;
    }
    this.#state = 'failed';
    this.#failure = error;
    this.#rejectReady(error);
    this.#rejectAll(error);
  }

  #rejectAll(error: DataClientError): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
