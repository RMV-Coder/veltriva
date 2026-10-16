// Typed access to the test hooks that `--mode test` builds compile in (src/main/testing/
// test-hooks.ts), and the helper that turns a test tab into a Playwright Page.
//
// `electronApp.evaluate` serializes its function and runs it in the main process. There, `require`
// is not defined and the `electron` module is the first parameter. The function can't use anything
// from this file, so each one reads `globalThis.__veltrivaTest` itself.
import { setTimeout as delay } from 'node:timers/promises';

import type { ElectronApplication, Page } from '@playwright/test';

import type { VeltrivaTestHooks, WebContentsRoleEntry } from '../../src/main/testing/test-hooks';

export type { WebContentsRoleEntry };

type OpenTestTabOptions = Parameters<VeltrivaTestHooks['openTestTab']>[0];

const TAB_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 100;

/** `openTestTab`: a tab-role view over the right half of the window, loading `url`. */
export function openTestTabInMain(
  app: ElectronApplication,
  options: OpenTestTabOptions,
): Promise<{ webContentsId: number }> {
  return app.evaluate((_electron, tabOptions) => {
    const hooks = globalThis.__veltrivaTest;
    if (hooks === undefined) {
      throw new Error('The test hooks are missing: this is not a test build.');
    }
    return hooks.openTestTab(tabOptions);
  }, options);
}

/** Detaches and closes every test tab. */
export async function closeTestTabsInMain(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const hooks = globalThis.__veltrivaTest;
    if (hooks === undefined) {
      throw new Error('The test hooks are missing: this is not a test build.');
    }
    hooks.closeTestTabs();
  });
}

/** Every live web contents with the role the guard gave it. */
export function webContentsRoles(app: ElectronApplication): Promise<WebContentsRoleEntry[]> {
  return app.evaluate(() => {
    const hooks = globalThis.__veltrivaTest;
    if (hooks === undefined) {
      throw new Error('The test hooks are missing: this is not a test build.');
    }
    return hooks.webContentsRoles();
  });
}

/** The URL of a web contents, read in main, so a pending navigation in a Page can't skew it. */
export function urlInMain(app: ElectronApplication, webContentsId: number): Promise<string | null> {
  return app.evaluate(
    ({ webContents }, id) => webContents.fromId(id)?.getURL() ?? null,
    webContentsId,
  );
}

/** The URLs of the main frame and of every frame below it, read in main. */
export function frameUrlsInMain(
  app: ElectronApplication,
  webContentsId: number,
): Promise<string[]> {
  return app.evaluate(
    ({ webContents }, id) =>
      webContents.fromId(id)?.mainFrame.framesInSubtree.map((frame) => frame.url) ?? [],
    webContentsId,
  );
}

export interface FrameInfo {
  readonly url: string;
  /** The URL of the parent frame; null for the main frame. */
  readonly parentUrl: string | null;
}

/** The main frame and every frame below it, with each one's parent, read in main. */
export function frameTreeInMain(
  app: ElectronApplication,
  webContentsId: number,
): Promise<FrameInfo[]> {
  return app.evaluate(
    ({ webContents }, id) =>
      webContents.fromId(id)?.mainFrame.framesInSubtree.map((frame) => ({
        url: frame.url,
        parentUrl: frame.parent?.url ?? null,
      })) ?? [],
    webContentsId,
  );
}

export interface TestTab {
  /** The tab as a Playwright Page. Never call `page.close()` on it. */
  readonly page: Page;
  readonly webContentsId: number;
}

/**
 * Opens a tab-role view on `url` and returns it as a Page (ADR-0008 §4, spike S6):
 *  - `waitForEvent('window')` is registered before the tab opens, because a view becomes a Page
 *    only after its first navigation and the event is not replayed;
 *  - the Page is confirmed by its URL, never taken on faith;
 *  - nothing here closes the tab. The `openTab` fixture calls `closeTestTabsInMain` at teardown.
 * Open one tab per URL: the URL is how a tab is told apart from the shell and from other tabs.
 */
export async function openTab(
  app: ElectronApplication,
  url: string,
  options: { readonly preload?: string } = {},
): Promise<TestTab> {
  const appeared = app.waitForEvent('window', { timeout: TAB_TIMEOUT_MS });
  // If opening fails first, nobody awaits `appeared`. Keep its timeout from becoming an
  // unhandled rejection; the `await` below still sees it.
  appeared.catch(() => undefined);

  const { webContentsId } = await openTestTabInMain(
    app,
    options.preload === undefined ? { url } : { url, preload: options.preload },
  );
  const page = await appeared;

  await waitForPageUrl(page, url);
  return { page, webContentsId };
}

async function waitForPageUrl(page: Page, expected: string): Promise<void> {
  const wanted = new URL(expected).href;
  const deadline = Date.now() + TAB_TIMEOUT_MS;
  for (;;) {
    if (!page.isClosed() && sameUrl(page.url(), wanted)) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `The page for the test tab did not show ${wanted} within ${String(TAB_TIMEOUT_MS)} ms; ` +
          `it shows ${page.url() || '(nothing)'}.`,
      );
    }
    await delay(POLL_INTERVAL_MS);
  }
}

function sameUrl(actual: string, wantedHref: string): boolean {
  try {
    return new URL(actual).href === wantedHref;
  } catch {
    return false;
  }
}
