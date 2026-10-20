// Test builds only: asks the data worker to sit inside one long SQLite statement, as a slow query
// would (src/data/testing/hold.ts, which handles it). Main may not import src/data, so the
// message's kind is repeated here; the lifecycle test that uses it fails if the two drift.
import type { Worker } from 'node:worker_threads';

const HOLD_MESSAGE_KIND = 'veltriva-test-hold';

export function holdDataWorker(worker: Worker, ms: number): void {
  worker.postMessage({ kind: HOLD_MESSAGE_KIND, ms });
}
