// Navigation in real tabs, M1.3a (ADR-0002 §7, ADR-0005): what the address bar, the toolbar buttons,
// the sidebar and the content area show as pages load, fail, stop and try to send the tab
// somewhere it must not go. Every page comes from the local fixture server.
//
// Held pages (`/held?key=…`) let a test decide when a load starts, stays pending and ends, so no
// assertion about a loading state depends on how fast the machine is. After the app cancels a
// navigation, the page is checked with `evaluate` and main, never with a locator (launch.ts rule 7).
import { startFixtureServer } from '../fixtures/server';
import { expect } from './expect';
import { test } from './fixtures';
import { pageForTab, recordNavigations, setSearchTemplate, tabState } from './hooks';
import { observeFor } from './launch';
import type { PageGlobal } from './page-globals';
import {
  SLOW_TIMEOUT_MS,
  backButton,
  expectConsistent,
  forwardButton,
  internalPage,
  loadInNewTab,
  loadingBar,
  omnibox,
  openNewTab,
  openTabAt,
  recordWorkspaceSnapshots,
  reloadButton,
  securityIndicator,
  sidebarTabs,
  stopButton,
  tabElement,
  tabElements,
  tabRow,
  typeAddress,
  waitForLoaded,
  waitForPage,
} from './shell-ui';

/** `window.navigateAway`, defined by tests/fixtures/pages/navigates-away.html. */
type NavigatesAwayGlobal = typeof globalThis & { navigateAway: { to(url: string): void } };

test.describe.configure({ timeout: 120_000 });

test.describe('navigation', () => {
  test.beforeEach(async ({ electronApp, fixtureServer, shell }) => {
    // Nothing here is a search, but a stray Enter must never reach a real search engine.
    await setSearchTemplate(electronApp, fixtureServer.url('/search?q={searchTerms}'));
    await expect(tabElements(shell)).toHaveCount(1);
  });

  test('a typed URL loads: title in the sidebar, URL in the address bar, "Not secure" for http', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const url = fixtureServer.url('/page-a.html');

    // A new tab has nothing to show yet.
    const tabId = await openNewTab(shell);
    await expect(omnibox(shell)).toHaveValue('');
    await expect(securityIndicator(shell)).toHaveAttribute('data-security', 'neutral');
    await expect(loadingBar(shell)).toHaveAttribute('data-loading', 'false');

    await typeAddress(shell, url);
    // Enter submits and takes the focus out of the field, so the page can have it.
    await expect(omnibox(shell)).not.toBeFocused();
    await waitForLoaded(electronApp, tabId);

    await expect(tabElement(shell, tabId)).toHaveAccessibleName('Page A');
    await expect(omnibox(shell)).toHaveValue(url);
    await expect(securityIndicator(shell)).toHaveAttribute('data-security', 'not-secure');
    await expect(shell.getByRole('img', { name: 'Not secure' })).toBeVisible();
    await expect(shell.getByRole('img', { name: 'Not secure' })).toContainText('Not secure');
    await expect(loadingBar(shell)).toHaveAttribute('data-loading', 'false');
    await expect(reloadButton(shell)).toBeVisible();
    await expect(stopButton(shell)).toHaveCount(0);

    // The tab's own page agrees, and its view is attached over the content area.
    const page = await pageForTab(electronApp, tabId);
    expect(page.url()).toBe(url);
    expect(await page.title()).toBe('Page A');
    expect(await tabState(electronApp, tabId)).toMatchObject({
      url,
      title: 'Page A',
      attached: true,
      page: { kind: 'web' },
    });
    await expectConsistent(electronApp, shell);
  });

  test('Back and Forward follow the history, and are disabled at its ends', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const urlA = fixtureServer.url('/page-a.html');
    const urlB = fixtureServer.url('/page-b.html');
    const urlC = fixtureServer.url('/page-c.html');

    const tabId = await loadInNewTab(electronApp, shell, urlA);
    await expect(backButton(shell)).toBeDisabled();
    await expect(forwardButton(shell)).toBeDisabled();

    await typeAddress(shell, urlB);
    await waitForPage(electronApp, tabId, { url: urlB, title: 'Page B' });
    await expect(backButton(shell)).toBeEnabled();
    await expect(forwardButton(shell)).toBeDisabled();

    await backButton(shell).click();
    await waitForPage(electronApp, tabId, { url: urlA, title: 'Page A' });
    await expect(omnibox(shell)).toHaveValue(urlA);
    await expect(tabElement(shell, tabId)).toHaveAccessibleName('Page A');
    await expect(backButton(shell)).toBeDisabled();
    await expect(forwardButton(shell)).toBeEnabled();

    await forwardButton(shell).click();
    await waitForPage(electronApp, tabId, { url: urlB, title: 'Page B' });
    await expect(omnibox(shell)).toHaveValue(urlB);
    await expect(backButton(shell)).toBeEnabled();
    await expect(forwardButton(shell)).toBeDisabled();

    // A new navigation from the middle of the history drops what was ahead.
    await backButton(shell).click();
    await waitForPage(electronApp, tabId, { url: urlA, title: 'Page A' });
    await expect(forwardButton(shell)).toBeEnabled();
    await typeAddress(shell, urlC);
    await waitForPage(electronApp, tabId, { url: urlC, title: 'Page C' });
    await expect(forwardButton(shell)).toBeDisabled();
    await expect(backButton(shell)).toBeEnabled();

    // Back from C lands on A, not B.
    await backButton(shell).click();
    await waitForPage(electronApp, tabId, { url: urlA, title: 'Page A' });
    await expectConsistent(electronApp, shell);
  });

  test('Reload loads the page again', async ({ electronApp, fixtureServer, shell }) => {
    const path = '/page-a.html?case=reload';
    const tabId = await loadInNewTab(electronApp, shell, fixtureServer.url(path));
    expect(fixtureServer.hits(path)).toBe(1);

    await reloadButton(shell).click();
    await expect.poll(() => fixtureServer.hits(path)).toBe(2);
    await waitForPage(electronApp, tabId, { url: fixtureServer.url(path), title: 'Page A' });
    await expect(reloadButton(shell)).toBeVisible();
    await expect(omnibox(shell)).toHaveValue(fixtureServer.url(path));
  });

  test('the Reload button becomes Stop while a page loads, and Stop ends the load', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const path = '/held?key=stop';
    const tabId = await openTabAt(shell, fixtureServer.url(path));

    // The request is at the server and unanswered: the tab is loading.
    await expect.poll(() => fixtureServer.hits(path)).toBe(1);
    await expect(stopButton(shell)).toBeVisible();
    await expect(reloadButton(shell)).toHaveCount(0);
    await expect(loadingBar(shell)).toHaveAttribute('data-loading', 'true');
    await expect(tabRow(shell, tabId).locator('[data-tab-status="loading"]')).toHaveCount(1);
    expect(await tabState(electronApp, tabId)).toMatchObject({ loading: true });

    await stopButton(shell).click();
    await expect(reloadButton(shell)).toBeVisible();
    await expect(stopButton(shell)).toHaveCount(0);
    await expect(loadingBar(shell)).toHaveAttribute('data-loading', 'false');
    await expect(tabRow(shell, tabId).locator('[data-tab-status]')).toHaveCount(0);

    // Releasing the page now changes nothing: nobody is waiting for it.
    fixtureServer.release('stop');
    const titles = await observeFor(1_000, async () => (await tabState(electronApp, tabId))?.title);
    expect(titles).toEqual(['']);
    expect(await tabState(electronApp, tabId)).toMatchObject({ loading: false });
  });

  test('a page that loads slowly ends up loaded, with the Reload button back', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tabId = await openTabAt(shell, fixtureServer.url('/slow?ms=2500'));
    await waitForPage(electronApp, tabId, {
      url: fixtureServer.url('/slow?ms=2500'),
      title: 'Slow fixture',
    });
    await expect(tabElement(shell, tabId)).toHaveAccessibleName('Slow fixture');
    await expect(reloadButton(shell)).toBeVisible();
    await expect(loadingBar(shell)).toHaveAttribute('data-loading', 'false');
    await expect(tabRow(shell, tabId).locator('[data-tab-status]')).toHaveCount(0);
  });

  test('a held page shows Stop until it is released', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const url = fixtureServer.url('/held?key=release');
    const tabId = await openTabAt(shell, url);
    await expect.poll(() => fixtureServer.hits('/held?key=release')).toBe(1);
    await expect(stopButton(shell)).toBeVisible();

    fixtureServer.release('release');
    await waitForPage(electronApp, tabId, { url, title: 'Held fixture' });
    await expect(reloadButton(shell)).toBeVisible();
    await expect(tabElement(shell, tabId)).toHaveAccessibleName('Held fixture');
    await expect(loadingBar(shell)).toHaveAttribute('data-loading', 'false');
  });

  test('keeps showing the current address while a page-initiated navigation is pending', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const urlA = fixtureServer.url('/navigates-away.html');
    const tabId = await loadInNewTab(electronApp, shell, urlA);
    const page = await pageForTab(electronApp, tabId);
    const heldUrl = fixtureServer.url('/held?key=pending');

    await page.evaluate((url) => {
      (globalThis as NavigatesAwayGlobal).navigateAway.to(url);
    }, heldUrl);

    // The request has started: the tab is loading, but no document has committed yet, so the
    // address bar, the label and main's own URL are still the old page's.
    await expect.poll(() => fixtureServer.hits('/held?key=pending')).toBe(1);
    await expect(stopButton(shell)).toBeVisible();
    await expect(omnibox(shell)).toHaveValue(urlA);
    await expect(tabElement(shell, tabId)).toHaveAccessibleName('Navigates away fixture');
    expect(await tabState(electronApp, tabId)).toMatchObject({ url: urlA, loading: true });
    const addresses = await observeFor(500, () => omnibox(shell).inputValue());
    expect(addresses).toEqual([urlA]);

    // The commit is what changes it.
    fixtureServer.release('pending');
    await waitForPage(electronApp, tabId, { url: heldUrl, title: 'Held fixture' });
    await expect(omnibox(shell)).toHaveValue(heldUrl);
    await expect(tabElement(shell, tabId)).toHaveAccessibleName('Held fixture');
    await expect(reloadButton(shell)).toBeVisible();
  });

  test('keeps the current address when a page-initiated navigation is stopped', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const urlA = fixtureServer.url('/navigates-away.html');
    const tabId = await loadInNewTab(electronApp, shell, urlA);
    const page = await pageForTab(electronApp, tabId);

    await page.evaluate((url) => {
      (globalThis as NavigatesAwayGlobal).navigateAway.to(url);
    }, fixtureServer.url('/held?key=stopped'));
    await expect.poll(() => fixtureServer.hits('/held?key=stopped')).toBe(1);
    await expect(stopButton(shell)).toBeVisible();

    await stopButton(shell).click();
    await expect(reloadButton(shell)).toBeVisible();
    await expect(omnibox(shell)).toHaveValue(urlA);
    expect(await tabState(electronApp, tabId)).toMatchObject({
      url: urlA,
      title: 'Navigates away fixture',
      loading: false,
    });
    // The old page is still there (checked with evaluate: a stopped navigation confuses locators).
    expect(await page.evaluate(() => (globalThis as PageGlobal).location.href)).toBe(urlA);
  });

  test('after Stop on a typed navigation, the address bar shows the page still on display', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    // ADR-0002 §7: the address bar changes only when a document commits or fails. A typed
    // navigation that is stopped leaves page A on display, so its address must stay too. (This
    // test found TabManager.navigate() setting the URL before the commit.)
    const urlA = fixtureServer.url('/page-a.html');
    const tabId = await loadInNewTab(electronApp, shell, urlA);

    await typeAddress(shell, fixtureServer.url('/held?key=typed-stop'));
    await expect.poll(() => fixtureServer.hits('/held?key=typed-stop')).toBe(1);
    await expect(stopButton(shell)).toBeVisible();
    await stopButton(shell).click();
    await expect(reloadButton(shell)).toBeVisible();

    expect(await tabState(electronApp, tabId)).toMatchObject({ title: 'Page A', url: urlA });
    await expect(omnibox(shell)).toHaveValue(urlA);
  });

  test('a failed load shows the network-error page, and "Try again" retries it', async ({
    electronApp,
    shell,
  }) => {
    // Start a server and close it: its port now refuses connections. Bring it back later.
    const first = await startFixtureServer();
    const port = Number(new URL(first.origin).port);
    const url = first.url('/page-a.html?case=retry');
    await first.close();

    let revived: Awaited<ReturnType<typeof startFixtureServer>> | undefined;
    try {
      const tabId = await openTabAt(shell, url);

      const errorPage = internalPage(shell, 'network-error');
      await expect(errorPage).toBeVisible({ timeout: SLOW_TIMEOUT_MS });
      await expect(errorPage.getByRole('heading', { level: 1 })).toHaveText(
        "This page couldn't load",
      );
      await expect(errorPage).toContainText(url);
      await expect(errorPage).toContainText('ERR_CONNECTION_REFUSED');
      await expect(errorPage.getByRole('button', { name: 'Try again' })).toBeVisible();

      // The error is the tab's state, not just a picture: no view, a failed status, its address.
      await expect(tabRow(shell, tabId).locator('[data-tab-status="failed"]')).toHaveCount(1);
      await expect(omnibox(shell)).toHaveValue(url);
      expect(await tabState(electronApp, tabId)).toMatchObject({
        url,
        loading: false,
        attached: false,
        page: {
          kind: 'internal',
          name: 'network-error',
          error: { name: 'ERR_CONNECTION_REFUSED' },
        },
      });
      await expectConsistent(electronApp, shell);

      // The site comes back; "Try again" loads it.
      revived = await startFixtureServer({ port });
      await errorPage.getByRole('button', { name: 'Try again' }).click();
      await waitForPage(electronApp, tabId, { url, title: 'Page A' });
      await expect(errorPage).toHaveCount(0);
      await expect(tabElement(shell, tabId)).toHaveAccessibleName('Page A');
      await expect(omnibox(shell)).toHaveValue(url);
      await expect(tabRow(shell, tabId).locator('[data-tab-status]')).toHaveCount(0);
      expect(revived.hits('/page-a.html?case=retry')).toBe(1);
      await expectConsistent(electronApp, shell);
    } finally {
      await revived?.close();
    }
  });

  test('an unsafe port fails with its error name', async ({ shell }) => {
    // Chromium refuses port 9 (discard) before any request leaves, so this needs no server.
    const url = 'http://127.0.0.1:9/';
    const tabId = await openTabAt(shell, url);
    const errorPage = internalPage(shell, 'network-error');
    await expect(errorPage).toBeVisible({ timeout: SLOW_TIMEOUT_MS });
    await expect(errorPage).toContainText('ERR_UNSAFE_PORT');
    await expect(errorPage).toContainText(url);
    // With no title to show, the sidebar names the tab by its address.
    await expect(tabElement(shell, tabId)).toHaveAccessibleName(url);
    expect((await sidebarTabs(shell)).find((tab) => tab.id === tabId)?.status).toBe('failed');
  });

  test.describe('favicons', () => {
    test('a PNG favicon is shown as a data:image/png image in the tab row', async ({
      electronApp,
      fixtureServer,
      shell,
    }) => {
      const tabId = await loadInNewTab(electronApp, shell, fixtureServer.url('/favicon-png.html'));
      const icon = tabRow(shell, tabId).locator('img');

      await expect(icon).toHaveCount(1);
      await expect(icon).toHaveAttribute('src', /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);
      // It is a real, decoded image (the fixture is 16x16), not a broken one.
      await expect(icon).toHaveJSProperty('naturalWidth', 16);
      expect(fixtureServer.hits('/favicon.png')).toBeGreaterThanOrEqual(1);
      expect((await tabState(electronApp, tabId))?.favicon).toMatch(/^data:image\/png;base64,/);

      // The next document has its own icon, or none: the old site's icon doesn't stay.
      await typeAddress(shell, fixtureServer.url('/page-a.html'));
      await waitForPage(electronApp, tabId, { title: 'Page A' });
      await expect(icon).toHaveCount(0);
      expect((await tabState(electronApp, tabId))?.favicon).toBeNull();
    });

    for (const [name, page, asset] of [
      ['an SVG favicon', '/favicon-svg.html', '/favicon.svg'],
      ['a PNG over 64 KB', '/favicon-big.html', '/favicon-big.png'],
      ['a file labeled image/png that is not an image', '/favicon-fake.html', '/favicon-fake.png'],
    ] as const) {
      test(`${name} is fetched and refused: no image in the tab row`, async ({
        electronApp,
        fixtureServer,
        shell,
      }) => {
        const tabId = await loadInNewTab(electronApp, shell, fixtureServer.url(page));
        // Main asked for the icon, so refusing it was a decision, not a missing request.
        await expect
          .poll(() => fixtureServer.hits(asset), { timeout: SLOW_TIMEOUT_MS })
          .toBeGreaterThanOrEqual(1);

        const icons = await observeFor(
          1_500,
          async () =>
            (await sidebarTabs(shell)).find((tab) => tab.id === tabId)?.faviconSrc ?? null,
        );
        expect(icons).toEqual([null]);
        await expect(tabRow(shell, tabId).locator('img')).toHaveCount(0);
        expect((await tabState(electronApp, tabId))?.favicon).toBeNull();
      });
    }
  });

  test('shows a page title without its bidirectional and control characters', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tabId = await loadInNewTab(electronApp, shell, fixtureServer.url('/bidi-title.html'));
    const expected = 'Bidi TitleIsolated End';

    await expect(tabElement(shell, tabId)).toHaveAccessibleName(expected);
    const label = (await sidebarTabs(shell)).find((tab) => tab.id === tabId)?.label ?? '';
    expect(label).toBe(expected);
    // No format or control characters of any kind survive (right-to-left override, zero-width
    // space, isolates, bell...).
    expect(label).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect((await tabState(electronApp, tabId))?.title).toBe(expected);

    // The page really did carry them: the sanitizing happened in main, not in the fixture.
    const raw = await (await pageForTab(electronApp, tabId)).title();
    expect(raw).toMatch(/\u{202e}/u);
    expect(raw).toMatch(/\u{200b}/u);
    expect(raw).toMatch(/\u{85}/u);
  });

  test('never shows a URL the guard cancelled, in the address bar or in any snapshot', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const urlA = fixtureServer.url('/navigates-away.html');
    const tabId = await loadInNewTab(electronApp, shell, urlA);
    const state = await tabState(electronApp, tabId);
    if (state?.webContentsId == null) {
      throw new Error('the tab should have a web contents');
    }
    const page = await pageForTab(electronApp, tabId);

    const navigations = await recordNavigations(electronApp, state.webContentsId);
    const recorder = await recordWorkspaceSnapshots(shell);

    // Two targets a page must not reach: the shell and an internal page. The guard sees both
    // and cancels them.
    const targets = ['app://shell/index.html', 'veltriva://newtab'];
    for (const [index, target] of targets.entries()) {
      await page.evaluate((url) => {
        (globalThis as NavigatesAwayGlobal).navigateAway.to(url);
      }, target);

      const records = await navigations.untilCount(index + 1);
      expect(records[index]).toEqual({ url: target, isMainFrame: true, cancelled: true });
    }
    // A data: document as the whole page is refused too. Chromium refuses a renderer-initiated
    // top-level data: navigation before Electron's `will-frame-navigate` fires, so the guard
    // never sees it (frames.spec.ts covers the policy). Either way it must never be shown.
    const dataUrl = 'data:text/html;charset=utf-8,%3Ctitle%3Espoofed%3C%2Ftitle%3E';
    await page.evaluate((url) => {
      (globalThis as NavigatesAwayGlobal).navigateAway.to(url);
    }, dataUrl);

    // Give a navigation that wrongly went ahead time to commit. No locators on the tab's page.
    const urls = await observeFor(1_000, async () => (await tabState(electronApp, tabId))?.url);
    expect(urls).toEqual([urlA]);
    expect(await page.evaluate(() => (globalThis as PageGlobal).location.href)).toBe(urlA);
    await expect(omnibox(shell)).toHaveValue(urlA);
    await expect(tabElement(shell, tabId)).toHaveAccessibleName('Navigates away fixture');
    expect((await navigations.snapshot()).filter((record) => !record.cancelled)).toEqual([]);

    // A real navigation still works, and shows up in the recording: the recorder is alive, so
    // the absence of the cancelled URLs means something.
    const urlB = fixtureServer.url('/page-b.html');
    await page.evaluate((url) => {
      (globalThis as NavigatesAwayGlobal).navigateAway.to(url);
    }, urlB);
    await waitForPage(electronApp, tabId, { url: urlB, title: 'Page B' });
    await expect(omnibox(shell)).toHaveValue(urlB);

    const snapshots = await recorder.snapshots();
    expect(snapshots.length).toBeGreaterThan(0);
    const addresses = snapshots.flatMap((snapshot) =>
      snapshot.tabs.filter((tab) => tab.id === tabId).map((tab) => tab.address.text),
    );
    expect(addresses).toContain(urlB);
    for (const address of addresses) {
      expect([urlA, urlB]).toContain(address);
    }
    const everything = JSON.stringify(snapshots);
    for (const target of [...targets, dataUrl]) {
      expect(everything).not.toContain(target);
    }
    expect(everything).not.toContain('spoofed');
    expect(everything).not.toContain('app://');
    expect(everything).not.toContain('veltriva://');
  });
});
