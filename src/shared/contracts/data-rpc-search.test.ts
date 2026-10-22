import { describe, expect, it } from 'vitest';

import { DATA_METHODS, MAX_SEARCH_QUERY, MAX_SEARCH_RESULTS } from './data-rpc';

const accepts = (method: keyof typeof DATA_METHODS, side: 'input' | 'output', value: unknown) =>
  DATA_METHODS[method][side].safeParse(value).success;

const T0 = 1_700_000_000_000;
const TAB = '0199f000-0000-7000-8000-00000000000a';

const result = {
  pageId: 1,
  url: 'https://a.example/',
  title: 'A page',
  site: 'a.example',
  faviconId: null,
  lastVisitAt: T0,
  visitCount: 2,
  tab: { id: TAB, placement: 'archive' },
  score: 1.25,
  breakdown: {
    text: 1,
    frecency: 0.05,
    titleExact: 0,
    siteMatch: 0,
    state: 0.2,
    bm25: -2.5,
    frecencyNow: 0.1,
  },
  titleRanges: [[0, 1]],
};

describe('search.query (M4.1)', () => {
  const input = (overrides: Record<string, unknown> = {}) => ({
    query: 'postgres index',
    now: T0,
    limit: 50,
    ...overrides,
  });

  it('takes the words, main clock and a bounded limit', () => {
    expect(accepts('search.query', 'input', input())).toBe(true);
    expect(accepts('search.query', 'input', input({ query: '' }))).toBe(true);
    expect(accepts('search.query', 'input', input({ limit: 1 }))).toBe(true);
    expect(accepts('search.query', 'input', input({ limit: MAX_SEARCH_RESULTS }))).toBe(true);
    for (const limit of [0, MAX_SEARCH_RESULTS + 1, 1.5, -1]) {
      expect(accepts('search.query', 'input', input({ limit })), String(limit)).toBe(false);
    }
    expect(accepts('search.query', 'input', input({ query: 'x'.repeat(MAX_SEARCH_QUERY) }))).toBe(
      true,
    );
    expect(
      accepts('search.query', 'input', input({ query: 'x'.repeat(MAX_SEARCH_QUERY + 1) })),
    ).toBe(false);
  });

  it('takes only the known filters, each in its own shape', () => {
    expect(
      accepts(
        'search.query',
        'input',
        input({ filter: { placement: 'archive', site: 'a.example', visitedSince: T0 } }),
      ),
    ).toBe(true);
    expect(accepts('search.query', 'input', input({ filter: {} }))).toBe(true);
    for (const filter of [
      { placement: 'closed' },
      { placement: 'strip', sql: '1=1' },
      { site: '' },
      { visitedSince: -1 },
      { column: 'title' },
    ]) {
      expect(accepts('search.query', 'input', input({ filter })), JSON.stringify(filter)).toBe(
        false,
      );
    }
    expect(accepts('search.query', 'input', input({ match: '"x"*' }))).toBe(false);
  });

  it('returns ranked results with each score term and title marks', () => {
    expect(accepts('search.query', 'output', { mode: 'text', results: [result] })).toBe(true);
    expect(accepts('search.query', 'output', { mode: 'recent', results: [] })).toBe(true);
    expect(
      accepts('search.query', 'output', {
        mode: 'text',
        results: [{ ...result, tab: null, breakdown: { ...result.breakdown, bm25: null } }],
      }),
    ).toBe(true);
  });

  it('refuses a result with a closed tab, an empty mark, a missing term or a mark as HTML', () => {
    for (const bad of [
      { ...result, tab: { id: TAB, placement: 'closed' } },
      { ...result, titleRanges: [[3, 3]] },
      { ...result, titleRanges: [[4, 2]] },
      { ...result, titleRanges: '<mark>A</mark> page' },
      { ...result, breakdown: { ...result.breakdown, state: undefined } },
      { ...result, breakdown: { ...result.breakdown, extra: 1 } },
      { ...result, html: '<b>x</b>' },
    ]) {
      expect(accepts('search.query', 'output', { mode: 'text', results: [bad] })).toBe(false);
    }
    expect(
      accepts('search.query', 'output', {
        mode: 'text',
        results: Array.from({ length: MAX_SEARCH_RESULTS + 1 }, () => result),
      }),
    ).toBe(false);
  });
});

describe('tabs.get and the Archive window (M4.2)', () => {
  it('reads one tab by its UUIDv7', () => {
    expect(accepts('tabs.get', 'input', { id: TAB })).toBe(true);
    expect(accepts('tabs.get', 'input', { id: 'tab-1' })).toBe(false);
    expect(accepts('tabs.get', 'output', { tab: null })).toBe(true);
  });

  it('pages through the Archive with a bounded offset', () => {
    const base = { workspaceId: TAB, limit: 100 };
    expect(accepts('tabs.listArchived', 'input', base)).toBe(true);
    expect(accepts('tabs.listArchived', 'input', { ...base, offset: 9900 })).toBe(true);
    for (const offset of [-1, 1.5, 10_000_001]) {
      expect(accepts('tabs.listArchived', 'input', { ...base, offset }), String(offset)).toBe(
        false,
      );
    }
  });

  it('reads one page by id', () => {
    expect(accepts('history.page', 'input', { pageId: 1 })).toBe(true);
    expect(accepts('history.page', 'input', { pageId: 0 })).toBe(false);
    expect(accepts('history.page', 'output', { page: null })).toBe(true);
  });
});
