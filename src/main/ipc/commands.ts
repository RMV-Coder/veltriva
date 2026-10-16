// Command implementations. Each one receives input that already passed its strict schema; tab ids
// are checked here, and an unknown one answers `not_found`.
import { app } from 'electron';

import { PRODUCT_NAME } from '../../shared/constants/app-identity';
import type { ExternalProtocolGuard } from '../external/protocol-guard';
import type { FocusManager } from '../focus/focus-manager';
import type { ContextMenus } from '../menus/context-menu';
import { submitAddress } from '../navigation/submit';
import type { BlockedPopups } from '../popups/blocked-popups';
import type { PromptManager } from '../prompts/prompt-manager';
import type { TabId, TabManager } from '../tabs/tab-manager';
import type { WorkspaceProjector } from '../tabs/workspace-projector';
import type { FullscreenController } from '../windows/fullscreen';
import type { LayoutManager } from '../windows/layout-manager';
import { isNavigationAllowed } from '../web/navigation-policy';
import { CommandError } from './command-error';
import type { CommandHandlers } from './router';

export interface CommandContext {
  readonly tabs: TabManager;
  readonly layout: LayoutManager;
  readonly projector: WorkspaceProjector;
  readonly focus: FocusManager;
  readonly fullscreen: FullscreenController;
  readonly contextMenus: ContextMenus;
  readonly prompts: PromptManager;
  readonly blockedPopups: BlockedPopups;
  readonly external: ExternalProtocolGuard;
  readonly searchTemplate: () => string;
}

export function createCommandHandlers({
  tabs,
  layout,
  projector,
  focus,
  fullscreen,
  contextMenus,
  prompts,
  blockedPopups,
  external,
  searchTemplate,
}: CommandContext): CommandHandlers {
  /** Runs `action` on an existing tab, or answers `not_found`. */
  const onTab = <T>(tabId: TabId, action: () => T): T => {
    if (!tabs.has(tabId)) {
      throw new CommandError('not_found');
    }
    return action();
  };
  const done = {} as const;

  return {
    'app.getInfo': () => ({
      productName: PRODUCT_NAME,
      version: app.getVersion(),
      versions: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
      },
    }),
    'workspace.getSnapshot': () => projector.snapshot(),

    'tabs.create': () => ({ tabId: tabs.create() }),
    'tabs.close': ({ tabId, keepFocus }) =>
      onTab(tabId, () => {
        tabs.close(tabId, { focus: keepFocus !== true });
        return done;
      }),
    'tabs.select': ({ tabId, keepFocus }) =>
      onTab(tabId, () => {
        tabs.select(tabId, { focus: keepFocus !== true });
        return done;
      }),
    'tabs.move': ({ tabId, toIndex }) =>
      onTab(tabId, () => {
        tabs.move(tabId, toIndex);
        return done;
      }),
    'tabs.setPinned': ({ tabId, pinned }) =>
      onTab(tabId, () => {
        tabs.setPinned(tabId, pinned);
        return done;
      }),
    'tabs.duplicate': ({ tabId }) => onTab(tabId, () => ({ tabId: tabs.duplicate(tabId) })),
    'tabs.zoom': ({ tabId, direction }) =>
      onTab(tabId, () => {
        tabs.zoom(tabId, direction);
        return done;
      }),
    'tabs.showMenu': ({ tabId, x, y }) =>
      onTab(tabId, () => {
        contextMenus.forSidebarTab(tabId, x, y);
        return done;
      }),

    'navigation.submit': ({ tabId, text }) =>
      onTab(tabId, () => ({
        action: submitAddress(tabs, tabId, text, searchTemplate(), (url) => {
          void external.request({ tabId, url, pageUrl: null, gesture: true });
        }),
      })),
    'navigation.back': ({ tabId }) =>
      onTab(tabId, () => {
        tabs.goBack(tabId);
        return done;
      }),
    'navigation.forward': ({ tabId }) =>
      onTab(tabId, () => {
        tabs.goForward(tabId);
        return done;
      }),
    'navigation.reload': ({ tabId }) =>
      onTab(tabId, () => {
        tabs.reload(tabId);
        return done;
      }),
    'navigation.stop': ({ tabId }) =>
      onTab(tabId, () => {
        tabs.stop(tabId);
        return done;
      }),

    'find.update': ({ tabId, text }) =>
      onTab(tabId, () => {
        tabs.updateFind(tabId, text);
        return done;
      }),
    'find.next': ({ tabId, forward }) =>
      onTab(tabId, () => {
        tabs.findNext(tabId, forward);
        return done;
      }),
    'find.close': ({ tabId }) =>
      onTab(tabId, () => {
        tabs.closeFind(tabId);
        if (tabs.selectedTabId() === tabId) {
          focus.focusSelected();
        }
        return done;
      }),

    'fullscreen.noticeShown': () => {
      fullscreen.noticeShown();
      return done;
    },
    'fullscreen.dismissNotice': () => {
      fullscreen.dismissNotice();
      return done;
    },

    'prompts.respond': ({ tabId, promptId, decision, remember, keepFocus }) =>
      onTab(tabId, () => {
        // A stale id, or a yes that came too soon after the question appeared, is ignored.
        const answered = prompts.respond(tabId, promptId, { decision, remember });
        // After a click, the keyboard goes back to the page, as after closing the find bar.
        if (answered && keepFocus !== true && tabs.selectedTabId() === tabId) {
          focus.focusSelected();
        }
        return done;
      }),
    'popups.openBlocked': ({ tabId }) =>
      onTab(tabId, () => {
        const url = blockedPopups.take(tabId);
        // Checked when it was blocked; checked again, as for every tab navigation main starts.
        if (url !== null && isNavigationAllowed('tab', { url, isMainFrame: true })) {
          const id = tabs.create({ afterTabId: tabId, select: true });
          tabs.navigate(id, url);
        }
        return done;
      }),
    'popups.dismissBlocked': ({ tabId, keepFocus }) =>
      onTab(tabId, () => {
        blockedPopups.clear(tabId);
        if (keepFocus !== true && tabs.selectedTabId() === tabId) {
          focus.focusSelected();
        }
        return done;
      }),

    'layout.setInsets': (insets) => {
      layout.setInsets(insets);
      return done;
    },
  };
}
