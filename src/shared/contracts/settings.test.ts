import { describe, expect, it } from 'vitest';

import { DEFAULT_SEARCH_TEMPLATE } from '../../core/url/omnibox';
import {
  applySettingsChange,
  DEFAULT_HISTORY_RETENTION_DAYS,
  DEFAULT_LIFECYCLE_DOCUMENT,
  DEFAULT_PRESSURE_PERCENT,
  DEFAULT_SETTINGS,
  OVERRIDE_LIMITS,
  parseSettings,
  pressurePercent,
  settingsChangeSchema,
  settingsSchema,
  strictSettingsSchema,
} from './settings';
import type { Settings } from './settings';

const CUSTOM_TEMPLATE = 'https://search.example/?q={searchTerms}';

describe('the defaults', () => {
  it('are DuckDuckGo, a year of history, and the Balanced lifecycle preset', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      search: { template: 'https://duckduckgo.com/?q={searchTerms}' },
      history: { retentionDays: 365 },
      startup: 'restore',
      memory: { paused: false },
      lifecycle: {
        preset: 'balanced',
        autoArchive: true,
        freeze: false,
        paused: false,
        preview: 'auto',
        overrides: {},
      },
    });
    expect(DEFAULT_SEARCH_TEMPLATE).toBe(DEFAULT_SETTINGS.search.template);
    expect(DEFAULT_HISTORY_RETENTION_DAYS).toBe(365);
  });

  it('are themselves a document the schema accepts, unchanged', () => {
    expect(settingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });

  it('are a document the strict schema accepts', () => {
    expect(strictSettingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
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
      startup: 'restore',
      memory: { paused: false },
      lifecycle: DEFAULT_LIFECYCLE_DOCUMENT,
    });
  });

  it('takes a section with only some of its fields, the others at their defaults', () => {
    expect(parseSettings({ history: { retentionDays: 30 } })).toEqual({
      search: DEFAULT_SETTINGS.search,
      history: { retentionDays: 30 },
      startup: 'restore',
      memory: { paused: false },
      lifecycle: DEFAULT_LIFECYCLE_DOCUMENT,
    });
    expect(parseSettings({ search: { template: CUSTOM_TEMPLATE } })).toEqual({
      search: { template: CUSTOM_TEMPLATE },
      history: DEFAULT_SETTINGS.history,
      startup: 'restore',
      memory: { paused: false },
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
      startup: 'restore',
      memory: { paused: false },
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
      startup: 'restore',
      memory: { paused: false },
      lifecycle: DEFAULT_LIFECYCLE_DOCUMENT,
    });
  });

  it('keeps a good retention when the template is bad', () => {
    expect(
      parseSettings({ search: { template: 'ftp://nope' }, history: { retentionDays: 14 } }),
    ).toEqual({
      search: { template: DEFAULT_SEARCH_TEMPLATE },
      history: { retentionDays: 14 },
      startup: 'restore',
      memory: { paused: false },
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
      startup: 'restore',
      memory: { paused: false },
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
      startup: 'restore',
      memory: { paused: false },
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
        preview: 'off',
        overrides: { stripCap: 20, discardAfterMs: 30 * 60 * 1000, discardPinned: true },
      }),
    ).toEqual({
      preset: 'aggressive',
      autoArchive: false,
      freeze: true,
      paused: true,
      preview: 'off',
      overrides: { stripCap: 20, discardAfterMs: 30 * 60 * 1000, discardPinned: true },
    });
  });

  it('takes a document from before M3.4, with no preview, at its default', () => {
    expect(
      lifecycle({
        preset: 'gentle',
        autoArchive: false,
        freeze: true,
        paused: true,
        overrides: { stripCap: 20 },
      }),
    ).toEqual({
      preset: 'gentle',
      autoArchive: false,
      freeze: true,
      paused: true,
      preview: 'auto',
      overrides: { stripCap: 20 },
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

describe('parseSettings: preview mode (M3.4)', () => {
  const preview = (value: unknown) =>
    parseSettings({ lifecycle: { preview: value } }).lifecycle.preview;

  it.each(['auto', 'off'] as const)('keeps %s', (value) => {
    expect(preview(value)).toBe(value);
  });

  it('is auto by default, and in the default document', () => {
    expect(preview(undefined)).toBe('auto');
    expect(DEFAULT_LIFECYCLE_DOCUMENT.preview).toBe('auto');
    expect(parseSettings({}).lifecycle.preview).toBe('auto');
  });

  it.each([
    ['an unknown word', 'on'],
    ['the wrong case', 'OFF'],
    ['an empty string', ''],
    ['true', true],
    ['false', false],
    ['a number', 0],
    ['null', null],
    ['an array', ['off']],
    ['an object', { mode: 'off' }],
  ])('falls back to auto for %s', (_what, value) => {
    expect(preview(value)).toBe('auto');
  });

  it('falls back alone: the other fields of the section are kept', () => {
    expect(
      parseSettings({
        lifecycle: { preset: 'gentle', paused: true, preview: 'maybe' },
      }).lifecycle,
    ).toEqual({
      ...DEFAULT_LIFECYCLE_DOCUMENT,
      preset: 'gentle',
      paused: true,
    });
  });

  it('keeps off when everything else in the section is invalid', () => {
    expect(
      parseSettings({
        lifecycle: { preset: 'turbo', autoArchive: 3, freeze: 'x', paused: null, preview: 'off' },
      }).lifecycle,
    ).toEqual({ ...DEFAULT_LIFECYCLE_DOCUMENT, preview: 'off' });
  });
});

describe('parseSettings: the M3.4 list of protected sites (M5.1)', () => {
  it('is no longer read: migration 3 made each site a rule in the site_rules table', () => {
    const parsed = parseSettings({
      lifecycle: { preset: 'gentle', protectedSites: ['example.com', 'localhost'] },
    });

    expect(parsed.lifecycle).toEqual({ ...DEFAULT_LIFECYCLE_DOCUMENT, preset: 'gentle' });
    expect(parsed.lifecycle).not.toHaveProperty('protectedSites');
  });
});

describe('parseSettings: startup behavior (M5.1)', () => {
  const startup = (value: unknown) => parseSettings({ startup: value }).startup;

  it.each(['restore', 'new-tab'] as const)('keeps %s', (value) => {
    expect(startup(value)).toBe(value);
  });

  it.each([
    ['missing', undefined],
    ['an unknown word', 'blank'],
    ['the wrong case', 'Restore'],
    ['a boolean', true],
    ['null', null],
    ['an object', { mode: 'new-tab' }],
  ])('is restore when %s', (_what, value) => {
    expect(startup(value)).toBe('restore');
  });
});

describe('parseSettings: Pause memory (M5.1)', () => {
  const paused = (memory: unknown) => parseSettings({ memory }).memory.paused;

  it('keeps on and off', () => {
    expect(paused({ paused: true })).toBe(true);
    expect(paused({ paused: false })).toBe(false);
  });

  it.each([
    ['missing', undefined],
    ['a string', { paused: 'yes' }],
    ['a number', { paused: 1 }],
    ['null', null],
    ['a boolean section', true],
  ])('is off when %s', (_what, memory) => {
    expect(paused(memory)).toBe(false);
  });

  it('falls back alone: a bad memory section keeps the rest of the document', () => {
    expect(parseSettings({ memory: 'paused', startup: 'new-tab' })).toEqual({
      ...DEFAULT_SETTINGS,
      startup: 'new-tab',
    });
  });
});

describe('parseSettings: the pressure thresholds (M5.1)', () => {
  const overrides = (value: unknown) =>
    parseSettings({ lifecycle: { overrides: value } }).lifecycle.overrides;

  it('are 10% and 4% of physical memory by default', () => {
    expect(DEFAULT_PRESSURE_PERCENT).toEqual({ moderate: 10, critical: 4 });
    expect(pressurePercent({})).toEqual({ moderate: 10, critical: 4 });
  });

  it('keeps thresholds in their ranges and in order', () => {
    expect(overrides({ moderatePressurePercent: 20, criticalPressurePercent: 8 })).toEqual({
      moderatePressurePercent: 20,
      criticalPressurePercent: 8,
    });
    expect(overrides({ moderatePressurePercent: 5 })).toEqual({ moderatePressurePercent: 5 });
  });

  it('drops a threshold out of its range alone', () => {
    expect(overrides({ moderatePressurePercent: 51, criticalPressurePercent: 3 })).toEqual({
      criticalPressurePercent: 3,
    });
    expect(overrides({ moderatePressurePercent: 12, criticalPressurePercent: 0 })).toEqual({
      moderatePressurePercent: 12,
    });
  });

  it('drops both when critical would not be below moderate, keeping the other overrides', () => {
    expect(
      overrides({ moderatePressurePercent: 6, criticalPressurePercent: 6, stripCap: 9 }),
    ).toEqual({ stripCap: 9 });
    // Against the default moderate (10%): critical 12% is out of order.
    expect(overrides({ criticalPressurePercent: 12 })).toEqual({});
    // Against the default critical (4%): moderate 3% is out of order.
    expect(overrides({ moderatePressurePercent: 3 })).toEqual({});
  });
});

/** A change as the settings page sends it, checked as main checks it. */
const accepts = (change: unknown) => settingsChangeSchema.safeParse(change).success;

describe('settingsChangeSchema: what main accepts from the settings page (M5.1)', () => {
  it.each([
    ['nothing', {}],
    ['an engine', { search: { template: 'https://www.google.com/search?q={searchTerms}' } }],
    ['a custom template', { search: { template: CUSTOM_TEMPLATE } }],
    ['startup', { startup: 'new-tab' }],
    ['Pause memory', { memory: { paused: true } }],
    ['a preset', { lifecycle: { preset: 'gentle' } }],
    ['the switches', { lifecycle: { autoArchive: false, freeze: true, paused: true } }],
    ['preview mode', { lifecycle: { preview: 'off' } }],
    ['an override', { lifecycle: { overrides: { stripCap: 25 } } }],
    ['clearing an override', { lifecycle: { overrides: { stripCap: null } } }],
    [
      'every override at its least',
      {
        lifecycle: {
          overrides: Object.fromEntries(
            Object.entries(OVERRIDE_LIMITS).map(([key, { min }]) => [key, min]),
          ),
        },
      },
    ],
    [
      'every override at its most',
      {
        lifecycle: {
          overrides: Object.fromEntries(
            Object.entries(OVERRIDE_LIMITS).map(([key, { max }]) => [key, max]),
          ),
        },
      },
    ],
    ['discarding pinned tabs', { lifecycle: { overrides: { discardPinned: true } } }],
  ])('accepts %s', (_what, change) => {
    expect(accepts(change)).toBe(true);
  });

  describe('rejects the whole change for', () => {
    it.each([
      ['a field it does not know', { theme: 'dark' }],
      ['a field it does not know in a section', { search: { template: CUSTOM_TEMPLATE, x: 1 } }],
      ['a lifecycle field it does not know', { lifecycle: { turbo: true } }],
      ['an override it does not know', { lifecycle: { overrides: { tabsPerRow: 3 } } }],
      ['the old protected-site list', { lifecycle: { protectedSites: ['example.com'] } }],
      ['the history section (M5.2 sets it)', { history: { retentionDays: 30 } }],
      [
        'plain http to another host',
        { search: { template: 'http://search.example/?q={searchTerms}' } },
      ],
      ['no {searchTerms}', { search: { template: 'https://search.example/?q=' } }],
      ['{searchTerms} in the host', { search: { template: 'https://{searchTerms}/' } }],
      ['a javascript: template', { search: { template: 'javascript:alert({searchTerms})' } }],
      [
        'a template too long',
        {
          search: { template: `https://search.example/?q={searchTerms}&x=${'a'.repeat(2100)}` },
        },
      ],
      ['an empty template', { search: { template: '' } }],
      ['no template', { search: {} }],
      ['an unknown startup', { startup: 'blank' }],
      ['a startup of the wrong type', { startup: 1 }],
      ['Pause memory as a string', { memory: { paused: 'yes' } }],
      ['an unknown preset', { lifecycle: { preset: 'turbo' } }],
      ['a switch as a number', { lifecycle: { autoArchive: 0 } }],
      ['an unknown preview mode', { lifecycle: { preview: 'on' } }],
      ['a discard sooner than a minute', { lifecycle: { overrides: { discardAfterMs: 59_999 } } }],
      [
        'a discard later than a week',
        {
          lifecycle: { overrides: { discardAfterMs: 7 * 24 * 3_600_000 + 1 } },
        },
      ],
      ['a strip cap of 0', { lifecycle: { overrides: { stripCap: 0 } } }],
      ['a strip cap of 501', { lifecycle: { overrides: { stripCap: 501 } } }],
      ['a fraction', { lifecycle: { overrides: { stripCap: 10.5 } } }],
      ['a number as a string', { lifecycle: { overrides: { stripCap: '10' } } }],
      ['NaN', { lifecycle: { overrides: { stripCap: Number.NaN } } }],
      ['infinity', { lifecycle: { overrides: { archiveAfterActiveDays: Infinity } } }],
      ['a negative guard', { lifecycle: { overrides: { interactionGuardMs: -1 } } }],
      ['archiving after 366 days', { lifecycle: { overrides: { archiveAfterActiveDays: 366 } } }],
      [
        'a moderate threshold of 51%',
        { lifecycle: { overrides: { moderatePressurePercent: 51 } } },
      ],
      ['a critical threshold of 0%', { lifecycle: { overrides: { criticalPressurePercent: 0 } } }],
      ['discardPinned as a string', { lifecycle: { overrides: { discardPinned: 'true' } } }],
      ['a section that is not an object', { lifecycle: 'gentle' }],
      ['a change that is not an object', 'reset'],
      ['null', null],
      ['an array', [{ startup: 'new-tab' }]],
    ])('%s', (_what, change) => {
      expect(accepts(change)).toBe(false);
    });
  });
});

describe('applySettingsChange: the document a change makes (M5.1)', () => {
  const change = (value: unknown) => settingsChangeSchema.parse(value);

  it('changes what the change names and keeps the rest', () => {
    const next = applySettingsChange(
      DEFAULT_SETTINGS,
      change({ startup: 'new-tab', lifecycle: { preset: 'gentle', overrides: { stripCap: 7 } } }),
    );

    expect(next).toEqual({
      ...DEFAULT_SETTINGS,
      startup: 'new-tab',
      lifecycle: { ...DEFAULT_LIFECYCLE_DOCUMENT, preset: 'gentle', overrides: { stripCap: 7 } },
    });
  });

  it('clears an override with null and keeps the others', () => {
    const current: Settings = {
      ...DEFAULT_SETTINGS,
      lifecycle: {
        ...DEFAULT_LIFECYCLE_DOCUMENT,
        overrides: { stripCap: 7, discardPinned: true },
      },
    };

    expect(
      applySettingsChange(current, change({ lifecycle: { overrides: { stripCap: null } } }))
        ?.lifecycle.overrides,
    ).toEqual({ discardPinned: true });
  });

  it('leaves the current document alone', () => {
    const current = structuredClone(DEFAULT_SETTINGS);

    applySettingsChange(current, change({ lifecycle: { overrides: { stripCap: 3 } } }));

    expect(current).toEqual(DEFAULT_SETTINGS);
  });

  it('treats a field sent as undefined like one left out', () => {
    expect(
      applySettingsChange(DEFAULT_SETTINGS, {
        lifecycle: { preset: undefined, paused: true },
      })?.lifecycle,
    ).toEqual({ ...DEFAULT_LIFECYCLE_DOCUMENT, paused: true });
  });

  describe('rejects a valid change that makes an invalid document', () => {
    it('a critical threshold at or above the moderate one', () => {
      expect(
        applySettingsChange(
          DEFAULT_SETTINGS,
          change({ lifecycle: { overrides: { criticalPressurePercent: 10 } } }),
        ),
      ).toBeNull();
      expect(
        applySettingsChange(
          DEFAULT_SETTINGS,
          change({ lifecycle: { overrides: { moderatePressurePercent: 4 } } }),
        ),
      ).toBeNull();
    });

    it('a moderate threshold lowered under a critical one set before', () => {
      const current: Settings = {
        ...DEFAULT_SETTINGS,
        lifecycle: { ...DEFAULT_LIFECYCLE_DOCUMENT, overrides: { criticalPressurePercent: 8 } },
      };

      expect(
        applySettingsChange(
          current,
          change({ lifecycle: { overrides: { moderatePressurePercent: 8 } } }),
        ),
      ).toBeNull();
      // Both in one change, in order, is fine.
      expect(
        applySettingsChange(
          current,
          change({
            lifecycle: { overrides: { moderatePressurePercent: 8, criticalPressurePercent: 3 } },
          }),
        )?.lifecycle.overrides,
      ).toEqual({ moderatePressurePercent: 8, criticalPressurePercent: 3 });
    });

    it('clearing the critical override when the moderate one is below the default critical', () => {
      const current: Settings = {
        ...DEFAULT_SETTINGS,
        lifecycle: {
          ...DEFAULT_LIFECYCLE_DOCUMENT,
          overrides: { moderatePressurePercent: 3, criticalPressurePercent: 2 },
        },
      };

      expect(
        applySettingsChange(
          current,
          change({ lifecycle: { overrides: { criticalPressurePercent: null } } }),
        ),
      ).toBeNull();
    });
  });
});
