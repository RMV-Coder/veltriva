// Starts the data worker and closes it on quit (ADR-0004). The worker is a separate bundle,
// out/main/data-worker.js (electron.vite.config.ts), loaded by file name: main imports none of its
// code, so better-sqlite3 is never loaded on main's thread (scripts/check-data-isolation.mjs).
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

import { app } from 'electron';

import type { DataWorkerOptions } from '../../shared/contracts/data-rpc';
import type { Logger } from '../platform/logger';
import { DataClient } from './data-client';
import type { DataLifecycle } from './data-lifecycle';

/** The database file, in the profile folder. */
export const DATABASE_FILE = 'veltriva.db';
/** Pre-upgrade and daily backups, in the profile folder. */
export const BACKUP_DIR = 'backups';
/** How long quitting waits for the database to close (assessment §5.5). */
export const SHUTDOWN_CAP_MS = 3000;

export interface StartedDataWorker {
  readonly client: DataClient;
  /** The thread itself: only test builds use it directly (src/main/testing/test-hooks.ts). */
  readonly worker: Worker;
}

export function startDataWorker(userDataDir: string, logger: Logger): StartedDataWorker {
  const workerData: DataWorkerOptions = {
    file: join(userDataDir, DATABASE_FILE),
    backupDir: join(userDataDir, BACKUP_DIR),
    appVersion: app.getVersion(),
  };
  // Inside app.asar in a packaged build; Electron loads worker scripts from the archive (S5).
  const worker = new Worker(join(__dirname, 'data-worker.js'), {
    workerData,
    name: 'veltriva-data',
  });
  return { client: new DataClient(worker, { logger }), worker };
}

/**
 * Holds the quit until the database has closed, for at most SHUTDOWN_CAP_MS. The timer runs while
 * the event loop is still alive: one scheduled after `app.quit()` never fired in time (S5). If
 * the worker is stuck in a statement, which nothing can interrupt, the process hard-exits; WAL
 * keeps the file intact (S5: five kills mid-write, every database reopened clean), and the next
 * start sees an unended run and checks the file.
 */
export function closeDataOnQuit(lifecycle: DataLifecycle, logger: Logger): void {
  let closing = false;
  app.on('before-quit', (event) => {
    if (closing) {
      return;
    }
    closing = true;
    event.preventDefault();
    void lifecycle.shutdown(SHUTDOWN_CAP_MS).then((result) => {
      if (result === 'timeout') {
        logger.error('data.closeTimedOut', { capMs: SHUTDOWN_CAP_MS });
        process.kill(process.pid);
        return;
      }
      if (result === 'failed') {
        logger.error('data.closeFailed');
      }
      app.quit();
    });
  });
}
