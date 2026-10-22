import { describe, expect, it } from 'vitest';

import { DEFAULT_SEARCH_TEMPLATE } from '../../core/url/omnibox';
import {
  DEFAULT_HISTORY_RETENTION_DAYS,
  DEFAULT_LIFECYCLE_DOCUMENT,
  DEFAULT_SETTINGS,
  parseSettings,
  settingsSchema,
} from './settings';

const CUSTOM_TEMPLATE = 'https://search.example/?q={searchTerms}';

describe('the defaults', () => {
  it('are DuckDuckGo, a year of history, and the Balanced lifecycle preset', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      search: { template: 'https://duckduckgo.com/?q={searchTerms}' },
      history: { retentionDays: 365 },
      lifecycle: {
        preset: 'balanced',
        autoArchive: true,
        freeze: false,
        paused: false,
        overrides: {},
      },
    });
    expect(DEFAULT_SEARCH_TEMPLATE).toBe(DEFAULT_SETTINGS.search.template);
    expect(DEFAULT_HISTORY_RETENTION_DAYS).toBe(365);
  });

  it('are themselves a document the schema accepts, unchanged', () => {
    expect(settingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });
});

describe('parseSettings: a document that is not one', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty array', []],
    ['an array of settings', [{ history: { retentionDays: 30 } }]],
    ['a string', 'settings'],
    ['a JSON string', '{"history":{"retentionDays":30}}'],
    ['a number', 42],
    ['zero', 0],
    ['true', true],
    ['false', false],
    ['NaN', Number.NaN],
  ])('is the defaults for %s', (_what, stored) => {
    expect(parseSettings(stored)).toEqual(DEFAULT_SETTINGS);
  });

  it('is the defaults for an empty object', () => {
    expect(parseSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it('is the defaults for an object of nothing it knows', () => {
    expect(parseSettings({ theme: 'dark', zoom: 1.5 })).toEqual(DEFAULT_SETTINGS);
  });
});

describe('parseSettings: a good document', () => {
  it('keeps what it holds', () => {
    expect(
      parseSettings({
        search: { template: CUSTOM_TEMPLATE },
        history: { retentionDays: 90 },
      }),
    ).toEqual({
      search: { template: CUSTOM_TEMPLATE },
      history: { retentionDays: 90 },
      lifecycle: DEFAULT_LIFECYCLE_DOCUMENT,
    });
  });

  it('takes a section with only some of its fields, the others at their defaults', () => {
    expect(parseSettings({ history: { retentionDays: 30 } })).toEqual({
      search: DEFAULT_SETTINGS.search,
      history: { retentionDays: 30 },
      lifecycle: DEFAULT_LIFECYCLE_DOCUMENT,
    });
    expect(parseSettings({ search: { template: CUSTOM_TEMPLATE } })).toEqual({
      search: { template: CUSTOM_TEMPLATE },
      history: DEFAULT_SETTINGS.history,
      lifecycle: DEFAULT_LIFECYCLE_DOCUMENT,
    });
  });

  it('ignores a field it does not know, at any level, without keeping it', () => {
    const parsed = parseSettings({
      futureFeature: { on: true },
      search: { template: CUSTOM_TEMPLATE, suggestions: true },
      history: { retentionDays: 30, keepIncognito: false },
    });

    expect(parsed).toEqual({
      search: { template: CUSTOM_TEMPLATE },
      history: { retentionDays: 30 },
      lifecycle: DEFAULT_LIFECYCLE_DOCUMENT,
    });
    expect(parsed).not.toHaveProperty('futureFeature');
  });

  it('does not change the document it was given', () => {
    const stored = { search: { template: 'nonsense' }, history: { retentionDays: 0 }, extra: 1 };
    const copy = structuredClone(stored);

    parseSettings(stored);

    expect(stored).toEqual(copy);
  });
});

describe('parseSettings: each field falls back alone', () => {
  it('keeps a good template when the retention is bad', () => {
    expect(
      parseSettings({ search: { template: CUSTOM_TEMPLATE }, history: { retentionDays: -5 } }),
    ).toEqual({
      search: { template: CUSTOM_TEMPLATE },
      history: { retentionDays: 365 },
      lifecycle: DEFAULT_LIFECYCLE_DOCUMENT,
    });
  });

  it('keeps a good retention when the template is bad', () => {
    expect(
      parseSettings({ search: { template: 'ftp://nope' }, history: { retentionDays: 14 } }),
    ).toEqual({
      search: { template: DEFAULT_SEARCH_TEMPLATE },
      history: { retentionDays: 14 },
      lifecycle: DEFAULT_LIFECYCLE_DOCUMENT,
    });
  });

  it.each([
    ['a string', 'search'],
    ['null', null],
    ['an array', ['https://x.example/?q={searchTerms}']],
    ['a number', 7],
  ])('keeps the history section when the search section is %s', (_what, search) => {
    expect(parseSettings({ search, history: { retentionDays: 14 } })).toEqual({
      search: DEFAULT_SETTINGS.search,
      history: { retentionDays: 14 },
      lifecycle: DEFAULT_LIFECYCLE_DOCUMENT,
    });
  });

  it.each([
    ['a string', 'history'],
    ['null', null],
    ['an array', [30]],
    ['a number', 30],
  ])('keeps the search section when the history section is %s', (_what, history) => {
    expect(parseSettings({ search: { template: CUSTOM_TEMPLATE }, history })).toEqual({
      search: { template: CUSTOM_TEMPLATE },
      history: DEFAULT_SETTINGS.history,
      lifecycle: DEFAULT_LIFECYCLE_DOCUMENT,
    });
  });

  it('takes the defaults for a section that is empty, and for a field that is missing', () => {
    expect(parseSettings({ search: {}, history: {} })).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({ search: { template: undefined } })).toEqual(DEFAULT_SETTINGS);
  });
});

describe('parseSettings: the search template', () => {
  it.each([
    ['an https address', 'https://search.example/?q={searchTerms}'],
    ['a template in the path', 'https://search.example/find/{searchTerms}'],
    ['a template in the fragment', 'https://search.example/#{searchTerms}'],
    ['two placeholders', 'https://search.example/?q={searchTerms}&alt={searchTerms}'],
    ['localhost over http', 'http://localhost:4000/search?q={searchTerms}'],
    ['127.0.0.1 over http', 'http://127.0.0.1:4000/search?q={searchTerms}'],
    ['[::1] over http', 'http://[::1]:4000/search?q={searchTerms}'],
    ['the default', DEFAULT_SEARCH_TEMPLATE],
  ])('keeps %s', (_what, template) => {
    expect(parseSettings({ search: { template } }).search.template).toBe(template);
  });

  it.each([
    ['plain http to another host', 'http://search.example/?q={searchTerms}'],
    ['a template with no {searchTerms}', 'https://search.example/?q='],
    ['a misspelled placeholder', 'https://search.example/?q={searchterms}'],
    ['a javascript: address', 'javascript:alert({searchTerms})'],
    ['a data: address', 'data:text/html,{searchTerms}'],
    ['a file: address', 'file:///C:/{searchTerms}'],
    ['an ftp: address', 'ftp://search.example/{searchTerms}'],
    ['{searchTerms} as the host', 'https://{searchTerms}/'],
    ['{searchTerms} in the credentials', 'https://{searchTerms}@search.example/'],
    ['{searchTerms} in the password', 'https://user:{searchTerms}@search.example/'],
    ['whitespace', 'https://search.example/?q={searchTerms} x'],
    ['a newline', 'https://search.example/?q={searchTerms}\n'],
    ['a control character', 'https://search.example/?q={searchTerms}\u0007'],
    ['an empty string', ''],
    ['text that is not an address', 'search for {searchTerms}'],
    ['a template too long', `https://search.example/?q={searchTerms}&x=${'a'.repeat(2100)}`],
    ['a number', 42],
    ['null', null],
    ['an object', { url: CUSTOM_TEMPLATE }],
  ])('takes the default for %s', (_what, template) => {
    expect(parseSettings({ search: { template } }).search.template).toBe(DEFAULT_SEARCH_TEMPLATE);
  });

  it('takes a template of exactly 2,048 characters, and not one more', () => {
    const base = 'https://search.example/?q={searchTerms}&x=';
    const atLimit = base + 'a'.repeat(2048 - base.length);
    expect(atLimit).toHaveLength(2048);

    expect(parseSettings({ search: { template: atLimit } }).search.template).toBe(atLimit);
    expect(parseSettings({ search: { template: `${atLimit}a` } }).search.template).toBe(
      DEFAULT_SEARCH_TEMPLATE,
    );
  });
});

describe('parseSettings: retentionDays', () => {
  const retention = (retentionDays: unknown): number =>
    parseSettings({ history: { retentionDays } }).history.retentionDays;

  it.each([1, 2, 7, 30, 365, 3650, 36_499, 36_500])('keeps %s days', (days) => {
    expect(retention(days)).toBe(days);
  });

  it.each([
    ['zero', 0],
    ['a negative number', -1],
    ['a very negative number', -36_500],
    ['one past the most', 36_501],
    ['a huge number', Number.MAX_SAFE_INTEGER],
    ['infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
    ['NaN', Number.NaN],
    ['a fraction', 1.5],
    ['a half', 0.5],
    ['a number just under 365', 364.999],
    ['a number string', '30'],
    ['an empty string', ''],
    ['true', true],
    ['null', null],
    ['an array', [30]],
    ['an object', { days: 30 }],
  ])('takes the default for %s', (_what, days) => {
    expect(retention(days)).toBe(DEFAULT_HISTORY_RETENTION_DAYS);
  });

  it('takes the default when the field is missing', () => {
    expect(parseSettings({ history: {} }).history.retentionDays).toBe(365);
  });

  it('takes a whole number written as a float, which JSON does not tell apart', () => {
    expect(retention(30.0)).toBe(30);
  });
});

describe('parseSettings: lifecycle (M3.2)', () => {
  const lifecycle = (section: unknown) => parseSettings({ lifecycle: section }).lifecycle;

  it('keeps what it holds', () => {
    expect(
      lifecycle({
        preset: 'aggressive',
        autoArchive: false,
        freeze: true,
        paused: true,
        overrides: { stripCap: 20, discardAfterMs: 30 * 60 * 1000, discardPinned: true },
      }),
    ).toEqual({
      preset: 'aggressive',
      autoArchive: false,
      freeze: true,
      paused: true,
      overrides: { stripCap: 20, discardAfterMs: 30 * 60 * 1000, discardPinned: true },
    });
  });

  it.each([
    ['null', null],
    ['a string', 'aggressive'],
    ['an array', ['gentle']],
    ['a number', 3],
  ])('is the default section for %s', (_what, section) => {
    expect(lifecycle(section)).toEqual(DEFAULT_LIFECYCLE_DOCUMENT);
  });

  it('takes the default for each field alone: an unknown preset keeps the switches', () => {
    expect(lifecycle({ preset: 'turbo', autoArchive: false, freeze: 'yes' })).toEqual({
      ...DEFAULT_LIFECYCLE_DOCUMENT,
      autoArchive: false,
    });
  });

  it('drops an override out of its range alone, keeping the others', () => {
    expect(
      lifecycle({
        overrides: {
          stripCap: 0,
          discardAfterMs: 1000,
          shelveAfterEngagedMs: 2 * 60 * 60 * 1000,
          archiveAfterActiveDays: 400,
          interactionGuardMs: -1,
          discardPinned: 'no',
        },
      }).overrides,
    ).toEqual({ shelveAfterEngagedMs: 2 * 60 * 60 * 1000 });
  });

  it('takes no overrides when they are not an object', () => {
    expect(lifecycle({ overrides: 'none' }).overrides).toEqual({});
  });
});
