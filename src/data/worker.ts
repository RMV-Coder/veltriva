// The data worker's entry point (ADR-0004): a worker_threads worker that owns Veltriva's only
// SQLite connection. Main starts it (src/main/persistence/data-worker.ts) and talks to it through
// the contract in src/shared/contracts/data-rpc.ts. Every statement runs here, on this thread,
// one at a time, so a slow one never blocks the browser's UI thread (S5).
import { parentPort, threadId, workerData } from 'node:worker_threads';

import { dataWorkerOptionsSchema } from '../shared/contracts/data-rpc';
import type { DataMessage } from '../shared/contracts/data-rpc';
import { openDatabase } from './database';
import { toErrorInfo } from './errors';
import { LATEST_VERSION } from './migrations';
import { createRepositoryHandlers } from './repos';
import { createDataServer } from './server';

async function main(): Promise<void> {
  const port = parentPort;
  if (port === null) {
    throw new Error('The data worker must run as a worker thread.');
  }
  const post = (message: DataMessage): void => {
    port.postMessage(message);
  };

  const options = dataWorkerOptionsSchema.safeParse(workerData);
  if (!options.success) {
    post({ kind: 'fatal', error: { code: 'internal', detail: 'workerData' } });
    port.close();
    return;
  }
  let opened;
  try {
    opened = await openDatabase(options.data);
  } catch (error) {
    post({ kind: 'fatal', error: toErrorInfo(error) });
    port.close();
    return;
  }

  const server = createDataServer(
    { db: opened.db, latestVersion: LATEST_VERSION, threadId },
    createRepositoryHandlers(opened.db),
  );
  // Messages main sent while the database was opening wait in the port until this listener
  // exists; main sends none before `ready` anyway.
  port.on('message', (message: unknown) => {
    const { reply, closed } = server.handle(message);
    if (reply !== null) {
      post(reply);
    }
    if (closed) {
      // Nothing else keeps this thread alive: it exits once the reply is flushed.
      port.close();
    }
  });
  post({ kind: 'ready', userVersion: opened.userVersion });
}

void main();
