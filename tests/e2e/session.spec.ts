// Session restore, M2.2a (assessment §5.9, ADR-0003 items 6 and 8, spike S2): what Veltriva brings
// back when it starts again on the same profile. Every test here launches the app more than once
// on one profile (`launcher`, ./session-ui.ts), so what comes back really went through the
// database: the session store writes the tabs, Recently closed and the window; the next start
// reads them, restores the selected tab into a new web contents and leaves the others unloaded.
//
// Rules from ADR-0008 item 4 that matter here:
//  - Before quitting or killing the app, wait until the database holds the change (`expectSaved`):
//    the store writes 250 ms to 1 s after one. The one test that does not wait (the last
//    quit-flush test) is about exactly that.
//  - Keys are sent from main with `sendInputEvent` (`sendKey`), never through Playwright's keyboard.
//  - Pages come from the local fixture server; searches point at it (the launcher sets that).
//  - Nothing here closes a tab's Page, and tabs are found by id, never by position.
//
// What restore brings back is the stack, the titles and the addresses. Scroll and form values are
// not persisted (S2), so no test expects them.
//
// Two things the app does on this Windows machine that these specs work around or mark:
//  - A launch soon after a hard kill often fails (the database cannot be opened with
//    SQLITE_IOERR_TRUNCATE, or Chromium cannot create its lock file). `launchAfterKill`
//    (./session-ui.ts) launches again and records each failure as a test annotation.
//  - A window restored at a fractional display scale opens a few pixels bigger than it was saved.
//    That test is marked `test.fail` for fractional scales only.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ElectronApplication } from '@playwright/test';

import { expect } from './expect';
import { selectedTabId, sendKey, tabState, tabStates, webContentsRoles } from './hooks';
import { appPaths, buildLaunchEnv, observeFor } from './launch';
import type { Launcher } from './session-ui';
import {
  dataReadyOf,
  dataValue,
  displayScaleFactor,
  expectSaved,
  killProcessTree,
  mainNotices,
  maximizeWindow,
  noticeStrip,
  placeTestWindow,
  readSavedSession,
  sameBounds,
  startWithPages,
  test,
  windowGeometry,
} from './session-ui';
import {
  backButton,
  closeWithButton,
  expectConsistent,
  forwardButton,
  internalPage,
  loadInNewTab,
  mainIds,
  newTabSearchBox,
  omnibox,
  openNewTab,
  reloadButton,
  sidebarIds,
  sidebarTabs,
  tabElement,
  togglePinWithButton,
  typeAddress,
  waitForLoaded,
  waitForPage,
} from './shell-ui';

// Each test starts the app two or three times, and the machine may be busy.
test.describe.configure({ timeout: 180_000 });

/** The back/forward stack Chromium holds for a web contents, read in main. */
function chromiumStack(
  app: ElectronApplication,
  webContentsId: number,
): Promise<{ index: number; urls: string[] } | null> {
  return app.evaluate(({ webContents }, id) => {
    const contents = webContents.fromId(id);
    if (contents === undefined) {
      return null;
    }
    return {
      index: contents.navigationHistory.getActiveIndex(),
      urls: contents.navigationHistory.getAllEntries().map((entry) => entry.url),
    };
  }, webContentsId);
}

/** How many tab web contents the app has: unloaded tabs have none. */
async function tabContentsCount(app: ElectronApplication): Promise<number> {
  return (await webContentsRoles(app)).filter((entry) => entry.role === 'tab').length;
}

test.describe('the tabs come back', () => {
  test('in their order, pinned first, with title and address; only the selected tab loads', async ({
    launcher,
    fixtureServer,
  }) => {
    const urlA = fixtureServer.url('/page-a.html?case=session-order');
    const urlB = fixtureServer.url('/page-b.html?case=session-order');
    const urlC = fixtureServer.url('/page-c.html?case=session-order');

    const first = await launcher.launch();
    expect(await dataReadyOf(first.app)).toMatchObject({ previousExit: 'none' });
    const [a, b, c] = await startWithPages(first.app, first.shell, [urlA, urlB, urlC]);
    // C was opened last; pinning it moves it to the front. A, the second tab, is selected.
    await togglePinWithButton(first.shell, c);
    await expect.poll(() => sidebarIds(first.shell)).toEqual([c, a, b]);
    await tabElement(first.shell, a).click();
    await expect(tabElement(first.shell, a)).toHaveAttribute('aria-selected', 'true');
    await expectSaved(first.app, { ids: [c, a, b], pinnedIds: [c], selectedTabId: a });
    await launcher.quit(first);

    const { app, shell } = await launcher.launch();
    // A clean exit leaves nothing to explain.
    expect(await dataReadyOf(app)).toMatchObject({ previousExit: 'clean' });
    expect(await mainNotices(app)).toEqual([]);

    await expect.poll(() => sidebarIds(shell)).toEqual([c, a, b]);
    expect((await sidebarTabs(shell)).map((tab) => [tab.label, tab.pinned, tab.selected])).toEqual([
      ['Page C', true, false],
      ['Page A', false, true],
      ['Page B', false, false],
    ]);
    expect(await selectedTabId(app)).toBe(a);

    // The selected tab loads; the other two stay unloaded: no web contents, the saved address.
    await waitForLoaded(app, a);
    const states = await tabStates(app);
    expect(
      states.map((tab) => ({
        id: tab.id,
        pinned: tab.pinned,
        runtime: tab.runtime,
        url: tab.url,
        title: tab.title,
        hasWebContents: tab.webContentsId !== null,
      })),
    ).toEqual([
      {
        id: c,
        pinned: true,
        runtime: 'unloaded',
        url: urlC,
        title: 'Page C',
        hasWebContents: false,
      },
      { id: a, pinned: false, runtime: 'live', url: urlA, title: 'Page A', hasWebContents: true },
      {
        id: b,
        pinned: false,
        runtime: 'unloaded',
        url: urlB,
        title: 'Page B',
        hasWebContents: false,
      },
    ]);
    expect(await tabContentsCount(app)).toBe(1);
    await expect(omnibox(shell)).toHaveValue(urlA);
    await expectConsistent(app, shell);

    // Selecting another tab loads it, and only it.
    await tabElement(shell, b).click();
    await expect(tabElement(shell, b)).toHaveAttribute('aria-selected', 'true');
    await waitForLoaded(app, b);
    expect(await tabState(app, b)).toMatchObject({
      runtime: 'live',
      url: urlB,
      title: 'Page B',
      attached: true,
    });
    expect(await tabState(app, c)).toMatchObject({ runtime: 'unloaded', webContentsId: null });
    expect(await tabContentsCount(app)).toBe(2);
    await expect(omnibox(shell)).toHaveValue(urlB);
    await expectConsistent(app, shell);
  });

  test('with the back and forward stack: Back and Forward walk the same pages', async ({
    launcher,
    fixtureServer,
  }) => {
    const urlA = fixtureServer.url('/page-a.html?case=session-stack');
    const urlB = fixtureServer.url('/page-b.html?case=session-stack');
    const urlC = fixtureServer.url('/page-c.html?case=session-stack');

    const first = await launcher.launch();
    const [tab] = await startWithPages(first.app, first.shell, [urlA]);
    await typeAddress(first.shell, urlB);
    await waitForPage(first.app, tab, { url: urlB, title: 'Page B' });
    await typeAddress(first.shell, urlC);
    await waitForPage(first.app, tab, { url: urlC, title: 'Page C' });
    await expectSaved(first.app, {
      urls: { [tab]: urlC },
      stacks: { [tab]: { index: 2, urls: [urlA, urlB, urlC] } },
    });
    await launcher.quit(first);

    const { app, shell } = await launcher.launch();
    // The tab shows C, the page it was on.
    await waitForPage(app, tab, { url: urlC, title: 'Page C' });
    await expect(omnibox(shell)).toHaveValue(urlC);
    const restored = await tabState(app, tab);
    expect(restored?.webContentsId).not.toBeNull();
    expect(await chromiumStack(app, restored?.webContentsId ?? -1)).toEqual({
      index: 2,
      urls: [urlA, urlB, urlC],
    });
    await expect(backButton(shell)).toBeEnabled();
    await expect(forwardButton(shell)).toBeDisabled();

    // Back goes to B, then A; the address bar and the buttons follow.
    await backButton(shell).click();
    await waitForPage(app, tab, { url: urlB, title: 'Page B' });
    await expect(omnibox(shell)).toHaveValue(urlB);
    await expect(backButton(shell)).toBeEnabled();
    await expect(forwardButton(shell)).toBeEnabled();
    await backButton(shell).click();
    await waitForPage(app, tab, { url: urlA, title: 'Page A' });
    await expect(omnibox(shell)).toHaveValue(urlA);
    await expect(backButton(shell)).toBeDisabled();
    await expect(forwardButton(shell)).toBeEnabled();

    // Forward returns to B, then C.
    await forwardButton(shell).click();
    await waitForPage(app, tab, { url: urlB, title: 'Page B' });
    await expect(omnibox(shell)).toHaveValue(urlB);
    await forwardButton(shell).click();
    await waitForPage(app, tab, { url: urlC, title: 'Page C' });
    await expect(omnibox(shell)).toHaveValue(urlC);
    await expect(forwardButton(shell)).toBeDisabled();
  });

  test('a new-tab page stays a new-tab page, with no web contents', async ({
    launcher,
    fixtureServer,
  }) => {
    const urlA = fixtureServer.url('/page-a.html?case=session-newtab');

    const first = await launcher.launch();
    const [a] = await startWithPages(first.app, first.shell, [urlA]);
    const blank = await openNewTab(first.shell);
    // A new-tab page is saved by its typeable address, with no stack.
    await expectSaved(first.app, {
      ids: [a, blank],
      selectedTabId: blank,
      urls: { [blank]: 'veltriva://newtab', [a]: urlA },
      stacks: { [blank]: null },
    });
    await launcher.quit(first);

    const { app, shell } = await launcher.launch();
    await expect.poll(() => sidebarIds(shell)).toEqual([a, blank]);
    expect(await selectedTabId(app)).toBe(blank);
    await expect(internalPage(shell, 'new-tab')).toBeVisible();
    await expect(newTabSearchBox(shell)).toBeVisible();
    expect((await sidebarTabs(shell)).map((tab) => [tab.label, tab.selected])).toEqual([
      ['Page A', false],
      ['New Tab', true],
    ]);

    // Nothing is loaded: the new-tab page is drawn by the shell, and A waits unloaded.
    expect(await tabState(app, blank)).toMatchObject({
      page: { kind: 'internal', name: 'new-tab' },
      runtime: 'unloaded',
      url: '',
      title: '',
      webContentsId: null,
      attached: false,
    });
    expect(await tabState(app, a)).toMatchObject({ runtime: 'unloaded', webContentsId: null });
    expect(await tabContentsCount(app)).toBe(0);
    await expectConsistent(app, shell);

    // Selecting A loads it; coming back to the new-tab page gives it no web contents either.
    await tabElement(shell, a).click();
    await waitForLoaded(app, a);
    await tabElement(shell, blank).click();
    await expect(internalPage(shell, 'new-tab')).toBeVisible();
    expect(await tabState(app, blank)).toMatchObject({
      page: { kind: 'internal', name: 'new-tab' },
      webContentsId: null,
    });
    expect(await tabContentsCount(app)).toBe(1);
    // Saved again, it is still a new-tab page.
    await expectSaved(app, { urls: { [blank]: 'veltriva://newtab' }, stacks: { [blank]: null } });
  });
});

test.describe('Recently closed', () => {
  test('survives a restart: Ctrl+Shift+T brings the tab back with its id and its history', async ({
    launcher,
    fixtureServer,
  }) => {
    const urlKeep = fixtureServer.url('/page-c.html?case=session-closed');
    const urlA = fixtureServer.url('/page-a.html?case=session-closed');
    const urlB = fixtureServer.url('/page-b.html?case=session-closed');

    const first = await launcher.launch();
    const [keep, closing] = await startWithPages(first.app, first.shell, [urlKeep, urlA]);
    // The tab that will be closed has two entries: A, then B.
    await typeAddress(first.shell, urlB);
    await waitForPage(first.app, closing, { url: urlB, title: 'Page B' });
    await closeWithButton(first.shell, closing);
    await expect.poll(() => sidebarIds(first.shell)).toEqual([keep]);
    await expectSaved(first.app, {
      ids: [keep],
      closedIds: [closing],
      urls: { [closing]: urlB },
      stacks: { [closing]: { index: 1, urls: [urlA, urlB] } },
    });
    await launcher.quit(first);

    const { app, shell } = await launcher.launch();
    await expect.poll(() => sidebarIds(shell)).toEqual([keep]);
    await waitForLoaded(app, keep);

    await sendKey(app, 'shell', 'T', ['control', 'shift']);
    // The same tab is back in the strip, selected, loading the page it was closed on.
    await expect
      .poll(async () => (await mainIds(app)).slice().sort())
      .toEqual([closing, keep].sort());
    expect(await selectedTabId(app)).toBe(closing);
    await waitForPage(app, closing, { url: urlB, title: 'Page B' });
    await expect(omnibox(shell)).toHaveValue(urlB);
    const reopened = await tabState(app, closing);
    expect(await chromiumStack(app, reopened?.webContentsId ?? -1)).toEqual({
      index: 1,
      urls: [urlA, urlB],
    });

    // Back works: its history came with it.
    await expect(backButton(shell)).toBeEnabled();
    await backButton(shell).click();
    await waitForPage(app, closing, { url: urlA, title: 'Page A' });
    await expect(omnibox(shell)).toHaveValue(urlA);
    await forwardButton(shell).click();
    await waitForPage(app, closing, { url: urlB, title: 'Page B' });

    // It left Recently closed, and the database says so once it has caught up.
    await expectSaved(app, { closedIds: [], urls: { [closing]: urlB } });
    expect((await readSavedSession(app)).strip.map((row) => row.id).sort()).toEqual(
      [closing, keep].sort(),
    );
    // Nothing else is left to reopen: the shortcut changes nothing.
    await sendKey(app, 'shell', 'T', ['control', 'shift']);
    expect(await observeFor(500, async () => (await mainIds(app)).length)).toEqual([2]);
  });
});

test.describe('what never reaches the database', () => {
  test('token fragments and credentials are cut; an ordinary fragment is kept', async ({
    launcher,
    fixtureServer,
    userDataDir,
  }) => {
    const urlC = fixtureServer.url('/page-c.html?case=session-secrets');
    const plain = fixtureServer.url('/page-a.html?case=session-secrets');
    const tokenUrl = `${plain}#access_token=SECRET-TOKEN&token_type=bearer`;
    const sectionUrl = `${fixtureServer.url('/page-b.html?case=session-secrets')}#section`;
    const credClean = fixtureServer.url('/page-c.html?case=session-secrets-credentials');
    const credTyped = credClean.replace('http://', 'http://alice:SECRET-PASSWORD@');

    const first = await launcher.launch();
    const [token, section, credentials] = await startWithPages(first.app, first.shell, [
      urlC,
      sectionUrl,
      credTyped,
    ]);
    // The token comes second in its tab's stack: C, then A with the access token in its fragment.
    await tabElement(first.shell, token).click();
    await expect(tabElement(first.shell, token)).toHaveAttribute('aria-selected', 'true');
    await typeAddress(first.shell, tokenUrl);
    // The live page keeps the token in its own address: only what is saved is cleaned.
    await waitForPage(first.app, token, { url: tokenUrl, title: 'Page A' });
    expect((await tabState(first.app, section))?.url).toBe(sectionUrl);
    // Select the section tab last: it is the one that loads at the next start.
    await tabElement(first.shell, section).click();
    await expect(tabElement(first.shell, section)).toHaveAttribute('aria-selected', 'true');

    await expectSaved(first.app, {
      ids: [token, section, credentials],
      selectedTabId: section,
      urls: { [token]: plain, [section]: sectionUrl, [credentials]: credClean },
      stacks: {
        [token]: { index: 1, urls: [urlC, plain] },
        [section]: { index: 0, urls: [sectionUrl] },
        [credentials]: { index: 0, urls: [credClean] },
      },
    });
    // No row says SECRET anywhere, in any column, on any entry.
    const saved = await readSavedSession(first.app);
    expect(JSON.stringify(saved)).not.toMatch(/SECRET|access_token|alice/u);
    await launcher.quit(first);

    // The database file itself (and its write-ahead log) never held them either.
    const file = join(userDataDir, 'veltriva.db');
    const bytes = Buffer.concat(
      await Promise.all(
        [file, `${file}-wal`].map((path) => readFile(path).catch(() => Buffer.alloc(0))),
      ),
    );
    expect(bytes.includes('page-c.html'), 'the scan should read the database').toBe(true);
    for (const secret of ['SECRET-TOKEN', 'access_token', 'SECRET-PASSWORD', 'alice']) {
      expect(bytes.includes(secret), `the database must not contain "${secret}"`).toBe(false);
    }

    const { app, shell } = await launcher.launch();
    await expect.poll(() => sidebarIds(shell)).toEqual([token, section, credentials]);
    // The ordinary fragment comes back with the page that was selected.
    await waitForLoaded(app, section);
    expect((await tabState(app, section))?.url).toBe(sectionUrl);
    await expect(omnibox(shell)).toHaveValue(sectionUrl);

    // The token tab comes back without its fragment, and so does what is behind it.
    expect((await tabState(app, token))?.url).toBe(plain);
    await tabElement(shell, token).click();
    await waitForPage(app, token, { url: plain, title: 'Page A' });
    await expect(omnibox(shell)).toHaveValue(plain);
    expect(await omnibox(shell).inputValue()).not.toContain('SECRET');
    await backButton(shell).click();
    await waitForPage(app, token, { url: urlC, title: 'Page C' });

    // The tab typed with a user name and a password never had them.
    expect((await tabState(app, credentials))?.url).toBe(credClean);
    await tabElement(shell, credentials).click();
    await waitForPage(app, credentials, { url: credClean });
    expect(await omnibox(shell).inputValue()).not.toMatch(/alice|SECRET/u);
  });
});

test.describe('the window', () => {
  /** How much a window may differ in size and still be "about" the one that was saved. */
  const ABOUT = 12;
  const differsBy = (actual: number, expected: number): number => Math.abs(actual - expected);

  /**
   * Places the window (and maximizes it if asked), waits until the database holds what the window
   * has, quits, and starts the app again. Returns the bounds placed and the window that opened.
   */
  async function restartWithWindow(launcher: Launcher, options: { readonly maximize: boolean }) {
    const first = await launcher.launch();
    const placed = await placeTestWindow(first.app);
    if (options.maximize) {
      await maximizeWindow(first.app);
      await expect.poll(async () => (await windowGeometry(first.app)).maximized).toBe(true);
    }
    // The saved document follows the window: poll until it equals what the window has now.
    await expect
      .poll(async () => {
        const [saved, geometry] = await Promise.all([
          readSavedSession(first.app).then((session) => session.window),
          windowGeometry(first.app),
        ]);
        return JSON.stringify(saved) ===
          JSON.stringify({ ...geometry.normal, maximized: options.maximize })
          ? 'saved'
          : { saved, window: geometry };
      })
      .toBe('saved');
    const scale = await displayScaleFactor(first.app);
    await launcher.quit(first);

    const second = await launcher.launch();
    return { placed, scale, reopened: await windowGeometry(second.app) };
  }

  test('opens where it was: at the same place, at about the same size, not maximized', async ({
    launcher,
  }) => {
    const { placed, reopened } = await restartWithWindow(launcher, { maximize: false });
    expect(reopened.maximized).toBe(false);
    expect(differsBy(reopened.normal.x, placed.x)).toBeLessThanOrEqual(1);
    expect(differsBy(reopened.normal.y, placed.y)).toBeLessThanOrEqual(1);
    expect(differsBy(reopened.normal.width, placed.width)).toBeLessThanOrEqual(ABOUT);
    expect(differsBy(reopened.normal.height, placed.height)).toBeLessThanOrEqual(ABOUT);
  });

  test('opens at exactly the size it had, to within a pixel', async ({ launcher }) => {
    const { placed, scale, reopened } = await restartWithWindow(launcher, { maximize: false });
    // Found by this test at 125 %: `new BaseWindow({ x, y, width, height })` rounded a 980 x 660
    // window up to 984 x 664, and it grew on every restart. createMainWindow now applies the saved
    // bounds again with `setBounds`, which is exact.
    test.info().annotations.push({ type: 'display scale', description: String(scale) });
    expect(
      sameBounds(reopened.normal, placed),
      `the window should open at ${JSON.stringify(placed)}, not ${JSON.stringify(reopened.normal)}`,
    ).toBe(true);
  });

  test('opens maximized if it was, and keeps the size it has when restored', async ({
    launcher,
  }) => {
    const { placed, reopened } = await restartWithWindow(launcher, { maximize: true });
    expect(reopened.maximized).toBe(true);
    expect(differsBy(reopened.normal.x, placed.x)).toBeLessThanOrEqual(1);
    expect(differsBy(reopened.normal.y, placed.y)).toBeLessThanOrEqual(1);
    expect(differsBy(reopened.normal.width, placed.width)).toBeLessThanOrEqual(ABOUT);
    expect(differsBy(reopened.normal.height, placed.height)).toBeLessThanOrEqual(ABOUT);
  });
});

test.describe('after a crash', () => {
  test('a hard kill loses at most the last second: the tabs are back, and a notice says why', async ({
    launcher,
    fixtureServer,
  }) => {
    const urlA = fixtureServer.url('/page-a.html?case=session-kill');
    const urlB = fixtureServer.url('/page-b.html?case=session-kill');

    const first = await launcher.launch();
    const [a, b] = await startWithPages(first.app, first.shell, [urlA, urlB]);
    await tabElement(first.shell, a).click();
    await expect(tabElement(first.shell, a)).toHaveAttribute('aria-selected', 'true');
    await expectSaved(first.app, {
      ids: [a, b],
      selectedTabId: a,
      urls: { [a]: urlA, [b]: urlB },
    });
    await launcher.kill(first);

    const { app, shell } = await launcher.launchAfterKill();
    expect(await dataReadyOf(app)).toMatchObject({ previousExit: 'crash' });
    await expect.poll(() => sidebarIds(shell)).toEqual([a, b]);
    expect(await selectedTabId(app)).toBe(a);
    await waitForLoaded(app, a);
    expect((await tabState(app, b))?.runtime).toBe('unloaded');

    // One notice, in main and in the shell: the tabs are back, the others load when selected.
    await expect
      .poll(async () => (await mainNotices(app)).map((notice) => notice.kind))
      .toEqual(['session-recovered']);
    await expect(noticeStrip(shell, 'session-recovered')).toBeVisible();
    await expect(noticeStrip(shell, 'session-recovered')).toContainText("didn't close properly");
    await expect(shell.getByRole('region', { name: 'Session recovered' })).toHaveCount(1);
    await expect(noticeStrip(shell, 'safe-mode')).toHaveCount(0);
    await expectConsistent(app, shell);

    // The tab that was not selected loads when it is.
    await tabElement(shell, b).click();
    await waitForPage(app, b, { url: urlB, title: 'Page B' });
  });

  test('two quick crashes in a row start safe mode: the tabs are back and none is loaded', async ({
    launcher,
    fixtureServer,
  }) => {
    const urlA = fixtureServer.url('/page-a.html?case=session-safe');
    const urlB = fixtureServer.url('/page-b.html?case=session-safe');

    const first = await launcher.launch();
    const [a, b] = await startWithPages(first.app, first.shell, [urlA, urlB]);
    await expectSaved(first.app, { ids: [a, b], selectedTabId: b });
    await launcher.kill(first);

    // The second run lives for a few seconds, then it is killed too.
    const second = await launcher.launchAfterKill();
    expect(await dataReadyOf(second.app)).toMatchObject({ previousExit: 'crash' });
    await expect.poll(() => sidebarIds(second.shell)).toEqual([a, b]);
    await launcher.kill(second);

    const { app, shell } = await launcher.launchAfterKill();
    expect(await dataReadyOf(app)).toMatchObject({ previousExit: 'crash' });
    await expect
      .poll(async () => (await mainNotices(app)).map((notice) => notice.kind))
      .toEqual(['safe-mode']);
    await expect(noticeStrip(shell, 'safe-mode')).toBeVisible();
    await expect(shell.getByRole('region', { name: 'Safe mode' })).toHaveCount(1);
    await expect(noticeStrip(shell, 'session-recovered')).toHaveCount(0);

    // Every tab is back, the same one is selected, and nothing loads, not even the selected tab.
    await expect.poll(() => sidebarIds(shell)).toEqual([a, b]);
    expect((await sidebarTabs(shell)).map((tab) => [tab.label, tab.selected])).toEqual([
      ['Page A', false],
      ['Page B', true],
    ]);
    expect(await selectedTabId(app)).toBe(b);
    const seen = await observeFor(1500, async () =>
      JSON.stringify((await tabStates(app)).map((tab) => [tab.runtime, tab.webContentsId])),
    );
    expect(seen).toEqual([
      JSON.stringify([
        ['unloaded', null],
        ['unloaded', null],
      ]),
    ]);
    expect(await tabContentsCount(app)).toBe(0);
    await expectConsistent(app, shell);

    // Reload loads the selected tab, with the page it was on.
    await reloadButton(shell).click();
    await waitForPage(app, b, { url: urlB, title: 'Page B' });
    expect((await tabState(app, a))?.runtime).toBe('unloaded');

    // Selecting the other tab loads it too.
    await tabElement(shell, a).click();
    await waitForPage(app, a, { url: urlA, title: 'Page A' });
    expect(await tabContentsCount(app)).toBe(2);
    await expectConsistent(app, shell);
  });
});

test.describe('one instance per profile', () => {
  test('a second launch on the same profile quits by itself, and the first keeps its tabs', async ({
    launcher,
    fixtureServer,
    userDataDir,
  }) => {
    const urlA = fixtureServer.url('/page-a.html?case=session-lock');

    const first = await launcher.launch();
    const [tab] = await startWithPages(first.app, first.shell, [urlA]);
    const runsBefore = await dataValue<{ runs: unknown[] }>(first.app, 'appRuns.recent', {
      limit: 10,
    });
    const summary = async (): Promise<unknown[]> =>
      (await tabStates(first.app)).map((state) => [
        state.id,
        state.runtime,
        state.url,
        state.title,
        state.pinned,
      ]);
    const statesBefore = await summary();

    // Started like any launch, without Playwright: it must end on its own.
    const { repoRoot, electronBinary } = appPaths();
    const started = Date.now();
    const child = spawn(electronBinary, [repoRoot], {
      cwd: repoRoot,
      env: buildLaunchEnv(userDataDir),
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    const outcome = await new Promise<{ code: number | null; signal: string | null } | 'timeout'>(
      (resolve) => {
        const timer = setTimeout(() => {
          resolve('timeout');
        }, 30_000);
        child.once('exit', (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
      },
    );
    if (outcome === 'timeout') {
      killProcessTree(child.pid);
    }
    expect(outcome, `the second instance should quit by itself. stderr: ${stderr}`).toEqual({
      code: 0,
      signal: null,
    });
    expect(Date.now() - started).toBeLessThan(25_000);

    // The first app is still running, with the same tabs, and it never saw a second run.
    expect(first.app.process().exitCode).toBeNull();
    expect(await summary()).toEqual(statesBefore);
    expect(await sidebarIds(first.shell)).toEqual([tab]);
    expect(
      (await dataValue<{ runs: unknown[] }>(first.app, 'appRuns.recent', { limit: 10 })).runs,
    ).toHaveLength(runsBefore.runs.length);
    await expect(omnibox(first.shell)).toHaveValue(urlA);
  });
});

test.describe('the saved session', () => {
  test('a change made just before quitting is written by the quit', async ({
    launcher,
    fixtureServer,
  }) => {
    const urlA = fixtureServer.url('/page-a.html?case=session-quit');
    const urlB = fixtureServer.url('/page-b.html?case=session-quit');

    const first = await launcher.launch();
    const [tab] = await startWithPages(first.app, first.shell, [urlA]);
    await expectSaved(first.app, { stacks: { [tab]: { index: 0, urls: [urlA] } } });
    // A navigation, and the quit right after it: the store has not written it yet (it waits up
    // to a second), so the quit's own flush has to. No wait on the database here.
    await typeAddress(first.shell, urlB);
    await waitForPage(first.app, tab, { url: urlB, title: 'Page B' });
    await launcher.quit(first);

    const { app, shell } = await launcher.launch();
    await waitForPage(app, tab, { url: urlB, title: 'Page B' });
    await expect(omnibox(shell)).toHaveValue(urlB);
    await backButton(shell).click();
    await waitForPage(app, tab, { url: urlA, title: 'Page A' });
  });

  test('an address a tab must never load comes back as a new-tab page', async ({
    launcher,
    fixtureServer,
  }) => {
    const urlA = fixtureServer.url('/page-a.html?case=session-hostile');
    const hostileId = '0199f000-0000-7000-8000-0000000000c1';

    const first = await launcher.launch();
    const [a] = await startWithPages(first.app, first.shell, [urlA]);
    await expectSaved(first.app, { ids: [a] });
    // A row the database file could hold, written by something other than Veltriva: addresses
    // that restore must never load, in the tab's own column and in every entry of its stack.
    const [row] = (await readSavedSession(first.app)).strip;
    expect(row).toBeDefined();
    await dataValue(first.app, 'tabs.upsertMany', {
      tabs: [
        {
          ...row,
          id: hostileId,
          position: 1,
          url: 'javascript:alert(1)',
          title: 'Hostile',
          restoreState: {
            v: 1,
            index: 1,
            entries: [
              { url: 'data:text/html,<script>alert(1)</script>', title: 'one' },
              { url: 'app://shell/index.html', title: 'two' },
            ],
          },
        },
      ],
    });
    await launcher.quit(first);

    const { app, shell } = await launcher.launch();
    await expect.poll(() => sidebarIds(shell)).toEqual([a, hostileId]);
    await waitForLoaded(app, a);
    // Restore checks a saved address before anything shows it: the row is a new-tab page at once,
    // and its saved title is not shown either.
    expect((await sidebarTabs(shell)).map((tab) => tab.label)).toEqual(['Page A', 'New Tab']);

    // Selecting it loads nothing: it is a new-tab page, with no web contents.
    await tabElement(shell, hostileId).click();
    await expect(internalPage(shell, 'new-tab')).toBeVisible();
    expect(await tabState(app, hostileId)).toMatchObject({
      page: { kind: 'internal', name: 'new-tab' },
      url: '',
      webContentsId: null,
      runtime: 'unloaded',
    });
    expect(await tabContentsCount(app)).toBe(1);
    await expect(tabElement(shell, hostileId)).toHaveAccessibleName('New Tab');
    // It is saved as the new-tab page it now is.
    await expectSaved(app, { urls: { [hostileId]: 'veltriva://newtab' } });
    // Another tab still loads normally next to it.
    const other = await loadInNewTab(app, shell, urlA);
    expect(await tabState(app, other)).toMatchObject({ runtime: 'live', url: urlA });
  });
});
