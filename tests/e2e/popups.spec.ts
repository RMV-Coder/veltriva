// Popups, M1.4a (ADR-0002 item 9; src/main/popups, src/main/windows/popup-windows.ts). Electron has
// no popup blocker, so main applies the gesture rule itself: a popup or a new tab needs a trusted
// mouse-down, tap or key press in that page within the last 5 s, and uses it up. Without one it is
// blocked and the toolbar offers "Open pop-up". A sized `window.open` becomes a popup window with a
// read-only address bar above the page; links and `window.open` without features become tabs.
//
// Gestures are `webContents.sendInputEvent` mouse-down and mouse-up at an element's coordinates
// (`clickElement`): main's `input-event` sees them (harness rule, ADR-0008 item 4). "No gesture" is
// `executeJavaScript(code, true)`: Chromium gets a user activation, but main sees no input.
//
// The pages are tests/fixtures/pages/popup-opener.html and popup-child.html. `127.0.0.1` is the
// opener's site; `localhost` on the same server is another one.
import { setTimeout as delay } from 'node:timers/promises';

import type { ElectronApplication } from '@playwright/test';

import { expect } from './expect';
import { test } from './fixtures';
import type { FixtureServer } from '../fixtures/server';
import {
  allWindows,
  clickElement,
  closeWindowShowing,
  evaluateInTab,
  fullscreenInfo,
  pageForTab,
  popupWindows,
  recordInputEvents,
  recordMainWarnings,
  selectedTabId,
  sendKey,
  setSearchTemplate,
  tabState,
  tabStates,
  webContentsExists,
  webContentsRoles,
} from './hooks';
import type { InputEventRecord, PopupWindowEntry, TabId } from './hooks';
import {
  clickNow,
  expectNoStripFor,
  promptStrip,
  stripSentence,
  tabSnapshot,
  waitForStrip,
} from './prompt-ui';
import type { LoadedTab } from './shell-ui';
import { loadTab, tabElements, typeAddress, waitForLoaded, waitForPage } from './shell-ui';

test.describe.configure({ timeout: 120_000 });

/** Where the popup the opener's buttons open goes (tests/fixtures/pages/popup-child.html). */
const CHILD_PATH = '/popup-child.html';

/**
 * How long the app gets to exit after its main window closes. Playwright reports the exit late on
 * a loaded machine (about 11 s measured when idle), so this is generous; a hang is far longer.
 */
const QUIT_TIMEOUT_MS = 90_000;

/** The popup address bar's page, on the shell's own origin. */
const POPUP_BAR_URL = 'app://shell/popup-bar.html';

async function loadOpener(
  app: ElectronApplication,
  shell: Parameters<typeof loadTab>[1],
  server: FixtureServer,
): Promise<LoadedTab> {
  return loadTab(app, shell, server.url('/popup-opener.html'));
}

async function tabIds(app: ElectronApplication): Promise<TabId[]> {
  return (await tabStates(app)).map((tab) => tab.id);
}

/** Waits until exactly `count` popup windows are open, and returns them. */
async function waitForPopups(app: ElectronApplication, count: number): Promise<PopupWindowEntry[]> {
  await expect
    .poll(async () => (await popupWindows(app)).length, {
      message: `${String(count)} popup window(s) should be open`,
      timeout: 30_000,
    })
    .toBe(count);
  return popupWindows(app);
}

/** The popup that committed `url` (its page may still be loading when the window appears). */
async function waitForPopupAt(app: ElectronApplication, url: string): Promise<PopupWindowEntry> {
  const seen: { popup: PopupWindowEntry | undefined } = { popup: undefined };
  await expect
    .poll(
      async () => {
        seen.popup = (await popupWindows(app)).find((entry) => entry.bar.text === url);
        return seen.popup !== undefined;
      },
      { message: `a popup window should show ${url}`, timeout: 30_000 },
    )
    .toBe(true);
  if (seen.popup === undefined) {
    throw new Error('unreachable: the poll passed with no popup');
  }
  return seen.popup;
}

/** The address bar's page: a `shell` view on `app://shell/popup-bar.html`, which loads after the window. */
async function popupBarContentsId(app: ElectronApplication): Promise<number> {
  const seen = { id: -1 };
  await expect
    .poll(
      async () => {
        const bar = (await webContentsRoles(app)).find(
          (entry) => entry.url === POPUP_BAR_URL && entry.role === 'shell',
        );
        seen.id = bar?.webContentsId ?? -1;
        return seen.id;
      },
      { message: "the popup's address bar page should load", timeout: 30_000 },
    )
    .toBeGreaterThan(-1);
  return seen.id;
}

/** Everything that must be gone once a popup window has closed, however it closed. */
async function expectPopupGone(app: ElectronApplication, popup: PopupWindowEntry): Promise<void> {
  await expect
    .poll(async () => (await popupWindows(app)).length, {
      message: 'the popup window should be gone',
    })
    .toBe(0);
  await expect
    .poll(() => webContentsExists(app, popup.webContentsId), {
      message: "the popup's web contents should be destroyed",
    })
    .toBe(false);
  // The address bar's contents goes with it: only the main shell is left.
  await expect
    .poll(
      async () => (await webContentsRoles(app)).filter((entry) => entry.role === 'shell').length,
      {
        message: "the popup's address bar should be destroyed",
      },
    )
    .toBe(1);
  expect((await allWindows(app)).length).toBe(1);
}

/** A message the opener page received (`popupFixture.messages`). */
interface PostedMessage {
  readonly data: { readonly type?: string };
  readonly origin: string;
}

async function messagesOfOpener(app: ElectronApplication, openerId: number): Promise<unknown[]> {
  return (await evaluateInTab(app, openerId, 'popupFixture.messages')) as unknown[];
}

test.describe('popups', () => {
  test.beforeEach(async ({ electronApp, fixtureServer, shell }) => {
    await setSearchTemplate(electronApp, fixtureServer.url('/search?q={searchTerms}'));
    await expect(tabElements(shell)).toHaveCount(1);
  });

  test.describe('without a gesture', () => {
    test('a sized window.open is blocked; the strip says so and "Open pop-up" opens it as a tab', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const opener = await loadOpener(electronApp, shell, fixtureServer);
      const before = await tabIds(electronApp);
      const popupUrl = fixtureServer.url(`${CHILD_PATH}?from=opener`);

      // Chromium gets a user activation; main sees no input at all.
      const opened = await evaluateInTab(
        electronApp,
        opener.webContentsId,
        'popupFixture.openPopup()',
        {
          userGesture: true,
        },
      );
      expect(opened, 'window.open returns null when the browser refuses').toBe(false);

      // "Pop-up blocked", with the address it wanted.
      await waitForStrip(shell, 'blocked-popups');
      await expect(stripSentence(shell)).toHaveText(`Pop-up blocked: ${popupUrl}`);
      expect((await tabSnapshot(shell, opener.tabId))?.blockedPopups).toEqual({
        count: 1,
        latest: popupUrl,
      });
      expect(await popupWindows(electronApp)).toEqual([]);
      expect(await tabIds(electronApp)).toEqual(before);

      // "Open pop-up" opens it as a foreground tab next to the opener (TabManager's, not a window).
      await clickNow(shell, 'Open pop-up');
      await expect.poll(async () => (await tabIds(electronApp)).length).toBe(before.length + 1);
      const created = (await tabIds(electronApp)).find((id) => !before.includes(id));
      expect(created).toBeDefined();
      const ids = await tabIds(electronApp);
      expect(ids.indexOf(created ?? '')).toBe(ids.indexOf(opener.tabId) + 1);
      await expect.poll(() => selectedTabId(electronApp)).toBe(created);
      await waitForPage(electronApp, created ?? '', { url: popupUrl });
      expect(await popupWindows(electronApp)).toEqual([]);
      const roles = await webContentsRoles(electronApp);
      expect(roles.find((entry) => entry.url === popupUrl)?.role).toBe('tab');

      // The notice is gone from the opener, and shows on no tab.
      expect((await tabSnapshot(shell, opener.tabId))?.blockedPopups).toBeNull();
      await expect(promptStrip(shell)).toHaveCount(0);
    });

    test('several blocked popups are counted, with the latest address; "Dismiss" clears them', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const opener = await loadOpener(electronApp, shell, fixtureServer);
      const before = await tabIds(electronApp);

      await evaluateInTab(electronApp, opener.webContentsId, 'popupFixture.openPopup()', {
        userGesture: true,
      });
      await waitForStrip(shell, 'blocked-popups');
      const crossUrl = fixtureServer.otherSiteUrl(`${CHILD_PATH}?from=opener`);
      await evaluateInTab(electronApp, opener.webContentsId, 'popupFixture.openCross()', {
        userGesture: true,
      });

      await expect(stripSentence(shell)).toHaveText(`2 pop-ups blocked. Latest: ${crossUrl}`);
      expect((await tabSnapshot(shell, opener.tabId))?.blockedPopups).toEqual({
        count: 2,
        latest: crossUrl,
      });

      await clickNow(shell, 'Dismiss');
      await expect(promptStrip(shell)).toHaveCount(0);
      expect((await tabSnapshot(shell, opener.tabId))?.blockedPopups).toBeNull();
      // Nothing was opened by dismissing.
      expect(await tabIds(electronApp)).toEqual(before);
      expect(await popupWindows(electronApp)).toEqual([]);
    });

    test('a new document in the tab clears the notice', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const opener = await loadOpener(electronApp, shell, fixtureServer);
      await evaluateInTab(electronApp, opener.webContentsId, 'popupFixture.openPopup()', {
        userGesture: true,
      });
      await waitForStrip(shell, 'blocked-popups');

      const away = fixtureServer.url('/page-a.html?case=popups-navigate');
      await typeAddress(shell, away);
      await waitForPage(electronApp, opener.tabId, { url: away });

      await expect(promptStrip(shell)).toHaveCount(0);
      expect((await tabSnapshot(shell, opener.tabId))?.blockedPopups).toBeNull();
    });

    test('window.open with no features is blocked without a gesture too', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const opener = await loadOpener(electronApp, shell, fixtureServer);
      const before = await tabIds(electronApp);

      // A new tab needs a gesture as much as a popup does.
      await evaluateInTab(electronApp, opener.webContentsId, 'popupFixture.openTab()', {
        userGesture: true,
      });
      await waitForStrip(shell, 'blocked-popups');
      expect(await tabIds(electronApp)).toEqual(before);
      expect((await tabSnapshot(shell, opener.tabId))?.blockedPopups?.count).toBe(1);
    });
  });

  test.describe('with a gesture', () => {
    test('window.open(url, name, "width=480,height=520") opens one popup window with a read-only address bar above the page', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const opener = await loadOpener(electronApp, shell, fixtureServer);
      const before = await tabIds(electronApp);
      const popupUrl = fixtureServer.url(`${CHILD_PATH}?from=opener`);

      await clickElement(electronApp, opener.webContentsId, '#open-popup');

      const popup = await waitForPopupAt(electronApp, popupUrl);
      expect(await waitForPopups(electronApp, 1)).toHaveLength(1);

      // The address bar shows the committed URL; the title names the host.
      expect(popup.url).toBe(popupUrl);
      expect(popup.bar).toEqual({ text: popupUrl, security: 'not-secure' });
      expect(popup.title).toContain(new URL(fixtureServer.origin).host);

      // The popup's contents is a `popup`; the bar is a `shell` view on its own page.
      const roles = await webContentsRoles(electronApp);
      expect(roles.find((entry) => entry.webContentsId === popup.webContentsId)?.role).toBe(
        'popup',
      );
      const barId = await popupBarContentsId(electronApp);
      // What the bar draws is what main says it shows.
      await expect
        .poll(
          () => evaluateInTab(electronApp, barId, "document.getElementById('address').textContent"),
          { message: "the bar's text should be the committed URL" },
        )
        .toBe(popupUrl);

      // Layout: the bar sits above the page, both as wide as the window, and the window is about
      // the size the page asked for (a frame's worth of slack).
      const { contentBounds, barBounds, pageBounds } = popup;
      expect(barBounds).toEqual({ x: 0, y: 0, width: contentBounds.width, height: 36 });
      expect(pageBounds.x).toBe(0);
      expect(pageBounds.y).toBe(barBounds.height);
      expect(pageBounds.width).toBe(contentBounds.width);
      expect(pageBounds.height).toBe(contentBounds.height - barBounds.height);
      expect(Math.abs(contentBounds.width - 480)).toBeLessThanOrEqual(10);
      expect(Math.abs(pageBounds.height - 520)).toBeLessThanOrEqual(10);

      // Centered on the browser window, whatever the page asked for.
      const windows = await allWindows(electronApp);
      const main = windows[0];
      const popupWindow = windows.find((window) =>
        window.contentsIds.includes(popup.webContentsId),
      );
      expect(main).toBeDefined();
      expect(popupWindow).toBeDefined();
      const centerOf = (rect: { x: number; y: number; width: number; height: number }) => ({
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
      });
      // A window's frame makes its outer box a little bigger than its content, hence the slack.
      expect(
        Math.abs(
          centerOf(popupWindow?.bounds ?? { x: 0, y: 0, width: 0, height: 0 }).x -
            centerOf(main?.bounds ?? { x: 0, y: 0, width: 0, height: 0 }).x,
        ),
      ).toBeLessThanOrEqual(40);
      expect(
        Math.abs(
          centerOf(popupWindow?.bounds ?? { x: 0, y: 0, width: 0, height: 0 }).y -
            centerOf(main?.bounds ?? { x: 0, y: 0, width: 0, height: 0 }).y,
        ),
      ).toBeLessThanOrEqual(60);

      // A window, not a tab; nothing blocked.
      expect(await tabIds(electronApp)).toEqual(before);
      expect((await tabSnapshot(shell, opener.tabId))?.blockedPopups).toBeNull();
      await expect(promptStrip(shell)).toHaveCount(0);
    });

    for (const site of ['same', 'other'] as const) {
      test(`the opener survives (${site} site): window.opener and postMessage work both ways`, async ({
        electronApp,
        fixtureServer,
        shell,
      }) => {
        const opener = await loadOpener(electronApp, shell, fixtureServer);
        const popupOrigin = site === 'same' ? fixtureServer.origin : fixtureServer.otherSiteOrigin;
        const popupUrl = `${popupOrigin}${CHILD_PATH}?from=opener`;

        await clickElement(
          electronApp,
          opener.webContentsId,
          site === 'same' ? '#open-popup' : '#open-cross',
        );
        const popup = await waitForPopupAt(electronApp, popupUrl);

        // The popup has an opener, and said hello through it.
        expect(await evaluateInTab(electronApp, popup.webContentsId, 'popupChild.hasOpener')).toBe(
          true,
        );
        await expect
          .poll(() => messagesOfOpener(electronApp, opener.webContentsId), {
            message: 'the opener should hear from the popup',
          })
          .toContainEqual({
            data: { type: 'hello', origin: popupOrigin, search: '?from=opener' },
            origin: popupOrigin,
          });

        // And the opener reaches the popup: a ping goes out, a pong comes back.
        await evaluateInTab(
          electronApp,
          opener.webContentsId,
          "popupFixture.send(0, { type: 'ping' })",
        );
        await expect
          .poll(() => messagesOfOpener(electronApp, opener.webContentsId), {
            message: "the opener should get the popup's reply",
          })
          .toContainEqual({ data: { type: 'pong', origin: popupOrigin }, origin: popupOrigin });
        expect(
          await evaluateInTab(electronApp, popup.webContentsId, 'popupChild.messages'),
        ).toEqual([{ data: { type: 'ping' }, origin: fixtureServer.origin }]);
        // The reference the opener holds is live: it is not closed.
        expect(
          await evaluateInTab(electronApp, opener.webContentsId, 'popupFixture.isClosed(0)'),
        ).toBe(false);
      });
    }

    test('a blank popup the opener writes into still says about:blank', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const opener = await loadOpener(electronApp, shell, fixtureServer);

      await clickElement(electronApp, opener.webContentsId, '#open-blank');
      const [popup] = await waitForPopups(electronApp, 1);
      expect(popup).toBeDefined();
      const popupId = popup?.webContentsId ?? -1;

      // The opener wrote a document into it, headline and all...
      await expect
        .poll(() => evaluateInTab(electronApp, popupId, 'document.title'), {
          message: 'the opener should have written into the popup',
        })
        .toBe('Written by the opener');
      expect(
        await evaluateInTab(electronApp, popupId, "document.querySelector('h1').textContent"),
      ).toBe('https://accounts.example.invalid/signin');
      // ...and none of it reached the address bar: nothing committed, so it is still about:blank.
      await delay(500);
      const [after] = await popupWindows(electronApp);
      expect(after?.bar).toEqual({ text: 'about:blank', security: 'neutral' });
      const barId = await popupBarContentsId(electronApp);
      expect(
        await evaluateInTab(electronApp, barId, "document.getElementById('address').textContent"),
      ).toBe('about:blank');
    });
  });

  test.describe('closing', () => {
    async function openPopup(
      app: ElectronApplication,
      shell: Parameters<typeof loadTab>[1],
      server: FixtureServer,
    ): Promise<{ opener: LoadedTab; popup: PopupWindowEntry }> {
      const opener = await loadOpener(app, shell, server);
      await clickElement(app, opener.webContentsId, '#open-popup');
      const popup = await waitForPopupAt(app, server.url(`${CHILD_PATH}?from=opener`));
      return { opener, popup };
    }

    test('window.close() in the popup closes its window and destroys its contents', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const { opener, popup } = await openPopup(electronApp, shell, fixtureServer);

      await evaluateInTab(electronApp, popup.webContentsId, 'window.close()');

      await expectPopupGone(electronApp, popup);
      // The opener lives on, and knows the window closed.
      expect(await tabState(electronApp, opener.tabId)).toBeDefined();
      await expect
        .poll(() => evaluateInTab(electronApp, opener.webContentsId, 'popupFixture.isClosed(0)'))
        .toBe(true);
    });

    test('closing the popup window closes its contents', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const { popup } = await openPopup(electronApp, shell, fixtureServer);

      await closeWindowShowing(electronApp, popup.webContentsId);

      await expectPopupGone(electronApp, popup);
    });

    test('Ctrl+W in the popup closes the popup, and only the popup', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const { opener, popup } = await openPopup(electronApp, shell, fixtureServer);
      const tabsBefore = await tabIds(electronApp);

      await sendKey(electronApp, popup.webContentsId, 'W', ['control']);

      await expectPopupGone(electronApp, popup);
      // Not the browser's tab: Ctrl+W in a popup is the popup's.
      expect(await tabIds(electronApp)).toEqual(tabsBefore);
      expect(await tabState(electronApp, opener.tabId)).toBeDefined();
    });

    test('a popup outlives its opener tab', async ({ electronApp, fixtureServer, shell }) => {
      const { opener, popup } = await openPopup(electronApp, shell, fixtureServer);

      // Navigate the opener away: its page is gone, the popup is not.
      const away = fixtureServer.url('/page-a.html?case=popup-outlives');
      await typeAddress(shell, away);
      await waitForPage(electronApp, opener.tabId, { url: away });

      await delay(500);
      expect((await popupWindows(electronApp)).map((entry) => entry.webContentsId)).toEqual([
        popup.webContentsId,
      ]);
      expect(await webContentsExists(electronApp, popup.webContentsId)).toBe(true);
    });
  });

  test('one gesture opens one popup: the second window.open of a click is blocked', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const opener = await loadOpener(electronApp, shell, fixtureServer);
    const first = fixtureServer.url(`${CHILD_PATH}?n=1`);
    const second = fixtureServer.url(`${CHILD_PATH}?n=2`);

    await clickElement(electronApp, opener.webContentsId, '#open-two');

    await waitForPopupAt(electronApp, first);
    expect(await waitForPopups(electronApp, 1)).toHaveLength(1);
    await waitForStrip(shell, 'blocked-popups');
    await expect(stripSentence(shell)).toHaveText(`Pop-up blocked: ${second}`);
    expect((await tabSnapshot(shell, opener.tabId))?.blockedPopups).toEqual({
      count: 1,
      latest: second,
    });
    // By the page's own account: the first call got a window, the second got null.
    expect(
      await evaluateInTab(
        electronApp,
        opener.webContentsId,
        'popupFixture.opened.map((popup) => popup !== null)',
      ),
    ).toEqual([true, false]);
    // And the gesture is not left over for a third: nothing opens by itself afterwards.
    await delay(500);
    expect(await popupWindows(electronApp)).toHaveLength(1);
  });

  test.describe('links', () => {
    test('a target=_blank link click opens a foreground tab next to the opener, not a popup window', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const opener = await loadOpener(electronApp, shell, fixtureServer);
      const before = await tabIds(electronApp);
      const target = fixtureServer.url(`${CHILD_PATH}?from=link`);

      await clickElement(electronApp, opener.webContentsId, '#blank-link');

      await expect.poll(async () => (await tabIds(electronApp)).length).toBe(before.length + 1);
      const ids = await tabIds(electronApp);
      const created = ids.find((id) => !before.includes(id)) ?? '';
      expect(ids.indexOf(created)).toBe(ids.indexOf(opener.tabId) + 1);
      await expect.poll(() => selectedTabId(electronApp)).toBe(created);
      await waitForPage(electronApp, created, { url: target });
      expect(await popupWindows(electronApp)).toEqual([]);
      expect(await allWindows(electronApp)).toHaveLength(1);
    });

    test('a Ctrl+click opens a background tab: the opener stays selected', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const opener = await loadOpener(electronApp, shell, fixtureServer);
      const before = await tabIds(electronApp);
      const target = fixtureServer.url(`${CHILD_PATH}?from=link`);

      await clickElement(electronApp, opener.webContentsId, '#blank-link', {
        modifiers: ['control'],
      });

      await expect.poll(async () => (await tabIds(electronApp)).length).toBe(before.length + 1);
      const ids = await tabIds(electronApp);
      const created = ids.find((id) => !before.includes(id)) ?? '';
      expect(ids.indexOf(created)).toBe(ids.indexOf(opener.tabId) + 1);
      // Background: the opener is still the selected tab, and the new one loads regardless.
      expect(await selectedTabId(electronApp)).toBe(opener.tabId);
      await expect
        .poll(async () => (await tabState(electronApp, created))?.url, {
          message: 'the background tab should load the link',
        })
        .toBe(target);
      expect(await popupWindows(electronApp)).toEqual([]);
    });

    test('window.open(url) without features opens a tab', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const opener = await loadOpener(electronApp, shell, fixtureServer);
      const before = await tabIds(electronApp);
      const target = fixtureServer.url(`${CHILD_PATH}?from=tab`);

      await clickElement(electronApp, opener.webContentsId, '#open-tab');

      await expect.poll(async () => (await tabIds(electronApp)).length).toBe(before.length + 1);
      const created = (await tabIds(electronApp)).find((id) => !before.includes(id)) ?? '';
      await expect.poll(() => selectedTabId(electronApp)).toBe(created);
      await waitForPage(electronApp, created, { url: target });
      expect(await popupWindows(electronApp)).toEqual([]);
    });
  });

  test.describe('refused URLs', () => {
    /** Sets what `#open-custom` opens, then clicks it with a real gesture. */
    async function openWithGesture(
      app: ElectronApplication,
      opener: LoadedTab,
      url: string,
    ): Promise<void> {
      await evaluateInTab(
        app,
        opener.webContentsId,
        `popupFixture.next = { url: ${JSON.stringify(url)}, name: 'refused', features: 'width=300,height=300' }`,
      );
      // With a gesture: a refusal is the URL's, not the missing click's.
      await clickElement(app, opener.webContentsId, '#open-custom');
    }

    test('window.open of data: opens nothing and shows no blocked notice', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const warnings = await recordMainWarnings(electronApp);
      const opener = await loadOpener(electronApp, shell, fixtureServer);
      const before = await tabIds(electronApp);

      await openWithGesture(electronApp, opener, 'data:text/html,<p>nope</p>');

      // Main saw the URL and refused its scheme.
      await expect
        .poll(async () => (await warnings.all()).find((w) => w.event === 'popup.refused')?.fields, {
          message: 'main should have refused the window.open',
        })
        .toMatchObject({ reason: 'refused-scheme' });
      await expectNoStripFor(shell, opener.tabId, 1_000, 'a refused URL is not a blocked popup');
      expect(await popupWindows(electronApp)).toEqual([]);
      expect(await tabIds(electronApp)).toEqual(before);
      expect(await evaluateInTab(electronApp, opener.webContentsId, 'popupFixture.opened')).toEqual(
        [null],
      );
    });

    test('window.open of file: opens nothing and shows no blocked notice', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const opener = await loadOpener(electronApp, shell, fixtureServer);
      const before = await tabIds(electronApp);

      await openWithGesture(electronApp, opener, 'file:///C:/Windows/System32/drivers/etc/hosts');

      // Chromium refuses a web page's file: window before main's handler hears of it (measured:
      // no `popup.refused` is logged), so what is checked is the outcome.
      await expect
        .poll(() => evaluateInTab(electronApp, opener.webContentsId, 'popupFixture.opened.length'))
        .toBe(1);
      await expectNoStripFor(shell, opener.tabId, 1_000, 'a refused URL is not a blocked popup');
      expect(await popupWindows(electronApp)).toEqual([]);
      expect(await tabIds(electronApp)).toEqual(before);
      expect(await evaluateInTab(electronApp, opener.webContentsId, 'popupFixture.opened')).toEqual(
        [null],
      );
    });

    // Accepted behavior, as in Chrome: Blink never hands main a `javascript:` URL. For
    // `window.open('javascript:...')` it opens a blank window and runs the script in it afterwards,
    // so the window-open handler sees `about:blank`, and with a gesture a blank popup opens. What
    // matters is that it is safe: the address bar says `about:blank`, never `javascript:`.
    test('window.open of javascript: opens only a blank popup: its bar says about:blank, never javascript:', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const opener = await loadOpener(electronApp, shell, fixtureServer);

      await openWithGesture(electronApp, opener, 'javascript:void(0)');

      const [popup] = await waitForPopups(electronApp, 1);
      // The address bar never shows `javascript:`: nothing but a blank page is on screen.
      expect(popup?.bar).toEqual({ text: 'about:blank', security: 'neutral' });
      const barId = await popupBarContentsId(electronApp);
      expect(
        await evaluateInTab(electronApp, barId, "document.getElementById('address').textContent"),
      ).toBe('about:blank');
      await expectNoStripFor(shell, opener.tabId, 500, 'a blank popup is not a blocked popup');
    });
  });

  test.describe('popups from an embedded page', () => {
    // A click inside an embedded page is the user's gesture for the popup that page opens: that is
    // how sign-in and payment widgets work. Such a click can't be made with `sendInputEvent`, which
    // reaches only the top page's own widget (measured: a click at a cross-site frame's coordinates
    // never lands in it). Playwright's click goes through CDP, which routes it into the frame.
    async function clickInFrame(
      app: ElectronApplication,
      opener: LoadedTab,
      site: 'same' | 'other',
      server: FixtureServer,
    ): Promise<() => Promise<InputEventRecord[]>> {
      await evaluateInTab(
        app,
        opener.webContentsId,
        `popupFixture.addFrame(${JSON.stringify(site)})`,
      );
      const page = await pageForTab(app, opener.tabId);
      const inputs = await recordInputEvents(app, opener.webContentsId);
      await page.frameLocator('#popup-frame').locator('#frame-open').click();

      // The click landed in the embedded page: it told the page around it so.
      const origin = site === 'same' ? server.origin : server.otherSiteOrigin;
      await expect
        .poll(
          async () =>
            ((await messagesOfOpener(app, opener.webContentsId)) as PostedMessage[]).some(
              (message) => message.data.type === 'frame-clicked' && message.origin === origin,
            ),
          { message: 'the click should have reached the embedded page' },
        )
        .toBe(true);
      return inputs.all;
    }

    test('a click inside a same-site embedded page opens the popup it asks for', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const opener = await loadOpener(electronApp, shell, fixtureServer);
      const inputs = await clickInFrame(electronApp, opener, 'same', fixtureServer);

      // The gesture reached main, and the popup opened.
      expect((await inputs()).map((input) => input.type)).toContain('mouseDown');
      await waitForPopupAt(electronApp, fixtureServer.url(`${CHILD_PATH}?from=frame`));
      await expect(promptStrip(shell)).toHaveCount(0);
    });

    // KNOWN BUG (found by this spec). Main's `input-event` is the only gesture signal (ADR-0002
    // item 9), and it never fires for input that Chromium routes to an out-of-process frame, which
    // is what a cross-site embedded page is. Measured: Playwright's click lands in the frame (it
    // reports `frame-clicked`), and the opener's `input-event` records nothing. So a real click on
    // a sign-in or payment widget served from another site is treated as "no gesture", and the
    // popup it opens is blocked ("Pop-up blocked"). The same click in a same-site frame works (the
    // test above).
    test.fail(
      'a click inside a cross-site embedded page opens the popup it asks for',
      async ({ electronApp, fixtureServer, shell }) => {
        const opener = await loadOpener(electronApp, shell, fixtureServer);
        const inputs = await clickInFrame(electronApp, opener, 'other', fixtureServer);

        // First the cause: main should have seen the click as input...
        expect((await inputs()).map((input) => input.type)).toContain('mouseDown');
        // ...and then the effect: the popup opens instead of being blocked.
        await expect
          .poll(async () => (await popupWindows(electronApp)).length, {
            message: 'the popup should open',
            timeout: 8_000,
          })
          .toBe(1);
      },
    );
  });

  test.describe('popups from a popup', () => {
    test('window.open inside a popup, with a gesture there, opens a tab in the main window and no second popup', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const opener = await loadOpener(electronApp, shell, fixtureServer);
      await clickElement(electronApp, opener.webContentsId, '#open-popup');
      const popup = await waitForPopupAt(
        electronApp,
        fixtureServer.url(`${CHILD_PATH}?from=opener`),
      );
      const before = await tabIds(electronApp);

      // A click in the popup's own page: the gesture is the popup's.
      await clickElement(electronApp, popup.webContentsId, '#open-nested');

      await expect.poll(async () => (await tabIds(electronApp)).length).toBe(before.length + 1);
      const ids = await tabIds(electronApp);
      const created = ids.find((id) => !before.includes(id)) ?? '';
      // Next to the tab that opened the popup.
      expect(ids.indexOf(created)).toBe(ids.indexOf(opener.tabId) + 1);
      await waitForPage(electronApp, created, {
        url: fixtureServer.url(`${CHILD_PATH}?nested=1`),
      });
      // Still one popup window: this one.
      expect((await popupWindows(electronApp)).map((entry) => entry.webContentsId)).toEqual([
        popup.webContentsId,
      ]);
      expect(await allWindows(electronApp)).toHaveLength(2);
    });

    test('window.open inside a popup with no gesture there is not allowed either', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const opener = await loadOpener(electronApp, shell, fixtureServer);
      await clickElement(electronApp, opener.webContentsId, '#open-popup');
      const popup = await waitForPopupAt(
        electronApp,
        fixtureServer.url(`${CHILD_PATH}?from=opener`),
      );
      const before = await tabIds(electronApp);

      const opened = await evaluateInTab(
        electronApp,
        popup.webContentsId,
        'popupChild.openNested()',
        {
          userGesture: true,
        },
      );

      expect(opened).toBe(false);
      await delay(500);
      expect(await tabIds(electronApp)).toEqual(before);
      expect(await popupWindows(electronApp)).toHaveLength(1);
    });
  });

  test.describe('no fullscreen in a popup', () => {
    /** A popup that has clicked its own "Go fullscreen" button (a gesture there). */
    async function clickFullscreenInPopup(
      app: ElectronApplication,
      shell: Parameters<typeof loadTab>[1],
      server: FixtureServer,
    ): Promise<PopupWindowEntry> {
      const opener = await loadOpener(app, shell, server);
      await clickElement(app, opener.webContentsId, '#open-popup');
      const popup = await waitForPopupAt(app, server.url(`${CHILD_PATH}?from=opener`));
      await clickElement(app, popup.webContentsId, '#go-fullscreen');
      // The click arrived, so the page really asked.
      await expect
        .poll(() => evaluateInTab(app, popup.webContentsId, 'popupChild.clicked'))
        .toEqual({ 'go-fullscreen': 1 });
      return popup;
    }

    test('a popup cannot go fullscreen, even with a gesture', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const warnings = await recordMainWarnings(electronApp);
      const popup = await clickFullscreenInPopup(electronApp, shell, fixtureServer);

      // The broker refused it for being a popup window (it has no notice to show).
      await expect
        .poll(
          async () =>
            (await warnings.all()).find(
              (warning) =>
                warning.event === 'permission.denied' && warning.fields.permission === 'fullscreen',
            )?.fields,
          { message: 'the broker should have refused the fullscreen request' },
        )
        .toMatchObject({ reason: 'no-fullscreen-notice', role: 'popup' });
      // Nothing is fullscreen, by the page's account, the windows' and the browser's.
      expect(
        await evaluateInTab(electronApp, popup.webContentsId, 'document.fullscreenElement'),
      ).toBeNull();
      expect((await allWindows(electronApp)).map((window) => window.fullScreen)).toEqual([
        false,
        false,
      ]);
      expect((await fullscreenInfo(electronApp)).state).toBeNull();
    });

    // KNOWN GAP (found by this spec). The request is refused, but the page is never told:
    // `requestFullscreen()` returns a promise that neither resolves nor rejects (measured, still
    // pending after 3 s and after 20 s; the tab is `fullscreen: null`). Chrome rejects it with a
    // TypeError. Electron 44's EnterFullscreenModeForTab simply returns when the permission is
    // denied. Harmless to the user, but a page that awaits it waits forever.
    test.fail(
      'the refused fullscreen request is rejected, not left pending',
      async ({ electronApp, fixtureServer, shell }) => {
        const popup = await clickFullscreenInPopup(electronApp, shell, fixtureServer);

        await expect
          .poll(() => evaluateInTab(electronApp, popup.webContentsId, 'popupChild.fullscreen'), {
            message: 'the fullscreen request should settle',
            timeout: 8_000,
          })
          .toMatchObject({ ok: false });
      },
    );
  });

  test('a click with Playwright reaches main as input, so it counts as a gesture (a harness fact)', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    // Not product behavior: it records how this harness's own click looks to main, so a spec
    // author knows which way of clicking is a gesture. `sendInputEvent` is the documented way
    // (ADR-0008 item 4); this pins what the other way does on this Electron version.
    const opener = await loadOpener(electronApp, shell, fixtureServer);
    const page = await pageForTab(electronApp, opener.tabId);
    const inputs = await recordInputEvents(electronApp, opener.webContentsId);

    await page.locator('#open-popup').click();

    await waitForPopups(electronApp, 1);
    const types = (await inputs.all()).map((input) => input.type);
    expect(types).toContain('mouseDown');
    expect(types).toContain('mouseUp');
    await waitForLoaded(electronApp, opener.tabId);
  });

  // Last: it closes the main window, and the fixture then finds an app that has already quit.
  test('closing the main window closes the popup windows, so the app quits', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    test.setTimeout(240_000);
    const opener = await loadOpener(electronApp, shell, fixtureServer);
    await clickElement(electronApp, opener.webContentsId, '#open-popup');
    await waitForPopups(electronApp, 1);
    expect(await allWindows(electronApp)).toHaveLength(2);
    // Playwright drops its handle on the process once the app is gone, so take it now.
    const child = electronApp.process();

    // The window that shows the opener's tab is the main window.
    const quit = electronApp.waitForEvent('close', { timeout: QUIT_TIMEOUT_MS });
    quit.catch(() => undefined);
    await closeWindowShowing(electronApp, opener.webContentsId);

    // The app quits only when no window is left (`window-all-closed`): the popup went with it.
    try {
      await quit;
    } catch (error) {
      // Say what is left, so a hang can be told from a slow exit.
      const left = await allWindows(electronApp).then(
        (windows) => JSON.stringify(windows.map((window) => window.contentsIds)),
        (reason: unknown) => `unreadable: ${String(reason).slice(0, 80)}`,
      );
      throw new Error(
        `The app did not quit within ${String(QUIT_TIMEOUT_MS)} ms of its main window closing. ` +
          `Windows left (web contents ids): ${left}`,
        { cause: error },
      );
    }
    await expect.poll(() => child.exitCode, { message: 'the app should exit cleanly' }).toBe(0);
  });
});
