// The memory, M2.2b (ADR-0004 item 10, assessment §5.4, §5.5, §5.7): what Veltriva records, in the
// real database, as tabs navigate. TabManager reports each main-frame commit with how the user got
// there; HistoryRecorder applies URL hygiene, writes visits through the data worker, settles the
// title after 2 s and stores the favicon once per SHA-256.
//
// Every test reads the rows the way main does, through the `dataCall` hook (`readMemory`,
// ./memory-ui.ts), and the file itself, after the app quit or was killed, through a copy of it
// (./profile-db.ts). Rows are written behind the page, so every read is a poll.
//
// Rules from ADR-0008 item 4 that matter here: pages come from the local fixture server (the
// launcher also points searches at it, so a stray Enter never reaches the internet); keys and
// clicks are real input (`clickElement`) or the shell's own buttons; nothing closes a tab's Page.
import { createHash } from 'node:crypto';

import type { ElectronApplication, Page } from '@playwright/test';

import type { PageRow } from '../../src/shared/contracts/data-rpc';
import { GIF_1X1, buildSolidIco, buildSolidPng } from '../fixtures/memory-routes';
import type { FixtureServer } from '../fixtures/server';
import { clickElement, evaluateInTab, tabState } from './hooks';
import { observeFor } from './launch';
import {
  expect,
  expectVisits,
  readMemory,
  storedTitle,
  test,
  visitList,
  waitForFavicon,
  waitForPageRow,
} from './memory-ui';
import type { Transition } from './memory-ui';
import {
  bytesWithoutSession,
  foundSecrets,
  profileDbBytes,
  readProfileDb,
  writeProfileDb,
} from './profile-db';
import { dataValue, expectSaved, startWithPages } from './session-ui';
import {
  backButton,
  forwardButton,
  loadInNewTab,
  reloadButton,
  tabElement,
  typeAddress,
  waitForLoaded,
  waitForPage,
} from './shell-ui';

// Each test starts the app one to three times, and the machine may be busy.
test.describe.configure({ timeout: 180_000 });

/** A page of the memory fixture (tests/fixtures/memory-routes.ts). */
function memoryPage(
  server: FixtureServer,
  options: {
    readonly title: string;
    readonly icon?: string;
    readonly links?: readonly string[];
    readonly animate?: number;
    readonly final?: string;
    readonly extra?: string;
  },
): string {
  const query = new URLSearchParams({ title: options.title });
  if (options.icon !== undefined) {
    query.set('icon', options.icon);
  }
  for (const link of options.links ?? []) {
    query.append('link', link);
  }
  if (options.animate !== undefined) {
    query.set('animate', String(options.animate));
    query.set('final', options.final ?? 'Final');
  }
  return server.url(`/memory/page?${query.toString()}${options.extra ?? ''}`);
}

async function webContentsOf(app: ElectronApplication, tabId: string): Promise<number> {
  const state = await tabState(app, tabId);
  if (state?.webContentsId === null || state?.webContentsId === undefined) {
    throw new Error(`Tab ${tabId} has no web contents.`);
  }
  return state.webContentsId;
}

test.describe('visits and how the user got there', () => {
  test('typed, search, link, back, forward and reload each leave a visit with their own transition', async ({
    launcher,
    fixtureServer,
  }) => {
    const linkTarget = fixtureServer.url('/page-c.html?case=history-link');
    const pageA = memoryPage(fixtureServer, { title: 'Typed page', links: [linkTarget] });
    const pageB = fixtureServer.url('/page-b.html?case=history-typed');

    const { app, shell } = await launcher.launch();
    const tab = await loadInNewTab(app, shell, pageA);
    await expectVisits(app, [[pageA, 'typed']]);

    // A search from the address bar: the launcher points the template at the fixture's /search.
    await typeAddress(shell, 'ham sandwich');
    await waitForPage(app, tab, { title: 'Search results for: ham sandwich' });
    const searchUrl = (await tabState(app, tab))?.url ?? '';
    expect(new URL(searchUrl).pathname).toBe('/search');
    await expectVisits(app, [
      [pageA, 'typed'],
      [searchUrl, 'generated'],
    ]);

    await typeAddress(shell, pageB);
    await waitForPage(app, tab, { url: pageB, title: 'Page B' });
    await typeAddress(shell, pageA);
    await waitForPage(app, tab, { url: pageA, title: 'Typed page' });

    // A click on a link, with a real gesture: not typed, not generated.
    await clickElement(app, await webContentsOf(app, tab), '#link-0');
    await waitForPage(app, tab, { url: linkTarget, title: 'Page C' });
    // Back to the page with the link, Forward to its target, then a reload.
    await backButton(shell).click();
    await waitForPage(app, tab, { url: pageA, title: 'Typed page' });
    await forwardButton(shell).click();
    await waitForPage(app, tab, { url: linkTarget, title: 'Page C' });
    await reloadButton(shell).click();
    await waitForPage(app, tab, { url: linkTarget, title: 'Page C' });

    const expected: [string, Transition][] = [
      [pageA, 'typed'],
      [searchUrl, 'generated'],
      [pageB, 'typed'],
      [pageA, 'typed'],
      [linkTarget, 'link'],
      [pageA, 'back_forward'],
      [linkTarget, 'back_forward'],
      [linkTarget, 'reload'],
    ];
    await expectVisits(app, expected);

    // One page per distinct address, with the counts the visits add up to.
    const { pages } = await readMemory(app);
    expect(pages).toHaveLength(4);
    const counts = Object.fromEntries(
      pages.map((page) => [page.url, [page.visitCount, page.typedCount]]),
    );
    expect(counts).toEqual({
      [pageA]: [3, 2], // typed, typed, back
      [searchUrl]: [1, 0], // a search is generated, never typed
      [pageB]: [1, 1],
      [linkTarget]: [3, 0], // link, forward, reload
    });
    for (const page of pages) {
      expect(page.host, page.url).toBe('127.0.0.1');
      expect(page.site, page.url).toBe('127.0.0.1');
      expect(page.lastVisitAt, page.url).toBeGreaterThanOrEqual(page.firstVisitAt);
      expect(page.frecency, page.url).toBeGreaterThan(0);
    }
    // Every visit names the tab it happened in.
    expect((await readMemory(app)).visits.every((visit) => visit.tabId === tab)).toBe(true);
  });

  test('a server redirect is one commit: the page it lands on is the page, and the hop leaves nothing', async ({
    launcher,
    fixtureServer,
  }) => {
    const destination = fixtureServer.url('/page-b.html?case=history-redirect');
    const hop = `${fixtureServer.url('/memory/redirect')}?to=${encodeURIComponent(destination)}`;
    const second = `${fixtureServer.url('/memory/redirect')}?status=301&to=${encodeURIComponent(hop)}`;

    const redirectsBefore = fixtureServer.pathHits('/memory/redirect');
    const { app, shell } = await launcher.launch();
    const tab = await loadInNewTab(app, shell, hop);
    await waitForPage(app, tab, { url: destination, title: 'Page B' });
    await expectVisits(app, [[destination, 'typed']]);
    // Typed in the address bar was the redirecting address, so the visit counts as typed.
    let { pages } = await readMemory(app);
    expect(pages.map((page) => [page.url, page.visitCount, page.typedCount])).toEqual([
      [destination, 1, 1],
    ]);

    // Two hops (301, then 302) are still one visit.
    await typeAddress(shell, second);
    await waitForPage(app, tab, { url: destination, title: 'Page B' });
    await expectVisits(app, [
      [destination, 'typed'],
      [destination, 'typed'],
    ]);
    ({ pages } = await readMemory(app));
    expect(pages.map((page) => [page.url, page.visitCount, page.typedCount])).toEqual([
      [destination, 2, 2],
    ]);
    expect(fixtureServer.pathHits('/memory/redirect') - redirectsBefore).toBe(3);
  });

  test('a restored tab records a restore visit when it loads, and an unloaded tab none until it does', async ({
    launcher,
    fixtureServer,
  }) => {
    const urlA = fixtureServer.url('/page-a.html?case=history-restore');
    const urlB = fixtureServer.url('/page-b.html?case=history-restore');

    const first = await launcher.launch();
    const [a, b] = await startWithPages(first.app, first.shell, [urlA, urlB]);
    await tabElement(first.shell, a).click();
    await expect(tabElement(first.shell, a)).toHaveAttribute('aria-selected', 'true');
    await expectSaved(first.app, { ids: [a, b], selectedTabId: a });
    await expectVisits(first.app, [
      [urlA, 'typed'],
      [urlB, 'typed'],
    ]);
    await launcher.quit(first);

    const { app, shell } = await launcher.launch();
    // The selected tab loads at start: a restore visit. The other stays unloaded: none.
    await waitForLoaded(app, a);
    await expectVisits(app, [
      [urlA, 'typed'],
      [urlB, 'typed'],
      [urlA, 'restore'],
    ]);
    expect((await tabState(app, b))?.runtime).toBe('unloaded');

    // Selecting it loads it, and that is a restore visit too.
    await tabElement(shell, b).click();
    await waitForLoaded(app, b);
    await expectVisits(app, [
      [urlA, 'typed'],
      [urlB, 'typed'],
      [urlA, 'restore'],
      [urlB, 'restore'],
    ]);
    const { pages } = await readMemory(app);
    expect(pages.map((page) => [page.url, page.visitCount, page.typedCount]).sort()).toEqual([
      [urlA, 2, 1],
      [urlB, 2, 1],
    ]);
  });
});

test.describe('how the user got there, when a navigation does not commit', () => {
  test('an address that turns into a download leaves nothing behind: the next link click is a link', async ({
    launcher,
    fixtureServer,
  }) => {
    const target = fixtureServer.url('/page-c.html?case=history-after-download');
    const pageA = memoryPage(fixtureServer, { title: 'Page with a link', links: [target] });
    const download = fixtureServer.url('/dl/file?name=typed.bin&size=512');
    // Regression: a typed address whose response is a download commits nothing and fails nothing,
    // and its `typed` transition used to stay for the next commit in the tab (here a click on a
    // link): a wrong transition, typed_count and frecency weight. A load that stops without a
    // commit now clears it (TabManager's loadingChanged).

    const { app, shell } = await launcher.launch();
    const tab = await loadInNewTab(app, shell, pageA);
    await expectVisits(app, [[pageA, 'typed']]);

    // Typed, but the response is an attachment: the page stays, and nothing commits.
    await typeAddress(shell, download);
    await expect.poll(() => fixtureServer.hits('/dl/file?name=typed.bin&size=512')).toBe(1);
    await expect.poll(async () => (await tabState(app, tab))?.loading).toBe(false);
    expect((await tabState(app, tab))?.page.kind).toBe('web');

    await clickElement(app, await webContentsOf(app, tab), '#link-0');
    await waitForPage(app, tab, { url: target, title: 'Page C' });
    await expectVisits(app, [
      [pageA, 'typed'],
      [target, 'link'],
    ]);
  });
});

test.describe('same-document navigations', () => {
  test('a fragment or a tracking parameter adds no visit; a pushState to a new path adds one', async ({
    launcher,
    fixtureServer,
  }) => {
    const base = fixtureServer.url('/page-a.html?case=history-same-document');
    const pushed = fixtureServer.url('/page-b.html?case=history-pushed');

    const { app, shell } = await launcher.launch();
    const tab = await loadInNewTab(app, shell, base);
    await expectVisits(app, [[base, 'typed']]);
    const contents = await webContentsOf(app, tab);
    const urlOfTab = async (): Promise<string | undefined> => (await tabState(app, tab))?.url;

    // A fragment is the same page.
    // With a user activation (`userGesture`): Chromium marks a history entry a page made without
    // one as skippable, and Back would not offer it.
    const scripted = { userGesture: true } as const;
    await evaluateInTab(app, contents, "location.hash = '#section-2'", scripted);
    await expect.poll(urlOfTab).toBe(`${base}#section-2`);
    // So is a parameter that only says how the user arrived.
    await evaluateInTab(
      app,
      contents,
      "history.pushState({}, '', location.pathname + location.search + '&utm_source=news&fbclid=abc')",
      scripted,
    );
    await expect.poll(urlOfTab).toBe(`${base}&utm_source=news&fbclid=abc`);
    // A new path is a new page. The two changes above were reported first, so if either had made
    // a visit it would be in the list before this one.
    await evaluateInTab(
      app,
      contents,
      `history.pushState({}, '', ${JSON.stringify(pushed)})`,
      scripted,
    );
    await expect.poll(urlOfTab).toBe(pushed);
    await expectVisits(app, [
      [base, 'typed'],
      [pushed, 'link'],
    ]);
    // And nothing more arrives late.
    expect(await observeFor(800, async () => (await visitList(app)).length)).toEqual([2]);

    // Back goes to the entry before the push: the page's key changed again, so it is a visit.
    await backButton(shell).click();
    await expect.poll(urlOfTab).toBe(`${base}&utm_source=news&fbclid=abc`);
    await expect
      .poll(async () => (await visitList(app)).map(([, transition]) => transition))
      .toEqual(['typed', 'link', 'back_forward']);
    const { pages } = await readMemory(app);
    expect(pages).toHaveLength(2);
    expect(pages.map((page) => [new URL(page.urlKey).pathname, page.visitCount]).sort()).toEqual([
      ['/page-a.html', 2],
      ['/page-b.html', 1],
    ]);
  });
});

test.describe('titles', () => {
  test('the settled title is written 2 s after it stopped changing, not before', async ({
    launcher,
    fixtureServer,
  }) => {
    const url = memoryPage(fixtureServer, { title: 'First title' });
    const { app, shell } = await launcher.launch();
    const tab = await loadInNewTab(app, shell, url);
    const contents = await webContentsOf(app, tab);
    await expect.poll(() => storedTitle(app, url), { timeout: 15_000 }).toBe('First title');

    // The page changes its title. The database must keep the old one for about 2 s.
    const changedAt = Date.now();
    await evaluateInTab(app, contents, "document.title = 'Second title'");
    await expect.poll(async () => (await tabState(app, tab))?.title).toBe('Second title');
    await expect.poll(() => storedTitle(app, url), { timeout: 15_000 }).toBe('Second title');
    const waited = Date.now() - changedAt;
    expect(waited, 'a title is written only once it has been stable for 2 s').toBeGreaterThan(
      1_800,
    );
  });

  test('a page that changes its title every 100 ms costs one write: the last title', async ({
    launcher,
    fixtureServer,
  }) => {
    const url = memoryPage(fixtureServer, {
      title: 'Starting title',
      animate: 20,
      final: 'Rested title',
    });
    const { app, shell } = await launcher.launch();
    const tab = await loadInNewTab(app, shell, url);

    // 20 titles over 2 s, then 2 s of quiet. Watch the database the whole time: no title but
    // the last one may ever be written.
    const seen = await observeFor(7_000, async () => (await storedTitle(app, url)) ?? '(no page)');
    expect(seen.filter((title) => title !== '' && title !== 'Rested title')).toEqual([]);
    expect(seen.at(-1)).toBe('Rested title');
    expect((await tabState(app, tab))?.title).toBe('Rested title');
  });

  test('a title that changed less than 2 s before quitting is still stored', async ({
    launcher,
    fixtureServer,
    userDataDir,
  }) => {
    const url = memoryPage(fixtureServer, { title: 'Before the change' });
    const first = await launcher.launch();
    const tab = await loadInNewTab(first.app, first.shell, url);
    const contents = await webContentsOf(first.app, tab);
    await expect
      .poll(() => storedTitle(first.app, url), { timeout: 15_000 })
      .toBe('Before the change');

    await evaluateInTab(first.app, contents, "document.title = 'Changed just before quitting'");
    await expect
      .poll(async () => (await tabState(first.app, tab))?.title)
      .toBe('Changed just before quitting');
    // Main has the new title and the 2 s have not passed: the quit's own flush has to write it.
    await launcher.quit(first);

    expect(readProfileDb(userDataDir, 'SELECT title FROM pages WHERE url = ?', [url])).toEqual([
      { title: 'Changed just before quitting' },
    ]);
  });

  test('leaving a page settles its title at once, for the page left and not the one reached', async ({
    launcher,
    fixtureServer,
  }) => {
    const first = memoryPage(fixtureServer, { title: 'Page one' });
    const second = memoryPage(fixtureServer, { title: 'Page two' });
    const { app, shell } = await launcher.launch();
    const tab = await loadInNewTab(app, shell, first);
    const contents = await webContentsOf(app, tab);
    await expect.poll(() => storedTitle(app, first), { timeout: 15_000 }).toBe('Page one');

    await evaluateInTab(app, contents, "document.title = 'Page one, renamed'");
    await expect.poll(async () => (await tabState(app, tab))?.title).toBe('Page one, renamed');
    await typeAddress(shell, second);
    await waitForPage(app, tab, { url: second, title: 'Page two' });
    // The rename was still waiting when the tab moved on; it belongs to page one.
    await expect.poll(() => storedTitle(app, first), { timeout: 1_500 }).toBe('Page one, renamed');
    await expect.poll(() => storedTitle(app, second), { timeout: 15_000 }).toBe('Page two');
  });
});

/** The addresses the hygiene tests visit, and what the memory must make of each. */
function hygieneUrls(server: FixtureServer) {
  return {
    tracked: server.url(
      '/page-a.html?case=hygiene-track&utm_source=newsletter&utm_campaign=spring&fbclid=FBCLID-1&gclid=GCLID-2',
    ),
    trackedKey: server.url('/page-a.html?case=hygiene-track'),
    secret: server.url(
      '/page-a.html?case=hygiene-redact&token=TOKEN-SECRET-1&keep=yes&sig=SIG-SECRET-2' +
        '&password=PASSWORD-SECRET-3&X-Amz-Signature=AMZ-SECRET-4&X-Amz-Credential=AMZ-CRED-5' +
        '&api_key=APIKEY-SECRET-6',
    ),
    secretKept: server.url('/page-a.html?case=hygiene-redact&keep=yes'),
    fragment: server.url('/page-b.html?case=hygiene-fragment#part-2'),
    fragmentKey: server.url('/page-b.html?case=hygiene-fragment'),
    // Callbacks: one-time credentials, never places to go back to.
    callback: server.url('/page-a.html?case=hygiene-oauth&code=CODE-SECRET-7&state=STATE-SECRET-8'),
    implicit: server.url(
      '/page-a.html?case=hygiene-implicit#access_token=ACCESS-SECRET-9&token_type=bearer',
    ),
    hashRoute: server.url(
      '/page-a.html?case=hygiene-hash-route#/cb?code=HCODE-SECRET-10&state=HSTATE-SECRET-11',
    ),
    idToken: server.url('/page-a.html?case=hygiene-idtoken&id_token=IDTOKEN-SECRET-12'),
    // Typed with a user name and a password: the address bar removes them before it navigates.
    typedCredentials:
      server.origin.replace('http://', 'http://alice:PASS-SECRET-13@') +
      '/page-c.html?case=hygiene-credentials',
    credentialsRemoved: server.url('/page-c.html?case=hygiene-credentials'),
    control: server.url('/page-b.html?case=hygiene-control'),
  };
}

type HygieneUrls = ReturnType<typeof hygieneUrls>;

/** Every secret value above, and the names of the parameters that carried them. */
const HYGIENE_SECRETS = [
  'TOKEN-SECRET-1',
  'SIG-SECRET-2',
  'PASSWORD-SECRET-3',
  'AMZ-SECRET-4',
  'AMZ-CRED-5',
  'APIKEY-SECRET-6',
  'CODE-SECRET-7',
  'STATE-SECRET-8',
  'ACCESS-SECRET-9',
  'HCODE-SECRET-10',
  'HSTATE-SECRET-11',
  'IDTOKEN-SECRET-12',
  'PASS-SECRET-13',
  'alice',
  'X-Amz-Signature',
  'api_key',
  'access_token',
] as const;

/**
 * The secrets the session cuts as well (a token in the fragment, credentials in the address): the
 * whole file, with the session in it, must not hold these either. The others (a `?token=` in the
 * query) the session keeps on purpose, so that a tab restores to the page it was on.
 */
const SESSION_CUTS = ['ACCESS-SECRET-9', 'HCODE-SECRET-10', 'PASS-SECRET-13', 'alice'] as const;

/** Visits every address in `hygieneUrls` in one tab, then the control page. */
async function browseForHygiene(
  app: ElectronApplication,
  shell: Page,
  urls: HygieneUrls,
): Promise<void> {
  const tab = await loadInNewTab(app, shell, urls.tracked);
  await expectVisits(app, [[urls.tracked, 'typed']]);
  // The address shown keeps the tracking parameters; the page's identity does not.
  const [tracked] = (await readMemory(app)).pages;
  expect(tracked?.urlKey).toBe(urls.trackedKey);
  expect(tracked?.url).toBe(urls.tracked);

  for (const url of [
    urls.secret,
    urls.fragment,
    urls.callback,
    urls.implicit,
    urls.hashRoute,
    urls.idToken,
  ]) {
    await typeAddress(shell, url);
    await waitForPage(app, tab, { url });
  }
  // The same page again, with no tracking parameters: the same row.
  await typeAddress(shell, urls.trackedKey);
  await waitForPage(app, tab, { url: urls.trackedKey });
  await typeAddress(shell, urls.typedCredentials);
  await waitForPage(app, tab, { url: urls.credentialsRemoved });
  await typeAddress(shell, urls.control);
  await waitForPage(app, tab, { url: urls.control, title: 'Page B' });
  // Visits are written in order, so once the control page is there, everything before it was
  // either recorded or not recorded for good.
  await waitForPageRow(app, urls.control);
}

/** What the memory must hold once `browseForHygiene` is done, whatever the file looks like. */
function expectedHygienePages(urls: HygieneUrls) {
  return [
    // The second visit (without tracking) rewrote the address shown with its own form.
    { urlKey: urls.trackedKey, url: urls.trackedKey, visitCount: 2, typedCount: 2 },
    { urlKey: urls.secretKept, url: urls.secretKept, visitCount: 1, typedCount: 1 },
    { urlKey: urls.fragmentKey, url: urls.fragment, visitCount: 1, typedCount: 1 },
    { urlKey: urls.credentialsRemoved, url: urls.credentialsRemoved, visitCount: 1, typedCount: 1 },
    { urlKey: urls.control, url: urls.control, visitCount: 1, typedCount: 1 },
  ].sort((a, b) => a.urlKey.localeCompare(b.urlKey));
}

function summarize(pages: readonly PageRow[]) {
  return pages
    .map(({ urlKey, url, visitCount, typedCount }) => ({ urlKey, url, visitCount, typedCount }))
    .sort((a, b) => a.urlKey.localeCompare(b.urlKey));
}

test.describe('URL hygiene, in the real file', () => {
  test('tracking parameters leave the key, secrets leave everything, callbacks and credentials leave no row', async ({
    launcher,
    fixtureServer,
    userDataDir,
  }) => {
    const urls = hygieneUrls(fixtureServer);
    const first = await launcher.launch();
    await browseForHygiene(first.app, first.shell, urls);

    // As main reads it: one row per key, the callbacks and the credentials nowhere.
    const { pages, visits } = await readMemory(first.app);
    expect(summarize(pages)).toEqual(expectedHygienePages(urls));
    expect(visits).toHaveLength(6);
    expect(JSON.stringify({ pages, visits })).not.toMatch(
      new RegExp(`${HYGIENE_SECRETS.join('|')}|FBCLID|GCLID|utm_`, 'u'),
    );
    await launcher.quit(first);

    // As the file holds it, read independently of the app.
    const rows = readProfileDb(userDataDir, 'SELECT url, url_key FROM pages ORDER BY url_key');
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      for (const text of [String(row.url), String(row.url_key)]) {
        expect(text).not.toMatch(new RegExp(HYGIENE_SECRETS.join('|'), 'iu'));
        expect(text).not.toMatch(/utm_|fbclid|gclid/iu);
      }
    }
    expect(readProfileDb(userDataDir, 'SELECT count(*) AS n FROM visits')).toEqual([{ n: 6 }]);
    // The search index is built from the stored address, so a secret is not searchable either.
    expect(
      readProfileDb(
        userDataDir,
        "SELECT count(*) AS n FROM pages_fts WHERE pages_fts MATCH 'secret OR amz OR cred OR alice'",
      ),
    ).toEqual([{ n: 0 }]);

    // The bytes: the file without the session holds none of them, and the whole file (and its log)
    // none of the ones the session cuts as well.
    const whole = profileDbBytes(userDataDir);
    expect(whole.includes('hygiene-control'), 'the scan should read the database').toBe(true);
    expect(foundSecrets(whole, SESSION_CUTS)).toEqual([]);
    const withoutSession = bytesWithoutSession(userDataDir);
    expect(withoutSession.includes('hygiene-control'), 'the scan should read the copy').toBe(true);
    expect(foundSecrets(withoutSession, HYGIENE_SECRETS)).toEqual([]);
  });

  test('the same holds after a hard kill: the rows are there, and the log holds no secret', async ({
    launcher,
    fixtureServer,
    userDataDir,
  }) => {
    const urls = hygieneUrls(fixtureServer);
    const first = await launcher.launch();
    await browseForHygiene(first.app, first.shell, urls);
    await expect
      .poll(async () => summarize((await readMemory(first.app)).pages), { timeout: 15_000 })
      .toEqual(expectedHygienePages(urls));
    // Nothing is flushed: whatever the file holds now is what the worker had committed.
    await launcher.kill(first);

    expect(
      readProfileDb(userDataDir, 'SELECT url_key FROM pages ORDER BY url_key').map(
        (row) => row.url_key,
      ),
    ).toEqual(expectedHygienePages(urls).map((page) => page.urlKey));
    const whole = profileDbBytes(userDataDir);
    expect(whole.includes('hygiene-control'), 'the scan should read the database and its log').toBe(
      true,
    );
    expect(foundSecrets(whole, SESSION_CUTS)).toEqual([]);
    expect(foundSecrets(bytesWithoutSession(userDataDir), HYGIENE_SECRETS)).toEqual([]);

    // The next start finds the same memory.
    // (The tab that was selected loads again, which is one more visit to the control page.)
    const { app } = await launcher.launchAfterKill();
    await expect
      .poll(async () => summarize((await readMemory(app)).pages), { timeout: 15_000 })
      .toEqual(
        expectedHygienePages(urls).map((page) =>
          page.urlKey === urls.control ? { ...page, visitCount: 2 } : page,
        ),
      );
  });

  test('a script that navigates to an address with a user name and a password leaves no row', async ({
    launcher,
    fixtureServer,
    userDataDir,
  }) => {
    const credentialed = fixtureServer.origin.replace('http://', 'http://bob:LINK-SECRET-14@');
    const target = `${credentialed}/page-c.html?case=hygiene-link-credentials`;
    const start = fixtureServer.url('/page-a.html?case=hygiene-link-start');
    const control = fixtureServer.url('/page-b.html?case=hygiene-link-control');

    const { app, shell } = await launcher.launch();
    const tab = await loadInNewTab(app, shell, start);
    await evaluateInTab(
      app,
      await webContentsOf(app, tab),
      `location.href = ${JSON.stringify(target)}`,
      { userGesture: true },
    );
    // Whatever the tab ends up showing (the navigation may be refused), the memory has nothing of
    // it. Give the navigation time to happen, so the address bar is not typed into mid-change.
    const moved = await expect
      .poll(async () => (await tabState(app, tab))?.url, { timeout: 8_000 })
      .not.toBe(start)
      .then(
        () => true,
        () => false,
      );
    await expect.poll(async () => (await tabState(app, tab))?.loading).toBe(false);
    const shown = await tabState(app, tab);
    test.info().annotations.push({
      type: 'address with credentials',
      description: `${moved ? 'followed' : 'refused'}: the tab shows ${shown?.page.kind ?? '?'} ${shown?.url ?? '?'} "${shown?.title ?? ''}"`,
    });
    await typeAddress(shell, control);
    await waitForPage(app, tab, { url: control });
    await waitForPageRow(app, control);

    const { pages } = await readMemory(app);
    expect(JSON.stringify(pages)).not.toMatch(/bob|LINK-SECRET/u);
    await launcher.quit({ app, shell });
    expect(foundSecrets(bytesWithoutSession(userDataDir), ['LINK-SECRET-14', 'bob'])).toEqual([]);
  });
});

test.describe('favicons', () => {
  /** The `favicons` rows, read from the file after the app quit. */
  function storedIcons(userDataDir: string) {
    return readProfileDb(
      userDataDir,
      'SELECT id, sha256, mime, bytes FROM favicons ORDER BY id',
    ).map((row) => ({
      id: Number(row.id),
      sha256: String(row.sha256),
      mime: String(row.mime),
      bytes: Buffer.from((row.bytes as { base64: string }).base64, 'base64'),
    }));
  }

  const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

  // Regression: Chromium reports a document's favicon candidates only when they differ from the
  // previous document's in the same tab, so the second of two pages with the same icon got none,
  // in the strip and in the memory (found by main-thread.spec.ts). TabRuntime now takes the last
  // candidates again when a document reports none.
  test('the next page in a tab with the same icon gets it too, in the strip and in the memory', async ({
    launcher,
    fixtureServer,
  }) => {
    const iconPath = '/memory/icon.png?w=16&h=16&c=0,120,60';
    const first = memoryPage(fixtureServer, { title: 'First with icon', icon: iconPath });
    const second = memoryPage(fixtureServer, { title: 'Second with icon', icon: iconPath });
    const third = memoryPage(fixtureServer, { title: 'Third with icon', icon: iconPath });

    const { app, shell } = await launcher.launch();
    const tab = await loadInNewTab(app, shell, first);
    const { page: firstRow } = await waitForFavicon(app, first);
    for (const [url, title] of [
      [second, 'Second with icon'],
      [third, 'Third with icon'],
    ] as const) {
      await typeAddress(shell, url);
      await waitForPage(app, tab, { url, title });
      const { page } = await waitForFavicon(app, url);
      expect(page.faviconId).toBe(firstRow.faviconId);
      await expect
        .poll(async () => (await tabState(app, tab))?.favicon ?? null, {
          message: `the strip should show the icon of ${title}`,
        })
        .not.toBeNull();
    }
  });

  test('a PNG, an ICO and a GIF are stored as served, once each, and pages with the same icon share the row', async ({
    launcher,
    fixtureServer,
    userDataDir,
  }) => {
    const pngPath = '/memory/icon.png?w=16&h=16&c=0,90,200';
    const icoPath = '/memory/icon.ico?size=32&c=200,0,0';
    const pages = {
      png: memoryPage(fixtureServer, { title: 'PNG icon', icon: pngPath }),
      ico: memoryPage(fixtureServer, { title: 'ICO icon', icon: icoPath }),
      // The same icon on another page: the same row.
      samePng: memoryPage(fixtureServer, { title: 'Same PNG', icon: pngPath }),
      // Another address with the very same bytes: the same row (it is the bytes that count).
      sameBytes: memoryPage(fixtureServer, { title: 'Same bytes', icon: `${pngPath}&copy=2` }),
      gif: memoryPage(fixtureServer, { title: 'GIF icon', icon: '/memory/icon.gif' }),
    };

    const first = await launcher.launch();
    const tab = await loadInNewTab(first.app, first.shell, pages.png);
    const ids: Record<string, number | null> = {};
    for (const [name, url] of Object.entries(pages)) {
      if (name !== 'png') {
        await typeAddress(first.shell, url);
        await waitForPage(first.app, tab, { url });
      }
      ids[name] = (await waitForFavicon(first.app, url)).page.faviconId;
    }
    expect(new Set([ids.png, ids.samePng, ids.sameBytes]).size, 'one row for one icon').toBe(1);
    expect(new Set(Object.values(ids)).size, 'PNG, ICO and GIF are three icons').toBe(3);
    await launcher.quit(first);

    const icons = storedIcons(userDataDir);
    expect(icons).toHaveLength(3);
    const served = {
      png: { bytes: buildSolidPng(16, 16, [0, 90, 200, 255]), mime: 'image/png' },
      ico: { bytes: buildSolidIco(32, [200, 0, 0, 255]), mime: 'image/x-icon' },
      gif: { bytes: GIF_1X1, mime: 'image/gif' },
    } as const;
    for (const [name, expected] of Object.entries(served)) {
      const row = icons.find((icon) => icon.bytes.equals(expected.bytes));
      expect(
        row,
        `${name}: the stored bytes should be the served file, byte for byte`,
      ).toBeDefined();
      expect(row?.mime, name).toBe(expected.mime);
      expect(row?.sha256, name).toBe(sha256(expected.bytes));
      expect(ids[name], `${name}: its page should point at the row`).toBe(row?.id);
    }
    // The pages table says the same.
    expect(
      readProfileDb(
        userDataDir,
        'SELECT count(DISTINCT favicon_id) AS n FROM pages WHERE favicon_id IS NOT NULL',
      ),
    ).toEqual([{ n: 3 }]);
  });

  test('an SVG icon, one over 64 KiB and one that is not an image get no row', async ({
    launcher,
    fixtureServer,
    userDataDir,
  }) => {
    const refused = [
      memoryPage(fixtureServer, { title: 'SVG icon', icon: '/favicon.svg' }),
      memoryPage(fixtureServer, { title: 'Big icon', icon: '/favicon-big.png' }),
      memoryPage(fixtureServer, { title: 'Fake icon', icon: '/favicon-fake.png' }),
    ];
    const control = memoryPage(fixtureServer, {
      title: 'Control icon',
      icon: '/memory/icon.png?w=16&h=16&c=1,2,3',
    });

    const first = await launcher.launch();
    const tab = await loadInNewTab(first.app, first.shell, refused[0] ?? '');
    for (const url of [...refused.slice(1), control]) {
      await typeAddress(first.shell, url);
      await waitForPage(first.app, tab, { url });
    }
    // The control's icon arrives after the others were looked at, and is the only one stored.
    await waitForFavicon(first.app, control);
    for (const url of refused) {
      const page = await waitForPageRow(first.app, url);
      expect(page.faviconId, url).toBeNull();
    }
    await launcher.quit(first);
    expect(storedIcons(userDataDir)).toHaveLength(1);
  });
});

test.describe('a site excluded from the memory', () => {
  test('is never recorded: no page, no visit, no title, no icon; other sites still are', async ({
    launcher,
    fixtureServer,
    userDataDir,
  }) => {
    // The database exists once the app has run on the profile. A site_rules row is a row only a
    // person with the file can add: no method of the data contract writes one yet.
    await launcher.quit(await launcher.launch());
    const site = new URL(fixtureServer.otherSiteOrigin).hostname;
    writeProfileDb(userDataDir, [
      {
        sql: 'INSERT INTO site_rules (site, protect, exclude_memory, created_at) VALUES (?, 0, 1, ?)',
        params: [site, Date.now()],
      },
    ]);

    const excluded = fixtureServer.otherSiteUrl(
      `/memory/page?title=Excluded+site&icon=${encodeURIComponent('/memory/icon.png?w=16&h=16&c=200,0,0')}`,
    );
    const excludedToo = fixtureServer.otherSiteUrl('/page-a.html?case=excluded-second');
    const included = memoryPage(fixtureServer, {
      title: 'Included site',
      icon: '/memory/icon.png?w=16&h=16&c=0,200,0',
    });

    const { app, shell } = await launcher.launch();
    const tab = await loadInNewTab(app, shell, excluded);
    await typeAddress(shell, excludedToo);
    await waitForPage(app, tab, { url: excludedToo, title: 'Page A' });
    await typeAddress(shell, included);
    await waitForPage(app, tab, { url: included, title: 'Included site' });
    // Everything the excluded pages would have written (a visit, then a title after 2 s, then an
    // icon) has had its time once the included page has its title and icon.
    await waitForFavicon(app, included);
    await expect.poll(() => storedTitle(app, included), { timeout: 15_000 }).toBe('Included site');

    const memory = await readMemory(app);
    expect(memory.pages.map((page) => page.url)).toEqual([included]);
    expect(memory.visits.map((visit) => [visit.url, visit.transition])).toEqual([
      [included, 'typed'],
    ]);
    await launcher.quit({ app, shell });

    expect(readProfileDb(userDataDir, 'SELECT url FROM pages')).toEqual([{ url: included }]);
    expect(readProfileDb(userDataDir, 'SELECT count(*) AS n FROM visits')).toEqual([{ n: 1 }]);
    // Only the included page's icon was stored.
    expect(readProfileDb(userDataDir, 'SELECT count(*) AS n FROM favicons')).toEqual([{ n: 1 }]);
    expect(
      readProfileDb(
        userDataDir,
        'SELECT exclude_memory AS excluded FROM site_rules WHERE site = ?',
        [site],
      ),
    ).toEqual([{ excluded: 1 }]);
  });
});

test.describe('retention', () => {
  const DAY = 86_400_000;

  test('upkeep deletes old visits, then the pages with none left, in the real file', async ({
    launcher,
    userDataDir,
  }) => {
    const now = Date.now();
    const address = (name: string): string => `http://127.0.0.1:9/retention-${name}`;
    const running = await launcher.launch();
    const visit = (name: string, daysAgo: number) =>
      dataValue(running.app, 'history.recordVisit', {
        page: {
          urlKey: address(name),
          url: address(name),
          host: '127.0.0.1',
          site: '127.0.0.1',
          title: '',
        },
        transition: 'link',
        visitedAt: now - daysAgo * DAY,
        tabId: null,
      });
    await visit('gone-a', 400);
    await visit('gone-b', 366);
    await visit('edge', 364);
    await visit('mixed', 500);
    await visit('mixed', 10);
    await visit('fresh', 0);

    const upkeep = (days: number) =>
      dataValue<{ pruned: { visits: number; pages: number; closedTabs: number } }>(
        running.app,
        'maintenance.run',
        { now, visitRetentionDays: days },
      );
    const left = async (): Promise<string[]> =>
      (await readMemory(running.app)).pages
        .map((page) => page.url.split('retention-')[1] ?? '')
        .sort();

    // A year: the three visits over a year old go, and the two pages they were the only ones of.
    expect((await upkeep(365)).pruned).toEqual({ visits: 3, pages: 2, closedTabs: 0 });
    expect(await left()).toEqual(['edge', 'fresh', 'mixed']);
    const { visits } = await readMemory(running.app);
    expect(visits.filter((entry) => entry.url.endsWith('retention-mixed'))).toHaveLength(1);
    // Nothing is due twice.
    expect((await upkeep(365)).pruned).toEqual({ visits: 0, pages: 0, closedTabs: 0 });

    // Five days: the visits of 364 and 10 days ago go, and their pages with them.
    expect((await upkeep(5)).pruned).toEqual({ visits: 2, pages: 2, closedTabs: 0 });
    expect(await left()).toEqual(['fresh']);
    await launcher.quit(running);

    expect(readProfileDb(userDataDir, 'SELECT url FROM pages')).toEqual([
      { url: address('fresh') },
    ]);
    expect(readProfileDb(userDataDir, 'SELECT count(*) AS n FROM visits')).toEqual([{ n: 1 }]);
    // Deleted means overwritten: the deleted pages' addresses are not in the file or its log.
    const bytes = profileDbBytes(userDataDir);
    expect(bytes.includes('retention-fresh'), 'the scan should read the database').toBe(true);
    expect(
      foundSecrets(bytes, [
        'retention-gone-a',
        'retention-gone-b',
        'retention-edge',
        'retention-mixed',
      ]),
    ).toEqual([]);
  });
});
