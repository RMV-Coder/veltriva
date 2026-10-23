import { describe, expect, it } from 'vitest';

import type { SettingsView } from '../../../shared/contracts/schemas';
import {
  defaultValue,
  durationText,
  effectiveValue,
  engineOf,
  FIELD_ORDER,
  FIELD_UNITS,
  fieldRange,
  fieldText,
  presetDescription,
  pressureInOrder,
  readField,
  templateProblem,
} from './settings-display';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A view as main sends it, with the real presets and limits. */
function view(overrides: Partial<SettingsView['settings']['lifecycle']> = {}): SettingsView {
  return {
    settings: {
      search: { template: 'https://duckduckgo.com/?q={searchTerms}' },
      history: { retentionDays: 365 },
      startup: 'restore',
      memory: { paused: false },
      diagnostics: { logging: false },
      lifecycle: {
        preset: 'balanced',
        autoArchive: true,
        freeze: false,
        paused: false,
        preview: 'auto',
        overrides: {},
        ...overrides,
      },
    },
    previewActive: true,
    siteRules: [],
    presets: {
      gentle: {
        discardAfterMs: 4 * HOUR,
        stripCap: 15,
        shelveAfterEngagedMs: 8 * HOUR,
        archiveAfterActiveDays: 14,
        interactionGuardMs: 30 * MINUTE,
        discardPinned: false,
      },
      balanced: {
        discardAfterMs: 60 * MINUTE,
        stripCap: 10,
        shelveAfterEngagedMs: 2 * HOUR,
        archiveAfterActiveDays: 3,
        interactionGuardMs: 15 * MINUTE,
        discardPinned: false,
      },
      aggressive: {
        discardAfterMs: 15 * MINUTE,
        stripCap: 6,
        shelveAfterEngagedMs: 30 * MINUTE,
        archiveAfterActiveDays: 1,
        interactionGuardMs: 5 * MINUTE,
        discardPinned: true,
      },
    },
    limits: {
      discardAfterMs: { min: MINUTE, max: 7 * DAY },
      stripCap: { min: 1, max: 500 },
      shelveAfterEngagedMs: { min: MINUTE, max: 30 * DAY },
      archiveAfterActiveDays: { min: 1, max: 365 },
      interactionGuardMs: { min: 0, max: DAY },
      moderatePressurePercent: { min: 2, max: 50 },
      criticalPressurePercent: { min: 1, max: 25 },
    },
    pressureDefaults: { moderate: 10, critical: 4 },
    searchEngines: [
      { id: 'duckduckgo', name: 'DuckDuckGo', template: 'https://duckduckgo.com/?q={searchTerms}' },
      { id: 'google', name: 'Google', template: 'https://www.google.com/search?q={searchTerms}' },
    ],
  };
}

describe('durationText', () => {
  it.each([
    [MINUTE, '1 minute'],
    [15 * MINUTE, '15 minutes'],
    [HOUR, '1 hour'],
    [4 * HOUR, '4 hours'],
    [90 * MINUTE, '1 hour 30 minutes'],
    [61 * MINUTE, '1 hour 1 minute'],
    [DAY, '1 day'],
    [7 * DAY, '7 days'],
    [25 * HOUR, '25 hours'],
    [30 * 1000, '1 minute'],
    [0, 'no time'],
  ])('says %i ms as "%s"', (ms, text) => {
    expect(durationText(ms)).toBe(text);
  });
});

describe('presetDescription: each preset in plain words', () => {
  it('says what Balanced does', () => {
    expect(presetDescription(view().presets.balanced)).toBe(
      "Unloads a tab you haven't looked at for 1 hour. Keeps your 10 most recent tabs in Tabs; one beyond them you haven't used for 2 hours of browsing moves to Sleeping. Archives a Sleeping tab after 3 days you use Veltriva without it.",
    );
  });

  it('says when pinned tabs are unloaded too, and a single day', () => {
    const text = presetDescription(view().presets.aggressive);
    expect(text).toContain("haven't looked at for 15 minutes, pinned tabs too.");
    expect(text).toContain('after 1 day you use Veltriva');
  });

  it('says one tab without a count', () => {
    expect(presetDescription({ ...view().presets.balanced, stripCap: 1 })).toContain(
      'Keeps your most recent tab in Tabs',
    );
  });
});

describe('the advanced fields', () => {
  it('cover every number main has a range for, each with words', () => {
    expect([...FIELD_ORDER].sort()).toEqual(Object.keys(view().limits).sort());
    for (const field of FIELD_ORDER) {
      expect(FIELD_UNITS[field].label).not.toBe('');
      expect(FIELD_UNITS[field].help).not.toBe('');
    }
  });

  it("show the preset's value until one is set, then that one", () => {
    expect(effectiveValue(view(), 'discardAfterMs')).toBe(HOUR);
    expect(effectiveValue(view({ preset: 'gentle' }), 'stripCap')).toBe(15);
    expect(effectiveValue(view({ overrides: { stripCap: 25 } }), 'stripCap')).toBe(25);
    expect(effectiveValue(view(), 'moderatePressurePercent')).toBe(10);
    expect(
      effectiveValue(
        view({ overrides: { criticalPressurePercent: 6 } }),
        'criticalPressurePercent',
      ),
    ).toBe(6);
    expect(defaultValue(view(), 'aggressive', 'interactionGuardMs')).toBe(5 * MINUTE);
  });

  it('are typed in their units: minutes, tabs, days, percent', () => {
    expect(fieldText('discardAfterMs', HOUR)).toBe('60');
    expect(fieldText('stripCap', 10)).toBe('10');
    expect(fieldText('archiveAfterActiveDays', 3)).toBe('3');
    expect(fieldRange(view(), 'discardAfterMs')).toEqual({ min: 1, max: 10_080 });
    expect(fieldRange(view(), 'interactionGuardMs')).toEqual({ min: 0, max: 1440 });
    expect(fieldRange(view(), 'moderatePressurePercent')).toEqual({ min: 2, max: 50 });
  });

  it('read what was typed as the stored value', () => {
    expect(readField(view(), 'discardAfterMs', '45')).toEqual({ ok: true, value: 45 * MINUTE });
    expect(readField(view(), 'discardAfterMs', ' 45 ')).toEqual({ ok: true, value: 45 * MINUTE });
    expect(readField(view(), 'stripCap', '500')).toEqual({ ok: true, value: 500 });
    expect(readField(view(), 'interactionGuardMs', '0')).toEqual({ ok: true, value: 0 });
  });

  it.each([
    ['nothing', ''],
    ['a word', 'ten'],
    ['a fraction', '1.5'],
    ['a negative number', '-5'],
    ['a number with a unit', '10m'],
    ['zero where one is the least', '0'],
    ['one more than the most', '10081'],
    ['an exponent', '1e3'],
    ['a huge number', '99999999999'],
  ])('say what is wrong with %s, in the unit', (_what, text) => {
    expect(readField(view(), 'discardAfterMs', text)).toEqual({
      ok: false,
      message: 'Enter a whole number from 1 to 10,080 (minutes).',
    });
  });
});

describe('pressureInOrder', () => {
  it('keeps "very low" below "low"', () => {
    expect(pressureInOrder(view(), 'criticalPressurePercent', 9)).toBe(true);
    expect(pressureInOrder(view(), 'criticalPressurePercent', 10)).toBe(false);
    expect(pressureInOrder(view(), 'moderatePressurePercent', 5)).toBe(true);
    expect(pressureInOrder(view(), 'moderatePressurePercent', 4)).toBe(false);
    expect(
      pressureInOrder(
        view({ overrides: { criticalPressurePercent: 8 } }),
        'moderatePressurePercent',
        8,
      ),
    ).toBe(false);
  });
});

describe('the search engine', () => {
  it('is the named engine whose template it is, else custom', () => {
    expect(engineOf(view())).toBe('duckduckgo');
    const custom = view();
    expect(
      engineOf({
        ...custom,
        settings: {
          ...custom.settings,
          search: { template: 'https://s.example/?q={searchTerms}' },
        },
      }),
    ).toBe('custom');
  });

  it('says what a custom template is missing before main is asked', () => {
    expect(templateProblem('')).toMatch(/Enter the address/);
    expect(templateProblem('https://s.example/?q=')).toMatch(/\{searchTerms\}/);
    expect(templateProblem('https://s.example/?q={searchTerms}')).toBeNull();
  });
});
