// Typed access to the test hooks that `--mode test` builds compile in (src/main/testing/
// test-hooks.ts), and the helper that turns a test tab into a Playwright Page.
//
// `electronApp.evaluate` serializes its function and runs it in the main process. There, `require`
// is not defined and the `electron` module is the first parameter. The function can't use anything
// from this file, so each one reads `globalThis.__veltrivaTest` itself.
import { setTimeout as delay } from 'node:timers/promises';

import type { CDPSession, ElectronApplication, Page } from '@playwright/test';

import type { Rect } from '../../src/core/layout/rect';
import type { TabId } from '../../src/main/tabs/tab-manager';
import type {
  TabStateEntry,
  VeltrivaTestHooks,
  WebContentsRoleEntry,
} from '../../src/main/testing/test-hooks';
import { expect } from './expect';
import { isShellUrl } from './launch';

export type { TabId, TabStateEntry, WebContentsRoleEntry };

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

// ── M1.3a: tabs ─────────────────────────────────────────────────────────────────────────────────

/** TabManager's view of every tab in strip order, with its web contents details (`tabStates`). */
export function tabStates(app: ElectronApplication): Promise<TabStateEntry[]> {
  return app.evaluate(() => {
    const hooks = globalThis.__veltrivaTest;
    if (hooks === undefined) {
      throw new Error('The test hooks are missing: this is not a test build.');
    }
    return hooks.tabStates();
  });
}

/** The state of one tab, or undefined if there is no such tab (any more). */
export async function tabState(
  app: ElectronApplication,
  tabId: TabId,
): Promise<TabStateEntry | undefined> {
  return (await tabStates(app)).find((tab) => tab.id === tabId);
}

/** The id of the selected tab, as TabManager has it. */
export function selectedTabId(app: ElectronApplication): Promise<TabId | null> {
  return app.evaluate(() => {
    const hooks = globalThis.__veltrivaTest;
    if (hooks === undefined) {
      throw new Error('The test hooks are missing: this is not a test build.');
    }
    return hooks.selectedTabId();
  });
}

/** The rectangle the selected tab's view fills, as the LayoutManager computes it. */
export function contentRect(app: ElectronApplication): Promise<Rect> {
  return app.evaluate(() => {
    const hooks = globalThis.__veltrivaTest;
    if (hooks === undefined) {
      throw new Error('The test hooks are missing: this is not a test build.');
    }
    return hooks.contentRect();
  });
}

/** Crashes a tab's renderer process (`forcefullyCrashRenderer`). */
export async function crashTab(app: ElectronApplication, tabId: TabId): Promise<void> {
  await app.evaluate((_electron, id) => {
    const hooks = globalThis.__veltrivaTest;
    if (hooks === undefined) {
      throw new Error('The test hooks are missing: this is not a test build.');
    }
    hooks.crashTab(id);
  }, tabId);
}

/**
 * Points the omnibox's searches at a template such as `http://127.0.0.1:<port>/search?q={searchTerms}`.
 * Call it first in every test that types into an address bar: the default is a real search
 * engine, and a test must never reach the internet.
 */
export async function setSearchTemplate(app: ElectronApplication, template: string): Promise<void> {
  await app.evaluate((_electron, value) => {
    const hooks = globalThis.__veltrivaTest;
    if (hooks === undefined) {
      throw new Error('The test hooks are missing: this is not a test build.');
    }
    hooks.setSearchTemplate(value);
  }, template);
}

/** Target ids never change for a Page, so each is looked up once. */
const targetIds = new WeakMap<Page, string>();

/** The page's DevTools target id, from a short-lived CDP session (S6). Undefined if it is gone. */
async function targetIdOf(page: Page): Promise<string | undefined> {
  const known = targetIds.get(page);
  if (known !== undefined) {
    return known;
  }
  let session: CDPSession | undefined;
  try {
    session = await page.context().newCDPSession(page);
    const { targetInfo } = await session.send('Target.getTargetInfo');
    targetIds.set(page, targetInfo.targetId);
    return targetInfo.targetId;
  } catch {
    // The page closed while we looked, or has not finished attaching. The caller tries again.
    return undefined;
  } finally {
    await session?.detach().catch(() => undefined);
  }
}

/**
 * The Playwright Page of a tab's web view (spike S6, launch.ts rule 5). It matches the tab's
 * DevTools target id (`getOrCreateDevToolsTargetId()`, returned by `tabStates`) against
 * `Target.getTargetInfo` from a CDP session on each page, so it never relies on page order or on
 * a URL. A view becomes a Page only after its first navigation, so this polls until it exists.
 * Never `page.close()` the result; act on it (click, screenshot) only while the tab is attached.
 */
export async function pageForTab(
  app: ElectronApplication,
  tabId: TabId,
  timeoutMs = TAB_TIMEOUT_MS,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const entry = await tabState(app, tabId);
    if (entry === undefined) {
      throw new Error(`Tab ${tabId} does not exist.`);
    }
    if (entry.devToolsTargetId !== null) {
      for (const page of app.windows()) {
        if (page.isClosed() || isShellUrl(page.url())) {
          continue;
        }
        if ((await targetIdOf(page)) === entry.devToolsTargetId) {
          return page;
        }
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `No Page appeared for tab ${tabId} within ${String(timeoutMs)} ms ` +
          `(DevTools target ${entry.devToolsTargetId ?? 'none: the tab has no web view'}).`,
      );
    }
    await delay(POLL_INTERVAL_MS);
  }
}

/** One `will-frame-navigate` event, as the main process saw it. */
export interface NavigationRecord {
  readonly url: string;
  readonly isMainFrame: boolean;
  /** True if an earlier listener (the guard's) had already called `preventDefault()`. */
  readonly cancelled: boolean;
}

/**
 * Records every `will-frame-navigate` of a web contents. The guard's handler is registered first
 * (when the contents is created), so `defaultPrevented` tells whether it cancelled the navigation.
 * The returned handle points at an array in main that keeps growing; `snapshot()` copies it.
 */
export async function recordNavigations(app: ElectronApplication, webContentsId: number) {
  const handle = await app.evaluateHandle(({ webContents }, id) => {
    const records: NavigationRecord[] = [];
    webContents.fromId(id)?.on('will-frame-navigate', (event) => {
      records.push({
        url: event.url,
        isMainFrame: event.isMainFrame,
        cancelled: event.defaultPrevented,
      });
    });
    return records;
  }, webContentsId);
  return {
    snapshot: (): Promise<NavigationRecord[]> => handle.jsonValue(),
    /** Resolves once at least `count` navigations have been recorded. */
    async untilCount(count: number): Promise<NavigationRecord[]> {
      await expect
        .poll(async () => (await handle.jsonValue()).length, {
          message: `waiting for ${String(count)} recorded navigations`,
        })
        .toBeGreaterThanOrEqual(count);
      return handle.jsonValue();
    },
  };
}

/**
 * Collects a web contents' console messages (as `level: text`). Chromium reports the navigations it
 * refuses itself (a top-level `data:` URL, an opaque-origin `blob:`) only there: they never reach
 * Electron's `will-frame-navigate`, so the guard's own rule is not what stops them.
 */
export async function watchConsole(app: ElectronApplication, webContentsId: number) {
  const handle = await app.evaluateHandle(({ webContents }, id) => {
    const messages: string[] = [];
    webContents.fromId(id)?.on('console-message', (event) => {
      messages.push(`${event.level}: ${event.message}`);
    });
    return messages;
  }, webContentsId);
  return { messages: (): Promise<string[]> => handle.jsonValue() };
}

/**
 * Runs `code` in a tab's page from the main process (`webContents.executeJavaScript`) and returns
 * its JSON-friendly result. For pages Playwright can no longer reach: after a renderer crash the
 * tab's Page object stays marked as crashed, even once the page is back.
 */
export function evaluateInTab(
  app: ElectronApplication,
  webContentsId: number,
  code: string,
): Promise<unknown> {
  return app.evaluate(
    async ({ webContents }, { id, source }) =>
      (await webContents.fromId(id)?.executeJavaScript(source)) as unknown,
    { id: webContentsId, source: code },
  );
}
