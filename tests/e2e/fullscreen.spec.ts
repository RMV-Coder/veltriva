// HTML fullscreen, M1.3b (threat T6, ADR-0002 item 8, ADR-0006 A'): a page that goes fullscreen
// fills the window, and for a few seconds the shell draws a notice naming the page's origin and how
// to leave, so the page can't pass itself off as the browser. The shell is raised above the page
// only once it confirms that it shows nothing but the notice; then it is lowered again.
//
// The page asks for fullscreen from main, with a user gesture (`requestPageFullscreen`): Chromium
// refuses `requestFullscreen()` without one. Keys come from `sendKey`. Whatever the page does, the
// user can always leave: Esc, F11, a tab switch or closing the tab, even when the page has replaced
// `document.exitFullscreen`.
import type { ElectronApplication, Page } from '@playwright/test';

import type { Rect } from '../../src/core/layout/rect';
import { expect } from './expect';
import { test } from './fixtures';
import {
  contentRect,
  crashTab,
  focusedWebContents,
  fullscreenInfo,
  pageForTab,
  requestPageFullscreen,
  sendKey,
  setSearchTemplate,
  tabState,
  viewStack,
  windowInfo,
} from './hooks';
import { observeFor } from './launch';
import type { LoadedTab } from './shell-ui';
import {
  closeWithButton,
  expectConsistent,
  fullscreenNotice,
  fullscreenNoticeLayer,
  loadTab,
  omnibox,
  tabElement,
  tabElements,
} from './shell-ui';

test.describe.configure({ timeout: 120_000 });

/** The notice stays on screen for 4 s once it is raised; allow for a loaded machine. */
const NOTICE_GONE_TIMEOUT_MS = 20_000;

type FullscreenFixtureGlobal = typeof globalThis & {
  fullscreenFixture: { changes: boolean[]; trapExit(): void; isFullscreen(): boolean };
};

function fixtureChanges(page: Page): Promise<boolean[]> {
  return page.evaluate(() => [
    ...(globalThis as FullscreenFixtureGlobal).fullscreenFixture.changes,
  ]);
}

/** Within a pixel: display scaling rounds view bounds. */
function expectRectsClose(actual: Rect | null, wanted: Rect): void {
  expect(actual).not.toBeNull();
  expect(Math.abs((actual?.x ?? NaN) - wanted.x)).toBeLessThanOrEqual(1);
  expect(Math.abs((actual?.y ?? NaN) - wanted.y)).toBeLessThanOrEqual(1);
  expect(Math.abs((actual?.width ?? NaN) - wanted.width)).toBeLessThanOrEqual(1);
  expect(Math.abs((actual?.height ?? NaN) - wanted.height)).toBeLessThanOrEqual(1);
}

/** Asks the tab's page for fullscreen and waits until main has noticed (`state` names the tab). */
async function enterFullscreen(app: ElectronApplication, tab: LoadedTab): Promise<void> {
  await requestPageFullscreen(app, tab.webContentsId);
  await expect
    .poll(async () => (await fullscreenInfo(app)).state?.tabId, {
      message: 'main should report the tab as fullscreen',
    })
    .toBe(tab.tabId);
}

/** Waits until the shell has been raised above the page for the notice. */
async function waitForRaisedShell(app: ElectronApplication): Promise<void> {
  await expect
    .poll(async () => (await fullscreenInfo(app)).shellRaised, {
      message: 'main should raise the shell once it shows the notice',
    })
    .toBe(true);
}

/** Everything that must hold once the tab has left fullscreen, however it left. */
async function expectLeftFullscreen(
  app: ElectronApplication,
  shell: Page,
  tab: LoadedTab,
): Promise<void> {
  await expect
    .poll(() => fullscreenInfo(app), { message: 'main should forget the fullscreen tab' })
    .toEqual({ state: null, shellRaised: false });
  await expect
    .poll(async () => (await windowInfo(app)).fullScreen, {
      message: 'the window should leave fullscreen',
    })
    .toBe(false);
  // The browser is back: the toolbar shows, and the tab sits in the content area again.
  await expect(omnibox(shell)).toBeVisible();
  await expect(shell.locator('html[data-overlay]')).toHaveCount(0);
  await expect(fullscreenNotice(shell)).toHaveCount(0);
  await expectConsistent(app, shell);
  const stack = await viewStack(app);
  expect(stack.at(-1)).toBe(tab.tabId);
}

test.describe('HTML fullscreen', () => {
  test.beforeEach(async ({ electronApp, fixtureServer, shell }) => {
    await setSearchTemplate(electronApp, fixtureServer.url('/search?q={searchTerms}'));
    await expect(tabElements(shell)).toHaveCount(1);
  });

  test('the window goes fullscreen and the tab fills it; the notice names the origin, then goes', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/fullscreen.html'));
    const page = await pageForTab(electronApp, tab.tabId);
    expect(await fullscreenInfo(electronApp)).toEqual({ state: null, shellRaised: false });
    expect(await viewStack(electronApp)).toEqual(['shell', tab.tabId]);
    expect((await windowInfo(electronApp)).fullScreen).toBe(false);
    const originalRect = await contentRect(electronApp);

    await enterFullscreen(electronApp, tab);

    // Main knows who is full screen, from the committed URL and not from anything the page says.
    const origin = new URL(fixtureServer.origin).host;
    expect(await fullscreenInfo(electronApp)).toMatchObject({
      state: { tabId: tab.tabId, origin, notice: true },
    });

    // The window is fullscreen and the tab's view fills all of it.
    await expect.poll(async () => (await windowInfo(electronApp)).fullScreen).toBe(true);
    await expect
      .poll(
        async () => {
          const [window, state, rect] = await Promise.all([
            windowInfo(electronApp),
            tabState(electronApp, tab.tabId),
            contentRect(electronApp),
          ]);
          const bounds = state?.bounds;
          return (
            bounds !== null &&
            bounds !== undefined &&
            Math.abs(bounds.x) <= 1 &&
            Math.abs(bounds.y) <= 1 &&
            Math.abs(bounds.width - window.contentBounds.width) <= 1 &&
            Math.abs(bounds.height - window.contentBounds.height) <= 1 &&
            Math.abs(rect.width - window.contentBounds.width) <= 1 &&
            Math.abs(rect.height - window.contentBounds.height) <= 1
          );
        },
        { message: 'the tab view and the layout rect should fill the fullscreen window' },
      )
      .toBe(true);
    const fullRect = await contentRect(electronApp);
    expect(fullRect.width).toBeGreaterThan(originalRect.width);
    expect(fullRect.height).toBeGreaterThan(originalRect.height);

    // The page agrees that it is fullscreen.
    expect(await fixtureChanges(page)).toEqual([true]);
    expect(
      await page.evaluate(() =>
        (globalThis as FullscreenFixtureGlobal).fullscreenFixture.isFullscreen(),
      ),
    ).toBe(true);

    // The shell draws the notice, and nothing else (it is transparent apart from the notice).
    await expect(shell.locator('html[data-overlay="fullscreen-notice"]')).toHaveCount(1);
    const notice = fullscreenNotice(shell);
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(`${origin} is now full screen`);
    await expect(notice).toContainText('Press Esc to exit full screen');
    // Page text never reaches the notice: the page's title is not in it.
    await expect(notice).not.toContainText('Fullscreen fixture');
    await expect(omnibox(shell)).toHaveCount(0);

    // Once the shell has confirmed the notice, main raises it above the page.
    await waitForRaisedShell(electronApp);
    expect((await viewStack(electronApp)).at(-1)).toBe('shell');
    expect(await viewStack(electronApp)).toEqual([tab.tabId, 'shell']);

    // About 4 s later the notice goes: the shell is lowered, the page is on top and has the keyboard.
    await expect
      .poll(async () => (await fullscreenInfo(electronApp)).state?.notice, {
        timeout: NOTICE_GONE_TIMEOUT_MS,
        message: 'the notice should hide by itself',
      })
      .toBe(false);
    await expect.poll(async () => (await fullscreenInfo(electronApp)).shellRaised).toBe(false);
    expect((await viewStack(electronApp)).at(-1)).toBe(tab.tabId);
    await expect(notice).toHaveCount(0);
    await expect(shell.locator('html[data-overlay="fullscreen-notice"]')).toHaveCount(0);
    await expect
      .poll(async () => (await focusedWebContents(electronApp))?.webContentsId)
      .toBe(tab.webContentsId);
    // The page is still fullscreen: only the notice ended.
    expect(await fullscreenInfo(electronApp)).toMatchObject({
      state: { tabId: tab.tabId, origin, notice: false },
    });
    expect((await windowInfo(electronApp)).fullScreen).toBe(true);
    expect(await fixtureChanges(page)).toEqual([true]);
  });

  test('a click on the notice hides it early and gives the page the keyboard back', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/fullscreen.html'));
    await enterFullscreen(electronApp, tab);
    await expect(fullscreenNotice(shell)).toBeVisible();
    await waitForRaisedShell(electronApp);
    const raisedAt = Date.now();
    // The keyboard is somewhere else, as it is after a real click on the notice.
    await sendKey(electronApp, 'shell', 'Shift');
    await expect.poll(async () => (await focusedWebContents(electronApp))?.isShell).toBe(true);

    await fullscreenNoticeLayer(shell).click();

    await expect
      .poll(async () => (await fullscreenInfo(electronApp)).state?.notice, {
        message: 'the click should hide the notice',
        timeout: 10_000,
      })
      .toBe(false);
    // Early: the notice's own time is 4 s from being raised.
    expect(Date.now() - raisedAt).toBeLessThan(3_500);
    expect(await fullscreenInfo(electronApp)).toMatchObject({
      state: { tabId: tab.tabId, notice: false },
      shellRaised: false,
    });
    expect((await viewStack(electronApp)).at(-1)).toBe(tab.tabId);
    await expect(fullscreenNotice(shell)).toHaveCount(0);
    await expect
      .poll(async () => (await focusedWebContents(electronApp))?.webContentsId)
      .toBe(tab.webContentsId);
    // The page stays fullscreen.
    expect((await windowInfo(electronApp)).fullScreen).toBe(true);
  });

  test('Esc, sent to the page, leaves fullscreen and puts the tab back in the content area', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/fullscreen.html'));
    const page = await pageForTab(electronApp, tab.tabId);
    const originalRect = await contentRect(electronApp);
    await enterFullscreen(electronApp, tab);
    await waitForRaisedShell(electronApp);
    await expect.poll(async () => (await windowInfo(electronApp)).fullScreen).toBe(true);

    await sendKey(electronApp, tab.webContentsId, 'Escape');

    await expectLeftFullscreen(electronApp, shell, tab);
    expectRectsClose(await contentRect(electronApp), originalRect);
    expectRectsClose((await tabState(electronApp, tab.tabId))?.bounds ?? null, originalRect);
    await expect.poll(() => fixtureChanges(page)).toEqual([true, false]);
    expect(
      await page.evaluate(() =>
        (globalThis as FullscreenFixtureGlobal).fullscreenFixture.isFullscreen(),
      ),
    ).toBe(false);
  });

  test('Esc, sent to the shell after a click on the notice took the keyboard, leaves fullscreen', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/fullscreen.html'));
    await enterFullscreen(electronApp, tab);
    await waitForRaisedShell(electronApp);

    // The keyboard is in the shell; the page, not Chromium's own handling, is out of reach.
    await sendKey(electronApp, 'shell', 'Escape');

    await expectLeftFullscreen(electronApp, shell, tab);
  });

  test("F11 ends the page's fullscreen like Esc does", async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/fullscreen.html'));
    const page = await pageForTab(electronApp, tab.tabId);
    await enterFullscreen(electronApp, tab);
    await expect.poll(async () => (await windowInfo(electronApp)).fullScreen).toBe(true);

    await sendKey(electronApp, tab.webContentsId, 'F11');

    await expectLeftFullscreen(electronApp, shell, tab);
    await expect.poll(() => fixtureChanges(page)).toEqual([true, false]);
  });

  // The page replaces `document.exitFullscreen` with a function that does nothing. Main leaves
  // through an isolated world, where the page's replacement does not exist.
  test.describe('a page that overrides document.exitFullscreen cannot trap the user', () => {
    /** `hides`: the tab is no longer shown after this way of leaving. */
    const ways: readonly {
      readonly name: string;
      readonly hides: boolean;
      readonly leave: (app: ElectronApplication, tab: LoadedTab) => Promise<void>;
    }[] = [
      { name: 'F11', hides: false, leave: (app, tab) => sendKey(app, tab.webContentsId, 'F11') },
      { name: 'Esc', hides: false, leave: (app, tab) => sendKey(app, tab.webContentsId, 'Escape') },
      {
        name: 'Ctrl+Tab to another tab',
        hides: true,
        leave: (app, tab) => sendKey(app, tab.webContentsId, 'Tab', ['control']),
      },
      {
        name: 'Ctrl+Shift+Tab to another tab',
        hides: true,
        leave: (app, tab) => sendKey(app, tab.webContentsId, 'Tab', ['control', 'shift']),
      },
    ];

    for (const { name, hides, leave } of ways) {
      test(`${name} still leaves`, async ({ electronApp, fixtureServer, shell }) => {
        const tab = await loadTab(electronApp, shell, fixtureServer.url('/fullscreen.html'));
        const page = await pageForTab(electronApp, tab.tabId);
        await page.evaluate(() => {
          (globalThis as FullscreenFixtureGlobal).fullscreenFixture.trapExit();
        });
        await enterFullscreen(electronApp, tab);
        await expect.poll(async () => (await windowInfo(electronApp)).fullScreen).toBe(true);

        await leave(electronApp, tab);

        await expect
          .poll(() => fullscreenInfo(electronApp), { message: `${name} should end the fullscreen` })
          .toEqual({ state: null, shellRaised: false });
        await expect.poll(async () => (await windowInfo(electronApp)).fullScreen).toBe(false);
        await expect(omnibox(shell)).toBeVisible();
        if (hides) {
          // A page that is no longer shown runs no animation frames, so it hears about the exit
          // when it is shown again (and, if the key came within a few ms of the page going
          // fullscreen, only then). Show it, and it must not be fullscreen.
          await tabElement(shell, tab.tabId).click();
          await expect(tabElement(shell, tab.tabId)).toHaveAttribute('aria-selected', 'true');
        }
        // The page's own exit was never called; the browser ended the fullscreen anyway, and the
        // page is told.
        await expect
          .poll(() =>
            page.evaluate(() =>
              (globalThis as FullscreenFixtureGlobal).fullscreenFixture.isFullscreen(),
            ),
          )
          .toBe(false);
        await expect.poll(() => fixtureChanges(page)).toEqual([true, false]);
        await expectConsistent(electronApp, shell);
      });
    }
  });

  // Closing the tab that is fullscreen: main forgets the fullscreen, the tab is gone, the browser's
  // UI is back, and the window leaves fullscreen too.
  const closers: readonly {
    readonly name: string;
    readonly trapped: boolean;
    readonly close: (app: ElectronApplication, shell: Page, tab: LoadedTab) => Promise<void>;
  }[] = [
    {
      name: 'Ctrl+W',
      trapped: true,
      close: (app, _shell, tab) => sendKey(app, tab.webContentsId, 'W', ['control']),
    },
    {
      name: 'its Close button',
      trapped: false,
      close: async (app, shell, tab) => {
        // The shell is above the page while the notice shows; wait for it to give way.
        await expect
          .poll(async () => (await fullscreenInfo(app)).state?.notice, {
            timeout: NOTICE_GONE_TIMEOUT_MS,
          })
          .toBe(false);
        await closeWithButton(shell, tab.tabId);
      },
    },
  ];

  /** Opens a page, makes it fullscreen, closes it the given way and waits for main to notice. */
  async function closeFullscreenTab(
    app: ElectronApplication,
    shell: Page,
    url: string,
    { trapped, close }: (typeof closers)[number],
  ): Promise<LoadedTab> {
    const tab = await loadTab(app, shell, url);
    if (trapped) {
      const page = await pageForTab(app, tab.tabId);
      await page.evaluate(() => {
        (globalThis as FullscreenFixtureGlobal).fullscreenFixture.trapExit();
      });
    }
    await enterFullscreen(app, tab);
    await expect.poll(async () => (await windowInfo(app)).fullScreen).toBe(true);

    await close(app, shell, tab);

    await expect
      .poll(() => fullscreenInfo(app), { message: 'closing the tab should end the fullscreen' })
      .toEqual({ state: null, shellRaised: false });
    return tab;
  }

  for (const closer of closers) {
    test(`closing the tab with ${closer.name} ends the fullscreen and restores the browser`, async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const tab = await closeFullscreenTab(
        electronApp,
        shell,
        fixtureServer.url('/fullscreen.html'),
        closer,
      );

      await expect.poll(() => tabState(electronApp, tab.tabId)).toBeUndefined();
      await expect(omnibox(shell)).toBeVisible();
      await expect(shell.locator('html[data-overlay]')).toHaveCount(0);
      await expectConsistent(electronApp, shell);
      expect(await viewStack(electronApp)).toEqual(['shell']);
    });

    // Found by this suite in M1.3b: Chromium takes the window out of fullscreen when the page
    // leaves it, but not when the page's web contents is destroyed while fullscreen, so the
    // window stayed fullscreen around the browser UI. Main now ends it (FullscreenController).
    test(`closing the tab with ${closer.name} also takes the window out of fullscreen`, async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      await closeFullscreenTab(electronApp, shell, fixtureServer.url('/fullscreen.html'), closer);

      await expect
        .poll(async () => (await windowInfo(electronApp)).fullScreen, {
          message: 'the window should leave fullscreen when its fullscreen tab closes',
          timeout: 5_000,
        })
        .toBe(false);
    });
  }

  test("closing the fullscreen tab keeps the user's own fullscreen (F11), which F11 then ends", async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/fullscreen.html'));
    await sendKey(electronApp, tab.webContentsId, 'F11');
    await expect.poll(async () => (await windowInfo(electronApp)).fullScreen).toBe(true);
    expect((await fullscreenInfo(electronApp)).state).toBeNull();

    await enterFullscreen(electronApp, tab);
    await sendKey(electronApp, tab.webContentsId, 'W', ['control']);

    await expect
      .poll(() => fullscreenInfo(electronApp))
      .toEqual({ state: null, shellRaised: false });
    await expect.poll(() => tabState(electronApp, tab.tabId)).toBeUndefined();
    // The window stays as the user had it before the page went fullscreen.
    expect(await observeFor(1_000, async () => (await windowInfo(electronApp)).fullScreen)).toEqual(
      [true],
    );
    await expect(omnibox(shell)).toBeVisible();

    await sendKey(electronApp, 'shell', 'F11');
    await expect.poll(async () => (await windowInfo(electronApp)).fullScreen).toBe(false);
    await expectConsistent(electronApp, shell);
  });

  test('a tab switch leaves fullscreen and the other tab is shown in the content area', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const other = await loadTab(electronApp, shell, fixtureServer.url('/page-a.html'));
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/fullscreen.html'));
    await enterFullscreen(electronApp, tab);
    await expect.poll(async () => (await windowInfo(electronApp)).fullScreen).toBe(true);

    // Ctrl+Tab wraps from the last tab to the first (the new-tab page), Ctrl+Shift+Tab goes back.
    await sendKey(electronApp, tab.webContentsId, 'Tab', ['control', 'shift']);

    await expect
      .poll(() => fullscreenInfo(electronApp))
      .toEqual({ state: null, shellRaised: false });
    await expect.poll(async () => (await windowInfo(electronApp)).fullScreen).toBe(false);
    expect((await tabState(electronApp, tab.tabId))?.attached).toBe(false);
    expect((await tabState(electronApp, other.tabId))?.attached).toBe(true);
    await expectConsistent(electronApp, shell);
  });

  test('only the selected tab can be fullscreen: a request from a background tab is refused', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const background = await loadTab(electronApp, shell, fixtureServer.url('/fullscreen.html'));
    const selected = await loadTab(electronApp, shell, fixtureServer.url('/page-a.html'));
    expect((await tabState(electronApp, background.tabId))?.attached).toBe(false);

    // Chromium may refuse for a hidden page or let it through for main to undo: either way, no tab
    // ends up fullscreen, and the selected tab keeps its place.
    await requestPageFullscreen(electronApp, background.webContentsId).catch(() => undefined);

    const seen = await observeFor(1_500, async () => {
      const [info, window] = await Promise.all([
        fullscreenInfo(electronApp),
        windowInfo(electronApp),
      ]);
      return JSON.stringify({ state: info.state?.tabId ?? null, fullScreen: window.fullScreen });
    });
    // Whatever flickered, it ended as it began.
    expect(seen.at(-1)).toBe(JSON.stringify({ state: null, fullScreen: false }));
    await expect.poll(async () => (await fullscreenInfo(electronApp)).state).toBeNull();
    await expect.poll(async () => (await windowInfo(electronApp)).fullScreen).toBe(false);
    expect(await viewStack(electronApp)).toEqual(['shell', selected.tabId]);
    await expectConsistent(electronApp, shell);
  });

  test('a page that navigates away while fullscreen ends it', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/fullscreen.html'));
    const page = await pageForTab(electronApp, tab.tabId);
    await enterFullscreen(electronApp, tab);
    await expect.poll(async () => (await windowInfo(electronApp)).fullScreen).toBe(true);

    await page
      .evaluate((target) => {
        (globalThis as unknown as { location: { href: string } }).location.href = target;
      }, fixtureServer.url('/page-b.html'))
      .catch(() => undefined);

    await expect.poll(async () => (await tabState(electronApp, tab.tabId))?.title).toBe('Page B');
    await expectLeftFullscreen(electronApp, shell, tab);
  });

  test('a crashed fullscreen tab ends it and shows the crashed page in the browser', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/fullscreen.html'));
    await enterFullscreen(electronApp, tab);
    await expect.poll(async () => (await windowInfo(electronApp)).fullScreen).toBe(true);

    await crashTab(electronApp, tab.tabId);

    await expect
      .poll(() => fullscreenInfo(electronApp), { message: 'a crash should end the fullscreen' })
      .toEqual({ state: null, shellRaised: false });
    await expect(shell.locator('[data-internal-page="crashed"]')).toBeVisible({ timeout: 30_000 });
    await expect(omnibox(shell)).toBeVisible();
    // With the page gone, the window must not stay fullscreen around the crash page.
    await expect.poll(async () => (await windowInfo(electronApp)).fullScreen).toBe(false);
    await expectConsistent(electronApp, shell);
  });

  test('the notice names a host with a port as the address bar would', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const port = new URL(fixtureServer.origin).port;
    // localhost is another name for the same server; the label follows the URL that committed.
    const tab = await loadTab(electronApp, shell, `http://localhost:${port}/fullscreen.html`);

    await enterFullscreen(electronApp, tab);

    expect((await fullscreenInfo(electronApp)).state?.origin).toBe(`localhost:${port}`);
    await expect(fullscreenNotice(shell)).toContainText(`localhost:${port} is now full screen`);
    await expect(fullscreenNoticeLayer(shell)).toBeVisible();
  });
});
