// Command implementations. Each one receives input that already passed its strict schema; tab ids
// are checked here, and an unknown one answers `not_found`.
import { app } from 'electron';

import { PRODUCT_NAME } from '../../shared/constants/app-identity';
import type { ActivityEntry } from '../../shared/contracts/activity';
import type { CommandOutput } from '../../shared/contracts/schemas';
import type { DownloadManager } from '../downloads/download-manager';
import type { ExternalProtocolGuard } from '../external/protocol-guard';
import type { FocusManager } from '../focus/focus-manager';
import type { PlacementActions } from '../lifecycle/placement-actions';
import type { MemoryCommands } from '../memory/memory-commands';
import type { ContextMenus } from '../menus/context-menu';
import { submitAddress } from '../navigation/submit';
import type { AppNotices } from '../notices/app-notices';
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
  readonly downloads: DownloadManager;
  readonly notices: AppNotices;
  readonly searchTemplate: () => string;
  /** The user's moves to Sleeping and the Archive, with Undo (M3.3). */
  readonly placement: PlacementActions;
  /** Undo and the activity log (M3.3). */
  readonly lifecycle: LifecycleCommands;
  /** Searching the memory, opening results, the Archive list (M4.2). */
  readonly memory: MemoryCommands;
}

export interface LifecycleCommands {
  /** Undoes the offered batch; how many tabs went back (0 when it is no longer offered). */
  undo(batchId: string): number;
  dismissUndo(batchId: string): void;
  /** The activity log, newest first. */
  activity(): ActivityEntry[];
  /** "Pause automation" (M3.4), saved in the settings. */
  setPaused(paused: boolean): void;
  /** Ends preview mode early (M3.4). */
  endPreview(): void;
  /** Protects a tab's site, or stops; the site, or null when the tab's page has none. */
  setSiteProtected(tabId: TabId, on: boolean): string | null;
  /** What the local diagnostics page shows (M3.4). */
  diagnostics(): CommandOutput<'lifecycle.diagnostics'>;
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
  downloads,
  notices,
  searchTemplate,
  placement,
  lifecycle,
  memory,
}: CommandContext): CommandHandlers {
  /** Runs `action` on an existing tab, or answers `not_found`. */
  const onTab = <T>(tabId: TabId, action: () => T): T => {
    if (!tabs.has(tabId)) {
      throw new CommandError('not_found');
    }
    return action();
  };
  const done = {} as const;
  /** Runs `action` on a download main knows, or answers `not_found`. */
  const onDownload = (downloadId: string, action: () => unknown): typeof done => {
    if (!downloads.has(downloadId)) {
      throw new CommandError('not_found');
    }
    const result = action();
    if (result instanceof Promise) {
      result.catch(() => undefined);
    }
    return done;
  };

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
        // A page the user worked in may object: then "Leave page?" asks (M3.3).
        tabs.requestClose(tabId, { focus: keepFocus !== true });
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
    'prompts.signIn': ({ tabId, promptId, username, password, keepFocus }) =>
      onTab(tabId, () => {
        // Only to the sign-in question shown; handed to Chromium once, never kept.
        const shown = prompts.current(tabId);
        if (shown?.id === promptId && shown.kind === 'http-auth') {
          const answered = prompts.respond(tabId, promptId, {
            decision: 'allow',
            remember: false,
            credentials: { username, password },
          });
          if (answered && keepFocus !== true && tabs.selectedTabId() === tabId) {
            focus.focusSelected();
          }
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

    'downloads.pause': ({ downloadId }) =>
      onDownload(downloadId, () => {
        downloads.pause(downloadId);
      }),
    'downloads.resume': ({ downloadId }) =>
      onDownload(downloadId, () => {
        downloads.resume(downloadId);
      }),
    'downloads.cancel': ({ downloadId }) =>
      onDownload(downloadId, () => {
        downloads.cancel(downloadId);
      }),
    'downloads.open': ({ downloadId }) => onDownload(downloadId, () => downloads.open(downloadId)),
    'downloads.showInFolder': ({ downloadId }) =>
      onDownload(downloadId, () => {
        downloads.showInFolder(downloadId);
      }),
    'downloads.keep': ({ downloadId }) => onDownload(downloadId, () => downloads.keep(downloadId)),
    'downloads.discard': ({ downloadId }) =>
      onDownload(downloadId, () => downloads.discard(downloadId)),
    'downloads.clear': ({ downloadId }) =>
      onDownload(downloadId, () => {
        downloads.clear(downloadId);
      }),

    'notices.dismiss': ({ noticeId }) => {
      // An id main doesn't show: already dismissed, perhaps from another click.
      if (!notices.dismiss(noticeId)) {
        throw new CommandError('not_found');
      }
      return done;
    },

    // M3.3: Sleeping, the Archive, protection, Undo and the activity log.
    'tabs.shelve': ({ tabId }) => onTab(tabId, () => ({ moved: placement.shelve(tabId) })),
    'tabs.archive': async ({ tabId }) => {
      if (!tabs.has(tabId)) {
        throw new CommandError('not_found');
      }
      return { moved: await placement.archive(tabId) };
    },
    'tabs.restore': async ({ tabId, keepFocus }) => {
      // A tab in the strip or Sleeping, or one in the Archive (not a live tab: `has` is false),
      // even one only the database still holds (M4.2: the Archive list reaches them all).
      const restored = await memory.restore(tabId, { focus: keepFocus !== true });
      if (restored === null) {
        throw new CommandError('not_found');
      }
      return { tabId: restored };
    },
    'tabs.setProtected': ({ tabId, protected: on }) =>
      onTab(tabId, () => {
        placement.setProtected(tabId, on);
        return done;
      }),
    'lifecycle.undo': ({ batchId }) => ({ undone: lifecycle.undo(batchId) }),
    'lifecycle.dismissUndo': ({ batchId }) => {
      lifecycle.dismissUndo(batchId);
      return done;
    },
    'lifecycle.activity': () => ({ entries: lifecycle.activity() }),
    // M3.4: Pause, preview, protected sites and the diagnostics page.
    'lifecycle.setPaused': ({ paused }) => {
      lifecycle.setPaused(paused);
      return done;
    },
    'lifecycle.endPreview': () => {
      lifecycle.endPreview();
      return done;
    },
    'tabs.setSiteProtected': ({ tabId, protected: on }) =>
      onTab(tabId, () => {
        const site = lifecycle.setSiteProtected(tabId, on);
        if (site === null) {
          throw new CommandError('not_found');
        }
        return { site };
      }),
    'lifecycle.diagnostics': () => lifecycle.diagnostics(),

    'memory.search': (input) => memory.search(input),
    'memory.open': async (input) => ({ tabId: await memory.open(input) }),
    // ADR-0006 A′: the shell painted its overlay on a transparent page; raise it and give it the
    // keyboard. Hiding lowers it once nothing else wants it raised.
    'overlay.show': ({ overlay }) => {
      layout.raiseShell(overlay);
      focus.focusShell();
      return done;
    },
    'overlay.hide': ({ overlay, focusPage }) => {
      layout.lowerShell(overlay);
      if (focusPage) {
        focus.focusSelected();
      }
      return done;
    },
    'archive.list': (input) => memory.archiveList(input),

    'layout.setInsets': (insets) => {
      layout.setInsets(insets);
      return done;
    },
  };
}
