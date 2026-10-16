// DevTools for pages, M1.3b (ADR-0002 item 8): F12 opens a page's DevTools in their own window and
// F12 again closes them; a new-tab or error page has nothing to inspect. The shell's own DevTools
// never open in a test build (only `npm run dev` binds Ctrl+Shift+I to them).
//
// A DevTools window is a web contents with the `devtools` role (the guard gives Electron's DevTools
// that role and leaves them alone). F12 is sent from main with `sendKey` (see find.spec.ts).
import type { ElectronApplication } from '@playwright/test';

import { startFixtureServer } from '../fixtures/server';
import { expect } from './expect';
import { test } from './fixtures';
import {
  isDevToolsOpened,
  sendKey,
  setSearchTemplate,
  shellContentsId,
  tabState,
  webContentsRoles,
} from './hooks';
import { observeFor } from './launch';
import { internalPage, loadTab, openNewTab, openTabAt, tabElements } from './shell-ui';

test.describe.configure({ timeout: 120_000 });

/** The DevTools windows that exist right now: the web contents with the `devtools` role. */
async function devToolsWindows(app: ElectronApplication) {
  return (await webContentsRoles(app)).filter((entry) => entry.role === 'devtools');
}

test.describe('page DevTools', () => {
  test.beforeEach(async ({ electronApp, fixtureServer, shell }) => {
    await setSearchTemplate(electronApp, fixtureServer.url('/search?q={searchTerms}'));
    await expect(tabElements(shell)).toHaveCount(1);
  });

  test("F12 opens the page's DevTools in their own window and F12 again closes them", async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/page-a.html'));
    expect(await isDevToolsOpened(electronApp, tab.webContentsId)).toBe(false);
    expect(await devToolsWindows(electronApp)).toEqual([]);

    await sendKey(electronApp, tab.webContentsId, 'F12');

    await expect
      .poll(() => isDevToolsOpened(electronApp, tab.webContentsId), {
        message: 'F12 should open the DevTools of the page',
      })
      .toBe(true);
    // They are a web contents of their own, with the role the guard gives DevTools.
    await expect.poll(async () => (await devToolsWindows(electronApp)).length).toBe(1);
    const [devtools] = await devToolsWindows(electronApp);
    expect(devtools?.url).toMatch(/^devtools:\/\//);
    // Detached: the tab keeps its place in the window and its view is not shrunk to make room.
    expect((await tabState(electronApp, tab.tabId))?.attached).toBe(true);

    await sendKey(electronApp, tab.webContentsId, 'F12');

    await expect
      .poll(() => isDevToolsOpened(electronApp, tab.webContentsId), {
        message: 'a second F12 should close them',
      })
      .toBe(false);
    await expect.poll(async () => (await devToolsWindows(electronApp)).length).toBe(0);

    // And they open again.
    await sendKey(electronApp, tab.webContentsId, 'F12');
    await expect.poll(() => isDevToolsOpened(electronApp, tab.webContentsId)).toBe(true);
    await expect.poll(async () => (await devToolsWindows(electronApp)).length).toBe(1);
  });

  test('each tab has its own DevTools, and closing the tab closes them', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tabA = await loadTab(electronApp, shell, fixtureServer.url('/page-a.html'));
    const tabB = await loadTab(electronApp, shell, fixtureServer.url('/page-b.html'));

    await sendKey(electronApp, tabB.webContentsId, 'F12');
    await expect.poll(() => isDevToolsOpened(electronApp, tabB.webContentsId)).toBe(true);
    expect(await isDevToolsOpened(electronApp, tabA.webContentsId)).toBe(false);

    // Tab A's F12 opens A's own; B's stay open when A is selected.
    await sendKey(electronApp, tabB.webContentsId, 'Tab', ['control', 'shift']);
    await expect.poll(async () => (await tabState(electronApp, tabA.tabId))?.attached).toBe(true);
    await sendKey(electronApp, tabA.webContentsId, 'F12');
    await expect.poll(() => isDevToolsOpened(electronApp, tabA.webContentsId)).toBe(true);
    await expect.poll(async () => (await devToolsWindows(electronApp)).length).toBe(2);
    expect(await isDevToolsOpened(electronApp, tabB.webContentsId)).toBe(true);

    // Closing A (Ctrl+W) takes its DevTools with it and leaves B's.
    await sendKey(electronApp, tabA.webContentsId, 'W', ['control']);
    await expect.poll(() => tabState(electronApp, tabA.tabId)).toBeUndefined();
    await expect.poll(async () => (await devToolsWindows(electronApp)).length).toBe(1);
    expect(await isDevToolsOpened(electronApp, tabB.webContentsId)).toBe(true);
  });

  test('F12 on a new-tab page does nothing', async ({ electronApp, shell }) => {
    const tabId = await openNewTab(shell);
    await expect(internalPage(shell, 'new-tab')).toBeVisible();
    const shellId = await shellContentsId(electronApp);

    await sendKey(electronApp, 'shell', 'F12');

    // Nothing opens for the page (it has no web contents) or for the shell behind it.
    expect(
      await observeFor(700, async () =>
        JSON.stringify({
          windows: (await devToolsWindows(electronApp)).length,
          shell: await isDevToolsOpened(electronApp, shellId),
        }),
      ),
    ).toEqual([JSON.stringify({ windows: 0, shell: false })]);
    expect((await tabState(electronApp, tabId))?.webContentsId).toBeNull();
  });

  test('F12 on an error page does nothing', async ({ electronApp, shell }) => {
    // A port nothing listens on refuses the connection.
    const closed = await startFixtureServer();
    const refused = closed.url('/page-a.html?case=devtools-error');
    await closed.close();
    const tabId = await openTabAt(shell, refused);
    await expect(internalPage(shell, 'network-error')).toBeVisible({ timeout: 30_000 });
    const shellId = await shellContentsId(electronApp);

    await sendKey(electronApp, 'shell', 'F12');

    expect(
      await observeFor(700, async () =>
        JSON.stringify({
          windows: (await devToolsWindows(electronApp)).length,
          shell: await isDevToolsOpened(electronApp, shellId),
        }),
      ),
    ).toEqual([JSON.stringify({ windows: 0, shell: false })]);
    expect((await tabState(electronApp, tabId))?.page).toMatchObject({
      kind: 'internal',
      name: 'network-error',
    });
  });

  test("the shell's own DevTools never open in a test build", async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/page-a.html'));
    const shellId = await shellContentsId(electronApp);

    // Ctrl+Shift+I is the development build's key for the shell's DevTools; F12 is the page's.
    await sendKey(electronApp, 'shell', 'I', ['control', 'shift']);
    await sendKey(electronApp, tab.webContentsId, 'I', ['control', 'shift']);
    await sendKey(electronApp, 'shell', 'F12');

    // F12 from the shell opens the selected tab's DevTools, and only those.
    await expect.poll(() => isDevToolsOpened(electronApp, tab.webContentsId)).toBe(true);
    expect(await observeFor(700, () => isDevToolsOpened(electronApp, shellId))).toEqual([false]);
    expect(await devToolsWindows(electronApp)).toHaveLength(1);
  });
});
