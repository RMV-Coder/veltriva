import { describe, expect, it } from 'vitest';

import { buildTabMenu } from './tab-menu-model';
import type { TabMenuContext, TabMenuEntry } from './tab-menu-model';

const shape = (entries: readonly TabMenuEntry[]): string[] =>
  entries.map((entry) =>
    entry.type === 'separator' ? '---' : `${entry.label}${entry.enabled ? '' : ' (disabled)'}`,
  );

/** The ids of the items, in order. */
const ids = (entries: readonly TabMenuEntry[]): string[] =>
  entries.flatMap((entry) => (entry.type === 'item' ? [entry.id] : []));

/** A page without a site: a new-tab page, a file, an error page. */
const base: TabMenuContext = {
  placement: 'strip',
  pinned: false,
  userProtected: false,
  canArchive: true,
  site: null,
  siteProtected: false,
  hasPage: true,
  otherUnpinnedTabs: 2,
  canReopenClosed: true,
};

/** A page on example.com. */
const onSite: TabMenuContext = { ...base, site: 'example.com' };

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
          site: null,
          siteProtected: false,
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

describe('buildTabMenu: the site (M3.4)', () => {
  it('offers to always protect the site of the page, right after the tab Protect item', () => {
    expect(shape(buildTabMenu(onSite))).toEqual([
      'New tab below',
      '---',
      'Reload',
      'Duplicate',
      'Pin tab',
      '---',
      'Move to Sleeping',
      'Archive tab',
      'Protect from automation',
      'Always protect example.com',
      '---',
      'Close tab',
      'Close other tabs',
      '---',
      'Reopen closed tab',
    ]);
  });

  it('offers to stop protecting a site the user protects', () => {
    const entries = shape(buildTabMenu({ ...onSite, siteProtected: true }));

    expect(entries).toContain('Stop protecting example.com');
    expect(entries).not.toContain('Always protect example.com');
  });

  it('has the ids protect-site and unprotect-site', () => {
    expect(ids(buildTabMenu(onSite))).toContain('protect-site');
    expect(ids(buildTabMenu(onSite))).not.toContain('unprotect-site');
    expect(ids(buildTabMenu({ ...onSite, siteProtected: true }))).toContain('unprotect-site');
    expect(ids(buildTabMenu({ ...onSite, siteProtected: true }))).not.toContain('protect-site');
  });

  it('leaves the site out for a page without one', () => {
    for (const siteProtected of [false, true]) {
      const entries = buildTabMenu({ ...base, siteProtected });

      expect(ids(entries)).not.toContain('protect-site');
      expect(ids(entries)).not.toContain('unprotect-site');
      // It is the menu of a page without a site, whatever the stale flag says.
      expect(shape(entries)).toEqual(shape(buildTabMenu(base)));
    }
  });

  it('keeps the tab Protect item and the site item independent', () => {
    const both = shape(buildTabMenu({ ...onSite, userProtected: true, siteProtected: true }));

    expect(both).toContain('Stop protecting');
    expect(both).toContain('Stop protecting example.com');
    const neither = shape(buildTabMenu(onSite));
    expect(neither).toContain('Protect from automation');
    expect(neither).toContain('Always protect example.com');
    const tabOnly = shape(buildTabMenu({ ...onSite, userProtected: true }));
    expect(tabOnly).toContain('Stop protecting');
    expect(tabOnly).toContain('Always protect example.com');
    const siteOnly = shape(buildTabMenu({ ...onSite, siteProtected: true }));
    expect(siteOnly).toContain('Protect from automation');
    expect(siteOnly).toContain('Stop protecting example.com');
  });

  it('offers it in the menu of a Sleeping tab too, after Protect', () => {
    expect(shape(buildTabMenu({ ...onSite, placement: 'shelf' }))).toEqual([
      'Move to Tabs',
      'Archive tab',
      'Protect from automation',
      'Always protect example.com',
      '---',
      'Close tab',
      '---',
      'Reopen closed tab',
    ]);
    expect(
      shape(
        buildTabMenu({
          ...onSite,
          placement: 'shelf',
          userProtected: true,
          siteProtected: true,
          canArchive: false,
        }),
      ),
    ).toEqual([
      'Move to Tabs',
      'Archive tab (disabled)',
      'Stop protecting',
      'Stop protecting example.com',
      '---',
      'Close tab',
      '---',
      'Reopen closed tab',
    ]);
  });

  it('leaves it out of a Sleeping tab menu when the page has no site', () => {
    expect(ids(buildTabMenu({ ...base, placement: 'shelf' }))).toEqual([
      'restore',
      'archive',
      'protect',
      'close',
      'reopen-closed',
    ]);
  });

  it('always enables it: protecting a site needs nothing of the tab', () => {
    const variants: Partial<TabMenuContext>[] = [
      {},
      { pinned: true },
      { canArchive: false },
      { hasPage: false },
      { otherUnpinnedTabs: 0 },
      { canReopenClosed: false },
      { placement: 'shelf' },
      { siteProtected: true },
    ];

    for (const variant of variants) {
      const entry = buildTabMenu({ ...onSite, ...variant }).find(
        (candidate) =>
          candidate.type === 'item' &&
          (candidate.id === 'protect-site' || candidate.id === 'unprotect-site'),
      );

      expect(entry, JSON.stringify(variant)).toMatchObject({ type: 'item', enabled: true });
    }
  });

  it('names the site as it was given, host names and addresses alike', () => {
    for (const site of ['example.co.uk', 'foo.github.io', 'localhost', '127.0.0.1', '[::1]']) {
      expect(shape(buildTabMenu({ ...base, site }))).toContain(`Always protect ${site}`);
      expect(shape(buildTabMenu({ ...base, site, siteProtected: true }))).toContain(
        `Stop protecting ${site}`,
      );
    }
  });

  it('does not interpret the site: it is a label, whatever it holds', () => {
    const site = '%s & <b>{x}</b>';

    expect(shape(buildTabMenu({ ...base, site }))).toContain(`Always protect ${site}`);
  });

  it('adds exactly one item to the strip menu and one to the Sleeping menu', () => {
    expect(buildTabMenu(onSite)).toHaveLength(buildTabMenu(base).length + 1);
    expect(buildTabMenu({ ...onSite, placement: 'shelf' })).toHaveLength(
      buildTabMenu({ ...base, placement: 'shelf' }).length + 1,
    );
  });

  it('has no two items with the same id', () => {
    for (const context of [
      onSite,
      { ...onSite, siteProtected: true },
      { ...onSite, placement: 'shelf' as const },
      { ...onSite, userProtected: true, siteProtected: true },
    ]) {
      const all = ids(buildTabMenu(context));

      expect(new Set(all).size).toBe(all.length);
    }
  });
});
