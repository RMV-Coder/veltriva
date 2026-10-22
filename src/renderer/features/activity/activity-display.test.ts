import { describe, expect, it } from 'vitest';

import type { ActivityEntry } from '../../../shared/contracts/activity';
import {
  MAX_ADDRESS_CHARS,
  MAX_TITLE_CHARS,
  activityRefreshKey,
  activityRowView,
  activitySentence,
  activityTimeText,
} from './activity-display';

type Sentence = Parameters<typeof activitySentence>[0];

const sentence = (
  action: Sentence['action'],
  rule: Sentence['rule'],
  pressure: Sentence['pressure'] = null,
): string => activitySentence({ action, rule, pressure });

describe('activitySentence', () => {
  it('says an unload for being hidden for a while', () => {
    expect(sentence('discard', 'discard-hidden')).toBe('Unloaded — not used for a while');
  });

  it('says plainly that memory pressure unloaded the tab, and how bad it was', () => {
    expect(sentence('discard', 'pressure-discard', 'critical')).toBe(
      'Unloaded because memory was very low',
    );
    expect(sentence('discard', 'pressure-discard', 'moderate')).toBe(
      'Unloaded because memory was low',
    );
  });

  it('still says memory was low when the pressure was not recorded', () => {
    expect(sentence('discard', 'pressure-discard')).toBe('Unloaded because memory was low');
  });

  it('says a pause in the background', () => {
    expect(sentence('freeze', 'freeze-hidden')).toBe('Paused in the background');
  });

  it('says a move to Sleeping for having too many tabs open', () => {
    expect(sentence('shelve', 'shelve-beyond-cap')).toBe('Moved to Sleeping — too many open tabs');
  });

  it('says an archive for being dormant for days', () => {
    expect(sentence('archive', 'archive-dormant')).toBe('Archived — not used for days');
  });

  it('says the user undid it', () => {
    expect(sentence('undo', null)).toBe('You undid this');
  });

  it('keeps the action when a rule is missing or new, rather than saying nothing', () => {
    expect(sentence('discard', null)).toBe('Unloaded');
    expect(sentence('shelve', null)).toBe('Moved to Sleeping');
    expect(sentence('archive', null)).toBe('Archived');
    expect(sentence('freeze', null)).toBe('Paused in the background');
  });

  it('ignores a pressure that belongs to another rule', () => {
    expect(sentence('discard', 'discard-hidden', 'critical')).toBe(
      'Unloaded — not used for a while',
    );
  });
});

describe('activityTimeText', () => {
  // Local time, so the expectations hold in any time zone.
  const at = (year: number, month: number, day: number, hour: number, minute: number): number =>
    new Date(year, month - 1, day, hour, minute).getTime();
  const now = at(2026, 10, 22, 16, 5);

  it('is the time of day for today', () => {
    expect(activityTimeText(at(2026, 10, 22, 14, 32), now)).toBe('14:32');
    expect(activityTimeText(at(2026, 10, 22, 0, 7), now)).toBe('00:07');
  });

  it('says "Yesterday" for the day before, also across a month', () => {
    expect(activityTimeText(at(2026, 10, 21, 23, 59), now)).toBe('Yesterday 23:59');
    expect(activityTimeText(at(2026, 11, 1, 9, 0), at(2026, 11, 2, 8, 0))).toBe('Yesterday 09:00');
    expect(activityTimeText(at(2026, 10, 31, 9, 0), at(2026, 11, 1, 8, 0))).toBe('Yesterday 09:00');
  });

  it('gives the day for anything older this year', () => {
    expect(activityTimeText(at(2026, 10, 20, 8, 15), now)).toBe('20 Oct 08:15');
    expect(activityTimeText(at(2026, 1, 3, 18, 40), now)).toBe('3 Jan 18:40');
  });

  it('adds the year for another year', () => {
    expect(activityTimeText(at(2025, 12, 31, 23, 0), now)).toBe('31 Dec 2025 23:00');
  });

  it('is empty for a time that is not a date', () => {
    expect(activityTimeText(Number.NaN, now)).toBe('');
    expect(activityTimeText(now, Number.NaN)).toBe('');
  });
});

describe('activityRowView', () => {
  const now = new Date(2026, 9, 22, 16, 5).getTime();
  const entry: ActivityEntry = {
    id: 7,
    at: new Date(2026, 9, 22, 14, 32).getTime(),
    action: 'discard',
    rule: 'discard-hidden',
    pressure: null,
    tabId: 'tab-1',
    title: 'Example Domain',
    address: 'example.com/docs',
    batchId: null,
  };

  it('gives the sentence, the time, the title and the address', () => {
    expect(activityRowView(entry, now)).toEqual({
      id: 7,
      sentence: 'Unloaded — not used for a while',
      time: '14:32',
      title: { text: 'Example Domain', full: undefined },
      address: { text: 'example.com/docs', full: undefined },
    });
  });

  it('uses the address as the title of a page without one, and does not say it twice', () => {
    const view = activityRowView({ ...entry, title: '   ' }, now);
    expect(view.title).toEqual({ text: 'example.com/docs', full: undefined });
    expect(view.address).toBeNull();
  });

  it('says "Untitled" when there is neither a title nor an address', () => {
    const view = activityRowView({ ...entry, title: '', address: '' }, now);
    expect(view.title.text).toBe('Untitled');
    expect(view.address).toBeNull();
  });

  it('leaves out an empty address under a title', () => {
    expect(activityRowView({ ...entry, address: '' }, now).address).toBeNull();
  });

  it('cuts a long title and address at their end and keeps the whole text for a tooltip', () => {
    const title = 'T'.repeat(MAX_TITLE_CHARS + 20);
    const address = `example.com/${'a'.repeat(MAX_ADDRESS_CHARS + 20)}`;
    const view = activityRowView({ ...entry, title, address }, now);
    expect(Array.from(view.title.text)).toHaveLength(MAX_TITLE_CHARS);
    expect(view.title.text.endsWith('…')).toBe(true);
    expect(view.title.full).toBe(title);
    expect(Array.from(view.address?.text ?? '')).toHaveLength(MAX_ADDRESS_CHARS);
    expect(view.address?.text.startsWith('example.com/')).toBe(true);
    expect(view.address?.full).toBe(address);
  });

  it('removes bidi overrides and other invisible characters from what a page wrote', () => {
    const view = activityRowView(
      { ...entry, title: 'safe‮exe.txt​\u0007', address: 'a⁦b⁩.example' },
      now,
    );
    expect(view.title.text).toBe('safe exe.txt');
    expect(view.address?.text).toBe('a b .example');
  });

  it('keeps markup as text: nothing of the page is interpreted', () => {
    const view = activityRowView({ ...entry, title: '<img src=x onerror=alert(1)>' }, now);
    expect(view.title.text).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('activityRefreshKey', () => {
  it('is empty before the first snapshot', () => {
    expect(activityRefreshKey(null)).toBe('');
  });

  it("follows main's activity version: the same version, the same key", () => {
    expect(activityRefreshKey({ activityVersion: 7 })).toBe(
      activityRefreshKey({ activityVersion: 7 }),
    );
    expect(activityRefreshKey({ activityVersion: 8 })).not.toBe(
      activityRefreshKey({ activityVersion: 7 }),
    );
    expect(activityRefreshKey({ activityVersion: 0 })).not.toBe(activityRefreshKey(null));
  });
});
