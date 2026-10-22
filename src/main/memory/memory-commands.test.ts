import { describe, expect, it } from 'vitest';

import type { DataInput, DataMethod, DataOutput, TabRow } from '../../shared/contracts/data-rpc';
import { displayUrl } from '../../core/url/display';
import { CommandError } from '../ipc/command-error';
import type { ArchivedTab, TabId, TabState } from '../tabs/tab-manager';
import { createMemoryCommands } from './memory-commands';

const NOW = Date.UTC(2026, 9, 22, 15, 30);
const TAB_A = '0199f000-0000-7000-8000-00000000000a';
const TAB_B = '0199f000-0000-7000-8000-00000000000b';
const TAB_NEW = '0199f000-0000-7000-8000-0000000000ff';
const WORKSPACE = '0199f000-0000-7000-8000-000000000001';

type Calls = { method: DataMethod; input: unknown }[];
type Answers = { [M in DataMethod]?: (input: DataInput<M>) => DataOutput<M> };

function searchResult(
  overrides: Partial<DataOutput<'search.query'>['results'][number]> = {},
): DataOutput<'search.query'>['results'][number] {
  return {
    pageId: 7,
    url: 'https://docs.example.org/postgres?token=x',
    title: 'Postgres indexes',
    site: 'example.org',
    faviconId: null,
    lastVisitAt: NOW - 1000,
    visitCount: 3,
    tab: null,
    score: 1.5,
    breakdown: {
      text: 1,
      frecency: 0.3,
      titleExact: 0.2,
      siteMatch: 0,
      state: 0,
      bm25: -3.2,
      frecencyNow: 0.5,
    },
    titleRanges: [[0, 8]],
    ...overrides,
  };
}

function archivedRow(id: string, archivedAt = NOW - 5000): TabRow {
  return {
    id,
    workspaceId: WORKSPACE,
    placement: 'archive',
    position: 0,
    pinned: false,
    userProtected: false,
    pageId: 7,
    url: 'https://docs.example.org/postgres',
    title: 'Postgres indexes',
    faviconId: null,
    restoreState: null,
    openerTabId: null,
    createdAt: NOW - 10_000,
    lastUsedAt: NOW - 9000,
    lastUsedEngaged: 0,
    lastUsedActiveDay: 0,
    placementChangedAt: archivedAt,
    archivedAt,
    archiveReason: 'auto',
    closedAt: null,
  };
}

function setup(
  options: {
    readonly answers?: Answers;
    readonly live?: Readonly<Record<string, Pick<TabState, 'placement' | 'ephemeral'>>>;
    readonly selected?: TabId | null;
    readonly inMemoryArchived?: readonly ArchivedTab[];
  } = {},
) {
  const calls: Calls = [];
  const log: string[] = [];
  const live = new Map(Object.entries(options.live ?? {}));
  const adopted: ArchivedTab[] = [...(options.inMemoryArchived ?? [])];
  let flushes = 0;
  const data = {
    call: <M extends DataMethod>(method: M, input: DataInput<M>): Promise<DataOutput<M>> => {
      calls.push({ method, input });
      const answer = options.answers?.[method] as
        ((input: DataInput<M>) => DataOutput<M>) | undefined;
      if (answer === undefined) {
        return Promise.reject(new Error(`unexpected ${method}`));
      }
      return Promise.resolve(answer(input));
    },
  };
  const memory = createMemoryCommands({
    data,
    tabs: {
      has: (id) => live.has(id),
      get: (id) => live.get(id) as TabState,
      selectedTabId: () => options.selected ?? null,
      create: (createOptions) => {
        log.push(`create ${JSON.stringify(createOptions)}`);
        return TAB_NEW;
      },
      navigate: (id, url, navigateOptions) => {
        log.push(`navigate ${id} ${url} ${navigateOptions?.transition ?? ''}`);
      },
      adoptArchived: (entry) => {
        log.push(`adopt ${entry.id}`);
        adopted.push(entry);
      },
      archivedTabs: () => adopted,
      archivedCount: () => 1234,
    },
    placement: {
      restore: (id, { focus }) => {
        log.push(`restore ${id} focus=${String(focus)}`);
        if (live.has(id) || adopted.some((entry) => entry.id === id)) {
          return id;
        }
        return null;
      },
    },
    workspaceId: () => WORKSPACE,
    flushSession: () => {
      flushes += 1;
      return Promise.resolve();
    },
    now: () => NOW,
  });
  return { memory, calls, log, flushes: () => flushes };
}

describe('memory.search', () => {
  it('asks the worker with main clock, the words and the limit, and no filter for All', async () => {
    const { memory, calls } = setup({
      answers: { 'search.query': () => ({ mode: 'text', results: [] }) },
    });
    await memory.search({ query: 'postgres ind', scope: 'all', limit: 20 });
    expect(calls).toEqual([
      { method: 'search.query', input: { query: 'postgres ind', now: NOW, limit: 20 } },
    ]);
  });

  it.each([
    ['open', { placement: 'strip' }],
    ['sleeping', { placement: 'shelf' }],
    ['archived', { placement: 'archive' }],
    ['week', { visitedSince: NOW - 7 * 24 * 60 * 60 * 1000 }],
  ] as const)('turns the %s scope into a filter', async (scope, filter) => {
    const { memory, calls } = setup({
      answers: { 'search.query': () => ({ mode: 'text', results: [] }) },
    });
    await memory.search({ query: 'x y', scope, limit: 5 });
    expect((calls[0]?.input as DataInput<'search.query'>).filter).toEqual(filter);
  });

  it('starts Today at local midnight', async () => {
    const { memory, calls } = setup({
      answers: { 'search.query': () => ({ mode: 'text', results: [] }) },
    });
    await memory.search({ query: '', scope: 'today', limit: 5 });
    const midnight = new Date(NOW);
    midnight.setHours(0, 0, 0, 0);
    expect((calls[0]?.input as DataInput<'search.query'>).filter).toEqual({
      visitedSince: midnight.getTime(),
    });
  });

  it('reads a site: word out of the words, and says which site it kept to', async () => {
    const { memory, calls } = setup({
      answers: { 'search.query': () => ({ mode: 'text', results: [] }) },
    });
    const answer = await memory.search({
      query: 'site:docs.github.com pulls',
      scope: 'archived',
      limit: 5,
    });
    expect(calls[0]?.input).toEqual({
      query: 'pulls',
      now: NOW,
      limit: 5,
      filter: { placement: 'archive', site: 'github.com' },
    });
    expect(answer.site).toBe('github.com');
  });

  it('lets the shell site filter win over a site: word', async () => {
    const { memory, calls } = setup({
      answers: { 'search.query': () => ({ mode: 'text', results: [] }) },
    });
    const answer = await memory.search({
      query: 'site:a.example x',
      scope: 'all',
      site: 'b.example',
      limit: 5,
    });
    expect((calls[0]?.input as DataInput<'search.query'>).filter).toEqual({ site: 'b.example' });
    expect(answer.site).toBe('b.example');
  });

  it('shows the address by the display rules and keeps only the five score terms', async () => {
    const { memory } = setup({
      answers: { 'search.query': () => ({ mode: 'text', results: [searchResult()] }) },
    });
    const [result] = (await memory.search({ query: 'postgres', scope: 'all', limit: 5 })).results;
    expect(result).toEqual({
      pageId: 7,
      title: 'Postgres indexes',
      address: displayUrl('https://docs.example.org/postgres?token=x').text,
      site: 'example.org',
      lastVisitAt: NOW - 1000,
      visitCount: 3,
      tab: null,
      titleRanges: [[0, 8]],
      score: 1.5,
      breakdown: { text: 1, frecency: 0.3, titleExact: 0.2, siteMatch: 0, state: 0 },
    });
  });

  it('reports a tab as TabManager knows it now, not as the last save did', async () => {
    const { memory } = setup({
      live: {
        [TAB_A]: { placement: 'shelf', ephemeral: false },
        [TAB_B]: { placement: 'strip', ephemeral: true },
      },
      answers: {
        'search.query': () => ({
          mode: 'text',
          results: [
            // Saved as open, moved to Sleeping since.
            searchResult({ pageId: 1, tab: { id: TAB_A, placement: 'strip' } }),
            // A private tab: never offered.
            searchResult({ pageId: 2, tab: { id: TAB_B, placement: 'strip' } }),
            // Saved as open, closed since.
            searchResult({
              pageId: 3,
              tab: { id: '0199f000-0000-7000-8000-0000000000c3', placement: 'strip' },
            }),
            // Archived: only the database holds it.
            searchResult({
              pageId: 4,
              tab: { id: '0199f000-0000-7000-8000-0000000000c4', placement: 'archive' },
            }),
          ],
        }),
      },
    });
    const tabs = (await memory.search({ query: 'x x', scope: 'all', limit: 5 })).results.map(
      (result) => result.tab,
    );
    expect(tabs).toEqual([
      { tabId: TAB_A, placement: 'shelf' },
      null,
      null,
      { tabId: '0199f000-0000-7000-8000-0000000000c4', placement: 'archive' },
    ]);
  });
});

describe('memory.open', () => {
  it('switches to a live tab, with the page focused', async () => {
    const { memory, log, calls } = setup({
      live: { [TAB_A]: { placement: 'strip', ephemeral: false } },
    });
    expect(await memory.open({ pageId: 7, tabId: TAB_A, target: 'switch' })).toBe(TAB_A);
    expect(log).toEqual([`restore ${TAB_A} focus=true`]);
    expect(calls).toEqual([]);
  });

  it('brings back an archived tab only the database holds, after taking it into memory', async () => {
    const { memory, log } = setup({
      answers: { 'tabs.get': ({ id }) => ({ tab: archivedRow(id) }) },
    });
    expect(await memory.open({ pageId: 7, tabId: TAB_A, target: 'switch' })).toBe(TAB_A);
    expect(log).toEqual([
      `restore ${TAB_A} focus=true`,
      `adopt ${TAB_A}`,
      `restore ${TAB_A} focus=true`,
    ]);
  });

  it('opens the page in a new tab when its tab went', async () => {
    const { memory, log } = setup({
      selected: TAB_B,
      answers: {
        'tabs.get': () => ({ tab: null }),
        'history.page': () => ({
          page: {
            id: 7,
            urlKey: 'https://docs.example.org/postgres',
            url: 'https://docs.example.org/postgres',
            host: 'docs.example.org',
            site: 'example.org',
            title: 'Postgres indexes',
            faviconId: null,
            firstVisitAt: 1,
            lastVisitAt: 2,
            visitCount: 1,
            typedCount: 0,
            frecency: 1,
            frecencyAt: 2,
          },
        }),
      },
    });
    expect(await memory.open({ pageId: 7, tabId: TAB_A, target: 'switch' })).toBe(TAB_NEW);
    expect(log.slice(-2)).toEqual([
      `create {"select":true,"afterTabId":"${TAB_B}"}`,
      `navigate ${TAB_NEW} https://docs.example.org/postgres link`,
    ]);
  });

  it('opens a new tab for newTab even when a tab shows the page', async () => {
    const { memory, log } = setup({
      live: { [TAB_A]: { placement: 'strip', ephemeral: false } },
      answers: {
        'history.page': ({ pageId }) => ({
          page: {
            id: pageId,
            urlKey: 'https://a.example/',
            url: 'https://a.example/',
            host: 'a.example',
            site: 'a.example',
            title: '',
            faviconId: null,
            firstVisitAt: 1,
            lastVisitAt: 2,
            visitCount: 1,
            typedCount: 0,
            frecency: 1,
            frecencyAt: 2,
          },
        }),
      },
    });
    expect(await memory.open({ pageId: 7, tabId: TAB_A, target: 'newTab' })).toBe(TAB_NEW);
    expect(log).toEqual([`create {"select":true}`, `navigate ${TAB_NEW} https://a.example/ link`]);
  });

  it('takes the selected tab there for current, as a typed address', async () => {
    const { memory, log } = setup({
      selected: TAB_B,
      answers: {
        'history.page': () => ({
          page: {
            id: 7,
            urlKey: 'https://a.example/',
            url: 'https://a.example/',
            host: 'a.example',
            site: 'a.example',
            title: '',
            faviconId: null,
            firstVisitAt: 1,
            lastVisitAt: 2,
            visitCount: 1,
            typedCount: 0,
            frecency: 1,
            frecencyAt: 2,
          },
        }),
      },
    });
    expect(await memory.open({ pageId: 7, target: 'current' })).toBe(TAB_B);
    expect(log).toEqual([`navigate ${TAB_B} https://a.example/ typed`]);
  });

  it('answers not_found for a page the memory no longer has', async () => {
    const { memory } = setup({ answers: { 'history.page': () => ({ page: null }) } });
    await expect(memory.open({ pageId: 9, target: 'newTab' })).rejects.toEqual(
      new CommandError('not_found'),
    );
  });
});

describe('archive.list', () => {
  it('saves pending changes first, then lists a window of the database, newest first', async () => {
    const { memory, calls, flushes } = setup({
      answers: {
        'tabs.listArchived': () => ({ tabs: [archivedRow(TAB_A), archivedRow(TAB_B)] }),
      },
    });
    const listed = await memory.archiveList({ offset: 200, limit: 100 });
    expect(flushes()).toBe(1);
    expect(calls).toEqual([
      {
        method: 'tabs.listArchived',
        input: { workspaceId: WORKSPACE, limit: 100, offset: 200 },
      },
    ]);
    expect(listed.total).toBe(1234);
    expect(listed.tabs.map((tab) => [tab.id, tab.reason, tab.favicon])).toEqual([
      [TAB_A, 'auto', null],
      [TAB_B, 'auto', null],
    ]);
  });

  it('shows the icon memory still has for the newest archived tabs', async () => {
    const icon = 'data:image/png;base64,iVBORw0KGgo=';
    const inMemory: ArchivedTab = {
      id: TAB_A,
      pinned: false,
      url: 'https://docs.example.org/postgres',
      title: 'Postgres indexes',
      history: null,
      createdAt: 1,
      lastUsedAt: 2,
      archivedAt: NOW - 5000,
      reason: 'manual',
      favicon: icon,
    };
    const { memory } = setup({
      inMemoryArchived: [inMemory],
      answers: { 'tabs.listArchived': () => ({ tabs: [archivedRow(TAB_A)] }) },
    });
    const [listed] = (await memory.archiveList({ offset: 0, limit: 10 })).tabs;
    expect(listed?.favicon).toBe(icon);
    expect(listed?.reason).toBe('manual');
  });
});
