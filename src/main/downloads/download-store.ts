// Download history in the database (M2.2b, schema amendment (c), the `downloads` table). The
// DownloadManager reports each change to a DownloadStore, fire and forget: a write that fails is
// logged by its code and forgotten, never thrown into the download (which matters far more than
// its row). Calls reach the data worker in the order they are made, and a call already sent is
// answered before the database closes, so the last writes before a quit still land.
import type { DownloadRow } from '../../shared/contracts/data-rpc';
import { DataClientError } from '../persistence/data-client';
import type { DataClient } from '../persistence/data-client';
import { isDataUnavailable } from '../persistence/stored-state';
import type { Logger } from '../platform/logger';
import { MAX_LISTED_DOWNLOADS } from './download-manager';

/** What the DownloadManager writes through. None of these throws or waits. */
export interface DownloadStore {
  /** Inserts the download's row, or replaces it. */
  upsert(row: DownloadRow): void;
  remove(id: string): void;
  /** Every row: the history is gone. */
  clear(): void;
}

export interface DownloadStoreOptions {
  readonly data: Pick<DataClient, 'call'>;
  readonly logger: Logger;
}

export function createDownloadStore(options: DownloadStoreOptions): DownloadStore {
  const { data, logger } = options;

  const guard = (method: string, call: () => Promise<unknown>): void => {
    try {
      // `Promise.resolve`: a rejection is handled however `call` produced it.
      Promise.resolve(call()).catch((error: unknown) => {
        failed(logger, 'downloads.writeFailed', method, error);
      });
    } catch (error) {
      failed(logger, 'downloads.writeFailed', method, error);
    }
  };

  return {
    upsert: (row) => {
      guard('downloads.upsert', () => data.call('downloads.upsert', row));
    },
    remove: (id) => {
      guard('downloads.delete', () => data.call('downloads.delete', { id }));
    },
    clear: () => {
      guard('downloads.clear', () => data.call('downloads.clear', {}));
    },
  };
}

/**
 * The stored downloads, newest first, for `DownloadManager.restore` at startup. [] if they can't
 * be read: the panel then starts empty, and the next download writes its own row as usual.
 */
export async function loadDownloads(
  options: DownloadStoreOptions & { readonly limit?: number },
): Promise<readonly DownloadRow[]> {
  try {
    const { downloads } = await options.data.call('downloads.list', {
      limit: options.limit ?? MAX_LISTED_DOWNLOADS,
    });
    return downloads;
  } catch (error) {
    failed(options.logger, 'downloads.readFailed', 'downloads.list', error);
    return [];
  }
}

function failed(logger: Logger, event: string, method: string, error: unknown): void {
  const code = error instanceof DataClientError ? error.code : 'internal';
  if (!isDataUnavailable(error)) {
    logger.warn(event, { method, code });
  }
}
