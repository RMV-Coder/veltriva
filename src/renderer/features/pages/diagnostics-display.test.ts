import { describe, expect, it } from 'vitest';

import {
  actionText,
  countText,
  dateText,
  diagnosticsView,
  engagedText,
  eventView,
  howText,
  memoryText,
  metricView,
  percentText,
  presetText,
  pressureText,
  protectedSitesText,
  ruleText,
  sinceText,
  updatedText,
} from './diagnostics-display';
import type { Diagnostics, RegretEvent } from './diagnostics-display';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A local date and time, so the tests do not depend on the machine's time zone. */
const local = (year: number, month: number, day: number, hour = 12, minute = 0): number =>
  new Date(year, month - 1, day, hour, minute).getTime();

const NOW = local(2026, 10, 22, 16, 0);

const event: RegretEvent = {
  at: local(2026, 10, 22, 14, 32),
  how: 'restore',
  action: 'shelve',
  rule: 'shelve-beyond-cap',
  afterEngagedMs: 12 * MINUTE,
};

const diagnostics: Diagnostics = {
  regret: {
    since: local(2026, 10, 19, 9, 0),
    moves: 12,
    moveRegrets: 3,
    unloads: 40,
    unloadRegrets: 2,
    events: [event],
  },
  engagement: { activeDay: 4, engagedMs: 5 * HOUR + 12 * MINUTE },
  settings: { preset: 'balanced', paused: false, preview: true, protectedSites: ['example.com'] },
  pressure: 'moderate',
  memory: { totalMb: 16_128, availableMb: 6_432 },
};

describe('countText', () => {
  it('writes a whole number with thousands separators', () => {
    expect(countText(0)).toBe('0');
    expect(countText(999)).toBe('999');
    expect(countText(16_128)).toBe('16,128');
    expect(countText(1_234_567)).toBe('1,234,567');
  });

  it('rounds a fraction and reads anything that is not a number as 0', () => {
    expect(countText(6432.6)).toBe('6,433');
    expect(countText(Number.NaN)).toBe('0');
    expect(countText(Number.POSITIVE_INFINITY)).toBe('0');
    expect(countText(-5)).toBe('0');
  });
});

describe('percentText', () => {
  it('is the share as a percentage, with at most one decimal', () => {
    expect(percentText(3, 12)).toBe('25%');
    expect(percentText(1, 3)).toBe('33.3%');
    expect(percentText(2, 3)).toBe('66.7%');
    expect(percentText(1, 8)).toBe('12.5%');
    expect(percentText(1, 1000)).toBe('0.1%');
  });

  it('is 0% when nothing was regretted and 100% when everything was', () => {
    expect(percentText(0, 7)).toBe('0%');
    expect(percentText(7, 7)).toBe('100%');
  });

  it('is null when there is nothing to take a share of: no rate, not a rate of 0', () => {
    expect(percentText(0, 0)).toBeNull();
    expect(percentText(3, 0)).toBeNull();
    expect(percentText(1, Number.NaN)).toBeNull();
    expect(percentText(Number.NaN, 4)).toBeNull();
  });

  it('never claims more than 100%', () => {
    expect(percentText(5, 4)).toBe('100%');
  });
});

describe('dateText and sinceText', () => {
  it("writes a date in the user's own time, day first", () => {
    expect(dateText(local(2026, 10, 19, 9, 0))).toBe('19 Oct 2026');
    expect(dateText(local(2027, 1, 3, 23, 59))).toBe('3 Jan 2027');
  });

  it('is null for a time that is not a date', () => {
    expect(dateText(Number.NaN)).toBeNull();
  });

  it('says when counting started', () => {
    expect(sinceText(local(2026, 10, 19, 9, 0))).toBe('Counting since 19 Oct 2026');
  });

  it('says nothing when main has no start', () => {
    expect(sinceText(0)).toBeNull();
    expect(sinceText(Number.NaN)).toBeNull();
  });
});

describe('engagedText', () => {
  it('says "under a minute" for less than one', () => {
    expect(engagedText(0)).toBe('under a minute');
    expect(engagedText(59_999)).toBe('under a minute');
  });

  it('counts whole minutes up to an hour, rounding down', () => {
    expect(engagedText(MINUTE)).toBe('1 min');
    expect(engagedText(12 * MINUTE + 59_000)).toBe('12 min');
    expect(engagedText(59 * MINUTE)).toBe('59 min');
  });

  it('counts hours and the minutes after them', () => {
    expect(engagedText(HOUR)).toBe('1 h');
    expect(engagedText(HOUR + 5 * MINUTE)).toBe('1 h 5 min');
    expect(engagedText(5 * HOUR + 12 * MINUTE)).toBe('5 h 12 min');
    expect(engagedText(137 * HOUR)).toBe('137 h');
  });

  it('reads anything that is not a time as none', () => {
    expect(engagedText(Number.NaN)).toBe('under a minute');
    expect(engagedText(-HOUR)).toBe('under a minute');
  });
});

describe('what automation did, why, and what the user did', () => {
  it('names the action', () => {
    expect(actionText('shelve')).toBe('Moved to Sleeping');
    expect(actionText('archive')).toBe('Archived');
    expect(actionText('discard')).toBe('Unloaded');
  });

  it('gives the rule as a reason, in plain words, for every rule', () => {
    expect(ruleText('discard-hidden')).toBe('Not used for a while');
    expect(ruleText('shelve-beyond-cap')).toBe('Too many open tabs');
    expect(ruleText('archive-dormant')).toBe('Not used for days');
    expect(ruleText('pressure-discard')).toBe('Memory was low');
    expect(ruleText('freeze-hidden')).toBe('Hidden in the background');
  });

  it('names how the user brought it back', () => {
    expect(howText('restore')).toBe('Brought it back');
    expect(howText('undo')).toBe('Undid it');
    expect(howText('reload')).toBe('Reloaded it');
  });
});

describe('eventView', () => {
  it("puts the time, the action, the reason, the user's answer and the engaged time in words", () => {
    expect(eventView(event, NOW)).toEqual({
      time: '14:32',
      timeFull: new Date(event.at).toLocaleString(),
      action: 'Moved to Sleeping',
      rule: 'Too many open tabs',
      how: 'Brought it back',
      after: '12 min',
    });
  });

  it('reads the time against now: yesterday, and an earlier day', () => {
    const yesterday = { ...event, at: local(2026, 10, 21, 8, 5) };
    expect(eventView(yesterday, NOW).time).toBe('Yesterday 08:05');
    const earlier = { ...event, at: local(2026, 10, 3, 8, 5) };
    expect(eventView(earlier, NOW).time).toBe('3 Oct 08:05');
  });

  it('describes an unload that was reloaded, and one that was undone under a minute later', () => {
    const view = eventView(
      {
        ...event,
        how: 'reload',
        action: 'discard',
        rule: 'pressure-discard',
        afterEngagedMs: 4000,
      },
      NOW,
    );
    expect(view).toMatchObject({
      action: 'Unloaded',
      rule: 'Memory was low',
      how: 'Reloaded it',
      after: 'under a minute',
    });
  });
});

describe('metricView', () => {
  it('gives the totals and the rate', () => {
    expect(metricView(12, 3)).toEqual({ total: '12', regrets: '3', rate: '25%' });
    expect(metricView(1_200, 0)).toEqual({ total: '1,200', regrets: '0', rate: '0%' });
  });

  it('has no rate before automation has done anything', () => {
    expect(metricView(0, 0)).toEqual({ total: '0', regrets: '0', rate: null });
  });
});

describe('presetText, pressureText, memoryText', () => {
  it('capitalizes the preset', () => {
    expect(presetText('balanced')).toBe('Balanced');
    expect(presetText('gentle')).toBe('Gentle');
  });

  it('does not trust the preset: it is cleaned, and an empty one is unknown', () => {
    expect(presetText('bal‮anced\n')).toBe('Bal anced');
    expect(presetText('   ')).toBe('Unknown');
    expect(presetText('')).toBe('Unknown');
  });

  it('states memory pressure', () => {
    expect(pressureText('none')).toBe('Normal');
    expect(pressureText('moderate')).toBe('Low');
    expect(pressureText('critical')).toBe('Very low');
  });

  it('gives the memory available out of the total, in MB', () => {
    expect(memoryText({ totalMb: 16_128, availableMb: 6_432 })).toBe('6,432 of 16,128 MB');
    expect(memoryText({ totalMb: 8_192.4, availableMb: 100.2 })).toBe('100 of 8,192 MB');
  });

  it('says "Unknown" when the machine\'s memory is not known', () => {
    expect(memoryText({ totalMb: 0, availableMb: 0 })).toBe('Unknown');
  });
});

describe('protectedSitesText', () => {
  it('keeps the sites in the order main gave them', () => {
    expect(protectedSitesText(['b.example', 'a.example'])).toEqual(['b.example', 'a.example']);
  });

  it('removes controls and invisible formatting, and sites nothing is left of', () => {
    expect(protectedSitesText(['exa‮mple.com', '​', ' ', 'ok.example'])).toEqual([
      'exa mple.com',
      'ok.example',
    ]);
  });

  it('is empty for no sites', () => {
    expect(protectedSitesText([])).toEqual([]);
  });
});

describe('updatedText', () => {
  it('says when the numbers were read', () => {
    expect(updatedText(local(2026, 10, 22, 15, 59), NOW)).toBe('Updated 15:59');
    expect(updatedText(local(2026, 10, 21, 15, 59), NOW)).toBe('Updated Yesterday 15:59');
  });

  it('says only "Updated" for a time that is not a date', () => {
    expect(updatedText(Number.NaN, NOW)).toBe('Updated');
  });
});

describe('diagnosticsView', () => {
  it('works out everything the page shows', () => {
    expect(diagnosticsView(diagnostics, NOW)).toEqual({
      since: 'Counting since 19 Oct 2026',
      moves: { total: '12', regrets: '3', rate: '25%' },
      unloads: { total: '40', regrets: '2', rate: '5%' },
      events: [eventView(event, NOW)],
      activeDay: '4',
      engaged: '5 h 12 min',
      preset: 'Balanced',
      automation: 'Running',
      preview: 'On',
      protectedSites: ['example.com'],
      pressure: 'Low',
      memory: '6,432 of 16,128 MB',
    });
  });

  it('shows a fresh install: nothing done, nothing regretted, nothing protected', () => {
    const fresh: Diagnostics = {
      regret: { since: 0, moves: 0, moveRegrets: 0, unloads: 0, unloadRegrets: 0, events: [] },
      engagement: { activeDay: 1, engagedMs: 0 },
      settings: { preset: 'balanced', paused: true, preview: false, protectedSites: [] },
      pressure: 'none',
      memory: { totalMb: 0, availableMb: 0 },
    };
    expect(diagnosticsView(fresh, NOW)).toEqual({
      since: null,
      moves: { total: '0', regrets: '0', rate: null },
      unloads: { total: '0', regrets: '0', rate: null },
      events: [],
      activeDay: '1',
      engaged: 'under a minute',
      preset: 'Balanced',
      automation: 'Paused',
      preview: 'Off',
      protectedSites: [],
      pressure: 'Normal',
      memory: 'Unknown',
    });
  });
});
