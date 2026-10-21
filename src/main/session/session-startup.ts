// Startup's half of session restore (assessment §5.9): wait for the database, then read the
// saved session, within a deadline. If that fails the app starts with a new tab and no session
// store, so nothing is written and the saved session is still there for the next start.
import { getRandomValues } from 'node:crypto';

import { isCrashLoop } from '../../core/session/crash-loop';
import { uuidv7 } from '../../core/id/uuidv7';
import type { DataClient, DataReady } from '../persistence/data-client';
import { DataClientError } from '../persistence/data-client';
import type { Logger } from '../platform/logger';
import type { LoadedSession } from './session-load';
import { loadSession } from './session-load';

/** Opening (and, on an upgrade, backing up and migrating) normally takes well under a second. */
export const SESSION_LOAD_DEADLINE_MS = 10_000;

export interface StartupSession {
  readonly ready: DataReady;
  readonly loaded: LoadedSession;
  /** Two quick crashes in a row: restore the tabs, load none (§5.9). */
  readonly safeMode: boolean;
}

export async function readSessionAtStartup(
  data: Pick<DataClient, 'call' | 'ready'>,
  logger: Logger,
  deadlineMs = SESSION_LOAD_DEADLINE_MS,
): Promise<StartupSession | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      logger.error('session.loadTimedOut', { deadlineMs });
      resolve(null);
    }, deadlineMs);
  });
  const reading = (async (): Promise<StartupSession | null> => {
    const ready = await data.ready;
    const now = Date.now();
    const loaded = await loadSession(data, {
      newWorkspaceId: uuidv7(now, getRandomValues(new Uint8Array(10))),
      now,
      runId: ready.runId,
    });
    return { ready, loaded, safeMode: isCrashLoop(loaded.previousRuns) };
  })().catch((error: unknown) => {
    logger.error('session.loadFailed', {
      code: error instanceof DataClientError ? error.code : 'internal',
    });
    return null;
  });
  try {
    return await Promise.race([reading, expired]);
  } finally {
    clearTimeout(timer);
  }
}
