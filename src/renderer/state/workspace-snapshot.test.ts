import { describe, expect, it } from 'vitest';

import {
  NO_AUTOMATION,
  automationOf,
  findSelectedTab,
  fullscreenNotice,
  isNewerSnapshot,
} from './workspace-snapshot';

describe('isNewerSnapshot', () => {
  it('accepts the first snapshot, whatever its version', () => {
    expect(isNewerSnapshot(null, { version: 0 })).toBe(true);
    expect(isNewerSnapshot(null, { version: 41 })).toBe(true);
  });

  it('accepts a strictly newer version', () => {
    expect(isNewerSnapshot({ version: 3 }, { version: 4 })).toBe(true);
    expect(isNewerSnapshot({ version: 3 }, { version: 10 })).toBe(true);
  });

  it('ignores a repeat of the held version', () => {
    expect(isNewerSnapshot({ version: 3 }, { version: 3 })).toBe(false);
  });

  it('ignores an older version that arrives late', () => {
    expect(isNewerSnapshot({ version: 7 }, { version: 6 })).toBe(false);
    expect(isNewerSnapshot({ version: 7 }, { version: 0 })).toBe(false);
  });
});

describe('findSelectedTab', () => {
  const tabs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('finds the selected tab', () => {
    expect(findSelectedTab({ selectedTabId: 'b', tabs })).toBe(tabs[1]);
  });

  it('is undefined before the first snapshot', () => {
    expect(findSelectedTab(null)).toBeUndefined();
  });

  it('is undefined when nothing is selected or the id matches no tab', () => {
    expect(findSelectedTab({ selectedTabId: null, tabs })).toBeUndefined();
    expect(findSelectedTab({ selectedTabId: 'gone', tabs })).toBeUndefined();
  });
});

describe('fullscreenNotice', () => {
  it('is the tab and origin while the notice must be drawn', () => {
    const fullscreen = { tabId: 'a', origin: 'www.example.com', notice: true };
    expect(fullscreenNotice({ fullscreen })).toEqual({ tabId: 'a', origin: 'www.example.com' });
  });

  it('is null once the notice is over, though the tab is still in fullscreen', () => {
    const fullscreen = { tabId: 'a', origin: 'www.example.com', notice: false };
    expect(fullscreenNotice({ fullscreen })).toBeNull();
  });

  it('is null when no tab is in fullscreen, or before the first snapshot', () => {
    expect(fullscreenNotice({ fullscreen: null })).toBeNull();
    expect(fullscreenNotice(null)).toBeNull();
  });
});

describe('automationOf', () => {
  it("is the snapshot's automation, as it is", () => {
    const automation = {
      paused: true,
      preview: true,
      previewUntilDay: 3,
      activeDay: 2,
      pressure: 'moderate',
    } as const;
    expect(automationOf({ automation })).toBe(automation);
  });

  it('is "running, nothing to report" before the first snapshot', () => {
    expect(automationOf(null)).toBe(NO_AUTOMATION);
    expect(NO_AUTOMATION).toEqual({
      paused: false,
      preview: false,
      previewUntilDay: 0,
      activeDay: 0,
      pressure: 'none',
    });
  });
});
