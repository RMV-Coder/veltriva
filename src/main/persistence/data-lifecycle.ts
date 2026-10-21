// The data worker over the app's lifetime (ADR-0004 item 5, assessment §5.5, §5.6, §5.9):
//   - once the database is open: tell the user about a recovery, and start the heartbeat;
//   - while the user is away: the worker's upkeep (weekly check, daily backup);
//   - on quit: the registered flushes, the run's clean end, then closing, all within one cap.
// Timers are unref'd, so none of them keeps the app alive.
import type { DataRecovery } from '../../shared/contracts/data-rpc';
import type { Logger } from '../platform/logger';
import { DataClientError } from './data-client';
import type { DataClient } from './data-client';

/** `app_runs.last_heartbeat_at` moves this often; a crash is dated by the last one (§5.5). */
export const HEARTBEAT_MS = 60_000;
/** How often main looks for a chance to run upkeep. */
export const MAINTENANCE_POLL_MS = 10 * 60_000;
/** Upkeep runs only after the user has been away this long (no keyboard or mouse input). */
export const IDLE_FOR_MAINTENANCE_S = 5 * 60;
/** A backup is stepped and a full check is about half a second at 50,000 pages (S5, M2.1b). */
export const MAINTENANCE_TIMEOUT_MS = 120_000;

/** §5.7: a year of history, unless the settings document says otherwise. */
export const DEFAULT_VISIT_RETENTION_DAYS = 365;

export type ShutdownResult = 'closed' | 'timeout' | 'failed';

export interface DataLifecycleOptions {
  readonly client: DataClient;
  readonly logger: Logger;
  /** Seconds since the user's last input (Electron's powerMonitor.getSystemIdleTime). */
  readonly idleSeconds: () => number;
  readonly onRecovered: (recovery: DataRecovery) => void;
  /** The settings document's history retention, read when upkeep runs (default 365 days). */
  readonly visitRetentionDays?: () => number;
  readonly now?: () => number;
}

export class DataLifecycle {
  readonly #client: DataClient;
  readonly #logger: Logger;
  readonly #idleSeconds: () => number;
  readonly #now: () => number;
  readonly #visitRetentionDays: () => number;
  readonly #flushes = new Set<() => Promise<void>>();
  readonly #timers: ReturnType<typeof setInterval>[] = [];
  #runId: number | null = null;
  #maintaining = false;
  #shuttingDown = false;

  constructor(options: DataLifecycleOptions) {
    this.#client = options.client;
    this.#logger = options.logger;
    this.#idleSeconds = options.idleSeconds;
    this.#now = options.now ?? Date.now;
    this.#visitRetentionDays = options.visitRetentionDays ?? (() => DEFAULT_VISIT_RETENTION_DAYS);
    options.client.ready.then(
      (ready) => {
        if (this.#shuttingDown) {
          return;
        }
        this.#runId = ready.runId;
        if (ready.recovery !== null) {
          this.#logger.error('data.recovered', { kind: ready.recovery.kind });
          options.onRecovered(ready.recovery);
        }
        this.#every(HEARTBEAT_MS, () => this.#heartbeat());
        this.#every(MAINTENANCE_POLL_MS, () => this.maintainIfIdle());
      },
      () => undefined, // The client has logged why; the app runs without its database.
    );
  }

  /**
   * Registers work that must reach the database before it closes, such as M2.2a's batched tab
   * writes. Each runs once at quit, inside the shutdown cap. Returns the unregister function.
   */
  addFlush(flush: () => Promise<void>): () => void {
    this.#flushes.add(flush);
    return () => {
      this.#flushes.delete(flush);
    };
  }

  /** Runs the worker's upkeep if the user is away and none is running. Exposed for tests. */
  async maintainIfIdle(): Promise<void> {
    if (this.#maintaining || this.#shuttingDown || this.#client.state !== 'ready') {
      return;
    }
    if (this.#idleSeconds() < IDLE_FOR_MAINTENANCE_S) {
      return;
    }
    this.#maintaining = true;
    try {
      const result = await this.#client.call(
        'maintenance.run',
        { now: this.#now(), visitRetentionDays: this.#visitRetentionDays() },
        { timeoutMs: MAINTENANCE_TIMEOUT_MS },
      );
      if (result.check === 'failed' || result.backup === 'failed' || result.backup === 'skipped') {
        this.#logger.warn('data.maintenance', { check: result.check, backup: result.backup });
      }
    } catch (error) {
      this.#logger.warn('data.maintenanceFailed', { code: codeOf(error) });
    } finally {
      this.#maintaining = false;
    }
  }

  /**
   * Flushes, ends the run cleanly, and closes the database, all within `capMs`. `timeout` means
   * the worker is stuck in a statement, which nothing can interrupt: the caller hard-exits.
   */
  async shutdown(capMs: number): Promise<ShutdownResult> {
    this.#shuttingDown = true;
    for (const timer of this.#timers) {
      clearInterval(timer);
    }
    const deadline = this.#now() + capMs;
    const left = (): number => Math.max(1, deadline - this.#now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        resolve('timeout');
      }, capMs);
    });
    const sequence = (async (): Promise<ShutdownResult> => {
      await Promise.allSettled([...this.#flushes].map((flush) => flush()));
      const runId = this.#runId;
      if (runId !== null && this.#client.state === 'ready') {
        await this.#client
          .call(
            'appRuns.end',
            { id: runId, at: this.#now(), exitKind: 'clean' },
            { timeoutMs: left() },
          )
          .catch((error: unknown) => {
            this.#logger.warn('data.endRunFailed', { code: codeOf(error) });
          });
      }
      await this.#client.close(left());
      return 'closed';
    })().catch((error: unknown): ShutdownResult =>
      codeOf(error) === 'timeout' ? 'timeout' : 'failed',
    );
    try {
      return await Promise.race([sequence, expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  #every(ms: number, task: () => Promise<void>): void {
    const timer = setInterval(() => {
      void task();
    }, ms);
    timer.unref();
    this.#timers.push(timer);
  }

  async #heartbeat(): Promise<void> {
    const runId = this.#runId;
    if (runId === null || this.#client.state !== 'ready') {
      return;
    }
    try {
      await this.#client.call('appRuns.heartbeat', { id: runId, at: this.#now() });
    } catch (error) {
      this.#logger.warn('data.heartbeatFailed', { code: codeOf(error) });
    }
  }
}

function codeOf(error: unknown): string {
  return error instanceof DataClientError ? error.code : 'internal';
}
