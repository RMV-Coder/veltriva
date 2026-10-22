import { describe, expect, it } from 'vitest';

import { uuidv7 } from '../../core/id/uuidv7';
import { MAX_FAVICON_BYTES, RASTER_TYPES } from '../../core/net/favicon-format';
import { VISIT_TRANSITIONS } from '../../core/search/frecency';
import {
  DATA_METHODS,
  MAX_FAVICON_BASE64,
  MAX_FAVICONS_PER_GET,
  MAX_STORED_TITLE,
  MAX_STORED_URL,
  isDataMethod,
  pageRowSchema,
} from './data-rpc';

const TAB_ID = uuidv7(1_700_000_000_000, new Uint8Array(10).fill(3));
const T0 = 1_700_000_000_000;

/** What `bytes` has to be: base64 text, which the worker sniffs again for its `mime`. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

const page = {
  urlKey: 'https://example.com/a',
  url: 'https://example.com/a',
  host: 'example.com',
  site: 'example.com',
  title: '',
};
const recordVisit = { page, transition: 'link', visitedAt: T0, tabId: TAB_ID };

const pageRow = {
  id: 1,
  urlKey: 'https://example.com/a',
  url: 'https://example.com/a',
  host: 'example.com',
  site: 'example.com',
  title: 'Example',
  faviconId: null,
  firstVisitAt: T0,
  lastVisitAt: T0 + 1000,
  visitCount: 2,
  typedCount: 1,
  frecency: 3.5,
  frecencyAt: T0 + 1000,
};

const accepts = (method: keyof typeof DATA_METHODS, side: 'input' | 'output', value: unknown) =>
  DATA_METHODS[method][side].safeParse(value).success;

describe('the history, favicon and maintenance methods', () => {
  it('are all in the contract, and recognized by name', () => {
    for (const method of [
      'history.recordVisit',
      'history.updatePage',
      'history.page',
      'history.pages',
      'history.visits',
      'favicons.put',
      'favicons.get',
      'maintenance.run',
      'maintenance.status',
    ]) {
      expect(isDataMethod(method), method).toBe(true);
    }
  });

  it('are the only history.*, favicons.* and maintenance.* methods', () => {
    const names = Object.keys(DATA_METHODS).filter((name) =>
      /^(history|favicons|maintenance)\./.test(name),
    );

    expect(names.sort()).toEqual([
      'favicons.get',
      'favicons.put',
      'history.page',
      'history.pages',
      'history.recordVisit',
      'history.updatePage',
      'history.visits',
      'maintenance.run',
      'maintenance.status',
    ]);
  });

  it('take no SQL, table or column name: every input is a strict object', () => {
    for (const method of [
      'history.recordVisit',
      'history.updatePage',
      'history.page',
      'history.pages',
      'history.visits',
      'favicons.put',
      'favicons.get',
      'maintenance.run',
    ] as const) {
      const base: Record<string, unknown> = {
        'history.recordVisit': recordVisit,
        'history.updatePage': { pageId: 1, title: 'x' },
        'history.page': { pageId: 1 },
        'history.pages': { limit: 5 },
        'history.visits': { pageId: 1, limit: 5 },
        'favicons.put': { bytes: PNG_BASE64, mime: 'image/png', at: T0 },
        'favicons.get': { ids: [1] },
        'maintenance.run': { now: T0, visitRetentionDays: 365 },
      };
      expect(accepts(method, 'input', base[method]), `${method} as it is`).toBe(true);
      expect(
        accepts(method, 'input', { ...(base[method] as object), sql: 'DROP TABLE pages' }),
        `${method} with a key more`,
      ).toBe(false);
    }
  });
});

describe('history.recordVisit', () => {
  const input = (overrides: Record<string, unknown> = {}) => ({ ...recordVisit, ...overrides });
  const inPage = (overrides: Record<string, unknown>) => input({ page: { ...page, ...overrides } });

  it('takes a visit, with the page main has already cleaned', () => {
    expect(accepts('history.recordVisit', 'input', recordVisit)).toBe(true);
  });

  it.each(VISIT_TRANSITIONS)('takes a %s visit', (transition) => {
    expect(accepts('history.recordVisit', 'input', input({ transition }))).toBe(true);
  });

  it.each(['click', 'LINK', 'Typed', '', 'visit', 'auto_bookmark', null, 7, undefined])(
    'refuses the transition %s',
    (transition) => {
      expect(accepts('history.recordVisit', 'input', input({ transition }))).toBe(false);
    },
  );

  it('takes a visit from no tab, or from a tab with a UUIDv7 id', () => {
    expect(accepts('history.recordVisit', 'input', input({ tabId: null }))).toBe(true);
    expect(accepts('history.recordVisit', 'input', input({ tabId: TAB_ID }))).toBe(true);
  });

  it.each([
    ['a missing tab id', undefined],
    ['a number', 5],
    ['an empty string', ''],
    ['a tab-N handle', 'tab-1'],
    ['a UUID that is not version 7', '123e4567-e89b-12d3-a456-426614174000'],
    ['an upper-case UUIDv7', TAB_ID.toUpperCase()],
  ])('refuses %s as the tab', (_what, tabId) => {
    expect(accepts('history.recordVisit', 'input', input({ tabId }))).toBe(false);
  });

  it.each([
    ['negative', -1],
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['past the safe integers', Number.MAX_SAFE_INTEGER + 2],
    ['a string', '1700000000000'],
    ['null', null],
    ['missing', undefined],
  ])('refuses a visit time that is %s', (_what, visitedAt) => {
    expect(accepts('history.recordVisit', 'input', input({ visitedAt }))).toBe(false);
  });

  it('takes a visit time of 0 and of the largest safe integer', () => {
    expect(accepts('history.recordVisit', 'input', input({ visitedAt: 0 }))).toBe(true);
    expect(
      accepts('history.recordVisit', 'input', input({ visitedAt: Number.MAX_SAFE_INTEGER })),
    ).toBe(true);
  });

  it('takes an empty title, as main sends at a commit, and one of the longest allowed', () => {
    expect(accepts('history.recordVisit', 'input', inPage({ title: '' }))).toBe(true);
    expect(
      accepts('history.recordVisit', 'input', inPage({ title: 'x'.repeat(MAX_STORED_TITLE) })),
    ).toBe(true);
    expect(
      accepts('history.recordVisit', 'input', inPage({ title: 'x'.repeat(MAX_STORED_TITLE + 1) })),
    ).toBe(false);
  });

  it.each(['urlKey', 'url'])('takes a %s of 1 to 65,536 characters only', (field) => {
    expect(accepts('history.recordVisit', 'input', inPage({ [field]: 'h' }))).toBe(true);
    expect(
      accepts('history.recordVisit', 'input', inPage({ [field]: 'h'.repeat(MAX_STORED_URL) })),
    ).toBe(true);
    expect(accepts('history.recordVisit', 'input', inPage({ [field]: '' }))).toBe(false);
    expect(
      accepts('history.recordVisit', 'input', inPage({ [field]: 'h'.repeat(MAX_STORED_URL + 1) })),
    ).toBe(false);
  });

  it.each(['host', 'site'])('takes a %s of 1 to 253 characters only', (field) => {
    expect(accepts('history.recordVisit', 'input', inPage({ [field]: 'a'.repeat(253) }))).toBe(
      true,
    );
    expect(accepts('history.recordVisit', 'input', inPage({ [field]: '' }))).toBe(false);
    expect(accepts('history.recordVisit', 'input', inPage({ [field]: 'a'.repeat(254) }))).toBe(
      false,
    );
  });

  it('refuses a page missing a field, or with one more', () => {
    for (const field of Object.keys(page)) {
      const rest = Object.fromEntries(Object.entries(page).filter(([key]) => key !== field));
      expect(accepts('history.recordVisit', 'input', input({ page: rest })), field).toBe(false);
    }
    expect(accepts('history.recordVisit', 'input', inPage({ visitCount: 99 }))).toBe(false);
  });

  it('refuses a visit with no page, no transition or no time, or with a key more', () => {
    expect(accepts('history.recordVisit', 'input', {})).toBe(false);
    expect(accepts('history.recordVisit', 'input', { ...recordVisit, page: undefined })).toBe(
      false,
    );
    expect(accepts('history.recordVisit', 'input', input({ pageId: 3 }))).toBe(false);
    expect(accepts('history.recordVisit', 'input', null)).toBe(false);
  });

  it('answers with the page id, or null for a site excluded from the memory', () => {
    expect(accepts('history.recordVisit', 'output', { pageId: 1 })).toBe(true);
    expect(accepts('history.recordVisit', 'output', { pageId: Number.MAX_SAFE_INTEGER })).toBe(
      true,
    );
    expect(accepts('history.recordVisit', 'output', { pageId: null })).toBe(true);
  });

  it.each([
    ['zero', { pageId: 0 }],
    ['a negative id', { pageId: -1 }],
    ['a fraction', { pageId: 1.5 }],
    ['a string', { pageId: '1' }],
    ['a missing id', {}],
    ['an extra key', { pageId: 1, created: true }],
  ])('refuses an answer with %s', (_what, value) => {
    expect(accepts('history.recordVisit', 'output', value)).toBe(false);
  });
});

describe('history.updatePage', () => {
  it('takes a title, an icon, both, or (as the schema allows) neither', () => {
    expect(accepts('history.updatePage', 'input', { pageId: 1, title: 'Hello' })).toBe(true);
    expect(accepts('history.updatePage', 'input', { pageId: 1, faviconId: 4 })).toBe(true);
    expect(
      accepts('history.updatePage', 'input', { pageId: 1, title: 'Hello', faviconId: 4 }),
    ).toBe(true);
    expect(accepts('history.updatePage', 'input', { pageId: 1 })).toBe(true);
  });

  it('takes an empty title and one of the longest allowed, and no longer', () => {
    expect(accepts('history.updatePage', 'input', { pageId: 1, title: '' })).toBe(true);
    expect(
      accepts('history.updatePage', 'input', { pageId: 1, title: 'x'.repeat(MAX_STORED_TITLE) }),
    ).toBe(true);
    expect(
      accepts('history.updatePage', 'input', {
        pageId: 1,
        title: 'x'.repeat(MAX_STORED_TITLE + 1),
      }),
    ).toBe(false);
  });

  it.each([
    ['no page id', { title: 'x' }],
    ['a page id of 0', { pageId: 0, title: 'x' }],
    ['a negative page id', { pageId: -2, title: 'x' }],
    ['a fractional page id', { pageId: 1.5, title: 'x' }],
    ['a string page id', { pageId: '1', title: 'x' }],
    ['a null page id', { pageId: null, title: 'x' }],
    ['an icon id of 0', { pageId: 1, faviconId: 0 }],
    ['a null icon id, which would clear the icon', { pageId: 1, faviconId: null }],
    ['a string icon id', { pageId: 1, faviconId: '4' }],
    ['a null title', { pageId: 1, title: null }],
    ['a numeric title', { pageId: 1, title: 5 }],
    ['an extra key', { pageId: 1, title: 'x', url: 'https://x.example/' }],
  ])('refuses %s', (_what, value) => {
    expect(accepts('history.updatePage', 'input', value)).toBe(false);
  });

  it('answers with a count', () => {
    expect(accepts('history.updatePage', 'output', { count: 0 })).toBe(true);
    expect(accepts('history.updatePage', 'output', { count: 1 })).toBe(true);
    expect(accepts('history.updatePage', 'output', { count: -1 })).toBe(false);
    expect(accepts('history.updatePage', 'output', {})).toBe(false);
  });
});

describe('history.pages', () => {
  it('takes a limit of 1 to 1,000', () => {
    for (const limit of [1, 50, 1000]) {
      expect(accepts('history.pages', 'input', { limit }), String(limit)).toBe(true);
    }
    for (const limit of [0, -1, 1001, 1.5, '10', null, undefined, Number.NaN]) {
      expect(accepts('history.pages', 'input', { limit }), String(limit)).toBe(false);
    }
    expect(accepts('history.pages', 'input', {})).toBe(false);
  });

  it('answers with page rows', () => {
    expect(accepts('history.pages', 'output', { pages: [] })).toBe(true);
    expect(accepts('history.pages', 'output', { pages: [pageRow, { ...pageRow, id: 2 }] })).toBe(
      true,
    );
  });

  it('answers with at most 1,000 pages', () => {
    const many = (count: number) => ({
      pages: Array.from({ length: count }, (_, n) => ({ ...pageRow, id: n + 1 })),
    });

    expect(accepts('history.pages', 'output', many(1000))).toBe(true);
    expect(accepts('history.pages', 'output', many(1001))).toBe(false);
  });

  it('refuses an answer that is not a list of pages', () => {
    expect(accepts('history.pages', 'output', {})).toBe(false);
    expect(accepts('history.pages', 'output', { pages: [{ id: 1 }] })).toBe(false);
    expect(accepts('history.pages', 'output', { pages: [], more: true })).toBe(false);
  });
});

describe('a page row', () => {
  const parses = (overrides: Record<string, unknown>) =>
    pageRowSchema.safeParse({ ...pageRow, ...overrides }).success;

  it('has every column the pages table has, and nothing else', () => {
    expect(pageRowSchema.safeParse(pageRow).success).toBe(true);
    expect(parses({ extra: 1 })).toBe(false);
    for (const field of Object.keys(pageRow)) {
      const rest = Object.fromEntries(Object.entries(pageRow).filter(([key]) => key !== field));
      expect(pageRowSchema.safeParse(rest).success, field).toBe(false);
    }
  });

  it('takes an icon id or null', () => {
    expect(parses({ faviconId: null })).toBe(true);
    expect(parses({ faviconId: 3 })).toBe(true);
    expect(parses({ faviconId: 0 })).toBe(false);
    expect(parses({ faviconId: undefined })).toBe(false);
  });

  it('takes a frecency of zero or more, and nothing else', () => {
    expect(parses({ frecency: 0 })).toBe(true);
    expect(parses({ frecency: 0.001 })).toBe(true);
    expect(parses({ frecency: 1e9 })).toBe(true);
    expect(parses({ frecency: -0.001 })).toBe(false);
    expect(parses({ frecency: Number.NaN })).toBe(false);
    expect(parses({ frecency: Number.POSITIVE_INFINITY })).toBe(false);
    expect(parses({ frecency: '1' })).toBe(false);
  });

  it('takes counts of whole numbers from zero', () => {
    for (const field of ['visitCount', 'typedCount']) {
      expect(parses({ [field]: 0 }), field).toBe(true);
      expect(parses({ [field]: 7 }), field).toBe(true);
      expect(parses({ [field]: -1 }), field).toBe(false);
      expect(parses({ [field]: 1.5 }), field).toBe(false);
    }
  });

  it('takes times as whole non-negative milliseconds', () => {
    for (const field of ['firstVisitAt', 'lastVisitAt', 'frecencyAt']) {
      expect(parses({ [field]: 0 }), field).toBe(true);
      expect(parses({ [field]: -1 }), field).toBe(false);
      expect(parses({ [field]: 1.5 }), field).toBe(false);
    }
  });

  it('takes an empty title, but no title past the limit', () => {
    expect(parses({ title: '' })).toBe(true);
    expect(parses({ title: 'x'.repeat(MAX_STORED_TITLE + 1) })).toBe(false);
  });
});

describe('history.visits', () => {
  const visit = { id: 1, visitedAt: T0, transition: 'typed', tabId: TAB_ID };

  it('takes a page and a limit of 1 to 1,000', () => {
    expect(accepts('history.visits', 'input', { pageId: 1, limit: 1 })).toBe(true);
    expect(accepts('history.visits', 'input', { pageId: 9, limit: 1000 })).toBe(true);
    expect(accepts('history.visits', 'input', { pageId: 1, limit: 0 })).toBe(false);
    expect(accepts('history.visits', 'input', { pageId: 1, limit: 1001 })).toBe(false);
    expect(accepts('history.visits', 'input', { pageId: 0, limit: 5 })).toBe(false);
    expect(accepts('history.visits', 'input', { limit: 5 })).toBe(false);
    expect(accepts('history.visits', 'input', { pageId: 1 })).toBe(false);
  });

  it('answers with visits, each with a transition and the tab or null', () => {
    expect(accepts('history.visits', 'output', { visits: [] })).toBe(true);
    expect(
      accepts('history.visits', 'output', {
        visits: [visit, { ...visit, id: 2, tabId: null, transition: 'redirect' }],
      }),
    ).toBe(true);
  });

  it.each([
    ['a transition it does not know', { ...visit, transition: 'click' }],
    ['a tab id that is not a UUIDv7', { ...visit, tabId: 'tab-1' }],
    ['no tab id at all', { id: 1, visitedAt: T0, transition: 'link' }],
    ['an id of 0', { ...visit, id: 0 }],
    ['a negative time', { ...visit, visitedAt: -1 }],
    ['a key more', { ...visit, pageId: 1 }],
  ])('refuses a visit with %s', (_what, bad) => {
    expect(accepts('history.visits', 'output', { visits: [bad] })).toBe(false);
  });

  it('answers with at most 1,000 visits', () => {
    const many = (count: number) => ({
      visits: Array.from({ length: count }, (_, n) => ({ ...visit, id: n + 1 })),
    });

    expect(accepts('history.visits', 'output', many(1000))).toBe(true);
    expect(accepts('history.visits', 'output', many(1001))).toBe(false);
  });
});

describe('favicons.put', () => {
  const icon = { bytes: PNG_BASE64, mime: 'image/png', at: T0 };

  it('takes base64 bytes, their type and a time', () => {
    expect(accepts('favicons.put', 'input', icon)).toBe(true);
  });

  it.each(RASTER_TYPES)('takes the raster type %s', (mime) => {
    expect(accepts('favicons.put', 'input', { ...icon, mime })).toBe(true);
  });

  it.each(['image/svg+xml', 'image/avif', 'text/html', 'IMAGE/PNG', 'image/png ', '', 5, null])(
    'refuses the type %s',
    (mime) => {
      expect(accepts('favicons.put', 'input', { ...icon, mime })).toBe(false);
    },
  );

  it.each(['QUJD', 'QUI=', 'QQ==', 'abc+/0', 'AAAA'])('takes the base64 text %s', (bytes) => {
    expect(accepts('favicons.put', 'input', { ...icon, bytes })).toBe(true);
  });

  it.each([
    ['nothing', ''],
    ['text with a space', 'QUJD QUJD'],
    ['text with a newline', 'QUJD\nQUJD'],
    ['url-safe base64', 'QUJD-_8'],
    ['three padding signs', 'QQ==='],
    ['padding in the middle', 'QQ==QUJD'],
    ['only padding', '=='],
    ['a data: URL', `data:image/png;base64,${PNG_BASE64}`],
    ['a non-string', 5],
    ['null', null],
  ])('refuses %s as the bytes', (_what, bytes) => {
    expect(accepts('favicons.put', 'input', { ...icon, bytes })).toBe(false);
  });

  it('takes the base64 of MAX_FAVICON_BYTES, and not a character more', () => {
    expect(MAX_FAVICON_BASE64).toBe(Math.ceil(MAX_FAVICON_BYTES / 3) * 4);
    const longest = 'A'.repeat(MAX_FAVICON_BASE64);
    expect(accepts('favicons.put', 'input', { ...icon, bytes: longest })).toBe(true);
    expect(accepts('favicons.put', 'input', { ...icon, bytes: `${longest}A` })).toBe(false);
  });

  it('refuses a missing or invalid time, a missing type, a missing icon, and the old `png` key', () => {
    expect(accepts('favicons.put', 'input', { bytes: PNG_BASE64, mime: 'image/png' })).toBe(false);
    expect(accepts('favicons.put', 'input', { ...icon, at: -1 })).toBe(false);
    expect(accepts('favicons.put', 'input', { ...icon, at: 1.5 })).toBe(false);
    expect(accepts('favicons.put', 'input', { bytes: PNG_BASE64, at: T0 })).toBe(false);
    expect(accepts('favicons.put', 'input', { mime: 'image/png', at: T0 })).toBe(false);
    expect(accepts('favicons.put', 'input', { png: PNG_BASE64, at: T0 })).toBe(false);
  });

  it('answers with the icon id', () => {
    expect(accepts('favicons.put', 'output', { id: 1 })).toBe(true);
    expect(accepts('favicons.put', 'output', { id: 0 })).toBe(false);
    expect(accepts('favicons.put', 'output', { id: null })).toBe(false);
    expect(accepts('favicons.put', 'output', {})).toBe(false);
  });
});

describe('favicons.get', () => {
  it(`takes 1 to ${String(MAX_FAVICONS_PER_GET)} ids`, () => {
    const ids = (n: number) => Array.from({ length: n }, (_, k) => k + 1);
    expect(accepts('favicons.get', 'input', { ids: [1] })).toBe(true);
    expect(accepts('favicons.get', 'input', { ids: ids(MAX_FAVICONS_PER_GET) })).toBe(true);
    expect(accepts('favicons.get', 'input', { ids: [] })).toBe(false);
    expect(accepts('favicons.get', 'input', { ids: ids(MAX_FAVICONS_PER_GET + 1) })).toBe(false);
  });

  it.each([
    ['an id of 0', [0]],
    ['a negative id', [-1]],
    ['a fractional id', [1.5]],
    ['a string id', ['1']],
    ['null among them', [1, null]],
  ])('refuses %s', (_what, ids) => {
    expect(accepts('favicons.get', 'input', { ids })).toBe(false);
  });

  it('refuses no ids field, and ids that are not a list', () => {
    expect(accepts('favicons.get', 'input', {})).toBe(false);
    expect(accepts('favicons.get', 'input', { ids: 1 })).toBe(false);
  });

  it('answers with icons, each an id, its type and its bytes', () => {
    expect(accepts('favicons.get', 'output', { favicons: [] })).toBe(true);
    expect(
      accepts('favicons.get', 'output', {
        favicons: [
          { id: 1, mime: 'image/png', bytes: PNG_BASE64 },
          { id: 2, mime: 'image/x-icon', bytes: 'QUJD' },
        ],
      }),
    ).toBe(true);
  });

  it.each([
    ['empty bytes', { id: 1, mime: 'image/png', bytes: '' }],
    ['bytes that are not base64', { id: 1, mime: 'image/png', bytes: 'not base64!' }],
    ['an SVG type', { id: 1, mime: 'image/svg+xml', bytes: 'QUJD' }],
    ['no type', { id: 1, bytes: 'QUJD' }],
    ['an id of 0', { id: 0, mime: 'image/png', bytes: 'QUJD' }],
    ['no bytes', { id: 1, mime: 'image/png' }],
    ['a key more', { id: 1, mime: 'image/png', bytes: 'QUJD', sha256: 'abc' }],
  ])('refuses an icon with %s', (_what, bad) => {
    expect(accepts('favicons.get', 'output', { favicons: [bad] })).toBe(false);
  });
});

describe('maintenance.run', () => {
  const run = { now: T0, visitRetentionDays: 365 };
  const result = {
    check: 'ok',
    backup: 'done',
    backupFile: 'veltriva-daily-2026-10-21.db',
    pruned: { visits: 10, pages: 2, closedTabs: 1 },
  };

  it('takes the time and the retention in days', () => {
    expect(accepts('maintenance.run', 'input', run)).toBe(true);
  });

  it('takes a retention of 1 to 36,500 days only', () => {
    for (const visitRetentionDays of [1, 30, 365, 36_500]) {
      expect(accepts('maintenance.run', 'input', { ...run, visitRetentionDays })).toBe(true);
    }
    for (const visitRetentionDays of [0, -1, 36_501, 1.5, Number.NaN, '365', null, undefined]) {
      expect(
        accepts('maintenance.run', 'input', { ...run, visitRetentionDays }),
        String(visitRetentionDays),
      ).toBe(false);
    }
  });

  it('needs both fields: a run without the retention is not a run', () => {
    expect(accepts('maintenance.run', 'input', { now: T0 })).toBe(false);
    expect(accepts('maintenance.run', 'input', { visitRetentionDays: 365 })).toBe(false);
    expect(accepts('maintenance.run', 'input', {})).toBe(false);
  });

  it.each([
    ['a negative time', { ...run, now: -1 }],
    ['a fractional time', { ...run, now: 1.5 }],
    ['a string time', { ...run, now: '1' }],
    ['a key more', { ...run, force: true }],
  ])('refuses %s', (_what, value) => {
    expect(accepts('maintenance.run', 'input', value)).toBe(false);
  });

  it('answers with the check, the backup, its file and what was pruned', () => {
    expect(accepts('maintenance.run', 'output', result)).toBe(true);
  });

  it.each(['ok', 'failed', 'not_due'])('takes the check result %s', (check) => {
    expect(accepts('maintenance.run', 'output', { ...result, check })).toBe(true);
  });

  it.each(['done', 'unchanged', 'not_due', 'failed', 'skipped'])(
    'takes the backup result %s',
    (backup) => {
      expect(accepts('maintenance.run', 'output', { ...result, backup })).toBe(true);
    },
  );

  it.each([
    ['a check result it does not know', { ...result, check: 'passed' }],
    ['a backup result it does not know', { ...result, backup: 'skip' }],
    ['no pruned counts', { check: 'ok', backup: 'done', backupFile: null }],
    ['a pruned count missing', { ...result, pruned: { visits: 1, pages: 1 } }],
    ['a negative pruned count', { ...result, pruned: { visits: -1, pages: 0, closedTabs: 0 } }],
    ['a fractional pruned count', { ...result, pruned: { visits: 0.5, pages: 0, closedTabs: 0 } }],
    [
      'a pruned count more',
      { ...result, pruned: { visits: 0, pages: 0, closedTabs: 0, favicons: 0 } },
    ],
    ['a backup file that is a path', { ...result, backupFile: 'backups/a.db' }],
    ['a backup file with a drive', { ...result, backupFile: 'C:a.db' }],
    ['an empty backup file name', { ...result, backupFile: '' }],
    ['no backup file field', { check: 'ok', backup: 'done', pruned: result.pruned }],
  ])('refuses an answer with %s', (_what, value) => {
    expect(accepts('maintenance.run', 'output', value)).toBe(false);
  });

  it('takes a null backup file and zero pruned counts, as an idle run reports', () => {
    expect(
      accepts('maintenance.run', 'output', {
        check: 'not_due',
        backup: 'not_due',
        backupFile: null,
        pruned: { visits: 0, pages: 0, closedTabs: 0 },
      }),
    ).toBe(true);
  });

  it('takes pruned counts as large as a safe integer', () => {
    expect(
      accepts('maintenance.run', 'output', {
        ...result,
        pruned: {
          visits: Number.MAX_SAFE_INTEGER,
          pages: Number.MAX_SAFE_INTEGER,
          closedTabs: Number.MAX_SAFE_INTEGER,
        },
      }),
    ).toBe(true);
  });
});
