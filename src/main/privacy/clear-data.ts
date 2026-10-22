// Clearing data (assessment §5.7, M5.2), the three ways it offers:
//   - one entry: a page of the memory (the palette's Shift+Delete), with the archived tab showing
//     it when that is the entry;
//   - "forget this site": every page and visit of the site, its archived and recently closed tabs,
//     and if asked its cookies, site storage and cached files, and its stored permissions;
//   - a time range (the last hour, day or week, or everything): the visits since then, and if asked
//     the tabs archived or closed since then, cookies and site data, and cached files.
// The memory is the data worker's: one transaction per request, then a checkpoint and a vacuum
// (data/repos/forget.ts). Archived and closed tabs leave TabManager's memory first, so the session
// store never writes them again. Open and Sleeping tabs are the user's, never touched.
//
// What Chromium can't scope is cleared whole, and the settings page says so: cookies, site data
// and cached files have no "since" in Electron's API, so a time range clears them for all time. For
// a site, cookies are matched by their domain; site storage and cached files by the site's
// addresses Veltriva knows (those of its pages and tabs, plus the site and www.).
import type { Cookie } from 'electron';

import { siteOf } from '../../core/url/site';
import type { ForgetCounts } from '../../shared/contracts/data-rpc';
import type { ClearRange } from '../../shared/contracts/schemas';
import type { DataClient } from '../persistence/data-client';
import type { Logger } from '../platform/logger';
import type { TabId, TabManager } from '../tabs/tab-manager';

const HOUR_MS = 60 * 60 * 1000;

const RANGE_MS: Readonly<Record<Exclude<ClearRange, 'all'>, number>> = {
  hour: HOUR_MS,
  day: 24 * HOUR_MS,
  week: 7 * 24 * HOUR_MS,
};

/** Chromium's storage for sites, apart from cookies and the cache. */
const SITE_STORAGE = [
  'localStorage',
  'indexedDB',
  'serviceWorkers',
  'fileSystems',
  'webSQL',
  'backgroundFetch',
] as const;

/** The browsing session's data: Electron's `Session`, or a fake in tests. */
export interface BrowsingStorage {
  clearData(options: {
    readonly dataTypes: readonly string[];
    readonly origins?: readonly string[];
  }): Promise<void>;
  readonly cookies: {
    get(
      filter: Record<string, never>,
    ): Promise<readonly Pick<Cookie, 'domain' | 'name' | 'path' | 'secure'>[]>;
    remove(url: string, name: string): Promise<void>;
  };
}

export interface ClearDataOptions {
  readonly data: Pick<DataClient, 'call'>;
  readonly tabs: Pick<TabManager, 'forgetRecords' | 'setArchivedTotal'>;
  readonly storage: BrowsingStorage;
  /** The workspace whose archived tabs are counted again; null without a database. */
  readonly workspaceId: () => string | null;
  readonly now: () => number;
  readonly logger: Logger;
  /** Forgets the site's stored permission decisions (main/privacy/site-permissions.ts). */
  readonly forgetSitePermissions: (site: string) => void;
}

/** What a clear did, for the settings page to say. */
export interface ClearResult {
  readonly pages: number;
  readonly visits: number;
  readonly tabs: number;
}

export class ClearData {
  readonly #options: ClearDataOptions;

  constructor(options: ClearDataOptions) {
    this.#options = options;
  }

  /** The time a range starts: 0 for everything. */
  since(range: ClearRange): number {
    return range === 'all' ? 0 : this.#options.now() - RANGE_MS[range];
  }

  async clearRange(request: {
    readonly range: ClearRange;
    readonly memory: boolean;
    readonly tabs: boolean;
    readonly siteData: boolean;
    readonly cache: boolean;
  }): Promise<ClearResult> {
    const since = this.since(request.range);
    if (request.tabs) {
      this.#options.tabs.forgetRecords(
        (record) => (record.archivedAt ?? record.closedAt ?? 0) >= since,
      );
    }
    const counts =
      request.memory || request.tabs
        ? await this.#forget({ scope: 'since', since, memory: request.memory, tabs: request.tabs })
        : null;
    // No "since" in Electron's API: these go for all time, whatever the range (the page says so).
    if (request.siteData) {
      await this.#storage({ dataTypes: ['cookies', ...SITE_STORAGE] });
    }
    if (request.cache) {
      await this.#storage({ dataTypes: ['cache'] });
    }
    return result(counts);
  }

  async forgetSite(request: {
    readonly site: string;
    readonly siteData: boolean;
    readonly permissions: boolean;
  }): Promise<ClearResult> {
    const { site } = request;
    this.#options.tabs.forgetRecords((record) => siteOf(record.url) === site);
    const counts = await this.#forget({ scope: 'site', site });
    if (request.siteData) {
      const origins = new Set(counts.origins);
      for (const host of [site, `www.${site}`]) {
        origins.add(`https://${host}`);
        origins.add(`http://${host}`);
      }
      for (const cookie of await this.#cookiesOf(site)) {
        const host = cookie.domain?.replace(/^\./, '') ?? '';
        const url = `${cookie.secure === true ? 'https' : 'http'}://${host}${cookie.path ?? '/'}`;
        origins.add(new URL(url).origin);
        await this.#options.storage.cookies.remove(url, cookie.name).catch(() => {
          this.#options.logger.warn('clearData.cookieFailed');
        });
      }
      await this.#storage({ dataTypes: [...SITE_STORAGE, 'cache'], origins: [...origins] });
    }
    if (request.permissions) {
      this.#options.forgetSitePermissions(site);
    }
    return result(counts);
  }

  /** One entry of the memory: pages, and the archived tabs showing them when those are the entry. */
  async forgetEntries(request: {
    readonly pageIds: readonly number[];
    readonly tabIds: readonly TabId[];
  }): Promise<ClearResult> {
    const ids = new Set(request.tabIds);
    if (ids.size > 0) {
      this.#options.tabs.forgetRecords((record) => ids.has(record.id));
    }
    const counts = await this.#forget({
      scope: 'pages',
      pageIds: [...request.pageIds],
      tabIds: [...request.tabIds],
    });
    return result(counts);
  }

  async #forget(
    request:
      | {
          readonly scope: 'since';
          readonly since: number;
          readonly memory: boolean;
          readonly tabs: boolean;
        }
      | { readonly scope: 'site'; readonly site: string }
      | { readonly scope: 'pages'; readonly pageIds: number[]; readonly tabIds: string[] },
  ): Promise<ForgetCounts> {
    const counts = await this.#options.data.call('memory.forget', request);
    // The archive's count: archived tabs only the database held may be gone too.
    const workspaceId = this.#options.workspaceId();
    if (workspaceId !== null) {
      const { count } = await this.#options.data.call('tabs.countArchived', { workspaceId });
      this.#options.tabs.setArchivedTotal(count);
    }
    return counts;
  }

  async #storage(options: {
    readonly dataTypes: readonly string[];
    readonly origins?: readonly string[];
  }): Promise<void> {
    try {
      await this.#options.storage.clearData(options);
    } catch {
      this.#options.logger.warn('clearData.storageFailed');
    }
  }

  async #cookiesOf(site: string) {
    try {
      const cookies = await this.#options.storage.cookies.get({});
      return cookies.filter((cookie) => {
        const domain = (cookie.domain ?? '').replace(/^\./, '').toLowerCase();
        return domain === site || domain.endsWith(`.${site}`);
      });
    } catch {
      this.#options.logger.warn('clearData.cookiesFailed');
      return [];
    }
  }
}

function result(counts: ForgetCounts | null): ClearResult {
  return {
    pages: counts?.pages ?? 0,
    visits: counts?.visits ?? 0,
    tabs: counts?.tabs ?? 0,
  };
}
