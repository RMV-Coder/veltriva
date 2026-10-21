// What Veltriva keeps of the user's decisions, M2.2b (ADR-0004 item 10, amendments (b) and (d)):
// permission answers (`permission_decisions`), "always allow" for an external protocol (a
// `protocol:<scheme>` row), the client-hint opt-ins (the `client_hints` document), and the settings
// document. Main reads them at startup, within 3 s, and writes each change through; the dismissal
// embargo stays in memory.
//
// Every test starts the app more than once on one profile (`launcher`, ./session-ui.ts), so a
// decision that comes back really went through the database file.
//
// PRIVACY (as in permissions.spec.ts): an automated test never turns on this machine's camera or
// microphone and never makes a real location lookup. Allow is exercised on notifications only;
// geolocation is only ever dismissed.
//
// The pages are the permissions, external-links and client-hints fixtures of M1.4a. No real app
// may open: test builds record external launches (`externalLaunches`) and open nothing.
import type { ElectronApplication } from '@playwright/test';

import { OPT_IN_HINTS, DEFAULT_HINTS } from '../../src/core/net/client-hints';
import { startFixtureServer } from '../fixtures/server';
import type { FixtureServer } from '../fixtures/server';
import {
  clientHintsReady,
  clickElement,
  contextMenuItems,
  evaluateInTab,
  externalLaunches,
} from './hooks';
import { closeApp, launchApp, shellPage } from './launch';
import { expect, expectVisits, storedPermissions, test } from './memory-ui';
import {
  clickNow,
  clickYes,
  expectNoStrip,
  expectNoStripFor,
  alwaysAllowBox,
  promptStrip,
  stripSentence,
  waitForStrip,
} from './prompt-ui';
import { readProfileDb, writeProfileDb } from './profile-db';
import { dataValue } from './session-ui';
import { loadTab, tabElements, typeAddress, waitForPage, SLOW_TIMEOUT_MS } from './shell-ui';

// Each test starts the app two or three times, and the machine may be busy.
test.describe.configure({ timeout: 180_000 });

// ── Permissions ─────────────────────────────────────────────────────────────────────────────────

type RequestName = 'notifications' | 'clipboard-read' | 'geolocation' | 'camera';

interface Outcome {
  readonly ok: boolean;
  readonly name?: string;
  readonly code?: number | null;
  readonly value?: string;
}

function startRequest(app: ElectronApplication, contentsId: number, name: RequestName) {
  return evaluateInTab(app, contentsId, `permissionsFixture.start(${JSON.stringify(name)})`);
}

/** Waits until a started request has settled, however it ended. */
async function settledOutcome(
  app: ElectronApplication,
  contentsId: number,
  name: RequestName,
): Promise<Outcome> {
  const seen: { outcome: Outcome | null } = { outcome: null };
  await expect
    .poll(
      async () => {
        seen.outcome = (await evaluateInTab(
          app,
          contentsId,
          `permissionsFixture.result(${JSON.stringify(name)})`,
        )) as Outcome | null;
        return seen.outcome !== null;
      },
      { message: `the ${name} request should settle`, timeout: SLOW_TIMEOUT_MS },
    )
    .toBe(true);
  if (seen.outcome === null) {
    throw new Error('unreachable: the poll passed with no outcome');
  }
  return seen.outcome;
}

async function permissionState(
  app: ElectronApplication,
  contentsId: number,
  name: string,
): Promise<string> {
  return (await evaluateInTab(
    app,
    contentsId,
    `permissionsFixture.state(${JSON.stringify(name)})`,
  )) as string;
}

const GRANTED = { ok: true, value: 'granted' };

test.describe('permission decisions', () => {
  test('"Allow" and "Block" come back after a restart, with no question; the embargo does not', async ({
    launcher,
    fixtureServer,
  }) => {
    const origin = fixtureServer.origin;
    const pageUrl = fixtureServer.url('/permissions.html');
    const otherUrl = fixtureServer.otherSiteUrl('/permissions.html');

    const first = await launcher.launch();
    const tab = await loadTab(first.app, first.shell, pageUrl);
    // Allow notifications...
    await startRequest(first.app, tab.webContentsId, 'notifications');
    await waitForStrip(first.shell, 'permission');
    await clickYes(first.shell, 'Allow');
    await expectNoStrip(first.shell);
    expect(await settledOutcome(first.app, tab.webContentsId, 'notifications')).toMatchObject(
      GRANTED,
    );
    // ...and block the clipboard.
    await startRequest(first.app, tab.webContentsId, 'clipboard-read');
    await waitForStrip(first.shell, 'permission');
    await clickNow(first.shell, 'Block');
    await expectNoStrip(first.shell);
    expect(await settledOutcome(first.app, tab.webContentsId, 'clipboard-read')).toMatchObject({
      ok: false,
      name: 'NotAllowedError',
    });

    // Another origin dismisses a question three times: the embargo blocks it for this run.
    const other = await loadTab(first.app, first.shell, otherUrl);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await startRequest(first.app, other.webContentsId, 'geolocation');
      await waitForStrip(first.shell, 'permission');
      await clickNow(first.shell, 'Dismiss');
      await expectNoStrip(first.shell);
      expect(await settledOutcome(first.app, other.webContentsId, 'geolocation')).toMatchObject({
        ok: false,
        code: 1,
      });
    }
    await startRequest(first.app, other.webContentsId, 'geolocation');
    await expectNoStripFor(first.shell, other.tabId, 1_000, 'an embargoed request must not ask');
    expect(await settledOutcome(first.app, other.webContentsId, 'geolocation')).toMatchObject({
      ok: false,
      code: 1,
    });

    // The two answers are rows; the embargo is not.
    await expect
      .poll(() => storedPermissions(first.app), { message: 'the answers should be stored' })
      .toEqual([
        { origin, permission: 'clipboard-read', decision: 'block' },
        { origin, permission: 'notifications', decision: 'allow' },
      ]);
    await launcher.quit(first);

    const { app, shell } = await launcher.launch();
    // Read at startup: the rows are there before any page asks.
    expect(await storedPermissions(app)).toEqual([
      { origin, permission: 'clipboard-read', decision: 'block' },
      { origin, permission: 'notifications', decision: 'allow' },
    ]);
    const again = await loadTab(app, shell, pageUrl);
    expect(await permissionState(app, again.webContentsId, 'notifications')).toBe('granted');
    expect(await permissionState(app, again.webContentsId, 'clipboard-read')).toBe('denied');
    await startRequest(app, again.webContentsId, 'notifications');
    await expectNoStripFor(shell, again.tabId, 1_000, 'a stored "Allow" must not ask again');
    expect(await settledOutcome(app, again.webContentsId, 'notifications')).toMatchObject(GRANTED);
    await startRequest(app, again.webContentsId, 'clipboard-read');
    await expectNoStripFor(shell, again.tabId, 1_000, 'a stored "Block" must not ask again');
    expect(await settledOutcome(app, again.webContentsId, 'clipboard-read')).toMatchObject({
      ok: false,
      name: 'NotAllowedError',
    });

    // The embargo did not survive: the origin that was blocked by it asks again.
    const asking = await loadTab(app, shell, otherUrl);
    await startRequest(app, asking.webContentsId, 'geolocation');
    await waitForStrip(shell, 'permission');
    await expect(stripSentence(shell)).toContainText('wants to know your location');
    await clickNow(shell, 'Dismiss');
    expect(await settledOutcome(app, asking.webContentsId, 'geolocation')).toMatchObject({
      ok: false,
      code: 1,
    });
    // Nothing about it was ever stored.
    expect((await storedPermissions(app)).map((row) => row.origin)).toEqual([origin, origin]);
  });

  test('answers survive a hard kill: they were committed when they were made', async ({
    launcher,
    fixtureServer,
  }) => {
    const origin = fixtureServer.origin;
    const pageUrl = fixtureServer.url('/permissions.html');
    const first = await launcher.launch();
    const tab = await loadTab(first.app, first.shell, pageUrl);
    await startRequest(first.app, tab.webContentsId, 'notifications');
    await waitForStrip(first.shell, 'permission');
    await clickYes(first.shell, 'Allow');
    expect(await settledOutcome(first.app, tab.webContentsId, 'notifications')).toMatchObject(
      GRANTED,
    );
    // The camera is only ever blocked in a test (privacy note above).
    await startRequest(first.app, tab.webContentsId, 'camera');
    await waitForStrip(first.shell, 'permission');
    await clickNow(first.shell, 'Block');
    expect(await settledOutcome(first.app, tab.webContentsId, 'camera')).toMatchObject({
      ok: false,
      name: 'NotAllowedError',
    });
    await expect
      .poll(() => storedPermissions(first.app))
      .toEqual([
        { origin, permission: 'camera', decision: 'block' },
        { origin, permission: 'notifications', decision: 'allow' },
      ]);
    // Nothing is flushed: the rows are what the worker had committed.
    await launcher.kill(first);

    const { app, shell } = await launcher.launchAfterKill();
    expect(await storedPermissions(app)).toEqual([
      { origin, permission: 'camera', decision: 'block' },
      { origin, permission: 'notifications', decision: 'allow' },
    ]);
    const again = await loadTab(app, shell, pageUrl);
    expect(await permissionState(app, again.webContentsId, 'notifications')).toBe('granted');
    await startRequest(app, again.webContentsId, 'notifications');
    await startRequest(app, again.webContentsId, 'camera');
    await expectNoStripFor(shell, again.tabId, 1_000, 'stored answers must not ask');
    expect(await settledOutcome(app, again.webContentsId, 'notifications')).toMatchObject(GRANTED);
    expect(await settledOutcome(app, again.webContentsId, 'camera')).toMatchObject({
      ok: false,
      name: 'NotAllowedError',
    });
  });
});

// ── External protocols ──────────────────────────────────────────────────────────────────────────

test.describe('"always allow" for an external protocol', () => {
  test('comes back after a restart as a protocol:<scheme> row, for that site only, and never skips the gesture', async ({
    launcher,
    fixtureServer,
  }) => {
    const origin = fixtureServer.origin;
    const linksUrl = fixtureServer.url('/external-links.html');
    const otherLinks = fixtureServer.otherSiteUrl('/external-links.html');

    const first = await launcher.launch();
    const tab = await loadTab(first.app, first.shell, linksUrl);
    await clickElement(first.app, tab.webContentsId, '#link-hello');
    await waitForStrip(first.shell, 'external-protocol');
    await alwaysAllowBox(first.shell).check();
    await clickYes(first.shell, 'Open');
    await expect.poll(() => externalLaunches(first.app)).toEqual(['veltriva-test:hello']);

    // Another site ticks the box and cancels: that is not an "always allow".
    const other = await loadTab(first.app, first.shell, otherLinks);
    await clickElement(first.app, other.webContentsId, '#link-hello');
    await waitForStrip(first.shell, 'external-protocol');
    await alwaysAllowBox(first.shell).check();
    await clickNow(first.shell, 'Cancel');
    await expectNoStrip(first.shell);

    await expect
      .poll(() => storedPermissions(first.app))
      .toEqual([{ origin, permission: 'protocol:veltriva-test', decision: 'allow' }]);
    await launcher.quit(first);

    const { app, shell } = await launcher.launch();
    expect(await storedPermissions(app)).toEqual([
      { origin, permission: 'protocol:veltriva-test', decision: 'allow' },
    ]);
    // Test builds record launches per run: nothing yet.
    expect(await externalLaunches(app)).toEqual([]);
    const again = await loadTab(app, shell, linksUrl);
    await clickElement(app, again.webContentsId, '#link-hello');
    await expect
      .poll(() => externalLaunches(app), { message: 'a remembered site launches without asking' })
      .toEqual(['veltriva-test:hello']);
    await expect(promptStrip(shell)).toHaveCount(0);

    // Still never without a gesture: a script launches nothing.
    await evaluateInTab(app, again.webContentsId, 'externalFixture.goTo("veltriva-test:hello")', {
      userGesture: true,
    });
    await expectNoStripFor(shell, again.tabId, 1_000, 'a remembered site still needs a gesture');
    expect(await externalLaunches(app)).toEqual(['veltriva-test:hello']);

    // The other site never ticked it in a way that counts: it asks.
    const asking = await loadTab(app, shell, otherLinks);
    await clickElement(app, asking.webContentsId, '#link-hello');
    await waitForStrip(shell, 'external-protocol');
    await clickNow(shell, 'Cancel');
    expect(await externalLaunches(app)).toEqual(['veltriva-test:hello']);
  });
});

// ── Client hints ────────────────────────────────────────────────────────────────────────────────

type Headers = Readonly<Record<string, string | string[] | undefined>>;

function hintNamesOf(headers: Headers): string[] {
  return Object.keys(headers)
    .filter((name) => name.startsWith('sec-ch-'))
    .sort();
}

function lastRequestTo(server: FixtureServer, pathAndQuery: string): Headers {
  const { pathname } = new URL(pathAndQuery, server.origin);
  const last = server
    .requestsTo(pathname)
    .filter((request) => request.url === pathAndQuery)
    .at(-1);
  if (last === undefined) {
    throw new Error(`The fixture server got no request for ${pathAndQuery}`);
  }
  return last.headers;
}

const WITH_OPT_INS = [...DEFAULT_HINTS, ...OPT_IN_HINTS].sort();

/** The client_hints document as the database holds it. */
async function storedHints(app: ElectronApplication): Promise<unknown> {
  return (await dataValue<{ value: unknown }>(app, 'appState.get', { key: 'client_hints' })).value;
}

async function askForHints(
  app: ElectronApplication,
  shell: Parameters<typeof typeAddress>[0],
  server: FixtureServer,
): Promise<string> {
  await expect.poll(() => clientHintsReady(app)).toBe(true);
  const tab = await loadTab(app, shell, server.url('/page-a.html?case=hints-before'));
  // Before it asks: the defaults only.
  expect(hintNamesOf(lastRequestTo(server, '/page-a.html?case=hints-before'))).toEqual(
    [...DEFAULT_HINTS].sort(),
  );
  await typeAddress(shell, server.url('/client-hints-opt-in'));
  await waitForPage(app, tab.tabId, { url: server.url('/client-hints-opt-in') });
  return tab.tabId;
}

test.describe('client-hint opt-ins', () => {
  const DOCUMENT_ORIGIN = (server: FixtureServer) => server.origin;

  test('an origin that sent Accept-CH gets the opt-in hints after a restart, and others do not', async ({
    launcher,
    fixtureServer,
  }) => {
    const first = await launcher.launch();
    await askForHints(first.app, first.shell, fixtureServer);
    // Written at most 5 s after the change.
    await expect
      .poll(() => storedHints(first.app), { timeout: 20_000 })
      .toEqual({ v: 1, origins: { [DOCUMENT_ORIGIN(fixtureServer)]: [...OPT_IN_HINTS] } });
    await launcher.quit(first);

    const { app, shell } = await launcher.launch();
    await expect.poll(() => clientHintsReady(app)).toBe(true);
    expect(await storedHints(app)).toEqual({
      v: 1,
      origins: { [DOCUMENT_ORIGIN(fixtureServer)]: [...OPT_IN_HINTS] },
    });
    // The site has not asked in this run, and its first request carries everything it asked for.
    const path = '/page-b.html?case=hints-after-restart';
    const tab = await loadTab(app, shell, fixtureServer.url(path));
    expect(hintNamesOf(lastRequestTo(fixtureServer, path))).toEqual(WITH_OPT_INS);
    // Another site (localhost) never asked: defaults only.
    const other = fixtureServer.otherSiteUrl('/page-c.html?case=hints-other-site');
    await typeAddress(shell, other);
    await waitForPage(app, tab.tabId, { url: other });
    expect(hintNamesOf(lastRequestTo(fixtureServer, '/page-c.html?case=hints-other-site'))).toEqual(
      [...DEFAULT_HINTS].sort(),
    );
  });

  test('an opt-in made just before quitting is written by the quit, not 5 s later', async ({
    launcher,
    fixtureServer,
    userDataDir,
  }) => {
    const first = await launcher.launch();
    await askForHints(first.app, first.shell, fixtureServer);
    // No wait for the 5 s write: the quit's flush has to do it.
    await launcher.quit(first);

    const rows = readProfileDb(
      userDataDir,
      "SELECT json FROM app_state WHERE key = 'client_hints'",
    );
    expect(rows).toHaveLength(1);
    expect(JSON.parse(String(rows[0]?.json))).toEqual({
      v: 1,
      origins: { [DOCUMENT_ORIGIN(fixtureServer)]: [...OPT_IN_HINTS] },
    });
  });

  test('an opt-in that was written survives a hard kill', async ({ launcher, fixtureServer }) => {
    const first = await launcher.launch();
    await askForHints(first.app, first.shell, fixtureServer);
    await expect.poll(() => storedHints(first.app), { timeout: 20_000 }).not.toBeNull();
    await launcher.kill(first);

    const { app, shell } = await launcher.launchAfterKill();
    await expect.poll(() => clientHintsReady(app)).toBe(true);
    const path = '/page-b.html?case=hints-after-kill';
    await loadTab(app, shell, fixtureServer.url(path));
    expect(hintNamesOf(lastRequestTo(fixtureServer, path))).toEqual(WITH_OPT_INS);
  });
});

// ── The settings document ───────────────────────────────────────────────────────────────────────

test.describe('the settings document', () => {
  /** Launches without the launcher, which would point the search template at the fixture itself. */
  async function withApp<T>(
    userDataDir: string,
    use: (run: {
      app: ElectronApplication;
      shell: Awaited<ReturnType<typeof shellPage>>;
    }) => Promise<T>,
  ): Promise<T> {
    const app = await launchApp(userDataDir);
    try {
      const shell = await shellPage(app);
      await expect(tabElements(shell).first()).toBeVisible({ timeout: SLOW_TIMEOUT_MS });
      return await use({ app, shell });
    } finally {
      await closeApp(app);
    }
  }

  /** What the "Search … for" item of a page's context menu calls the engine. */
  async function engineName(app: ElectronApplication, tabId: string): Promise<string | undefined> {
    const entries = await contextMenuItems(app, tabId, { selectionText: 'foo' });
    const item = entries.find((entry) => entry.type === 'item' && entry.id === 'search-selection');
    return item?.type === 'item' ? item.label : undefined;
  }

  const putSettings = (userDataDir: string, document: unknown): void => {
    writeProfileDb(userDataDir, [
      {
        sql: 'INSERT INTO settings (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json',
        params: [JSON.stringify(document)],
      },
    ]);
  };

  test('a search template that points at another server sends the address bar there', async ({
    fixtureServer,
    userDataDir,
  }) => {
    // The worker's fixture server has served other tests' searches: count from here.
    const searchesBefore = fixtureServer.pathHits('/search');
    const elsewhere = await startFixtureServer();
    try {
      // The first run makes the database; the settings row is put in as a person with the file would.
      await withApp(userDataDir, () => Promise.resolve());
      putSettings(userDataDir, {
        search: { template: elsewhere.url('/search?q={searchTerms}') },
      });

      await withApp(userDataDir, async ({ app, shell }) => {
        // The starting tab is the new-tab page; type the search in its address bar.
        await typeAddress(shell, 'needle in a haystack');
        await expect
          .poll(() => elsewhere.pathHits('/search'), {
            message: 'the search should go to the settings server',
          })
          .toBe(1);
        expect(fixtureServer.pathHits('/search')).toBe(searchesBefore);
        expect(elsewhere.requestsTo('/search').map((request) => request.url)).toEqual([
          '/search?q=needle%20in%20a%20haystack',
        ]);
        await expectVisits(
          app,
          [[elsewhere.url('/search?q=needle%20in%20a%20haystack'), 'generated']],
          'the search is a generated visit on the other server',
        );
      });
    } finally {
      await elsewhere.close();
    }
  });

  const INVALID: readonly [string, unknown][] = [
    [
      'a template without {searchTerms}',
      { search: { template: 'https://example.invalid/search' } },
    ],
    [
      'a plain-http template on a real host',
      { search: { template: 'http://example.invalid/?q={searchTerms}' } },
    ],
    ['a template that is not text', { search: { template: 7 } }],
    ['a search section that is not an object', { search: 'duckduckgo' }],
    ['a document that is an array', ['an', 'array']],
    ['an empty document', {}],
  ];

  test('an invalid stored template is replaced by the default, and the app still starts', async ({
    fixtureServer,
    userDataDir,
  }) => {
    // One run makes the database; each case below puts its document in and starts the app on it.
    await withApp(userDataDir, () => Promise.resolve());
    for (const [name, document] of INVALID) {
      await test.step(name, async () => {
        putSettings(userDataDir, document);
        await withApp(userDataDir, async ({ app, shell }) => {
          const tab = await loadTab(
            app,
            shell,
            fixtureServer.url('/page-a.html?case=settings-invalid'),
          );
          // The default engine, with no search made: asking the page's context menu who it is.
          expect(await engineName(app, tab.tabId)).toBe('Search DuckDuckGo for “foo”');
        });
      });
    }
  });

  test('one bad field does not reset the others: a valid template stands beside an invalid retention', async ({
    fixtureServer,
    userDataDir,
  }) => {
    await withApp(userDataDir, () => Promise.resolve());
    putSettings(userDataDir, {
      search: { template: fixtureServer.url('/search?q={searchTerms}') },
      history: { retentionDays: 'forever' },
      somethingFromANewerVersion: true,
    });
    await withApp(userDataDir, async ({ app, shell }) => {
      const tab = await loadTab(
        app,
        shell,
        fixtureServer.url('/page-a.html?case=settings-partial'),
      );
      expect(await engineName(app, tab.tabId)).toBe(
        `Search ${new URL(fixtureServer.origin).host} for “foo”`,
      );
    });
    // And the table itself refuses text that is not JSON (CHECK json_valid), so the worst a file
    // can hold is JSON that is not a document, which the case above starts on.
    expect(() => {
      writeProfileDb(userDataDir, [
        { sql: 'UPDATE settings SET json = ? WHERE id = 1', params: ['{not json'] },
      ]);
    }).toThrow(/CHECK constraint|json_valid/u);
  });
});
