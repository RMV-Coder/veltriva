// The context menu of a tab in the sidebar: right-click, the Menu key or Shift+F10 on the tab. It
// is also how a keyboard user pins or duplicates a tab, and moves it to Sleeping or the Archive or
// protects it from automation (M3.3). A Sleeping tab has a shorter menu. Pure, so the entries are
// unit-tested and a test hook can show them (Playwright can't click native menus).

export type TabMenuItemId =
  | 'new-tab-below'
  | 'reload'
  | 'duplicate'
  | 'pin'
  | 'unpin'
  | 'close'
  | 'close-others'
  | 'reopen-closed'
  | 'shelve'
  | 'archive'
  | 'restore'
  | 'protect'
  | 'unprotect'
  | 'protect-site'
  | 'unprotect-site';

export type TabMenuEntry =
  | {
      readonly type: 'item';
      readonly id: TabMenuItemId;
      readonly label: string;
      readonly enabled: boolean;
    }
  | { readonly type: 'separator' };

export interface TabMenuContext {
  /** In the strip, or Sleeping. */
  readonly placement: 'strip' | 'shelf';
  readonly pinned: boolean;
  readonly userProtected: boolean;
  /** It has a page worth keeping in the Archive (an address, and not a private tab). */
  readonly canArchive: boolean;
  /** Its page's site (M3.4), or null for a page without one; and whether the user protects it. */
  readonly site: string | null;
  readonly siteProtected: boolean;
  /** The tab shows a web page (or an error or crash page with a URL to load again). */
  readonly hasPage: boolean;
  /** How many tabs "Close other tabs" would close: the others that aren't pinned, as in Chrome. */
  readonly otherUnpinnedTabs: number;
  readonly canReopenClosed: boolean;
}

const item = (id: TabMenuItemId, label: string, enabled = true): TabMenuEntry => ({
  type: 'item',
  id,
  label,
  enabled,
});
const SEPARATOR: TabMenuEntry = { type: 'separator' };

export function buildTabMenu(context: TabMenuContext): TabMenuEntry[] {
  const protect = context.userProtected
    ? item('unprotect', 'Stop protecting')
    : item('protect', 'Protect from automation');
  // The site's name is main's own label of the page's host, never page text.
  const site =
    context.site === null
      ? []
      : [
          context.siteProtected
            ? item('unprotect-site', `Stop protecting ${context.site}`)
            : item('protect-site', `Always protect ${context.site}`),
        ];
  if (context.placement === 'shelf') {
    return [
      item('restore', 'Move to Tabs'),
      item('archive', 'Archive tab', context.canArchive),
      protect,
      ...site,
      SEPARATOR,
      item('close', 'Close tab'),
      SEPARATOR,
      item('reopen-closed', 'Reopen closed tab', context.canReopenClosed),
    ];
  }
  return [
    item('new-tab-below', 'New tab below'),
    SEPARATOR,
    item('reload', 'Reload', context.hasPage),
    item('duplicate', 'Duplicate'),
    context.pinned ? item('unpin', 'Unpin tab') : item('pin', 'Pin tab'),
    SEPARATOR,
    // A pinned tab stays in the strip (I8): unpin it first.
    item('shelve', 'Move to Sleeping', !context.pinned),
    item('archive', 'Archive tab', context.canArchive),
    protect,
    ...site,
    SEPARATOR,
    item('close', 'Close tab'),
    item('close-others', 'Close other tabs', context.otherUnpinnedTabs > 0),
    SEPARATOR,
    item('reopen-closed', 'Reopen closed tab', context.canReopenClosed),
  ];
}
