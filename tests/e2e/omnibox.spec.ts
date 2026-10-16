// The address bar, M1.3a (assessment §3.6, ADR-0002 §7): what main does with the text a user
// submits, and how the shell's field behaves around it. Main classifies (src/core/url/omnibox.ts);
// the shell only forwards the text and shows main's answer, so these specs submit real input and
// look at the tab, the page and the fixture server.
//
// Searches go to the local fixture's /search page through `setSearchTemplate`, which every test
// sets first. The default engine is a real one: nothing here may reach it. That is also why no
// test types a bare real domain (it would be navigated to), and why the hostile-looking
// credentials input uses a `.invalid` host, which can't resolve anywhere.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { FixtureServer } from '../fixtures/server';
import { expect } from './expect';
import { test } from './fixtures';
import {
  pageForTab,
  recordNavigations,
  setSearchTemplate,
  tabState,
  tabStates,
  webContentsRoles,
} from './hooks';
import { observeFor } from './launch';
import {
  backButton,
  credentialsWarning,
  forwardButton,
  internalPage,
  loadInNewTab,
  newTabSearchBox,
  omnibox,
  openNewTab,
  openTabAt,
  reloadButton,
  securityIndicator,
  sidebarLabels,
  stopButton,
  tabElement,
  typeAddress,
  waitForPage,
} from './shell-ui';
import type { PageGlobal } from './page-globals';

/** `window.navigateAway`, defined by tests/fixtures/pages/navigates-away.html. */
type NavigatesAwayGlobal = typeof globalThis & { navigateAway: { to(url: string): void } };

test.describe.configure({ timeout: 120_000 });

/** The path and query a search for `query` takes on the fixture server. */
const searchPath = (query: string): string => `/search?q=${encodeURIComponent(query)}`;
const searchTitle = (query: string): string => `Search results for: ${query}`;

// The fixture server lives as long as the worker, so count searches from the start of each test.
let searchesAtStart = 0;
const searchesMade = (server: FixtureServer): number =>
  server.pathHits('/search') - searchesAtStart;

test.describe('omnibox', () => {
  test.beforeEach(async ({ electronApp, fixtureServer, shell }) => {
    searchesAtStart = fixtureServer.pathHits('/search');
    await setSearchTemplate(electronApp, fixtureServer.url('/search?q={searchTerms}'));
    await expect(shell.getByRole('tab')).toHaveCount(1);
  });

  test('words are searched for through the template, encoded', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tabId = await openNewTab(shell);

    const plain = 'hello world';
    await typeAddress(shell, plain);
    await waitForPage(electronApp, tabId, {
      url: fixtureServer.url(searchPath(plain)),
      title: searchTitle(plain),
    });
    await expect(omnibox(shell)).toHaveValue(fixtureServer.url('/search?q=hello%20world'));
    await expect(tabElement(shell, tabId)).toHaveAccessibleName(searchTitle(plain));
    expect(fixtureServer.hits('/search?q=hello%20world')).toBe(1);

    // Characters that mean something in a URL are escaped, and survive the round trip.
    const tricky = 'a&b=c d/é#x';
    await typeAddress(shell, tricky);
    await waitForPage(electronApp, tabId, {
      url: fixtureServer.url(searchPath(tricky)),
      title: searchTitle(tricky),
    });
    expect(fixtureServer.hits(searchPath(tricky))).toBe(1);
    expect(searchesMade(fixtureServer)).toBe(2);
  });

  test('a 127.0.0.1 address navigates over http, without searching', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tabId = await openTabAt(
      shell,
      `${fixtureServer.origin.replace('http://', '')}/page-a.html`,
    );
    const url = fixtureServer.url('/page-a.html');

    await waitForPage(electronApp, tabId, { url, title: 'Page A' });
    await expect(omnibox(shell)).toHaveValue(url);
    await expect(securityIndicator(shell)).toHaveAttribute('data-security', 'not-secure');
    expect(searchesMade(fixtureServer)).toBe(0);
  });

  test('javascript: and data: text is searched for, never run or navigated to', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tabId = await loadInNewTab(electronApp, shell, fixtureServer.url('/page-a.html'));
    const typed = [
      'javascript:document.title="pwned"',
      'JaVaScRiPt:void(0)',
      'data:text/html,<script>document.title="pwned"</script>',
    ];

    for (const text of typed) {
      await typeAddress(shell, text);
      await waitForPage(electronApp, tabId, {
        url: fixtureServer.url(searchPath(text)),
        title: searchTitle(text),
      });
      // The search page is the only thing that ran: one request, an http(s) tab, no `pwned`.
      expect(fixtureServer.hits(searchPath(text))).toBe(1);
      const state = await tabState(electronApp, tabId);
      expect(state?.url.startsWith('http://127.0.0.1:')).toBe(true);
      expect(state?.title).not.toBe('pwned');
      await expect(omnibox(shell)).toHaveValue(fixtureServer.url(searchPath(text)));
    }
    expect(searchesMade(fixtureServer)).toBe(typed.length);
  });

  test('veltriva://newtab opens the new-tab page and drops the web page', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tabId = await loadInNewTab(electronApp, shell, fixtureServer.url('/page-a.html'));
    const before = await tabState(electronApp, tabId);
    expect(before?.webContentsId).not.toBeNull();

    await typeAddress(shell, 'veltriva://newtab');

    await expect(internalPage(shell, 'new-tab')).toBeVisible();
    await expect(tabElement(shell, tabId)).toHaveAccessibleName('New Tab');
    await expect(omnibox(shell)).toHaveValue('');
    await expect(securityIndicator(shell)).toHaveAttribute('data-security', 'neutral');
    await expect(backButton(shell)).toBeDisabled();
    await expect(forwardButton(shell)).toBeDisabled();
    expect(await tabState(electronApp, tabId)).toMatchObject({
      url: '',
      title: '',
      runtime: 'unloaded',
      page: { kind: 'internal', name: 'new-tab' },
      webContentsId: null,
      attached: false,
    });

    // The page's web contents is closed, not hidden (ADR-0002 §2).
    const roles = await webContentsRoles(electronApp);
    expect(roles.map((entry) => entry.webContentsId)).not.toContain(before?.webContentsId);
    expect(searchesMade(fixtureServer)).toBe(0);
  });

  test("another app's scheme, a login-looking address and blank input do nothing", async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const urlA = fixtureServer.url('/page-a.html');
    const tabId = await loadInNewTab(electronApp, shell, urlA);
    const state = await tabState(electronApp, tabId);
    if (state?.webContentsId == null) {
      throw new Error('the tab should have a web contents');
    }
    const navigations = await recordNavigations(electronApp, state.webContentsId);
    const windowsBefore = electronApp.windows().length;
    const tabsBefore = (await tabStates(electronApp)).map((tab) => tab.id);

    // `.invalid` can never resolve: if these were ever navigated, nothing would leave the machine.
    // None of them is searched for either (a search would send what may be a password).
    for (const text of [
      'zoommtg:join?confno=1',
      'user:pass@host.invalid',
      'mailto:someone@host.invalid',
      '   ',
    ]) {
      await typeAddress(shell, text);
      // Nothing is going to load, so the field shows the tab's address again at once.
      await expect(omnibox(shell)).toHaveValue(urlA);

      const urls = await observeFor(400, async () => (await tabState(electronApp, tabId))?.url);
      expect(urls, `after submitting ${JSON.stringify(text)}`).toEqual([urlA]);
    }

    expect(searchesMade(fixtureServer)).toBe(0);
    expect(await navigations.snapshot()).toEqual([]);
    expect(await tabState(electronApp, tabId)).toMatchObject({
      url: urlA,
      title: 'Page A',
      loading: false,
      page: { kind: 'web' },
      attached: true,
    });
    expect((await tabStates(electronApp)).map((tab) => tab.id)).toEqual(tabsBefore);
    expect(electronApp.windows().length).toBe(windowsBefore);
    await expect(tabElement(shell, tabId)).toHaveAccessibleName('Page A');
  });

  test("the new-tab page's own search box searches and navigates", async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    // Words.
    const searching = await openNewTab(shell);
    const box = newTabSearchBox(shell);
    await expect(box).toBeVisible();
    await box.fill('fresh words');
    await box.press('Enter');
    await waitForPage(electronApp, searching, {
      url: fixtureServer.url(searchPath('fresh words')),
      title: searchTitle('fresh words'),
    });
    await expect(internalPage(shell, 'new-tab')).toHaveCount(0);
    expect(fixtureServer.hits(searchPath('fresh words'))).toBe(1);

    // An address.
    const navigating = await openNewTab(shell);
    const secondBox = newTabSearchBox(shell);
    await expect(secondBox).toBeVisible();
    await secondBox.fill(`${fixtureServer.origin.replace('http://', '')}/page-b.html`);
    await secondBox.press('Enter');
    await waitForPage(electronApp, navigating, {
      url: fixtureServer.url('/page-b.html'),
      title: 'Page B',
    });
    expect(await sidebarLabels(shell)).toEqual(['New Tab', searchTitle('fresh words'), 'Page B']);
  });

  test('focus selects the address, Escape reverts an edit, and an edit stays with its tab', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const urlA = fixtureServer.url('/page-a.html');
    const tabA = await loadInNewTab(electronApp, shell, urlA);
    const box = omnibox(shell);

    // Focusing selects everything, so the first key replaces the address.
    await box.click();
    await expect(box).toBeFocused();
    await shell.keyboard.type('x');
    await expect(box).toHaveValue('x');

    // Escape puts the tab's address back, and keeps the focus (selected, ready to retype).
    await shell.keyboard.press('Escape');
    await expect(box).toHaveValue(urlA);
    await expect(box).toBeFocused();
    await shell.keyboard.type('y');
    await expect(box).toHaveValue('y');
    await shell.keyboard.press('Escape');
    await expect(box).toHaveValue(urlA);

    // Nothing was submitted by any of this.
    expect(searchesMade(fixtureServer)).toBe(0);
    expect(await tabState(electronApp, tabA)).toMatchObject({ url: urlA, title: 'Page A' });

    // An edit belongs to the tab it was typed in: leaving the tab abandons it.
    const urlB = fixtureServer.url('/page-b.html');
    const tabB = await loadInNewTab(electronApp, shell, urlB);
    await box.fill('half-typed words');
    await tabElement(shell, tabA).click();
    await expect(box).toHaveValue(urlA);
    await tabElement(shell, tabB).click();
    await expect(box).toHaveValue(urlB);
  });

  test('keeps the text that was sent while the same address loads, then shows the address', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const path = '/held?key=resubmit';
    const url = fixtureServer.url(path);
    const tabId = await openTabAt(shell, url);
    await expect.poll(() => fixtureServer.hits(path)).toBe(1);
    fixtureServer.release('resubmit');
    await waitForPage(electronApp, tabId, { url, title: 'Held fixture' });

    // The same address, typed without its scheme: main's address for the tab doesn't change, so
    // the field keeps what was sent for as long as the load lasts.
    fixtureServer.rearm('resubmit');
    const typed = `${fixtureServer.origin.replace('http://', '')}${path}`;
    await typeAddress(shell, typed);
    await expect.poll(() => fixtureServer.hits(path)).toBe(2);
    await expect(stopButton(shell)).toBeVisible();
    await expect(omnibox(shell)).not.toBeFocused();
    await expect(omnibox(shell)).toHaveValue(typed);

    // The load ends, and the field shows main's address again.
    fixtureServer.release('resubmit');
    await expect(reloadButton(shell)).toBeVisible();
    await expect(omnibox(shell)).toHaveValue(url);
  });

  test('a typed URL with a username and password is loaded without them', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const host = fixtureServer.origin.replace('http://', '');
    // A path of its own: other specs use /echo-headers, and the server counts for the whole run.
    const path = '/echo-headers?case=typed-credentials';
    const url = fixtureServer.url(path);
    const tabId = await openTabAt(shell, `http://user:pass@${host}${path}`);
    await waitForPage(electronApp, tabId, { url });

    // The address bar, main and the request all lack the credentials.
    await expect(omnibox(shell)).toHaveValue(url);
    const state = await tabState(electronApp, tabId);
    expect(state?.url).toBe(url);
    expect(state?.url).not.toMatch(/user|pass/);
    const page = await pageForTab(electronApp, tabId);
    const body = await page.evaluate(() => (globalThis as PageGlobal).document.body.textContent);
    const headers = JSON.parse(body ?? '{}') as Record<string, string>;
    expect(headers).not.toHaveProperty('authorization');
    expect(fixtureServer.hits(path)).toBe(1);
  });

  test('a typed URL with a username and password shows the credentials warning', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    // Assessment §3.6 step 8 and threat T7: strip user:pass@ and warn, for a typed address as for
    // a page's navigation (next test). The classifier strips them before loading and tells
    // TabManager, whose next commit carries the warning. (This test found it missing.)
    const host = fixtureServer.origin.replace('http://', '');
    const tabId = await openTabAt(shell, `http://user:pass@${host}/page-a.html`);
    await waitForPage(electronApp, tabId, {
      url: fixtureServer.url('/page-a.html'),
      title: 'Page A',
    });

    // The load is over and the shell has had its snapshot: no need to wait out the full timeout
    // for something that is expected not to appear yet.
    await expect(credentialsWarning(shell)).toBeVisible({ timeout: 5_000 });
  });

  test('a page that navigates to a username and password URL gets the credentials warning', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tabId = await loadInNewTab(electronApp, shell, fixtureServer.url('/navigates-away.html'));
    await expect(credentialsWarning(shell)).toHaveCount(0);
    const page = await pageForTab(electronApp, tabId);

    const host = fixtureServer.origin.replace('http://', '');
    const plain = fixtureServer.url('/page-b.html');
    await page.evaluate((url) => {
      (globalThis as NavigatesAwayGlobal).navigateAway.to(url);
    }, `http://user:pass@${host}/page-b.html`);
    await expect(tabElement(shell, tabId)).toHaveAccessibleName('Page B');

    // The address bar shows the URL without them, with the warning beside the security state.
    await expect(omnibox(shell)).toHaveValue(plain);
    const warning = shell.getByRole('img', {
      name: 'A username or password was removed from this address',
    });
    await expect(warning).toBeVisible();
    await expect(credentialsWarning(shell)).toHaveCount(1);
    await expect(securityIndicator(shell)).toHaveAttribute('data-security', 'not-secure');
    expect(await omnibox(shell).inputValue()).not.toMatch(/user|pass/);

    // The warning is about the address on display: the next address has none.
    await typeAddress(shell, fixtureServer.url('/page-c.html'));
    await waitForPage(electronApp, tabId, {
      url: fixtureServer.url('/page-c.html'),
      title: 'Page C',
    });
    await expect(credentialsWarning(shell)).toHaveCount(0);
  });

  test('opens a typed drive path as a local file, and searches for a network path', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    // A Windows path on a local drive opens the file: the indicator says "Local file".
    const file = resolve(__dirname, '..', 'fixtures', 'pages', 'page-a.html');
    const tabId = await openTabAt(shell, file);
    await waitForPage(electronApp, tabId, { url: pathToFileURL(file).href, title: 'Page A' });
    await expect(securityIndicator(shell)).toHaveAttribute('data-security', 'local');
    await expect(shell.getByRole('img', { name: 'Local file' })).toBeVisible();
    await expect(omnibox(shell)).toHaveValue(pathToFileURL(file).href);

    // A network path would make Windows connect over SMB and offer the user's credentials to
    // that server, so it is a search like any other text. (`.invalid` can't resolve anyway.)
    const network = '\\\\host.invalid\\share\\secret.txt';
    await typeAddress(shell, network);
    await waitForPage(electronApp, tabId, {
      url: fixtureServer.url(searchPath(network)),
      title: searchTitle(network),
    });
    expect(fixtureServer.hits(searchPath(network))).toBe(1);
    expect((await tabState(electronApp, tabId))?.url.startsWith('file:')).toBe(false);
  });
});
