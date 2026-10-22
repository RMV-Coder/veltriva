import { describe, expect, it, vi } from 'vitest';

import { DATA_METHODS } from '../../shared/contracts/data-rpc';
import type { DataMethod } from '../../shared/contracts/data-rpc';
import { ClearData } from './clear-data';
import type { BrowsingStorage } from './clear-data';

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const WORKSPACE = '0199f100-0000-7000-8000-000000000001';

interface Record {
  readonly id: string;
  readonly url: string;
  readonly archivedAt: number | null;
  readonly closedAt: number | null;
}

function setup(records: Record[] = [], origins: string[] = []) {
  const calls: { method: string; input: unknown }[] = [];
  const call = vi.fn((method: DataMethod, input: unknown) => {
    DATA_METHODS[method].input.parse(input);
    calls.push({ method, input });
    if (method === 'memory.forget') {
      return Promise.resolve({ pages: 3, visits: 7, tabs: 2, favicons: 1, origins });
    }
    return Promise.resolve({ count: 40 });
  });
  const memory = [...records];
  const forgotten: string[] = [];
  const tabs = {
    forgetRecords: vi.fn((matches: (record: Record) => boolean) => {
      const gone = memory.filter((record) => matches(record)).map((record) => record.id);
      forgotten.push(...gone);
      return gone;
    }),
    setArchivedTotal: vi.fn(),
  };
  const cleared: { dataTypes: readonly string[]; origins?: readonly string[] }[] = [];
  const removedCookies: string[] = [];
  const storage: BrowsingStorage = {
    clearData: (options) => {
      cleared.push(options);
      return Promise.resolve();
    },
    cookies: {
      get: () =>
        Promise.resolve([
          { domain: '.example.com', name: 'sid', path: '/', secure: true },
          { domain: 'mail.example.com', name: 'pref', path: '/app', secure: false },
          { domain: '.example.org', name: 'other', path: '/', secure: true },
          { domain: 'notexample.com', name: 'lookalike', path: '/', secure: true },
        ]),
      remove: (url, name) => {
        removedCookies.push(`${name} ${url}`);
        return Promise.resolve();
      },
    },
  };
  const forgetSitePermissions = vi.fn();
  const clear = new ClearData({
    data: { call: call as never },
    tabs,
    storage,
    workspaceId: () => WORKSPACE,
    now: () => NOW,
    logger: { warn: vi.fn(), error: vi.fn() },
    forgetSitePermissions,
  });
  return { clear, calls, tabs, forgotten, cleared, removedCookies, forgetSitePermissions };
}

describe('ClearData (M5.2)', () => {
  it.each([
    ['hour', NOW - HOUR],
    ['day', NOW - 24 * HOUR],
    ['week', NOW - 7 * 24 * HOUR],
    ['all', 0],
  ] as const)('a range of %s starts at %i', (range, since) => {
    expect(setup().clear.since(range)).toBe(since);
  });

  describe('a time range', () => {
    it('forgets the memory since then in the worker, and counts the archive again', async () => {
      const { clear, calls, tabs } = setup();

      const result = await clear.clearRange({
        range: 'hour',
        memory: true,
        tabs: false,
        siteData: false,
        cache: false,
      });

      expect(result).toEqual({ pages: 3, visits: 7, tabs: 2 });
      expect(calls).toEqual([
        {
          method: 'memory.forget',
          input: { scope: 'since', since: NOW - HOUR, memory: true, tabs: false },
        },
        { method: 'tabs.countArchived', input: { workspaceId: WORKSPACE } },
      ]);
      expect(tabs.setArchivedTotal).toHaveBeenCalledWith(40);
      // Tabs were not asked for: none leaves memory.
      expect(tabs.forgetRecords).not.toHaveBeenCalled();
    });

    it('drops the archived and closed tabs since then from memory before the worker deletes them', async () => {
      const { clear, forgotten, calls } = setup([
        {
          id: 'old-archived',
          url: 'https://a.example/',
          archivedAt: NOW - 2 * HOUR,
          closedAt: null,
        },
        { id: 'new-archived', url: 'https://b.example/', archivedAt: NOW - 10, closedAt: null },
        { id: 'new-closed', url: 'https://c.example/', archivedAt: null, closedAt: NOW - 10 },
      ]);

      await clear.clearRange({
        range: 'hour',
        memory: false,
        tabs: true,
        siteData: false,
        cache: false,
      });

      expect(forgotten).toEqual(['new-archived', 'new-closed']);
      expect(calls[0]).toEqual({
        method: 'memory.forget',
        input: { scope: 'since', since: NOW - HOUR, memory: false, tabs: true },
      });
    });

    it("clears cookies, site data and the cache for all time: Electron can't scope them by time", async () => {
      const { clear, cleared, calls } = setup();

      await clear.clearRange({
        range: 'day',
        memory: false,
        tabs: false,
        siteData: true,
        cache: true,
      });

      expect(calls).toEqual([]);
      expect(cleared).toEqual([
        {
          dataTypes: [
            'cookies',
            'localStorage',
            'indexedDB',
            'serviceWorkers',
            'fileSystems',
            'webSQL',
            'backgroundFetch',
          ],
        },
        { dataTypes: ['cache'] },
      ]);
    });
  });

  describe('forgetting a site', () => {
    it('forgets its records and memory; clears its cookies by domain and its storage and cache by its origins', async () => {
      const { clear, forgotten, calls, cleared, removedCookies, forgetSitePermissions } = setup(
        [
          { id: 'a', url: 'https://mail.example.com/x', archivedAt: NOW, closedAt: null },
          { id: 'b', url: 'https://example.org/', archivedAt: null, closedAt: NOW },
        ],
        ['https://mail.example.com'],
      );

      await clear.forgetSite({ site: 'example.com', siteData: true, permissions: true });

      expect(forgotten).toEqual(['a']);
      expect(calls[0]).toEqual({
        method: 'memory.forget',
        input: { scope: 'site', site: 'example.com' },
      });
      // The site's cookies, on any host of it; not another site's, nor a look-alike's.
      expect(removedCookies).toEqual([
        'sid https://example.com/',
        'pref http://mail.example.com/app',
      ]);
      expect(cleared).toHaveLength(1);
      expect(cleared[0]?.dataTypes).toEqual([
        'localStorage',
        'indexedDB',
        'serviceWorkers',
        'fileSystems',
        'webSQL',
        'backgroundFetch',
        'cache',
      ]);
      expect([...(cleared[0]?.origins ?? [])].sort()).toEqual(
        [
          'http://example.com',
          'http://mail.example.com',
          'http://www.example.com',
          'https://example.com',
          'https://mail.example.com',
          'https://www.example.com',
        ].sort(),
      );
      expect(forgetSitePermissions).toHaveBeenCalledWith('example.com');
    });

    it('leaves the browser data and permissions alone when not asked', async () => {
      const { clear, cleared, removedCookies, forgetSitePermissions } = setup();

      await clear.forgetSite({ site: 'example.com', siteData: false, permissions: false });

      expect(cleared).toEqual([]);
      expect(removedCookies).toEqual([]);
      expect(forgetSitePermissions).not.toHaveBeenCalled();
    });
  });

  it('forgets one entry: its pages, and the archived tab named, which leaves memory first', async () => {
    const { clear, forgotten, calls } = setup([
      {
        id: '0199f100-0000-7000-8000-00000000000a',
        url: 'https://a.example/',
        archivedAt: NOW,
        closedAt: null,
      },
      {
        id: '0199f100-0000-7000-8000-00000000000b',
        url: 'https://b.example/',
        archivedAt: NOW,
        closedAt: null,
      },
    ]);

    await clear.forgetEntries({ pageIds: [5], tabIds: ['0199f100-0000-7000-8000-00000000000a'] });

    expect(forgotten).toEqual(['0199f100-0000-7000-8000-00000000000a']);
    expect(calls[0]).toEqual({
      method: 'memory.forget',
      input: { scope: 'pages', pageIds: [5], tabIds: ['0199f100-0000-7000-8000-00000000000a'] },
    });
  });
});
