// Keyboard focus, M1.3b (assessment §3.9, FocusManager): which view has the keyboard, the shell or
// the page, and the rules that move it between them.
//
// "Has the keyboard" is main's truth, `webContents.getFocusedWebContents()` (`focusedWebContents`):
// the shell page keeps its own `document.activeElement` while a page has the keyboard, and
// Playwright emulates page focus, so a DOM check alone would pass while the keyboard is elsewhere.
// A spec that needs to see main move the focus resets the DOM state first (`blurAddressBar`) and
// gives the shell the keyboard the way a click would (`focusWebContents`); Playwright's own clicks
// and keys go straight to the renderer and move nothing.
import type { ElectronApplication } from '@playwright/test';

import { expect } from './expect';
import { test } from './fixtures';
import {
  focusWebContents,
  focusedWebContents,
  selectedTabId,
  sendKey,
  setSearchTemplate,
  tabState,
} from './hooks';
import type { TabId } from './hooks';
import { observeFor } from './launch';
import {
  blurAddressBar,
  closeWithButton,
  fieldSelection,
  findBar,
  findField,
  loadTab,
  mainIds,
  newTabButton,
  newTabSearchBox,
  omnibox,
  openNewTab,
  tabElement,
  tabElements,
  typeAddress,
  waitForLoaded,
} from './shell-ui';

test.describe.configure({ timeout: 120_000 });

/** Waits until `webContentsId` is the web contents with the keyboard. */
async function expectPageFocused(app: ElectronApplication, webContentsId: number): Promise<void> {
  await expect
    .poll(async () => (await focusedWebContents(app))?.webContentsId, {
      message: `web contents ${String(webContentsId)} should have the keyboard`,
    })
    .toBe(webContentsId);
}

/** Waits until the shell has the keyboard. */
async function expectShellFocused(app: ElectronApplication): Promise<void> {
  await expect
    .poll(async () => (await focusedWebContents(app))?.isShell, {
      message: 'the shell should have the keyboard',
    })
    .toBe(true);
}

async function webContentsIdOf(app: ElectronApplication, tabId: TabId): Promise<number> {
  const id = (await tabState(app, tabId))?.webContentsId;
  if (id === null || id === undefined) {
    throw new Error(`Tab ${tabId} has no web contents.`);
  }
  return id;
}

test.describe('focus', () => {
  test.beforeEach(async ({ electronApp, fixtureServer, shell }) => {
    await setSearchTemplate(electronApp, fixtureServer.url('/search?q={searchTerms}'));
    await expect(tabElements(shell)).toHaveCount(1);
  });

  test('Ctrl+L gives the keyboard to the address bar, with its text selected', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const address = fixtureServer.url('/page-a.html?case=focus-ctrl-l');
    const tab = await loadTab(electronApp, shell, address);
    // After a typed navigation the page has the keyboard.
    await expectPageFocused(electronApp, tab.webContentsId);
    await blurAddressBar(shell);

    await sendKey(electronApp, 'focused', 'L', ['control']);

    await expectShellFocused(electronApp);
    await expect(omnibox(shell)).toBeFocused();
    await expect(omnibox(shell)).toHaveValue(address);
    expect(await fieldSelection(omnibox(shell))).toEqual([0, address.length]);
  });

  test('Ctrl+T and the "New tab" button focus the new tab\'s address bar, empty', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/page-a.html?case=focus-new'));
    await expectPageFocused(electronApp, tab.webContentsId);
    await blurAddressBar(shell);

    await sendKey(electronApp, 'focused', 'T', ['control']);

    await expectShellFocused(electronApp);
    await expect(omnibox(shell)).toBeFocused();
    await expect(omnibox(shell)).toHaveValue('');
    const created = await selectedTabId(electronApp);
    expect(created).not.toBe(tab.tabId);

    // The button does the same from a page: select the page again (a click gives it the keyboard).
    await tabElement(shell, tab.tabId).click();
    await expectPageFocused(electronApp, tab.webContentsId);
    await blurAddressBar(shell);
    const before = await mainIds(electronApp);
    // A real click on the button first gives the shell the keyboard; Playwright's does not.
    await focusWebContents(electronApp, 'shell');
    await newTabButton(shell).click();
    await expect.poll(async () => (await mainIds(electronApp)).length).toBe(before.length + 1);
    await expect(omnibox(shell)).toBeFocused();
    await expectShellFocused(electronApp);
  });

  test('a typed navigation gives the page the keyboard when it commits, not when Enter is pressed', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tabId = await openNewTab(shell);
    await expectShellFocused(electronApp);

    // A page that is held back: Enter has been pressed, nothing has committed.
    const held = fixtureServer.url('/held?key=focus-commit');
    await typeAddress(shell, held);
    await expect.poll(async () => (await tabState(electronApp, tabId))?.loading).toBe(true);
    expect(
      await observeFor(700, async () => (await focusedWebContents(electronApp))?.isShell ?? null),
    ).toEqual([true]);

    // It commits: the page has the keyboard.
    fixtureServer.release('focus-commit');
    await waitForLoaded(electronApp, tabId);
    await expectPageFocused(electronApp, await webContentsIdOf(electronApp, tabId));
    await expect(omnibox(shell)).not.toBeFocused();

    // A second typed navigation in the same tab does the same, and so does a search.
    await sendKey(electronApp, 'focused', 'L', ['control']);
    await expectShellFocused(electronApp);
    await typeAddress(shell, fixtureServer.url('/page-b.html?case=focus-commit'));
    await expect.poll(async () => (await tabState(electronApp, tabId))?.title).toBe('Page B');
    await expectPageFocused(electronApp, await webContentsIdOf(electronApp, tabId));

    await sendKey(electronApp, 'focused', 'L', ['control']);
    await expectShellFocused(electronApp);
    await typeAddress(shell, 'focus search terms');
    await expect
      .poll(async () => (await tabState(electronApp, tabId))?.title)
      .toBe('Search results for: focus search terms');
    await expectPageFocused(electronApp, await webContentsIdOf(electronApp, tabId));
  });

  test('F6 cycles the address bar, the sidebar’s selected tab and the page (M6.2); a new-tab page’s stop is its search box', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/page-a.html?case=focus-f6'));
    await expectPageFocused(electronApp, tab.webContentsId);

    await blurAddressBar(shell);
    await sendKey(electronApp, 'focused', 'F6');
    await expectShellFocused(electronApp);
    await expect(omnibox(shell)).toBeFocused();

    await sendKey(electronApp, 'focused', 'F6');
    await expect(tabElement(shell, tab.tabId)).toBeFocused();
    await expectShellFocused(electronApp);

    await sendKey(electronApp, 'focused', 'F6');
    await expectPageFocused(electronApp, tab.webContentsId);

    // A new-tab page is drawn by the shell, so its search box is the page's stop.
    await sendKey(electronApp, 'focused', 'T', ['control']);
    await expectShellFocused(electronApp);
    await expect(omnibox(shell)).toBeFocused();
    const newTab = await selectedTabId(electronApp);
    expect(newTab).not.toBe(tab.tabId);
    // Main focuses the address bar at once, before the snapshot that selects the new tab reaches
    // the shell; F6's next stop is the tab the shell shows as selected, so wait for the shell.
    await expect(tabElement(shell, newTab ?? '')).toHaveAttribute('aria-selected', 'true');
    await sendKey(electronApp, 'focused', 'F6');
    await expect(tabElement(shell, newTab ?? '')).toBeFocused();
    await sendKey(electronApp, 'focused', 'F6');
    await expect(newTabSearchBox(shell)).toBeFocused();
    await expectShellFocused(electronApp);
    await sendKey(electronApp, 'focused', 'F6');
    await expect(omnibox(shell)).toBeFocused();
  });

  test('Ctrl+F from the address bar opens the find bar; Escape there gives the keyboard to the page', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/find.html'));
    await sendKey(electronApp, 'focused', 'L', ['control']);
    await expect(omnibox(shell)).toBeFocused();
    await expectShellFocused(electronApp);

    // The keyboard is in the address bar, and Ctrl+F still opens the find bar and moves into it.
    await sendKey(electronApp, 'focused', 'F', ['control']);
    await expect(findBar(shell)).toBeVisible();
    await expect(findField(shell)).toBeFocused();
    await expectShellFocused(electronApp);

    await findField(shell).fill('zebra');
    await findField(shell).press('Escape');

    await expect(findBar(shell)).toHaveCount(0);
    await expectPageFocused(electronApp, tab.webContentsId);
  });

  test('Enter and Space in the sidebar select a tab and keep the keyboard in the sidebar', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tabA = await loadTab(
      electronApp,
      shell,
      fixtureServer.url('/page-a.html?case=focus-side'),
    );
    const tabB = await loadTab(
      electronApp,
      shell,
      fixtureServer.url('/page-b.html?case=focus-side'),
    );
    await expectPageFocused(electronApp, tabB.webContentsId);

    // The user tabs into the sidebar: the shell has the keyboard, on a tab that is not selected.
    await focusWebContents(electronApp, 'shell');
    await tabElement(shell, tabA.tabId).focus();
    await tabElement(shell, tabA.tabId).press('Enter');

    await expect.poll(() => selectedTabId(electronApp)).toBe(tabA.tabId);
    // Selected, but the keyboard stays on the tab element in the shell, not in A's page.
    await expect(tabElement(shell, tabA.tabId)).toBeFocused();
    expect(
      await observeFor(500, async () => (await focusedWebContents(electronApp))?.isShell ?? null),
    ).toEqual([true]);

    // Space is the same.
    await tabElement(shell, tabB.tabId).focus();
    await tabElement(shell, tabB.tabId).press(' ');
    await expect.poll(() => selectedTabId(electronApp)).toBe(tabB.tabId);
    await expect(tabElement(shell, tabB.tabId)).toBeFocused();
    expect((await focusedWebContents(electronApp))?.isShell).toBe(true);
  });

  test('a click on a web tab in the sidebar gives its page the keyboard', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tabA = await loadTab(
      electronApp,
      shell,
      fixtureServer.url('/page-a.html?case=focus-click'),
    );
    const tabB = await loadTab(
      electronApp,
      shell,
      fixtureServer.url('/page-b.html?case=focus-click'),
    );
    await expectPageFocused(electronApp, tabB.webContentsId);

    // A click lands in the shell first (it takes the keyboard), then selects the tab.
    await focusWebContents(electronApp, 'shell');
    await expectShellFocused(electronApp);
    await tabElement(shell, tabA.tabId).click();

    await expect.poll(() => selectedTabId(electronApp)).toBe(tabA.tabId);
    await expectPageFocused(electronApp, tabA.webContentsId);
  });

  test('Delete in the sidebar closes the tab and keeps the keyboard in the sidebar; the Close button hands it to the next page', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tabA = await loadTab(
      electronApp,
      shell,
      fixtureServer.url('/page-a.html?case=focus-close'),
    );
    const tabB = await loadTab(
      electronApp,
      shell,
      fixtureServer.url('/page-b.html?case=focus-close'),
    );
    const tabC = await loadTab(
      electronApp,
      shell,
      fixtureServer.url('/page-c.html?case=focus-close'),
    );

    // Delete on the selected tab C: it closes, B is selected, and the keyboard stays in the sidebar.
    await focusWebContents(electronApp, 'shell');
    await tabElement(shell, tabC.tabId).focus();
    await tabElement(shell, tabC.tabId).press('Delete');
    await expect.poll(() => tabState(electronApp, tabC.tabId)).toBeUndefined();
    await expect.poll(() => selectedTabId(electronApp)).toBe(tabB.tabId);
    await expectShellFocused(electronApp);
    await expect(tabElement(shell, tabB.tabId)).toBeFocused();

    // The mouse's Close button on B: A takes its place, and A's page has the keyboard.
    await closeWithButton(shell, tabB.tabId);
    await expect.poll(() => tabState(electronApp, tabB.tabId)).toBeUndefined();
    await expect.poll(() => selectedTabId(electronApp)).toBe(tabA.tabId);
    await expectPageFocused(electronApp, tabA.webContentsId);
  });

  test('a tab selected with a shortcut gets the keyboard in its page, or in the address bar for a new tab', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const [first] = await mainIds(electronApp);
    const tabA = await loadTab(
      electronApp,
      shell,
      fixtureServer.url('/page-a.html?case=focus-switch'),
    );
    await expectPageFocused(electronApp, tabA.webContentsId);

    // Ctrl+1 selects the new-tab page: the address bar has the keyboard.
    await blurAddressBar(shell);
    await sendKey(electronApp, 'focused', '1', ['control']);
    await expect.poll(() => selectedTabId(electronApp)).toBe(first);
    await expectShellFocused(electronApp);
    await expect(omnibox(shell)).toBeFocused();

    // Ctrl+2 selects A: its page has the keyboard.
    await sendKey(electronApp, 'focused', '2', ['control']);
    await expect.poll(() => selectedTabId(electronApp)).toBe(tabA.tabId);
    await expectPageFocused(electronApp, tabA.webContentsId);
  });
});
