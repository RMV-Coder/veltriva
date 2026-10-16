// Tabs, M1.3a (ADR-0003, ADR-0005): opening, switching, closing, pinning and reordering, driven
// through the shell UI a user touches (src/renderer/features/sidebar). Main is authoritative: after
// each step the specs compare the sidebar with TabManager's own view (`tabStates`) and with where
// the selected tab's native view sits (`expectConsistent` in ./shell-ui.ts).
//
// Tabs that only need to exist are new-tab pages: they are quick and have no web contents. Tabs
// that must be "live" load a fixture page through the address bar.
import { expect } from './expect';
import { test } from './fixtures';
import {
  contentRect,
  pageForTab,
  selectedTabId,
  setSearchTemplate,
  tabState,
  tabStates,
  webContentsRoles,
} from './hooks';
import {
  closeWithButton,
  dragTab,
  expectConsistent,
  internalPage,
  loadInNewTab,
  mainIds,
  newTabSearchBox,
  openNewTab,
  sidebarIds,
  sidebarLabels,
  sidebarTabs,
  tabElement,
  tabElements,
  tabList,
  tabRow,
  togglePinWithButton,
} from './shell-ui';

// Every test opens several tabs, and the machine may be busy.
test.describe.configure({ timeout: 120_000 });

test.describe('tabs', () => {
  test.beforeEach(async ({ electronApp, fixtureServer, shell }) => {
    // Nothing here searches, but a stray Enter in the address bar must never reach the internet.
    await setSearchTemplate(electronApp, fixtureServer.url('/search?q={searchTerms}'));
    await expect(tabElements(shell)).toHaveCount(1);
  });

  test('starts with one selected tab on the new-tab page', async ({ electronApp, shell }) => {
    await expect(tabList(shell)).toBeVisible();
    await expect(shell.locator('h1')).toHaveCount(1);
    await expect(shell.getByRole('heading', { level: 1, name: 'Veltriva Browser' })).toBeVisible();
    await expect(internalPage(shell, 'new-tab')).toBeVisible();
    await expect(newTabSearchBox(shell)).toBeVisible();
    await expect(shell.getByRole('button', { name: 'About this build' })).toBeVisible();

    const [tab, ...others] = await sidebarTabs(shell);
    expect(others).toEqual([]);
    expect(tab).toMatchObject({ label: 'New Tab', selected: true, pinned: false, status: null });

    // The new-tab page is drawn by the shell: no web contents, no view.
    const states = await tabStates(electronApp);
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({
      id: tab?.id,
      page: { kind: 'internal', name: 'new-tab' },
      runtime: 'unloaded',
      url: '',
      webContentsId: null,
      devToolsTargetId: null,
      attached: false,
      bounds: null,
    });
    expect(await selectedTabId(electronApp)).toBe(tab?.id);
    await expectConsistent(electronApp, shell);
  });

  test('opens a selected tab with each click on "New tab"', async ({ electronApp, shell }) => {
    const [first] = await sidebarIds(shell);
    const second = await openNewTab(shell);
    await expectConsistent(electronApp, shell);
    const third = await openNewTab(shell);
    await expectConsistent(electronApp, shell);

    expect(await sidebarIds(shell)).toEqual([first, second, third]);
    expect(await mainIds(electronApp)).toEqual([first, second, third]);
    expect(await selectedTabId(electronApp)).toBe(third);
    expect((await sidebarTabs(shell)).map((tab) => tab.selected)).toEqual([false, false, true]);
    expect(await sidebarLabels(shell)).toEqual(['New Tab', 'New Tab', 'New Tab']);
  });

  test('switches tabs by clicking, attaching only the selected web view', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const [blankTab] = await sidebarIds(shell);
    if (blankTab === undefined) {
      throw new Error('the app starts with a tab');
    }
    const tabA = await loadInNewTab(electronApp, shell, fixtureServer.url('/page-a.html'));
    const tabB = await loadInNewTab(electronApp, shell, fixtureServer.url('/page-b.html'));
    await expect.poll(() => sidebarLabels(shell)).toEqual(['New Tab', 'Page A', 'Page B']);

    // Loading selected B: only its view is attached, over the content area.
    await expectConsistent(electronApp, shell);
    expect(await selectedTabId(electronApp)).toBe(tabB);
    expect((await tabState(electronApp, tabA))?.attached).toBe(false);

    await tabElement(shell, tabA).click();
    await expect(tabElement(shell, tabA)).toHaveAttribute('aria-selected', 'true');
    await expectConsistent(electronApp, shell);
    expect(await selectedTabId(electronApp)).toBe(tabA);
    expect(await tabState(electronApp, tabA)).toMatchObject({ attached: true, runtime: 'live' });

    // B is hidden, not closed: its web contents is alive and keeps its page.
    const hiddenB = await tabState(electronApp, tabB);
    expect(hiddenB).toMatchObject({ attached: false, runtime: 'live', title: 'Page B' });
    expect(hiddenB?.webContentsId).not.toBeNull();
    expect(await (await pageForTab(electronApp, tabB)).title()).toBe('Page B');

    // The new-tab page has no view at all: selecting it detaches every web view.
    await tabElement(shell, blankTab).click();
    await expect(tabElement(shell, blankTab)).toHaveAttribute('aria-selected', 'true');
    await expect(internalPage(shell, 'new-tab')).toBeVisible();
    await expectConsistent(electronApp, shell);
    expect((await tabStates(electronApp)).filter((tab) => tab.attached)).toEqual([]);

    await tabElement(shell, tabB).click();
    await expect(tabElement(shell, tabB)).toHaveAttribute('aria-selected', 'true');
    await expect(internalPage(shell, 'new-tab')).toHaveCount(0);
    await expectConsistent(electronApp, shell);
    expect(await selectedTabId(electronApp)).toBe(tabB);
  });

  test('closes a tab with its Close button and selects the tab that took its place', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const [blankTab] = await sidebarIds(shell);
    const tabA = await loadInNewTab(electronApp, shell, fixtureServer.url('/page-a.html'));
    const tabB = await loadInNewTab(electronApp, shell, fixtureServer.url('/page-b.html'));
    const closedWebContents = (await tabState(electronApp, tabA))?.webContentsId;
    expect(closedWebContents).toBeTruthy();

    // Select the middle tab, then close it: the next one takes its place.
    await tabElement(shell, tabA).click();
    await expect(tabElement(shell, tabA)).toHaveAttribute('aria-selected', 'true');
    await closeWithButton(shell, tabA);

    await expect.poll(() => sidebarIds(shell)).toEqual([blankTab, tabB]);
    await expect(tabElement(shell, tabB)).toHaveAttribute('aria-selected', 'true');
    await expectConsistent(electronApp, shell);
    expect(await selectedTabId(electronApp)).toBe(tabB);

    // Closing destroys the tab's web contents (ADR-0002 §2), it doesn't just hide it.
    const roles = await webContentsRoles(electronApp);
    expect(roles.map((entry) => entry.webContentsId)).not.toContain(closedWebContents);
  });

  test('selects the previous tab when the selected last tab is closed', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const [blankTab] = await sidebarIds(shell);
    const tabA = await loadInNewTab(electronApp, shell, fixtureServer.url('/page-a.html'));
    const tabB = await loadInNewTab(electronApp, shell, fixtureServer.url('/page-b.html'));

    await closeWithButton(shell, tabB); // B is selected and last
    await expect.poll(() => sidebarIds(shell)).toEqual([blankTab, tabA]);
    await expect(tabElement(shell, tabA)).toHaveAttribute('aria-selected', 'true');
    await expectConsistent(electronApp, shell);
    expect(await selectedTabId(electronApp)).toBe(tabA);
  });

  test('keeps the selection when another tab is closed', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const [blankTab] = await sidebarIds(shell);
    const tabA = await loadInNewTab(electronApp, shell, fixtureServer.url('/page-a.html'));

    // A is selected; close the unselected new-tab page.
    await closeWithButton(shell, blankTab ?? '');
    await expect.poll(() => sidebarIds(shell)).toEqual([tabA]);
    await expect(tabElement(shell, tabA)).toHaveAttribute('aria-selected', 'true');
    await expectConsistent(electronApp, shell);
    expect(await tabState(electronApp, tabA)).toMatchObject({ attached: true, runtime: 'live' });
  });

  test('closes the focused tab with Delete and moves focus to its neighbor', async ({
    electronApp,
    shell,
  }) => {
    const [first] = await sidebarIds(shell);
    const second = await openNewTab(shell);
    const third = await openNewTab(shell);

    // Delete on the middle tab: focus goes to the tab after it.
    await tabElement(shell, second).focus();
    await shell.keyboard.press('Delete');
    await expect.poll(() => sidebarIds(shell)).toEqual([first, third]);
    await expect(tabElement(shell, third)).toBeFocused();
    await expectConsistent(electronApp, shell);

    // Delete on the last tab: focus goes to the one before it.
    await shell.keyboard.press('Delete');
    await expect.poll(() => sidebarIds(shell)).toEqual([first]);
    await expect(tabElement(shell, first ?? '')).toBeFocused();
    await expectConsistent(electronApp, shell);
    expect(await selectedTabId(electronApp)).toBe(first);
  });

  test('leaves a fresh new tab when the last tab is closed', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    // First with the new-tab page itself...
    const [original] = await sidebarIds(shell);
    await closeWithButton(shell, original ?? '');
    await expect
      .poll(async () => (await sidebarIds(shell)).filter((id) => id !== original))
      .toHaveLength(1);
    const [fresh, ...rest] = await sidebarIds(shell);
    expect(rest).toEqual([]);
    expect(fresh).not.toBe(original);
    await expect(internalPage(shell, 'new-tab')).toBeVisible();
    await expectConsistent(electronApp, shell);

    // ...then with a live web page, whose contents must be destroyed.
    const tabA = await loadInNewTab(electronApp, shell, fixtureServer.url('/page-a.html'));
    const webContentsId = (await tabState(electronApp, tabA))?.webContentsId;
    await closeWithButton(shell, fresh ?? '');
    await expect.poll(() => sidebarIds(shell)).toEqual([tabA]);
    await closeWithButton(shell, tabA);
    await expect.poll(async () => (await sidebarIds(shell)).includes(tabA)).toBe(false);

    const [last, ...others] = await sidebarTabs(shell);
    expect(others).toEqual([]);
    expect(last).toMatchObject({ label: 'New Tab', selected: true });
    expect(last?.id).not.toBe(tabA);
    await expect(internalPage(shell, 'new-tab')).toBeVisible();
    await expectConsistent(electronApp, shell);
    expect(await mainIds(electronApp)).toEqual([last?.id]);
    expect((await webContentsRoles(electronApp)).map((entry) => entry.webContentsId)).not.toContain(
      webContentsId,
    );
  });

  test('pins and unpins tabs, moving pinned tabs to the top', async ({ electronApp, shell }) => {
    const [first] = await sidebarIds(shell);
    const second = await openNewTab(shell);
    const third = await openNewTab(shell);
    if (first === undefined) {
      throw new Error('the app starts with a tab');
    }

    // Pin the last tab: it moves to the top, in the pinned section.
    await togglePinWithButton(shell, third);
    await expect.poll(() => sidebarIds(shell)).toEqual([third, first, second]);
    await expect(tabElement(shell, third)).toHaveAttribute('data-pinned', 'true');
    await expect(tabElement(shell, first)).toHaveAttribute('data-pinned', 'false');
    expect(await mainIds(electronApp)).toEqual([third, first, second]);
    await expectConsistent(electronApp, shell);

    // The button now offers to unpin.
    const row = tabRow(shell, third);
    await row.hover();
    await expect(
      row.getByRole('button', { name: 'Unpin tab', exact: true, includeHidden: true }),
    ).toHaveCount(1);
    await expect(
      row.getByRole('button', { name: 'Pin tab', exact: true, includeHidden: true }),
    ).toHaveCount(0);

    // Pinning another tab puts it at the end of the pinned section.
    await togglePinWithButton(shell, second);
    await expect.poll(() => sidebarIds(shell)).toEqual([third, second, first]);
    expect((await sidebarTabs(shell)).map((tab) => tab.pinned)).toEqual([true, true, false]);
    expect((await tabStates(electronApp)).map((tab) => tab.pinned)).toEqual([true, true, false]);
    await expectConsistent(electronApp, shell);

    // Unpinning puts the tab at the start of the unpinned tabs.
    await togglePinWithButton(shell, third);
    await expect.poll(() => sidebarIds(shell)).toEqual([second, third, first]);
    expect((await sidebarTabs(shell)).map((tab) => tab.pinned)).toEqual([true, false, false]);
    await expect(tabElement(shell, third)).toHaveAttribute('data-pinned', 'false');
    expect(await mainIds(electronApp)).toEqual([second, third, first]);
    await expectConsistent(electronApp, shell);
  });

  test('moves a tab within its section with Alt+Shift+Arrow', async ({ electronApp, shell }) => {
    const [t0] = await sidebarIds(shell);
    const t1 = await openNewTab(shell);
    const t2 = await openNewTab(shell);
    const t3 = await openNewTab(shell);
    if (t0 === undefined) {
      throw new Error('the app starts with a tab');
    }

    const expectOrder = async (expected: string[]): Promise<void> => {
      await expect.poll(() => sidebarIds(shell)).toEqual(expected);
      expect(await mainIds(electronApp)).toEqual(expected);
    };

    await tabElement(shell, t1).focus();
    await shell.keyboard.press('Alt+Shift+ArrowDown');
    await expectOrder([t0, t2, t1, t3]);
    // The moved tab keeps the keyboard focus, so the next press continues from there.
    await expect(tabElement(shell, t1)).toBeFocused();

    // One press at a time: a press is a command with an absolute index, computed from the last
    // snapshot, so a second press before the new order arrives would repeat the first move.
    await shell.keyboard.press('Alt+Shift+ArrowUp');
    await expectOrder([t0, t1, t2, t3]);
    await expect(tabElement(shell, t1)).toBeFocused();
    await shell.keyboard.press('Alt+Shift+ArrowUp');
    await expectOrder([t1, t0, t2, t3]);
    await expect(tabElement(shell, t1)).toBeFocused();

    // At the top edge nothing happens.
    await shell.keyboard.press('Alt+Shift+ArrowUp');
    await expectOrder([t1, t0, t2, t3]);

    // A pinned tab doesn't leave the pinned section, and an unpinned one can't enter it.
    await togglePinWithButton(shell, t1);
    await expectOrder([t1, t0, t2, t3]);
    await tabElement(shell, t0).focus();
    await shell.keyboard.press('Alt+Shift+ArrowUp');
    await expectOrder([t1, t0, t2, t3]);
    await tabElement(shell, t1).focus();
    await shell.keyboard.press('Alt+Shift+ArrowDown');
    await expectOrder([t1, t0, t2, t3]);

    // The selection didn't change with any of this: the last tab opened is still selected.
    expect(await selectedTabId(electronApp)).toBe(t3);
    await expect(tabElement(shell, t3)).toHaveAttribute('aria-selected', 'true');
    await expectConsistent(electronApp, shell);
  });

  test("reorders with a pointer drag, within the dragged tab's section", async ({
    electronApp,
    shell,
  }) => {
    const [t0] = await sidebarIds(shell);
    const t1 = await openNewTab(shell);
    const t2 = await openNewTab(shell);
    const t3 = await openNewTab(shell);
    if (t0 === undefined) {
      throw new Error('the app starts with a tab');
    }
    const dropLine = shell.locator('[data-drop-indicator]');

    const expectOrder = async (expected: string[]): Promise<void> => {
      await expect.poll(() => sidebarIds(shell)).toEqual(expected);
      expect(await mainIds(electronApp)).toEqual(expected);
    };

    // t0 below t2: the drop line shows while the pointer is down, and goes when it is released.
    await expect(dropLine).toHaveCount(0);
    await dragTab(shell, t0, t2, 'after', async () => {
      await expect(dropLine).toHaveCount(1);
    });
    await expect(dropLine).toHaveCount(0);
    await expectOrder([t1, t2, t0, t3]);

    // t3 above t1, the first row.
    await dragTab(shell, t3, t1, 'before', async () => {
      await expect(dropLine).toHaveCount(1);
    });
    await expectOrder([t3, t1, t2, t0]);

    // Dragging doesn't select: t3 was selected when it was created, and still is, and a drag of
    // an unselected tab leaves the selection alone.
    expect(await selectedTabId(electronApp)).toBe(t3);
    await dragTab(shell, t0, t1, 'before');
    await expectOrder([t3, t0, t1, t2]);
    expect(await selectedTabId(electronApp)).toBe(t3);
    await expect(tabElement(shell, t3)).toHaveAttribute('aria-selected', 'true');
    await expectConsistent(electronApp, shell);

    // A pinned tab at the top; dragging an unpinned tab above it stays in the unpinned section.
    await togglePinWithButton(shell, t3);
    await expectOrder([t3, t0, t1, t2]);
    await dragTab(shell, t2, t3, 'before');
    await expectOrder([t3, t2, t0, t1]);
    expect((await sidebarTabs(shell)).map((tab) => tab.pinned)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    await expectConsistent(electronApp, shell);
  });

  test('moves focus with the arrow keys, Home and End, and selects with Enter and Space', async ({
    electronApp,
    shell,
  }) => {
    const [t0] = await sidebarIds(shell);
    const t1 = await openNewTab(shell);
    const t2 = await openNewTab(shell);
    if (t0 === undefined) {
      throw new Error('the app starts with a tab');
    }

    await tabElement(shell, t2).focus(); // the selected tab is the list's tab stop
    await shell.keyboard.press('ArrowDown'); // wraps around from the last to the first
    await expect(tabElement(shell, t0)).toBeFocused();
    await shell.keyboard.press('ArrowUp'); // and back
    await expect(tabElement(shell, t2)).toBeFocused();
    await shell.keyboard.press('Home');
    await expect(tabElement(shell, t0)).toBeFocused();
    await shell.keyboard.press('ArrowDown');
    await expect(tabElement(shell, t1)).toBeFocused();
    await shell.keyboard.press('End');
    await expect(tabElement(shell, t2)).toBeFocused();

    // Moving focus doesn't select (manual activation); Enter and Space do.
    expect(await selectedTabId(electronApp)).toBe(t2);
    await shell.keyboard.press('Home');
    await expect(tabElement(shell, t0)).toBeFocused();
    expect(await selectedTabId(electronApp)).toBe(t2);
    await shell.keyboard.press('Enter');
    await expect(tabElement(shell, t0)).toHaveAttribute('aria-selected', 'true');
    expect(await selectedTabId(electronApp)).toBe(t0);

    await shell.keyboard.press('ArrowDown');
    await expect(tabElement(shell, t1)).toBeFocused();
    await shell.keyboard.press('Space');
    await expect(tabElement(shell, t1)).toHaveAttribute('aria-selected', 'true');
    expect(await selectedTabId(electronApp)).toBe(t1);
    await expectConsistent(electronApp, shell);
  });

  test('keeps one selected tab and one attached view through a sequence of changes', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const [blankTab] = await sidebarIds(shell);
    await expectConsistent(electronApp, shell, 'at the start');

    const tabA = await loadInNewTab(electronApp, shell, fixtureServer.url('/page-a.html'));
    await expectConsistent(electronApp, shell, 'after loading A');
    const tabB = await loadInNewTab(electronApp, shell, fixtureServer.url('/page-b.html'));
    await expectConsistent(electronApp, shell, 'after loading B');

    await togglePinWithButton(shell, tabB);
    await expect.poll(() => sidebarIds(shell)).toEqual([tabB, blankTab, tabA]);
    await expectConsistent(electronApp, shell, 'after pinning the selected tab B');

    await tabElement(shell, tabA).click();
    await expect(tabElement(shell, tabA)).toHaveAttribute('aria-selected', 'true');
    await expectConsistent(electronApp, shell, 'after selecting A');

    await tabElement(shell, blankTab ?? '').click();
    await expect(internalPage(shell, 'new-tab')).toBeVisible();
    await expectConsistent(electronApp, shell, 'after selecting the new-tab page');

    await closeWithButton(shell, tabB);
    await expect.poll(() => sidebarIds(shell)).toEqual([blankTab, tabA]);
    await expectConsistent(electronApp, shell, 'after closing the pinned tab B');

    await closeWithButton(shell, blankTab ?? '');
    await expect.poll(() => sidebarIds(shell)).toEqual([tabA]);
    await expect(tabElement(shell, tabA)).toHaveAttribute('aria-selected', 'true');
    await expectConsistent(electronApp, shell, 'after closing the new-tab page');
    expect(await tabState(electronApp, tabA)).toMatchObject({ attached: true });
  });

  test('keeps the selected view over the content area when the window is resized', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tabId = await loadInNewTab(electronApp, shell, fixtureServer.url('/page-a.html'));
    await expectConsistent(electronApp, shell, 'before resizing');
    const before = await contentRect(electronApp);

    // The shell reports its chrome again, and the layout manager refits the view.
    await electronApp.evaluate(({ BaseWindow }) => {
      BaseWindow.getAllWindows()[0]?.setContentSize(900, 640);
    });
    await expect
      .poll(async () => (await contentRect(electronApp)).width)
      .toBeLessThan(before.width);
    await expectConsistent(electronApp, shell, 'after making the window smaller');
    expect(await tabState(electronApp, tabId)).toMatchObject({ attached: true });

    await electronApp.evaluate(({ BaseWindow }) => {
      BaseWindow.getAllWindows()[0]?.setContentSize(1100, 760);
    });
    await expect.poll(async () => (await contentRect(electronApp)).width).toBeGreaterThan(600);
    await expectConsistent(electronApp, shell, 'after making the window larger');
  });
});
