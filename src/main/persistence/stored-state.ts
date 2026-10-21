// What main keeps besides the session (M2.2b): the settings document, the user's permission
// decisions (protocol "always allow" among them, amendment (b)), the client-hint opt-ins
// (amendment (d)) and the download history (amendment (c)). Read once at startup, within a
// deadline; anything unreadable starts empty or at its default, as before Phase 2. Each change is
// then written through, and a failed write is logged by code and dropped: a decision the user
// made still holds for the run.
import type { StoredDecision } from '../../core/permissions/permission-decisions';
import type { Decision, PromptedPermission } from '../../core/permissions/permission-policy';
import type { DataInput, DownloadRow } from '../../shared/contracts/data-rpc';
import { DEFAULT_SETTINGS, parseSettings } from '../../shared/contracts/settings';
import type { Settings } from '../../shared/contracts/settings';
import type { DataClient } from './data-client';
import { DataClientError } from './data-client';
import type { Logger } from '../platform/logger';

export const STORED_STATE_DEADLINE_MS = 3000;
export const CLIENT_HINTS_DOCUMENT = 'client_hints';
/** Opt-ins change on page loads; the document is written at most this often (and at quit). */
export const CLIENT_HINTS_WRITE_DELAY_MS = 5000;
const PROTOCOL_PREFIX = 'protocol:';
/** More than the table should ever hold; a cap, so a damaged file can't flood main. */
const MAX_DECISIONS_LOADED = 10_000;

export interface StoredState {
  readonly settings: Settings;
  readonly decisions: readonly StoredDecision[];
  /** External-protocol "always allow" answers. */
  readonly alwaysAllowed: readonly { readonly site: string; readonly scheme: string }[];
  /** The client_hints document, unchecked (ClientHintOptIns checks it). */
  readonly clientHints: unknown;
  /** Newest first. */
  readonly downloads: readonly DownloadRow[];
}

export const EMPTY_STORED_STATE: StoredState = {
  settings: DEFAULT_SETTINGS,
  decisions: [],
  alwaysAllowed: [],
  clientHints: null,
  downloads: [],
};

/** The database is not there to write to, so there is nothing to report for each write. */
export function isDataUnavailable(error: unknown): boolean {
  if (!(error instanceof DataClientError)) {
    return false;
  }
  switch (error.code) {
    case 'closed':
    case 'worker_gone':
    case 'open_failed':
    case 'db_newer':
    case 'db_foreign':
    case 'migration_failed':
      return true;
    default:
      return false;
  }
}

export async function readStoredState(
  data: Pick<DataClient, 'call'>,
  logger: Logger,
  options: { readonly downloads: number; readonly deadlineMs?: number },
): Promise<StoredState> {
  const read = <T>(what: string, fallback: T, reading: () => Promise<T>): Promise<T> =>
    reading().catch((error: unknown) => {
      if (!isDataUnavailable(error)) {
        logger.warn('storedState.readFailed', {
          what,
          code: error instanceof DataClientError ? error.code : 'internal',
        });
      }
      return fallback;
    });
  const reading = Promise.all([
    read('settings', DEFAULT_SETTINGS, async () =>
      parseSettings((await data.call('settings.get', {})).value),
    ),
    read(
      'permissions',
      [],
      async () => (await data.call('permissions.list', { limit: MAX_DECISIONS_LOADED })).decisions,
    ),
    read(
      'clientHints',
      null,
      async () => (await data.call('appState.get', { key: CLIENT_HINTS_DOCUMENT })).value,
    ),
    read(
      'downloads',
      [],
      async () => (await data.call('downloads.list', { limit: options.downloads })).downloads,
    ),
  ]).then(([settings, rows, clientHints, downloads]): StoredState => {
    const decisions: StoredDecision[] = [];
    const alwaysAllowed: { site: string; scheme: string }[] = [];
    for (const row of rows) {
      if (row.permission.startsWith(PROTOCOL_PREFIX)) {
        if (row.decision === 'allow') {
          alwaysAllowed.push({
            site: row.origin,
            scheme: row.permission.slice(PROTOCOL_PREFIX.length),
          });
        }
      } else {
        decisions.push(row);
      }
    }
    return { settings, decisions, alwaysAllowed, clientHints, downloads };
  });
  const deadlineMs = options.deadlineMs ?? STORED_STATE_DEADLINE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<StoredState>((resolve) => {
    timer = setTimeout(() => {
      logger.warn('storedState.timedOut', { deadlineMs });
      resolve(EMPTY_STORED_STATE);
    }, deadlineMs);
  });
  try {
    return await Promise.race([reading, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** Writes the user's decisions through, as they make them. */
export function decisionWriters(
  data: Pick<DataClient, 'call'>,
  logger: Logger,
  now: () => number = Date.now,
): {
  readonly permission: (origin: string, permission: PromptedPermission, decision: Decision) => void;
  readonly alwaysAllow: (site: string, scheme: string) => void;
} {
  const write = (origin: string, permission: string, decision: Decision): void => {
    data
      .call('permissions.set', { origin, permission, decision, updatedAt: now() })
      .catch((error: unknown) => {
        if (!isDataUnavailable(error)) {
          logger.warn('storedState.writeFailed', {
            what: 'permission',
            code: error instanceof DataClientError ? error.code : 'internal',
          });
        }
      });
  };
  return {
    permission: write,
    alwaysAllow: (site, scheme) => {
      write(site, `${PROTOCOL_PREFIX}${scheme}`, 'allow');
    },
  };
}

/**
 * The client_hints document, written CLIENT_HINTS_WRITE_DELAY_MS after a change (one write for a
 * burst of page loads), and by `flush` at quit.
 */
export class ClientHintsWriter {
  readonly #data: Pick<DataClient, 'call'>;
  readonly #logger: Logger;
  readonly #document: () => DataInput<'appState.set'>['value'];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #dirty = false;

  constructor(options: {
    readonly data: Pick<DataClient, 'call'>;
    readonly logger: Logger;
    readonly document: () => DataInput<'appState.set'>['value'];
  }) {
    this.#data = options.data;
    this.#logger = options.logger;
    this.#document = options.document;
  }

  changed(): void {
    this.#dirty = true;
    if (this.#timer === undefined) {
      this.#timer = setTimeout(() => {
        void this.flush();
      }, CLIENT_HINTS_WRITE_DELAY_MS);
      this.#timer.unref();
    }
  }

  async flush(): Promise<void> {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (!this.#dirty) {
      return;
    }
    this.#dirty = false;
    try {
      await this.#data.call('appState.set', {
        key: CLIENT_HINTS_DOCUMENT,
        value: this.#document(),
      });
    } catch (error) {
      if (!isDataUnavailable(error)) {
        this.#logger.warn('storedState.writeFailed', {
          what: 'clientHints',
          code: error instanceof DataClientError ? error.code : 'internal',
        });
      }
    }
  }
}
