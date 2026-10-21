// Idle-time upkeep (assessment §5.6, §5.7): retention, a weekly full check, and a daily backup
// when the data changed. Main decides when the user is idle and calls `maintenance.run`; this decides what is
// due. Its state is the app_state document `maintenance`, which only this worker writes, so
// "changed since the last backup" can't race: a write during a backup sets it again.
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';

import type { DatabaseConnection } from 'better-sqlite3/win32-x64';
import { z } from 'zod';

import { MAINTENANCE_STATE_KEY } from '../shared/contracts/data-rpc';
import type { DataOutput } from '../shared/contracts/data-rpc';
import { dailyBackupName, pruneBackups } from './backups';
import { DataError } from './errors';
import { fullCheck, isCorruption, markNeedsCheck } from './integrity';

export const BACKUP_EVERY_MS = 24 * 60 * 60 * 1000;
export const CHECK_EVERY_MS = 7 * BACKUP_EVERY_MS;
/** Recently closed keeps a week (the same as main's startup purge, session-load.ts). */
export const CLOSED_TAB_RETENTION_MS = 7 * BACKUP_EVERY_MS;
/** Rows deleted per statement; the worker answers other calls between chunks. */
export const RETENTION_CHUNK = 2_000;
/** Chunks per table per run: a first run after a year away catches up over a few idle periods. */
export const RETENTION_CHUNKS_PER_RUN = 25;
/** Free pages returned to the file system per run (16 MB at 4 KiB pages). */
export const VACUUM_PAGES_PER_RUN = 4_096;

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
type Pruned = RunResult['pruned'];
const NOTHING_PRUNED: Pruned = { visits: 0, pages: 0, closedTabs: 0 };

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
  readonly #prune: {
    readonly visits: (before: number) => number;
    readonly orphanPages: () => number;
    readonly orphanFavicons: () => number;
    readonly closedTabs: (before: number) => number;
  };
  #running: Promise<RunResult> | null = null;
  #stopping = false;
  /**
   * Orphans are looked for after visits went, and once per worker: the scan is over every page,
   * so it doesn't run on every idle period, and a run cut short is finished by the next start.
   */
  #orphansDue = true;

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
    const chunked = (sql: string) => {
      const statement = db.prepare(sql);
      return (...params: number[]) => statement.run([...params, RETENTION_CHUNK]).changes;
    };
    this.#prune = {
      visits: chunked(
        'DELETE FROM visits WHERE id IN (SELECT id FROM visits WHERE visited_at < ? LIMIT ?)',
      ),
      orphanPages: chunked(
        `DELETE FROM pages WHERE id IN (
           SELECT id FROM pages p WHERE NOT EXISTS (SELECT 1 FROM visits v WHERE v.page_id = p.id)
           LIMIT ?
         )`,
      ),
      orphanFavicons: chunked(
        `DELETE FROM favicons WHERE id IN (
           SELECT id FROM favicons f
           WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.favicon_id = f.id)
             AND NOT EXISTS (SELECT 1 FROM tabs t WHERE t.favicon_id = f.id)
           LIMIT ?
         )`,
      ),
      closedTabs: chunked(
        `DELETE FROM tabs WHERE id IN (
           SELECT id FROM tabs WHERE placement = 'closed' AND closed_at < ? ORDER BY closed_at LIMIT ?
         )`,
      ),
    };
    // A backup cut short by a crash or a kill leaves its .partial file; nothing else would ever
    // remove it.
    try {
      for (const name of readdirSync(this.#backupDir)) {
        if (/^veltriva-daily-.*\.db\.partial$/.test(name)) {
          rmSync(join(this.#backupDir, name), { force: true });
        }
      }
    } catch {
      // No backup folder yet.
    }
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

  run(now: number, visitRetentionDays: number): Promise<RunResult> {
    if (this.#stopping) {
      return Promise.reject(new DataError('closed'));
    }
    if (this.#running !== null) {
      return Promise.reject(new DataError('busy'));
    }
    const running = this.#run(now, visitRetentionDays).finally(() => {
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

  async #run(now: number, visitRetentionDays: number): Promise<RunResult> {
    // Retention comes first, so what it changes is in the check and the backup. Nothing is
    // deleted from a file that failed its check: a restart recovers it first. Damage the deletes
    // run into is a failed check, and no backup.
    let pruned = NOTHING_PRUNED;
    if (this.#state.lastCheckOk !== false) {
      try {
        pruned = await this.#retain(now, visitRetentionDays);
      } catch (error) {
        if (!isCorruption(error)) {
          throw error;
        }
        this.#update({ lastCheckAt: now, lastCheckOk: false });
        markNeedsCheck(this.#file);
        return { check: 'failed', backup: 'skipped', backupFile: null, pruned };
      }
    }
    const backupDue =
      due(this.#state.lastBackupAt, now, BACKUP_EVERY_MS) && this.#state.changedSinceBackup;
    // A damaged database must never replace a good backup, so every backup is preceded by the
    // full check: a quick check passes on a search index that disagrees with its pages (found in
    // review). After a failed check it runs every time, until a restart recovers the file.
    const checkDue =
      due(this.#state.lastCheckAt, now, CHECK_EVERY_MS) ||
      this.#state.lastCheckOk === false ||
      backupDue;
    let check: RunResult['check'] = 'not_due';
    if (checkDue) {
      const ok = fullCheck(this.#db);
      this.#update({ lastCheckAt: now, lastCheckOk: ok });
      check = ok ? 'ok' : 'failed';
      if (!ok) {
        markNeedsCheck(this.#file);
      }
    }
    if (check === 'failed') {
      return { check, backup: 'skipped', backupFile: null, pruned };
    }
    if (!due(this.#state.lastBackupAt, now, BACKUP_EVERY_MS)) {
      return { check, backup: 'not_due', backupFile: null, pruned };
    }
    if (!backupDue) {
      return { check, backup: 'unchanged', backupFile: null, pruned };
    }
    return this.#backup(now, check, pruned);
  }

  /**
   * Retention (§5.7): visits older than the setting, then pages and icons nothing refers to, then
   * closed tabs older than a week; then free pages go back to the file system. Each statement
   * deletes a bounded chunk in its own transaction, and the worker answers other calls between.
   */
  async #retain(now: number, visitRetentionDays: number): Promise<Pruned> {
    const drain = async (step: () => number): Promise<number> => {
      let total = 0;
      for (let chunk = 0; chunk < RETENTION_CHUNKS_PER_RUN && !this.#stopping; chunk += 1) {
        const deleted = step();
        total += deleted;
        if (deleted < RETENTION_CHUNK) {
          break;
        }
        await nextTurn();
      }
      return total;
    };
    const visits = await drain(() =>
      this.#prune.visits(now - visitRetentionDays * BACKUP_EVERY_MS),
    );
    // Before the orphan scan, so an icon only an expired closed tab used goes in the same run.
    const closedTabs = await drain(() => this.#prune.closedTabs(now - CLOSED_TAB_RETENTION_MS));
    let pages = 0;
    if (visits > 0 || closedTabs > 0 || this.#orphansDue) {
      this.#orphansDue = false;
      pages = await drain(() => this.#prune.orphanPages());
      await drain(() => this.#prune.orphanFavicons());
    }
    if (visits > 0 || pages > 0 || closedTabs > 0) {
      this.noteWrite();
      this.#db.pragma(`incremental_vacuum(${String(VACUUM_PAGES_PER_RUN)})`);
    }
    return { visits, pages, closedTabs };
  }

  async #backup(now: number, check: RunResult['check'], pruned: Pruned): Promise<RunResult> {
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
      return { check, backup: 'failed', backupFile: null, pruned };
    }
    pruneBackups(this.#backupDir, 'daily');
    this.#update({ lastBackupAt: now });
    return { check, backup: 'done', backupFile: name, pruned };
  }

  #update(change: Partial<MaintenanceState>): void {
    this.#state = { ...this.#state, ...change };
    this.#save(this.#state);
  }
}
