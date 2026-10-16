// E2E test hooks (ADR-0008 §4). Compiled into `--mode test` builds only: src/main/index.ts calls
// `installTestHooks` behind `import.meta.env.MODE === 'test'`, which production builds fold to
// `false` and drop, and `npm run package:dir` refuses a build that still contains the marker.
// Tests reach the hooks with `electronApp.evaluate(() => globalThis.__veltrivaTest...)`.
import { webContents } from 'electron';
import type { WebContentsView } from 'electron';

import type { Rect } from '../../core/layout/rect';
import { setSearchTemplate } from '../navigation/search-engine';
import type { TabId, TabManager, TabState } from '../tabs/tab-manager';
import { createViewWithRole, roleOf } from '../web/roles';
import type { WebContentsRole } from '../web/web-contents-role';
import { TAB_WEB_PREFERENCES } from '../web/web-preferences';
import type { LayoutManager } from '../windows/layout-manager';
import type { MainWindow } from '../windows/main-window';

export const TEST_HOOKS_MARKER = '__veltrivaTest';

export interface WebContentsRoleEntry {
  readonly webContentsId: number;
  readonly role: WebContentsRole | 'none';
  readonly url: string;
}

export interface TabStateEntry extends TabState {
  /** The tab's web contents, if it has one. */
  readonly webContentsId: number | null;
  /** Its DevTools target id, for matching a Playwright Page (S6: `pageForTab`). */
  readonly devToolsTargetId: string | null;
  /** Whether its view is attached to the window right now. */
  readonly attached: boolean;
  /** Its view's bounds, if it has one. */
  readonly bounds: Rect | null;
}

export interface VeltrivaTestHooks {
  /**
   * Opens a tab-role view outside TabManager, over the right half of the window, and loads
   * `url`. `preload` exists for one test only: it gives a non-shell page an IPC channel so the
   * test can prove IpcRouter rejects it. Real tabs never have a preload.
   */
  openTestTab(options: { url: string; preload?: string }): Promise<{ webContentsId: number }>;
  /** Detaches and closes every test tab opened with `openTestTab`. */
  closeTestTabs(): void;
  /** Every live web contents and the role the guard gave it. */
  webContentsRoles(): WebContentsRoleEntry[];
  /** TabManager's view of every tab, in strip order, plus its web contents details. */
  tabStates(): TabStateEntry[];
  selectedTabId(): TabId | null;
  /** The content area the selected tab fills. */
  contentRect(): Rect;
  /** Crashes a tab's renderer (`forcefullyCrashRenderer`). */
  crashTab(tabId: TabId): void;
  /** Points the omnibox's searches at a template, e.g. a local fixture. */
  setSearchTemplate(template: string): void;
}

declare global {
  var __veltrivaTest: VeltrivaTestHooks | undefined;
}

export interface TestHookContext {
  readonly main: MainWindow;
  readonly tabs: TabManager;
  readonly layout: LayoutManager;
  readonly views: ReadonlyMap<TabId, WebContentsView>;
}

export function installTestHooks({ main, tabs, layout, views }: TestHookContext): void {
  const testTabs = new Set<WebContentsView>();

  const hooks: VeltrivaTestHooks = {
    async openTestTab({ url, preload }) {
      const view = createViewWithRole('tab', {
        webPreferences:
          preload === undefined ? { ...TAB_WEB_PREFERENCES } : { ...TAB_WEB_PREFERENCES, preload },
      });
      testTabs.add(view);
      main.window.contentView.addChildView(view);
      const { width, height } = main.window.getContentBounds();
      const half = Math.floor(width / 2);
      view.setBounds({ x: half, y: 0, width: width - half, height });
      await view.webContents.loadURL(url);
      return { webContentsId: view.webContents.id };
    },

    closeTestTabs() {
      for (const view of testTabs) {
        main.window.contentView.removeChildView(view);
        view.webContents.close();
      }
      testTabs.clear();
    },

    webContentsRoles() {
      return webContents.getAllWebContents().map((contents) => ({
        webContentsId: contents.id,
        role: roleOf(contents) ?? 'none',
        url: contents.getURL(),
      }));
    },

    tabStates() {
      const attached = new Set(main.window.contentView.children);
      return tabs.tabs().map((tab) => {
        const view = views.get(tab.id);
        return {
          ...tab,
          webContentsId: view?.webContents.id ?? null,
          devToolsTargetId: view?.webContents.getOrCreateDevToolsTargetId() ?? null,
          attached: view !== undefined && attached.has(view),
          bounds: view?.getBounds() ?? null,
        };
      });
    },

    selectedTabId() {
      return tabs.selectedTabId();
    },

    contentRect() {
      return layout.contentRect();
    },

    crashTab(tabId) {
      const view = views.get(tabId);
      if (view === undefined) {
        throw new Error(`Tab ${tabId} has no web contents to crash`);
      }
      view.webContents.forcefullyCrashRenderer();
    },

    setSearchTemplate(template) {
      setSearchTemplate(template);
    },
  };

  globalThis.__veltrivaTest = Object.freeze(hooks);
}
