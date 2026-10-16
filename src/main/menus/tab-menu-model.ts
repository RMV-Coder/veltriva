// The context menu of a tab in the sidebar: right-click, the Menu key or Shift+F10 on the tab. It
// is also how a keyboard user pins or duplicates a tab. Pure, so the entries are unit-tested and a
// test hook can show them (Playwright can't click native menus).

export type TabMenuItemId =
  | 'new-tab-below'
  | 'reload'
  | 'duplicate'
  | 'pin'
  | 'unpin'
  | 'close'
  | 'close-others'
  | 'reopen-closed';

export type TabMenuEntry =
  | {
      readonly type: 'item';
      readonly id: TabMenuItemId;
      readonly label: string;
      readonly enabled: boolean;
    }
  | { readonly type: 'separator' };

export interface TabMenuContext {
  readonly pinned: boolean;
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
  return [
    item('new-tab-below', 'New tab below'),
    SEPARATOR,
    item('reload', 'Reload', context.hasPage),
    item('duplicate', 'Duplicate'),
    context.pinned ? item('unpin', 'Unpin tab') : item('pin', 'Pin tab'),
    SEPARATOR,
    item('close', 'Close tab'),
    item('close-others', 'Close other tabs', context.otherUnpinnedTabs > 0),
    SEPARATOR,
    item('reopen-closed', 'Reopen closed tab', context.canReopenClosed),
  ];
}
