import { describe, expect, it } from 'vitest';

import { buildTabMenu } from './tab-menu-model';
import type { TabMenuContext, TabMenuEntry } from './tab-menu-model';

const shape = (entries: readonly TabMenuEntry[]): string[] =>
  entries.map((entry) =>
    entry.type === 'separator' ? '---' : `${entry.label}${entry.enabled ? '' : ' (disabled)'}`,
  );

const base: TabMenuContext = {
  placement: 'strip',
  pinned: false,
  userProtected: false,
  canArchive: true,
  hasPage: true,
  otherUnpinnedTabs: 2,
  canReopenClosed: true,
};

describe('buildTabMenu', () => {
  it('offers the tab actions, Pin for an unpinned tab', () => {
    expect(shape(buildTabMenu(base))).toEqual([
      'New tab below',
      '---',
      'Reload',
      'Duplicate',
      'Pin tab',
      '---',
      'Move to Sleeping',
      'Archive tab',
      'Protect from automation',
      '---',
      'Close tab',
      'Close other tabs',
      '---',
      'Reopen closed tab',
    ]);
  });

  it('offers Unpin for a pinned tab, and keeps it out of Sleeping (I8)', () => {
    const entries = buildTabMenu({ ...base, pinned: true });
    expect(shape(entries)).toContain('Unpin tab');
    expect(shape(entries)).not.toContain('Pin tab');
    expect(shape(entries)).toContain('Move to Sleeping (disabled)');
  });

  it('offers Stop protecting for a protected tab', () => {
    const entries = shape(buildTabMenu({ ...base, userProtected: true }));
    expect(entries).toContain('Stop protecting');
    expect(entries).not.toContain('Protect from automation');
  });

  it('disables Archive for a tab with nothing to keep', () => {
    expect(shape(buildTabMenu({ ...base, canArchive: false }))).toContain('Archive tab (disabled)');
  });

  it('gives a Sleeping tab its own, shorter menu', () => {
    expect(shape(buildTabMenu({ ...base, placement: 'shelf' }))).toEqual([
      'Move to Tabs',
      'Archive tab',
      'Protect from automation',
      '---',
      'Close tab',
      '---',
      'Reopen closed tab',
    ]);
    expect(
      shape(buildTabMenu({ ...base, placement: 'shelf', userProtected: true, canArchive: false })),
    ).toEqual([
      'Move to Tabs',
      'Archive tab (disabled)',
      'Stop protecting',
      '---',
      'Close tab',
      '---',
      'Reopen closed tab',
    ]);
  });

  it('disables what has nothing to act on', () => {
    expect(
      shape(
        buildTabMenu({
          placement: 'strip',
          pinned: false,
          userProtected: false,
          canArchive: false,
          hasPage: false,
          otherUnpinnedTabs: 0,
          canReopenClosed: false,
        }),
      ),
    ).toEqual([
      'New tab below',
      '---',
      'Reload (disabled)',
      'Duplicate',
      'Pin tab',
      '---',
      'Move to Sleeping',
      'Archive tab (disabled)',
      'Protect from automation',
      '---',
      'Close tab',
      'Close other tabs (disabled)',
      '---',
      'Reopen closed tab (disabled)',
    ]);
  });
});
