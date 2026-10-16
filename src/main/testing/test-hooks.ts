// E2E test hooks (ADR-0008 §4). Compiled into `--mode test` builds only: src/main/index.ts calls
// `installTestHooks` behind `import.meta.env.MODE === 'test'`, which production builds fold to
// `false` and drop, and `npm run package:dir` refuses a build that still contains the marker.
// Tests reach the hooks with `electronApp.evaluate(() => globalThis.__veltrivaTest...)`.
import { webContents } from 'electron';
import type { WebContentsView } from 'electron';

import { roleOf, createViewWithRole } from '../web/roles';
import type { WebContentsRole } from '../web/web-contents-role';
import { TAB_WEB_PREFERENCES } from '../web/web-preferences';
import type { MainWindow } from '../windows/main-window';

export const TEST_HOOKS_MARKER = '__veltrivaTest';

export interface WebContentsRoleEntry {
  readonly webContentsId: number;
  readonly role: WebContentsRole | 'none';
  readonly url: string;
}

export interface VeltrivaTestHooks {
  /**
   * Opens a tab-role view (tab webPreferences, `persist:browsing`) over the right half of the
   * window and loads `url`. Real tabs arrive in M1.3. `preload` exists for one test only: it
   * gives a non-shell page an IPC channel so the test can prove IpcRouter rejects it. Tabs
   * never have a preload outside tests.
   */
  openTestTab(options: { url: string; preload?: string }): Promise<{ webContentsId: number }>;
  /** Detaches and closes every test tab. */
  closeTestTabs(): void;
  /** Every live web contents and the role the guard gave it. */
  webContentsRoles(): WebContentsRoleEntry[];
}

declare global {
  var __veltrivaTest: VeltrivaTestHooks | undefined;
}

export function installTestHooks(getMainWindow: () => MainWindow): void {
  const testTabs = new Set<WebContentsView>();

  const hooks: VeltrivaTestHooks = {
    async openTestTab({ url, preload }) {
      const { window } = getMainWindow();
      const view = createViewWithRole('tab', {
        webPreferences:
          preload === undefined ? { ...TAB_WEB_PREFERENCES } : { ...TAB_WEB_PREFERENCES, preload },
      });
      testTabs.add(view);
      window.contentView.addChildView(view);
      const { width, height } = window.getContentBounds();
      const half = Math.floor(width / 2);
      view.setBounds({ x: half, y: 0, width: width - half, height });
      await view.webContents.loadURL(url);
      return { webContentsId: view.webContents.id };
    },

    closeTestTabs() {
      const { window } = getMainWindow();
      for (const view of testTabs) {
        window.contentView.removeChildView(view);
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
  };

  globalThis.__veltrivaTest = Object.freeze(hooks);
}
