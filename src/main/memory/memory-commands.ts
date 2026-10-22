// The memory's commands (M4.2, assessment §5.4, §7.3): what the palette, the address bar's
// suggestions and the Archive list ask main for. Main turns the shell's words and filters into a
// data-worker search, checks every tab the database names against TabManager (the database lags
// it by up to a second), and opens results: a tab is switched to, or brought back from Sleeping
// or the Archive, even an archived tab only the database still holds.
import { displayUrl } from '../../core/url/display';
import { splitSiteFilter } from '../../core/search/site-filter';
import type { DataClient } from '../persistence/data-client';
import type { DataInput } from '../../shared/contracts/data-rpc';
import type { CommandInput, CommandOutput } from '../../shared/contracts/schemas';
import { CommandError } from '../ipc/command-error';
import type { PlacementActions } from '../lifecycle/placement-actions';
import { toArchivedTab } from '../session/session-load';
import type { TabId, TabManager } from '../tabs/tab-manager';
import { projectArchived } from '../tabs/workspace-projector';
import { isNavigationAllowed } from '../web/navigation-policy';

const DAY_MS = 24 * 60 * 60 * 1000;

type SearchFilter = NonNullable<DataInput<'search.query'>['filter']>;

export interface MemoryCommands {
  search(input: CommandInput<'memory.search'>): Promise<CommandOutput<'memory.search'>>;
  /** Opens a result; the tab now showing it. */
  open(input: CommandInput<'memory.open'>): Promise<TabId>;
  archiveList(input: CommandInput<'archive.list'>): Promise<CommandOutput<'archive.list'>>;
  /**
   * Brings a tab back from Sleeping or the Archive (or selects it in the strip). An archived tab
   * that only the database still holds is taken into memory first. Null when there is no such tab.
   */
  restore(tabId: TabId, options: { readonly focus: boolean }): Promise<TabId | null>;
}

export interface MemoryCommandsOptions {
  readonly data: Pick<DataClient, 'call'>;
  readonly tabs: Pick<
    TabManager,
    | 'has'
    | 'get'
    | 'selectedTabId'
    | 'create'
    | 'navigate'
    | 'adoptArchived'
    | 'archivedTabs'
    | 'archivedCount'
  >;
  readonly placement: Pick<PlacementActions, 'restore'>;
  /** The workspace whose tabs are listed: known once the session has loaded. */
  readonly workspaceId: () => string | null;
  /** Writes the tabs' pending changes, so the database holds the newest archive moves. */
  readonly flushSession?: () => Promise<void>;
  readonly now?: () => number;
}

/** The start of the local day `now` falls in. */
function startOfDay(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

export function createMemoryCommands(options: MemoryCommandsOptions): MemoryCommands {
  const { data, tabs, placement } = options;
  const now = options.now ?? Date.now;

  const filterFor = (
    scope: CommandInput<'memory.search'>['scope'],
    site: string | null,
    at: number,
  ): SearchFilter => {
    const filter: { -readonly [K in keyof SearchFilter]: SearchFilter[K] } = {};
    if (scope === 'open') {
      filter.placement = 'strip';
    } else if (scope === 'sleeping') {
      filter.placement = 'shelf';
    } else if (scope === 'archived') {
      filter.placement = 'archive';
    } else if (scope === 'today') {
      filter.visitedSince = startOfDay(at);
    } else if (scope === 'week') {
      filter.visitedSince = Math.max(0, at - 7 * DAY_MS);
    }
    if (site !== null) {
      filter.site = site;
    }
    return filter;
  };

  /**
   * The tab a result names, as TabManager knows it now: a strip or Sleeping tab that closed or
   * moved since the last save is reported as it is, or not at all.
   */
  const liveTab = (
    tab: { readonly id: string; readonly placement: 'strip' | 'shelf' | 'archive' } | null,
  ): CommandOutput<'memory.search'>['results'][number]['tab'] => {
    if (tab === null) {
      return null;
    }
    if (tabs.has(tab.id)) {
      const live = tabs.get(tab.id);
      return live.ephemeral ? null : { tabId: tab.id, placement: live.placement };
    }
    // Not live: still archived (the database holds it), or closed since the last save.
    return tab.placement === 'archive' ? { tabId: tab.id, placement: 'archive' } : null;
  };

  const restore = async (tabId: TabId, { focus }: { readonly focus: boolean }) => {
    const restored = placement.restore(tabId, { focus });
    if (restored !== null) {
      return restored;
    }
    const { tab } = await data.call('tabs.get', { id: tabId });
    const archived = tab === null ? null : toArchivedTab(tab);
    if (archived === null) {
      return null;
    }
    tabs.adoptArchived(archived);
    return placement.restore(tabId, { focus });
  };

  return {
    async search({ query, scope, site, limit }) {
      const at = now();
      const words = splitSiteFilter(query);
      const keepTo = site ?? words.site;
      const filter = filterFor(scope, keepTo, at);
      const answer = await data.call('search.query', {
        query: words.text,
        now: at,
        limit,
        ...(Object.keys(filter).length === 0 ? {} : { filter }),
      });
      return {
        mode: answer.mode,
        site: keepTo,
        results: answer.results.map((result) => ({
          pageId: result.pageId,
          title: result.title,
          address: displayUrl(result.url).text,
          site: result.site,
          lastVisitAt: result.lastVisitAt,
          visitCount: result.visitCount,
          tab: liveTab(result.tab),
          titleRanges: result.titleRanges.map(([start, end]) => [start, end] as [number, number]),
          score: result.score,
          breakdown: {
            text: result.breakdown.text,
            frecency: result.breakdown.frecency,
            titleExact: result.breakdown.titleExact,
            siteMatch: result.breakdown.siteMatch,
            state: result.breakdown.state,
          },
        })),
      };
    },

    async open({ pageId, tabId, target }) {
      if (target === 'switch' && tabId !== undefined) {
        const restored = await restore(tabId, { focus: true });
        if (restored !== null) {
          return restored;
        }
        // The tab went (closed, or restored and closed again): open the page itself.
      }
      const { page } = await data.call('history.page', { pageId });
      if (page === null || !isNavigationAllowed('tab', { url: page.url, isMainFrame: true })) {
        throw new CommandError('not_found');
      }
      const selected = tabs.selectedTabId();
      if (target === 'current' && selected !== null) {
        // The address bar's suggestion: as if its address were typed.
        tabs.navigate(selected, page.url, { transition: 'typed' });
        return selected;
      }
      const opened = tabs.create({
        select: true,
        ...(selected === null ? {} : { afterTabId: selected }),
      });
      tabs.navigate(opened, page.url, { transition: 'link' });
      return opened;
    },

    async archiveList({ offset, limit }) {
      const workspaceId = options.workspaceId();
      if (workspaceId === null) {
        return { total: 0, tabs: [] };
      }
      await options.flushSession?.();
      const { tabs: rows } = await data.call('tabs.listArchived', { workspaceId, limit, offset });
      // Memory has the icons of the newest; the database has none (they are memory only).
      const inMemory = new Map(tabs.archivedTabs().map((tab) => [tab.id, tab]));
      const listed = rows.flatMap((row) => {
        const tab = inMemory.get(row.id) ?? toArchivedTab(row);
        return tab === null ? [] : [projectArchived(tab)];
      });
      return { total: tabs.archivedCount(), tabs: listed };
    },

    restore,
  };
}
