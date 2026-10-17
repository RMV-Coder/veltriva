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
 *
 * `userGesture: true` is `executeJavaScript(code, true)`: Chromium gets a user activation (so
 * `requestFullscreen()` and `window.open` are allowed by the page's own rules), but main's
 * `input-event` sees no input, so the gesture rule of M1.4a sees no gesture. That is how a spec
 * tests "no gesture". For a real one use `clickElement` or `clickInPage`.
 */
export function evaluateInTab(
  app: ElectronApplication,
  webContentsId: number,
  code: string,
  options: { readonly userGesture?: boolean } = {},
): Promise<unknown> {
  return app.evaluate(
    async ({ webContents }, { id, source, gesture }) =>
      (await webContents.fromId(id)?.executeJavaScript(source, gesture)) as unknown,
    { id: webContentsId, source: code, gesture: options.userGesture === true },
  );
}

// ── M1.3b: keys, focus, windows, menus ──────────────────────────────────────────────────────────

/** The modifiers `webContents.sendInputEvent` takes for a keyboard event. */
export type KeyModifier = 'shift' | 'control' | 'alt' | 'meta';

/**
 * Who receives a key from `sendKey`: a web contents by id (a tab's `webContentsId`), the shell,
 * or whichever web contents has the keyboard right now (what a real keystroke reaches).
 */
export type KeyTarget = number | 'shell' | 'focused';

/** The shell page's URL prefix, matched in main where this file's imports don't exist. */
const SHELL_URL_PREFIX = 'app://shell/';

/**
 * Sends a key press (keyDown, then keyUp) to a web contents from main, with
 * `webContents.sendInputEvent` (ADR-0008 4, "Rules found while writing M1.3b"). Playwright's
 * keyboard goes through CDP, which skips `before-input-event`, so a browser shortcut sent that way
 * never reaches main. `keyCode` is an Electron key name: 'F', 'Tab', 'F5', 'Left', '=', 'Escape'.
 *
 * Unless the target is 'focused', the web contents is focused first, as the user's keystroke goes
 * to the one that has the keyboard. A printable key without Ctrl, Alt or Meta also sends the
 * `char` event between the two, so it types text; a shortcut (Ctrl held) carries only a control
 * code in a real keystroke, so it sends none.
 */
export async function sendKey(
  app: ElectronApplication,
  target: KeyTarget,
  keyCode: string,
  modifiers: readonly KeyModifier[] = [],
): Promise<void> {
  await app.evaluate(
    ({ webContents }, { to, key, held, shellPrefix }) => {
      const contents =
        to === 'focused'
          ? webContents.getFocusedWebContents()
          : to === 'shell'
            ? webContents
                .getAllWebContents()
                .find((candidate) => candidate.getURL().startsWith(shellPrefix))
            : webContents.fromId(to);
      if (contents === undefined || contents === null || contents.isDestroyed()) {
        throw new Error(`sendKey: no web contents to send ${key} to (${String(to)})`);
      }
      if (to !== 'focused') {
        contents.focus();
      }
      const typesText = key.length === 1 && held.every((name) => name === 'shift');
      contents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: held });
      if (typesText) {
        contents.sendInputEvent({ type: 'char', keyCode: key, modifiers: held });
      }
      contents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: held });
    },
    { to: target, key: keyCode, held: [...modifiers], shellPrefix: SHELL_URL_PREFIX },
  );
}

/** The web contents that has the keyboard right now. */
export interface FocusedContents {
  readonly webContentsId: number;
  readonly url: string;
  readonly isShell: boolean;
}

/** `webContents.getFocusedWebContents()`, or null when none has the keyboard. */
export function focusedWebContents(app: ElectronApplication): Promise<FocusedContents | null> {
  return app.evaluate(({ webContents }, shellPrefix) => {
    const focused = webContents.getFocusedWebContents();
    if (focused === null || focused.isDestroyed()) {
      return null;
    }
    const url = focused.getURL();
    return { webContentsId: focused.id, url, isShell: url.startsWith(shellPrefix) };
  }, SHELL_URL_PREFIX);
}

/**
 * Gives the keyboard to a web contents the way a mouse click on it would: `webContents.focus()`.
 * Playwright's own clicks and keys go straight to the renderer and do not move it.
 */
export async function focusWebContents(
  app: ElectronApplication,
  target: Exclude<KeyTarget, 'focused'>,
): Promise<void> {
  await app.evaluate(
    ({ webContents }, { to, shellPrefix }) => {
      const contents =
        to === 'shell'
          ? webContents
              .getAllWebContents()
              .find((candidate) => candidate.getURL().startsWith(shellPrefix))
          : webContents.fromId(to);
      if (contents === undefined || contents.isDestroyed()) {
        throw new Error(`focusWebContents: no web contents (${String(to)})`);
      }
      contents.focus();
    },
    { to: target, shellPrefix: SHELL_URL_PREFIX },
  );
}

/** The shell's web contents id (the one at `app://shell/`). */
export function shellContentsId(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ webContents }, shellPrefix) => {
    const shell = webContents
      .getAllWebContents()
      .find((contents) => contents.getURL().startsWith(shellPrefix));
    if (shell === undefined) {
      throw new Error('The shell web contents is missing.');
    }
    return shell.id;
  }, SHELL_URL_PREFIX);
}

export interface WindowInfo {
  readonly fullScreen: boolean;
  /** The window's content area, which the shell fills. */
  readonly contentBounds: Rect;
}

/** The main window as the OS sees it (the only `BaseWindow`). */
export function windowInfo(app: ElectronApplication): Promise<WindowInfo> {
  return app.evaluate(({ BaseWindow }) => {
    const [window] = BaseWindow.getAllWindows();
    if (window === undefined) {
      throw new Error('There is no window.');
    }
    return { fullScreen: window.isFullScreen(), contentBounds: window.getContentBounds() };
  });
}

/** The window's views from bottom to top: 'shell', a tab's id, or 'other' (`viewStack`). */
export function viewStack(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => {
    const hooks = globalThis.__veltrivaTest;
    if (hooks === undefined) {
      throw new Error('The test hooks are missing: this is not a test build.');
    }
    return hooks.viewStack();
  });
}

export type FullscreenInfo = ReturnType<VeltrivaTestHooks['fullscreen']>;

/** HTML fullscreen as main sees it (`fullscreen`). */
export function fullscreenInfo(app: ElectronApplication): Promise<FullscreenInfo> {
  return app.evaluate(() => {
    const hooks = globalThis.__veltrivaTest;
    if (hooks === undefined) {
      throw new Error('The test hooks are missing: this is not a test build.');
    }
    return hooks.fullscreen();
  });
}

/**
 * Asks a page to go fullscreen, with a user gesture: `requestFullscreen()` is refused without one.
 * Resolves when the page's own promise does.
 */
export async function requestPageFullscreen(
  app: ElectronApplication,
  webContentsId: number,
): Promise<void> {
  await app.evaluate(async ({ webContents }, id) => {
    await webContents
      .fromId(id)
      ?.executeJavaScript('document.documentElement.requestFullscreen()', true);
  }, webContentsId);
}

/** Whether a web contents has DevTools open (docked or detached). */
export function isDevToolsOpened(
  app: ElectronApplication,
  webContentsId: number,
): Promise<boolean> {
  return app.evaluate(
    ({ webContents }, id) => webContents.fromId(id)?.isDevToolsOpened() ?? false,
    webContentsId,
  );
}

export type ContextMenuParams = NonNullable<Parameters<VeltrivaTestHooks['contextMenuItems']>[1]>;
export type MenuItemId = Parameters<VeltrivaTestHooks['invokeContextMenuItem']>[2];
export type TabMenuItemId = Parameters<VeltrivaTestHooks['invokeTabMenuItem']>[1];
export type MenuEntry = ReturnType<VeltrivaTestHooks['contextMenuItems']>[number];
export type TabMenuEntry = ReturnType<VeltrivaTestHooks['tabMenuItems']>[number];

/** The entries a right-click with these params would show in the tab (`contextMenuItems`). */
export function contextMenuItems(
  app: ElectronApplication,
  tabId: TabId,
  params: ContextMenuParams = {},
): Promise<MenuEntry[]> {
  return app.evaluate(
    (_electron, { id, given }) => {
      const hooks = globalThis.__veltrivaTest;
      if (hooks === undefined) {
        throw new Error('The test hooks are missing: this is not a test build.');
      }
      return hooks.contextMenuItems(id, given);
    },
    { id: tabId, given: params },
  );
}

/** Runs a page context-menu item as if it had been clicked (`invokeContextMenuItem`). */
export async function invokeContextMenuItem(
  app: ElectronApplication,
  tabId: TabId,
  params: ContextMenuParams,
  itemId: MenuItemId,
): Promise<void> {
  await app.evaluate(
    (_electron, { id, given, item }) => {
      const hooks = globalThis.__veltrivaTest;
      if (hooks === undefined) {
        throw new Error('The test hooks are missing: this is not a test build.');
      }
      hooks.invokeContextMenuItem(id, given, item);
    },
    { id: tabId, given: params, item: itemId },
  );
}

/** The entries of a sidebar tab's menu (`tabMenuItems`). */
export function tabMenuItems(app: ElectronApplication, tabId: TabId): Promise<TabMenuEntry[]> {
  return app.evaluate((_electron, id) => {
    const hooks = globalThis.__veltrivaTest;
    if (hooks === undefined) {
      throw new Error('The test hooks are missing: this is not a test build.');
    }
    return hooks.tabMenuItems(id);
  }, tabId);
}

/** Runs a sidebar tab menu item as if it had been clicked (`invokeTabMenuItem`). */
export async function invokeTabMenuItem(
  app: ElectronApplication,
  tabId: TabId,
  itemId: TabMenuItemId,
): Promise<void> {
  await app.evaluate(
    (_electron, { id, item }) => {
      const hooks = globalThis.__veltrivaTest;
      if (hooks === undefined) {
        throw new Error('The test hooks are missing: this is not a test build.');
      }
      hooks.invokeTabMenuItem(id, item);
    },
    { id: tabId, item: itemId },
  );
}

/**
 * A key held down: one keyDown, then `repeats` more with the auto-repeat flag (what the OS sends
 * while a key stays pressed), then one keyUp. The first event goes to `target` (focused first); the
 * rest go to whichever web contents has the keyboard by then, as the OS's repeats do: a shortcut
 * that closes the tab and moves focus to another one is repeated into that one.
 */
export async function holdKey(
  app: ElectronApplication,
  target: Exclude<KeyTarget, 'focused'>,
  keyCode: string,
  modifiers: readonly KeyModifier[],
  repeats: number,
): Promise<void> {
  await app.evaluate(
    ({ webContents }, { to, key, held, count, shellPrefix }) => {
      const first =
        to === 'shell'
          ? webContents
              .getAllWebContents()
              .find((candidate) => candidate.getURL().startsWith(shellPrefix))
          : webContents.fromId(to);
      if (first === undefined || first.isDestroyed()) {
        throw new Error(`holdKey: no web contents to send ${key} to (${String(to)})`);
      }
      first.focus();
      first.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: held });
      let last = first;
      for (let repeat = 0; repeat < count; repeat += 1) {
        const next = webContents.getFocusedWebContents();
        last = next === null || next.isDestroyed() ? last : next;
        if (last.isDestroyed()) {
          throw new Error(`holdKey: no web contents left to repeat ${key} to`);
        }
        last.sendInputEvent({
          type: 'keyDown',
          keyCode: key,
          modifiers: [...held, 'isautorepeat' as const],
        });
      }
      if (!last.isDestroyed()) {
        last.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: held });
      }
    },
    {
      to: target,
      key: keyCode,
      held: [...modifiers],
      count: repeats,
      shellPrefix: SHELL_URL_PREFIX,
    },
  );
}

/** One `before-input-event` as a later listener saw it. */
export interface InputRecord {
  readonly type: string;
  readonly key: string;
  readonly code: string;
  readonly control: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  /** True if an earlier listener (the app's shortcut handler) had cancelled the event. */
  readonly prevented: boolean;
}

/**
 * Records every `before-input-event` of a web contents after the app's own handler, which is
 * registered first when the contents is created. `prevented` tells whether that handler cancelled
 * the key, and a cancelled key never reaches the page. This is how a spec sees a reserved shortcut
 * that closes the very tab it was sent to. The handle points at an array in main that keeps
 * growing; `all()` copies it.
 */
export async function recordInputs(app: ElectronApplication, webContentsId: number) {
  const handle = await app.evaluateHandle(({ webContents }, id) => {
    const records: InputRecord[] = [];
    webContents.fromId(id)?.on('before-input-event', (event, input) => {
      records.push({
        type: input.type,
        key: input.key,
        code: input.code,
        control: input.control,
        shift: input.shift,
        alt: input.alt,
        prevented: event.defaultPrevented,
      });
    });
    return records;
  }, webContentsId);
  return { all: (): Promise<InputRecord[]> => handle.jsonValue() };
}

// ── M1.4a: gestures, popups, external launches ──────────────────────────────────────────────────

/** Every URL the external-protocol guard launched. Test builds record launches and open nothing. */
export function externalLaunches(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => {
    const hooks = globalThis.__veltrivaTest;
    if (hooks === undefined) {
      throw new Error('The test hooks are missing: this is not a test build.');
    }
    return hooks.externalLaunches();
  });
}

export type PopupWindowEntry = ReturnType<VeltrivaTestHooks['popupWindows']>[number];

/** The open popup windows, with the address bar's text and the layout (`popupWindows`). */
export function popupWindows(app: ElectronApplication): Promise<PopupWindowEntry[]> {
  return app.evaluate(() => {
    const hooks = globalThis.__veltrivaTest;
    if (hooks === undefined) {
      throw new Error('The test hooks are missing: this is not a test build.');
    }
    return hooks.popupWindows();
  });
}

/** One native window and the web contents its views show. */
export interface WindowEntry {
  readonly title: string;
  readonly fullScreen: boolean;
  /** The window including its frame. */
  readonly bounds: Rect;
  readonly contentBounds: Rect;
  /** The web contents ids of the window's views, bottom to top. */
  readonly contentsIds: readonly number[];
}

/** Every `BaseWindow` the app has, in creation order (the main window first). */
export function allWindows(app: ElectronApplication): Promise<WindowEntry[]> {
  return app.evaluate(({ BaseWindow }) =>
    BaseWindow.getAllWindows().map((window) => ({
      title: window.getTitle(),
      fullScreen: window.isFullScreen(),
      bounds: window.getBounds(),
      contentBounds: window.getContentBounds(),
      contentsIds: window.contentView.children.flatMap((child) => {
        const contents = (child as { webContents?: { id: number } }).webContents;
        return contents === undefined ? [] : [contents.id];
      }),
    })),
  );
}

/**
 * Closes the native window that shows `webContentsId`, as the window's close button does (the
 * `close` event runs, so the app's own cleanup does). Throws if no window shows it.
 */
export async function closeWindowShowing(
  app: ElectronApplication,
  webContentsId: number,
): Promise<void> {
  await app.evaluate(({ BaseWindow }, id) => {
    for (const window of BaseWindow.getAllWindows()) {
      const shows = window.contentView.children.some(
        (child) => (child as { webContents?: { id: number } }).webContents?.id === id,
      );
      if (shows) {
        window.close();
        return;
      }
    }
    throw new Error(`closeWindowShowing: no window shows web contents ${String(id)}`);
  }, webContentsId);
}

/** Whether a web contents still exists in the app (a destroyed one is gone). */
export function webContentsExists(
  app: ElectronApplication,
  webContentsId: number,
): Promise<boolean> {
  return app.evaluate(({ webContents }, id) => {
    const contents = webContents.fromId(id);
    return contents !== undefined && !contents.isDestroyed();
  }, webContentsId);
}

/** A point in a page, in CSS pixels from the top-left of its viewport. */
export interface PagePoint {
  readonly x: number;
  readonly y: number;
}

export interface ClickOptions {
  /** Held during the click: `control` makes a link open in a background tab. */
  readonly modifiers?: readonly KeyModifier[];
}

/**
 * A real click at a point of a page: a mouse move, a `mouseDown` and a `mouseUp`, sent from main
 * with `webContents.sendInputEvent` (ADR-0008 4, "Rules found while writing M1.4a"). Main's
 * `input-event` sees it, so it is the user gesture a popup or an app launch needs, and Chromium
 * activates the page too. Playwright's own click goes through CDP and may give main nothing.
 */
export async function clickInPage(
  app: ElectronApplication,
  webContentsId: number,
  x: number,
  y: number,
  options: ClickOptions = {},
): Promise<void> {
  await app.evaluate(
    ({ webContents }, { id, px, py, held }) => {
      const contents = webContents.fromId(id);
      if (contents === undefined || contents.isDestroyed()) {
        throw new Error(`clickInPage: no web contents ${String(id)}`);
      }
      contents.sendInputEvent({ type: 'mouseMove', x: px, y: py, modifiers: held });
      contents.sendInputEvent({
        type: 'mouseDown',
        x: px,
        y: py,
        button: 'left',
        clickCount: 1,
        modifiers: held,
      });
      contents.sendInputEvent({
        type: 'mouseUp',
        x: px,
        y: py,
        button: 'left',
        clickCount: 1,
        modifiers: held,
      });
    },
    { id: webContentsId, px: x, py: y, held: [...(options.modifiers ?? [])] },
  );
}

/**
 * The center of the first element matching `selector`, from `getBoundingClientRect` in the page.
 * Throws if there is no such element, or if something else covers its center (a click there would
 * land elsewhere).
 */
export async function elementCenter(
  app: ElectronApplication,
  webContentsId: number,
  selector: string,
): Promise<PagePoint> {
  const found = (await evaluateInTab(
    app,
    webContentsId,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (element === null) {
        return { problem: 'no such element' };
      }
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        return { problem: 'the element has no size' };
      }
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (hit === null || !(hit === element || element.contains(hit))) {
        return { problem: 'something else covers the center of the element' };
      }
      return { x, y };
    })()`,
  )) as { problem?: string; x?: number; y?: number };
  if (found.problem !== undefined || found.x === undefined || found.y === undefined) {
    throw new Error(
      `elementCenter(${selector}) in web contents ${String(webContentsId)}: ${found.problem ?? 'unknown'}`,
    );
  }
  return { x: found.x, y: found.y };
}

/** `clickInPage` at the center of the element `selector` matches. */
export async function clickElement(
  app: ElectronApplication,
  webContentsId: number,
  selector: string,
  options: ClickOptions = {},
): Promise<void> {
  const { x, y } = await elementCenter(app, webContentsId, selector);
  await clickInPage(app, webContentsId, x, y, options);
}

/** One `input-event` as main saw it (the event the gesture tracker reads). */
export interface InputEventRecord {
  readonly type: string;
  readonly key: string | null;
}

/**
 * Records every `input-event` of a web contents: the raw input main sees, which is what the
 * gesture tracker reads. It is how a spec learns whether a given way of clicking (Playwright's,
 * `sendInputEvent`) reaches main at all. The handle points at an array in main that keeps growing.
 */
export async function recordInputEvents(app: ElectronApplication, webContentsId: number) {
  const handle = await app.evaluateHandle(({ webContents }, id) => {
    const records: InputEventRecord[] = [];
    webContents.fromId(id)?.on('input-event', (_event, input) => {
      const key = 'key' in input && typeof input.key === 'string' ? input.key : null;
      records.push({ type: input.type, key });
    });
    return records;
  }, webContentsId);
  return { all: (): Promise<InputEventRecord[]> => handle.jsonValue() };
}

/** One `console.warn` the app made through its logger: `[veltriva] <event> <fields>`. */
export interface MainWarning {
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

/**
 * Records the app's own log warnings from now on (`consoleLogger.warn` in main), such as
 * `permission.denied`, `external.noGesture` and `popup.refused`. They say which rule refused
 * something, so a spec can tell "refused by the broker" from "never asked". The handle points at
 * an array in main that keeps growing.
 */
export async function recordMainWarnings(app: ElectronApplication) {
  const handle = await app.evaluateHandle(() => {
    const records: MainWarning[] = [];
    const original = console.warn.bind(console);
    console.warn = (...args: unknown[]) => {
      const [first, second] = args;
      if (typeof first === 'string' && first.startsWith('[veltriva] ')) {
        records.push({
          event: first.slice('[veltriva] '.length),
          fields:
            typeof second === 'object' && second !== null
              ? (second as Record<string, unknown>)
              : {},
        });
      }
      original(...args);
    };
    return records;
  });
  return { all: (): Promise<MainWarning[]> => handle.jsonValue() };
}

// ── M1.4b: downloads ────────────────────────────────────────────────────────────────────────────

/** Where a test build saves downloads: a folder in the test's own profile, never the user's. */
export function testDownloadsFolder(app: ElectronApplication): Promise<string> {
  return app.evaluate(() => {
    const hooks = globalThis.__veltrivaTest;
    if (hooks === undefined) {
      throw new Error('The test hooks are missing: this is not a test build.');
    }
    return hooks.testDownloadsFolder();
  });
}

export type RecordedFileAction = ReturnType<VeltrivaTestHooks['recordedFileActions']>[number];

/**
 * Every Open and Show in folder the download manager asked for, in order. Test builds record them
 * instead of calling `shell.openPath` or `shell.showItemInFolder`, so nothing is ever opened.
 */
export function recordedFileActions(app: ElectronApplication): Promise<RecordedFileAction[]> {
  return app.evaluate(() => {
    const hooks = globalThis.__veltrivaTest;
    if (hooks === undefined) {
      throw new Error('The test hooks are missing: this is not a test build.');
    }
    return hooks.recordedFileActions();
  });
}

/**
 * A real click whose mouse button stays down for `holdMs` before it is released. Main's gesture
 * tracker records the press (`mouseDown`), and the page's click handlers and the window-open
 * handler run at the release, so a hold longer than the 5 s window sends a trusted click, with
 * every modifier Chromium needs to read it as an Alt+click, whose gesture has already expired
 * (M1.4b).
 */
export async function holdClickInPage(
  app: ElectronApplication,
  webContentsId: number,
  x: number,
  y: number,
  options: ClickOptions & { readonly holdMs: number },
): Promise<void> {
  const held = [...(options.modifiers ?? [])];
  await app.evaluate(
    ({ webContents }, { id, px, py, modifiers }) => {
      const contents = webContents.fromId(id);
      if (contents === undefined || contents.isDestroyed()) {
        throw new Error(`holdClickInPage: no web contents ${String(id)}`);
      }
      contents.sendInputEvent({ type: 'mouseMove', x: px, y: py, modifiers });
      contents.sendInputEvent({
        type: 'mouseDown',
        x: px,
        y: py,
        button: 'left',
        clickCount: 1,
        modifiers,
      });
    },
    { id: webContentsId, px: x, py: y, modifiers: held },
  );
  await delay(options.holdMs);
  await app.evaluate(
    ({ webContents }, { id, px, py, modifiers }) => {
      const contents = webContents.fromId(id);
      if (contents === undefined || contents.isDestroyed()) {
        throw new Error(`holdClickInPage: no web contents ${String(id)}`);
      }
      contents.sendInputEvent({
        type: 'mouseUp',
        x: px,
        y: py,
        button: 'left',
        clickCount: 1,
        modifiers,
      });
    },
    { id: webContentsId, px: x, py: y, modifiers: held },
  );
}
