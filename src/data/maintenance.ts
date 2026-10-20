// Idle-time upkeep (assessment §5.6): a weekly full check, and a daily backup when the data
// changed. Main decides when the user is idle and calls `maintenance.run`; this decides what is
// due. Its state is the app_state document `maintenance`, which only this worker writes, so
// "changed since the last backup" can't race: a write during a backup sets it again.
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import type { DatabaseConnection } from 'better-sqlite3/win32-x64';
import { z } from 'zod';

import { MAINTENANCE_STATE_KEY } from '../shared/contracts/data-rpc';
import type { DataOutput } from '../shared/contracts/data-rpc';
import { dailyBackupName, pruneBackups } from './backups';
import { DataError } from './errors';
import { fullCheck, markNeedsCheck, quickCheck } from './integrity';

export const BACKUP_EVERY_MS = 24 * 60 * 60 * 1000;
export const CHECK_EVERY_MS = 7 * BACKUP_EVERY_MS;

const timestamp = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const stateSchema = z.strictObject({
  lastBackupAt: timestamp.nullable(),
  changedSinceBackup: z.boolean(),
  lastCheckAt: timestamp.nullable(),
  lastCheckOk: z.boolean().nullable(),
});
export type MaintenanceState = z.infer<typeof stateSchema>;

const INITIAL: MaintenanceState = {
  lastBackupAt: null,
  changedSinceBackup: false,
  lastCheckAt: null,
  lastCheckOk: null,
};

type RunResult = DataOutput<'maintenance.run'>;

/** Due after `every`, or at once if the clock went back past the last time. */
function due(last: number | null, now: number, every: number): boolean {
  return last === null || now - last >= every || now < last;
}

export class Maintenance {
  readonly #db: DatabaseConnection;
  readonly #file: string;
  readonly #backupDir: string;
  readonly #save: (state: MaintenanceState) => void;
  #state: MaintenanceState;
  #running: Promise<RunResult> | null = null;
  #stopping = false;

  constructor(
    db: DatabaseConnection,
    options: { readonly file: string; readonly backupDir: string },
  ) {
    this.#db = db;
    this.#file = options.file;
    this.#backupDir = options.backupDir;
    const read = db.prepare('SELECT json FROM app_state WHERE key = ?').pluck();
    const write = db.prepare(
      'INSERT INTO app_state (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json',
    );
    this.#save = (state) => {
      write.run([MAINTENANCE_STATE_KEY, JSON.stringify(state)]);
    };
    const stored = read.get([MAINTENANCE_STATE_KEY]);
    let parsed: MaintenanceState | undefined;
    if (typeof stored === 'string') {
      try {
        parsed = stateSchema.parse(JSON.parse(stored));
      } catch {
        parsed = undefined; // Unreadable: start over, which at worst takes a backup early.
      }
    }
    this.#state = parsed ?? INITIAL;
  }

  status(): MaintenanceState {
    return { ...this.#state };
  }

  /** The user's data changed; the next due backup is worth taking. */
  noteWrite(): void {
    if (!this.#state.changedSinceBackup) {
      this.#update({ changedSinceBackup: true });
    }
  }

  run(now: number): Promise<RunResult> {
    if (this.#stopping) {
      return Promise.reject(new DataError('closed'));
    }
    if (this.#running !== null) {
      return Promise.reject(new DataError('busy'));
    }
    const running = this.#run(now).finally(() => {
      this.#running = null;
    });
    this.#running = running;
    return running;
  }

  /** Stops a running backup at its next step and waits for it, so the connection can close. */
  async stop(): Promise<void> {
    this.#stopping = true;
    await this.#running?.catch(() => undefined);
  }

  async #run(now: number): Promise<RunResult> {
    let check: RunResult['check'] = 'not_due';
    if (due(this.#state.lastCheckAt, now, CHECK_EVERY_MS)) {
      const ok = fullCheck(this.#db);
      this.#update({ lastCheckAt: now, lastCheckOk: ok });
      check = ok ? 'ok' : 'failed';
      if (!ok) {
        markNeedsCheck(this.#file);
      }
    }
    if (check === 'failed') {
      return { check, backup: 'skipped', backupFile: null };
    }
    if (!due(this.#state.lastBackupAt, now, BACKUP_EVERY_MS)) {
      return { check, backup: 'not_due', backupFile: null };
    }
    if (!this.#state.changedSinceBackup) {
      return { check, backup: 'unchanged', backupFile: null };
    }
    // A damaged database must never replace a good backup: the full check just ran, or this.
    if (check === 'not_due' && !quickCheck(this.#db)) {
      markNeedsCheck(this.#file);
      return { check, backup: 'skipped', backupFile: null };
    }
    return this.#backup(now, check);
  }

  async #backup(now: number, check: RunResult['check']): Promise<RunResult> {
    const name = dailyBackupName(now);
    const final = join(this.#backupDir, name);
    // Written under another name and renamed when complete, so recovery never sees half a file.
    const partial = `${final}.partial`;
    this.#update({ changedSinceBackup: false });
    try {
      mkdirSync(this.#backupDir, { recursive: true });
      await this.#db.backup(partial, {
        progress: () => {
          if (this.#stopping) {
            throw new DataError('closed');
          }
          return undefined;
        },
      });
      renameSync(partial, final);
    } catch {
      rmSync(partial, { force: true });
      this.#update({ changedSinceBackup: true });
      return { check, backup: 'failed', backupFile: null };
    }
    pruneBackups(this.#backupDir, 'daily');
    this.#update({ lastBackupAt: now });
    return { check, backup: 'done', backupFile: name };
  }

  #update(change: Partial<MaintenanceState>): void {
    this.#state = { ...this.#state, ...change };
    this.#save(this.#state);
  }
}
