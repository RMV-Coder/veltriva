// The memory's recorder (assessment §5.5, §5.7): TabManager reports commits, titles and icons;
// this turns them into visits and page updates in the data worker.
//   - A visit per cross-document commit, and per same-document commit that changed the page's
//     key (its path or query: a fragment or a tracking parameter alone is the same page).
//   - URL hygiene first (core/url/hygiene.ts): only what it allows is ever sent.
//   - A title is written once it has been stable for 2 s, so a page that animates its title
//     (a counter, a ticker) costs one write, not one per change.
//   - An icon is re-encoded to a PNG of at most 64×64 (./favicon-png.ts) and stored once by its
//     SHA-256; the same icon on a thousand pages is one row.
// Nothing here throws into TabManager: a failed write is logged by code and dropped. The memory
// is a convenience; losing a visit must never break browsing.
import type { VisitTransition } from '../../core/search/frecency';
import { historyUrl } from '../../core/url/hygiene';
import type { DataClient } from '../persistence/data-client';
import { DataClientError } from '../persistence/data-client';
import { isDataUnavailable } from '../persistence/stored-state';
import type { Logger } from '../platform/logger';
import type { TabHistoryObserver, TabId } from '../tabs/tab-manager';

export const TITLE_DEBOUNCE_MS = 2000;
/** Icons already stored this run, by the `data:` URL they came as. */
export const FAVICON_CACHE_SIZE = 256;

export interface HistoryRecorderOptions {
  readonly data: Pick<DataClient, 'call'>;
  readonly logger: Logger;
  /** A validated favicon as a base64 PNG of at most 64×64, or null if it can't be one. */
  readonly encodeFavicon: (dataUrl: string) => string | null;
  readonly now?: () => number;
}

interface TabEntry {
  /** The page of the tab's latest recorded commit: null when it was not recorded. */
  pageId: Promise<number | null>;
  urlKey: string | null;
  /** A title waiting out the debounce, for `pageId`. */
  pendingTitle: string | null;
  titleTimer: ReturnType<typeof setTimeout> | undefined;
}

export class HistoryRecorder implements TabHistoryObserver {
  readonly #data: Pick<DataClient, 'call'>;
  readonly #logger: Logger;
  readonly #encodeFavicon: (dataUrl: string) => string | null;
  readonly #now: () => number;
  readonly #tabs = new Map<TabId, TabEntry>();
  readonly #favicons = new Map<string, Promise<number | null>>();
  readonly #inFlight = new Set<Promise<unknown>>();
  #stopped = false;

  constructor(options: HistoryRecorderOptions) {
    this.#data = options.data;
    this.#logger = options.logger;
    this.#encodeFavicon = options.encodeFavicon;
    this.#now = options.now ?? Date.now;
  }

  committed(
    tabId: TabId,
    commit: {
      readonly url: string;
      readonly sameDocument: boolean;
      readonly transition: VisitTransition;
    },
  ): void {
    if (this.#stopped) {
      return;
    }
    const entry = this.#entry(tabId);
    const page = historyUrl(commit.url);
    if (commit.sameDocument && page !== null && page.urlKey === entry.urlKey) {
      return; // A fragment, or a parameter that only says how the user arrived.
    }
    // The title waiting belongs to the page being left.
    this.#writeTitle(entry);
    entry.urlKey = page?.urlKey ?? null;
    if (page === null) {
      entry.pageId = Promise.resolve(null);
      return;
    }
    entry.pageId = this.#track(
      this.#data
        .call('history.recordVisit', {
          // The title at a commit is often the previous page's: the settled one follows.
          page: { ...page, title: '' },
          transition: commit.transition,
          visitedAt: this.#now(),
          tabId,
        })
        .then(
          ({ pageId }) => pageId,
          (error: unknown) => this.#failed('history.recordVisit', error),
        ),
    );
  }

  titleChanged(tabId: TabId, title: string): void {
    const entry = this.#tabs.get(tabId);
    if (this.#stopped || entry === undefined || entry.urlKey === null || title === '') {
      return;
    }
    entry.pendingTitle = title;
    clearTimeout(entry.titleTimer);
    entry.titleTimer = setTimeout(() => {
      this.#writeTitle(entry);
    }, TITLE_DEBOUNCE_MS);
    entry.titleTimer.unref();
  }

  faviconChanged(tabId: TabId, favicon: string): void {
    const entry = this.#tabs.get(tabId);
    if (this.#stopped || entry === undefined || entry.urlKey === null) {
      return;
    }
    void this.#track(
      entry.pageId.then(async (pageId) => {
        // An icon is stored only for a page that was: not for an excluded site's.
        const faviconId = pageId === null ? null : await this.#storedFavicon(favicon);
        if (pageId !== null && faviconId !== null) {
          await this.#data
            .call('history.updatePage', { pageId, faviconId })
            .catch((error: unknown) => this.#failed('history.updatePage', error));
        }
      }),
    );
  }

  closed(tabId: TabId): void {
    const entry = this.#tabs.get(tabId);
    if (entry !== undefined) {
      this.#writeTitle(entry);
      this.#tabs.delete(tabId);
    }
  }

  /** At quit (DataLifecycle's flush): titles still waiting are written, and every write lands. */
  async flush(): Promise<void> {
    for (const entry of this.#tabs.values()) {
      this.#writeTitle(entry);
    }
    this.#stopped = true;
    await Promise.allSettled([...this.#inFlight]);
  }

  #entry(tabId: TabId): TabEntry {
    let entry = this.#tabs.get(tabId);
    if (entry === undefined) {
      entry = {
        pageId: Promise.resolve(null),
        urlKey: null,
        pendingTitle: null,
        titleTimer: undefined,
      };
      this.#tabs.set(tabId, entry);
    }
    return entry;
  }

  #writeTitle(entry: TabEntry): void {
    clearTimeout(entry.titleTimer);
    entry.titleTimer = undefined;
    const title = entry.pendingTitle;
    entry.pendingTitle = null;
    if (title === null) {
      return;
    }
    void this.#track(
      entry.pageId.then(async (pageId) => {
        if (pageId !== null) {
          await this.#data
            .call('history.updatePage', { pageId, title })
            .catch((error: unknown) => this.#failed('history.updatePage', error));
        }
      }),
    );
  }

  /** The icon's row, stored on first sight this run; null if it can't be stored. */
  #storedFavicon(dataUrl: string): Promise<number | null> {
    const known = this.#favicons.get(dataUrl);
    if (known !== undefined) {
      return known;
    }
    let png: string | null;
    try {
      png = this.#encodeFavicon(dataUrl);
    } catch {
      png = null;
    }
    const stored =
      png === null
        ? Promise.resolve(null)
        : this.#data.call('favicons.put', { png, at: this.#now() }).then(
            ({ id }) => id,
            (error: unknown) => {
              this.#favicons.delete(dataUrl); // Tried again on the next sight.
              return this.#failed('favicons.put', error);
            },
          );
    this.#favicons.set(dataUrl, stored);
    if (this.#favicons.size > FAVICON_CACHE_SIZE) {
      const oldest = this.#favicons.keys().next();
      if (oldest.done !== true) {
        this.#favicons.delete(oldest.value);
      }
    }
    return stored;
  }

  #track<T>(promise: Promise<T>): Promise<T> {
    this.#inFlight.add(promise);
    void promise.finally(() => this.#inFlight.delete(promise));
    return promise;
  }

  #failed(method: string, error: unknown): null {
    // The database may simply be unavailable (it failed to open, or the app is quitting).
    const code = error instanceof DataClientError ? error.code : 'internal';
    if (!isDataUnavailable(error)) {
      this.#logger.warn('history.writeFailed', { method, code });
    }
    return null;
  }
}
