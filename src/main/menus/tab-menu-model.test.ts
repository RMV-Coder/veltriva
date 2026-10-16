import { describe, expect, it } from 'vitest';

import { buildTabMenu } from './tab-menu-model';
import type { TabMenuContext, TabMenuEntry } from './tab-menu-model';

const shape = (entries: readonly TabMenuEntry[]): string[] =>
  entries.map((entry) =>
    entry.type === 'separator' ? '---' : `${entry.label}${entry.enabled ? '' : ' (disabled)'}`,
  );

const base: TabMenuContext = {
  pinned: false,
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
      'Close tab',
      'Close other tabs',
      '---',
      'Reopen closed tab',
    ]);
  });

  it('offers Unpin for a pinned tab', () => {
    const entries = buildTabMenu({ ...base, pinned: true });
    expect(shape(entries)).toContain('Unpin tab');
    expect(shape(entries)).not.toContain('Pin tab');
  });

  it('disables what has nothing to act on', () => {
    expect(
      shape(
        buildTabMenu({
          pinned: false,
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
      'Close tab',
      'Close other tabs (disabled)',
      '---',
      'Reopen closed tab (disabled)',
    ]);
  });
});
