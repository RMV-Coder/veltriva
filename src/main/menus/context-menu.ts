// Native context menus for pages and for the shell's fields (assessment §3.3: menus are native,
// drawn above every view). The entries come from ./context-menu-model.ts; this pops them up and
// runs what the user picks.
//
// Actions that navigate or copy work on page-controlled data (link and image URLs, selected text),
// so: a URL opens in a tab only if the tab navigation policy allows it, checked again when the
// action runs; text goes to the clipboard only on the user's click; and a selection is searched
// for through the validated search template.
import { clipboard, Menu } from 'electron';
import type { BaseWindow, ContextMenuParams, WebContents, WebContentsView } from 'electron';

import { buildSearchUrl } from '../../core/url/omnibox';
import type { TabId, TabManager } from '../tabs/tab-manager';
import { isNavigationAllowed } from '../web/navigation-policy';
import { buildContextMenu, canSave } from './context-menu-model';
import type { MenuEntry, MenuItemId, MenuParams } from './context-menu-model';
import { buildTabMenu } from './tab-menu-model';
import type { TabMenuEntry, TabMenuItemId } from './tab-menu-model';

export interface ContextMenuDependencies {
  readonly window: BaseWindow;
  readonly shell: WebContentsView;
  readonly tabs: () => TabManager;
  readonly views: ReadonlyMap<TabId, WebContentsView>;
  readonly searchTemplate: () => string;
  /** The search engine's name for the "Search … for" item. */
  readonly searchEngine: () => string;
}

export interface ContextMenus {
  /** A right-click on a tab's page. */
  forTab(tabId: TabId, params: ContextMenuParams): void;
  /** A right-click in the shell: only its fields get a menu (editing). */
  forShell(params: ContextMenuParams): void;
  /** The entries for a tab and these params, without showing them (test hook). */
  entriesForTab(tabId: TabId, params: MenuParams): MenuEntry[];
  /** Runs an item as if it had been clicked in the tab's menu (test hook). */
  runForTab(tabId: TabId, params: MenuParams, id: MenuItemId): void;
  /** The menu of a tab in the sidebar, at a point in the window (`tabs.showMenu`). */
  forSidebarTab(tabId: TabId, x: number, y: number): void;
  /** The sidebar tab menu's entries, without showing them (test hook). */
  sidebarTabEntries(tabId: TabId): TabMenuEntry[];
  /** Runs a sidebar tab menu item as if it had been clicked (test hook). */
  runForSidebarTab(tabId: TabId, id: TabMenuItemId): void;
}

/** Whether main may open a page-supplied URL in a tab: what a page could navigate a tab to. */
export function canOpenInTab(url: string): boolean {
  return isNavigationAllowed('tab', { url, isMainFrame: true });
}

export function createContextMenus(deps: ContextMenuDependencies): ContextMenus {
  const tabEntries = (tabId: TabId, params: MenuParams): MenuEntry[] => {
    const tab = deps.tabs().get(tabId);
    return buildContextMenu(params, {
      source: 'tab',
      canGoBack: tab.canGoBack,
      canGoForward: tab.canGoForward,
      canOpen: canOpenInTab,
      searchEngine: deps.searchEngine(),
    });
  };

  const openInNewTab = (sourceTabId: TabId, url: string, select: boolean): void => {
    if (!canOpenInTab(url)) {
      return;
    }
    const tabs = deps.tabs();
    const id = tabs.create({ afterTabId: sourceTabId, select });
    tabs.navigate(id, url, { focus: select });
  };

  const runEdit = (contents: WebContents, id: MenuItemId): boolean => {
    switch (id) {
      case 'undo':
        contents.undo();
        return true;
      case 'redo':
        contents.redo();
        return true;
      case 'cut':
        contents.cut();
        return true;
      case 'copy':
        contents.copy();
        return true;
      case 'paste':
        contents.paste();
        return true;
      case 'paste-plain':
        contents.pasteAndMatchStyle();
        return true;
      case 'select-all':
        contents.selectAll();
        return true;
      default:
        return false;
    }
  };

  const runForTab = (tabId: TabId, params: MenuParams, id: MenuItemId): void => {
    const contents = deps.views.get(tabId)?.webContents;
    const tabs = deps.tabs();
    if (contents === undefined || contents.isDestroyed() || !tabs.has(tabId)) {
      return;
    }
    if (runEdit(contents, id)) {
      return;
    }
    if (id.startsWith('suggestion-')) {
      const suggestion = params.dictionarySuggestions[Number(id.slice('suggestion-'.length))];
      if (suggestion !== undefined) {
        contents.replaceMisspelling(suggestion);
      }
      return;
    }
    switch (id) {
      case 'open-link-in-new-tab':
        // In the background, after the page, as Chrome does.
        openInNewTab(tabId, params.linkURL, false);
        return;
      case 'copy-link':
        clipboard.writeText(params.linkURL).catch(() => undefined);
        return;
      case 'save-link':
      case 'save-image': {
        // Checked again: the params came from the page. The download manager names and places it.
        const url = id === 'save-link' ? params.linkURL : params.srcURL;
        if (canSave(url, { canOpen: canOpenInTab })) {
          contents.downloadURL(url);
        }
        return;
      }
      case 'open-image-in-new-tab':
        openInNewTab(tabId, params.srcURL, false);
        return;
      case 'copy-image':
        contents.copyImageAt(params.x, params.y);
        return;
      case 'copy-image-address':
        clipboard.writeText(params.srcURL).catch(() => undefined);
        return;
      case 'search-selection': {
        const query = params.selectionText.trim();
        if (query !== '') {
          openInNewTab(tabId, buildSearchUrl(deps.searchTemplate(), query), true);
        }
        return;
      }
      case 'add-to-dictionary':
        if (params.misspelledWord !== '') {
          contents.session.addWordToSpellCheckerDictionary(params.misspelledWord);
        }
        return;
      case 'back':
        tabs.goBack(tabId);
        return;
      case 'forward':
        tabs.goForward(tabId);
        return;
      case 'reload':
        tabs.reload(tabId);
        return;
      case 'inspect':
        if (!contents.isDevToolsOpened()) {
          contents.openDevTools({ mode: 'detach', activate: true });
        }
        contents.inspectElement(params.x, params.y);
        return;
      default:
        return;
    }
  };

  /** Pops a menu up at the click, which is in `view`'s coordinates. */
  const popup = (
    entries: readonly MenuEntry[],
    view: WebContentsView,
    params: MenuParams,
    onPick: (id: MenuItemId) => void,
  ): void => {
    if (entries.length === 0 || deps.window.isDestroyed()) {
      return;
    }
    const menu = Menu.buildFromTemplate(
      entries.map((entry) =>
        entry.type === 'separator'
          ? { type: 'separator' as const }
          : {
              // An "&" marks a Windows access key; page text must not create one.
              label: entry.label.replaceAll('&', '&&'),
              enabled: entry.enabled,
              click: () => {
                onPick(entry.id);
              },
            },
      ),
    );
    const bounds = view.getBounds();
    menu.popup({
      window: deps.window,
      x: Math.round(bounds.x + params.x),
      y: Math.round(bounds.y + params.y),
    });
  };

  return {
    forTab(tabId, params) {
      const view = deps.views.get(tabId);
      if (view === undefined || !deps.tabs().has(tabId)) {
        return;
      }
      popup(tabEntries(tabId, params), view, params, (id) => {
        runForTab(tabId, params, id);
      });
    },
    forShell(params) {
      const entries = buildContextMenu(params, {
        source: 'shell',
        canGoBack: false,
        canGoForward: false,
        canOpen: () => false,
        searchEngine: '',
      });
      popup(entries, deps.shell, params, (id) => {
        runEdit(deps.shell.webContents, id);
      });
    },
    entriesForTab: tabEntries,
    runForTab,
    forSidebarTab(tabId, x, y) {
      if (!deps.tabs().has(tabId) || deps.window.isDestroyed()) {
        return;
      }
      const menu = Menu.buildFromTemplate(
        sidebarTabEntries(tabId).map((entry) =>
          entry.type === 'separator'
            ? { type: 'separator' as const }
            : {
                label: entry.label,
                enabled: entry.enabled,
                click: () => {
                  runForSidebarTab(tabId, entry.id);
                },
              },
        ),
      );
      // The shell's view fills the window from its top-left corner: its points are the window's.
      menu.popup({ window: deps.window, x: Math.round(x), y: Math.round(y) });
    },
    sidebarTabEntries,
    runForSidebarTab,
  };

  function sidebarTabEntries(tabId: TabId): TabMenuEntry[] {
    const tabs = deps.tabs();
    const tab = tabs.get(tabId);
    return buildTabMenu({
      pinned: tab.pinned,
      hasPage: tab.url !== '',
      otherUnpinnedTabs: tabs.tabs().filter((other) => other.id !== tabId && !other.pinned).length,
      canReopenClosed: tabs.canReopenClosed(),
    });
  }

  /**
   * The menu was opened from the sidebar, so keyboard focus stays there (`focus: false`): a
   * keyboard user keeps working in the tab list.
   */
  function runForSidebarTab(tabId: TabId, id: TabMenuItemId): void {
    const tabs = deps.tabs();
    if (!tabs.has(tabId)) {
      return;
    }
    switch (id) {
      case 'new-tab-below':
        tabs.create({ afterTabId: tabId });
        return;
      case 'reload':
        tabs.reload(tabId);
        return;
      case 'duplicate':
        tabs.duplicate(tabId);
        return;
      case 'pin':
        tabs.setPinned(tabId, true);
        return;
      case 'unpin':
        tabs.setPinned(tabId, false);
        return;
      case 'close':
        tabs.close(tabId, { focus: false });
        return;
      case 'close-others':
        // Pinned tabs stay, as in Chrome: pinning is how the user says "keep this one".
        for (const other of tabs.tabs()) {
          if (other.id !== tabId && !other.pinned) {
            tabs.close(other.id, { focus: false });
          }
        }
        tabs.select(tabId, { focus: false });
        return;
      case 'reopen-closed':
        tabs.reopenClosed();
        return;
    }
  }
}
