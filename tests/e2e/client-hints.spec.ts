// User-agent client hints (src/core/net/client-hints.ts, src/main/web/client-hints.ts). Electron's
// Chromium sends `Sec-CH-UA*` on subresources but not on a page's own navigation, and ignores
// `Accept-CH`; Google's sign-in refused Veltriva as an embedded browser (manual check M1). Main
// adds what Chrome would send, with Chromium's own values. These tests hold main's headers to
// Chromium's: the same strings Chromium puts on a fetch from the same page, and the values the
// page reads from `navigator.userAgentData`.
//
// The fixture server's two origins are `127.0.0.1` and `localhost` (another site). Both are
// loopback, so both are potentially trustworthy and get hints, as in Chrome.
import type { ElectronApplication } from '@playwright/test';

import { expect } from './expect';
import { test } from './fixtures';
import type { FixtureServer } from '../fixtures/server';
import { clientHintsReady, evaluateInTab, setSearchTemplate } from './hooks';
import { loadTab, typeAddress, waitForPage } from './shell-ui';
import type { LoadedTab } from './shell-ui';

test.describe.configure({ timeout: 120_000 });

const DEFAULT_HINTS = ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'] as const;
const OPT_IN_HINTS = [
  'sec-ch-ua-arch',
  'sec-ch-ua-bitness',
  'sec-ch-ua-form-factors',
  'sec-ch-ua-full-version',
  'sec-ch-ua-full-version-list',
  'sec-ch-ua-model',
  'sec-ch-ua-platform-version',
  'sec-ch-ua-wow64',
] as const;

type Headers = Readonly<Record<string, string | string[] | undefined>>;

/** The client-hint headers of a request, and nothing else. */
function hintsOf(headers: Headers): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([name]) => name.startsWith('sec-ch-'))
      .map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : (value ?? '')]),
  );
}

/** The headers of the last request the fixture server got for `pathAndQuery`. */
function lastRequestTo(server: FixtureServer, pathAndQuery: string): Headers {
  const { pathname } = new URL(pathAndQuery, server.origin);
  const requests = server.requestsTo(pathname).filter((request) => request.url === pathAndQuery);
  const last = requests.at(-1);
  if (last === undefined) {
    throw new Error(`The fixture server got no request for ${pathAndQuery}`);
  }
  return last.headers;
}

/** What Chromium itself sends on a fetch from the tab's page (it does for subresources). */
async function hintsOnFetch(
  app: ElectronApplication,
  tab: LoadedTab,
  pathAndQuery: string,
): Promise<Record<string, string>> {
  const echoed = (await evaluateInTab(
    app,
    tab.webContentsId,
    `fetch(${JSON.stringify(pathAndQuery)}).then((response) => response.json())`,
  )) as Headers;
  return hintsOf(echoed);
}

interface PageUserAgentData {
  readonly brands: readonly { brand: string; version: string }[];
  readonly fullVersionList: readonly { brand: string; version: string }[];
  readonly platform: string;
  readonly platformVersion: string;
  readonly architecture: string;
  readonly bitness: string;
}

function pageUserAgentData(app: ElectronApplication, tab: LoadedTab): Promise<PageUserAgentData> {
  return evaluateInTab(
    app,
    tab.webContentsId,
    `navigator.userAgentData.getHighEntropyValues(
      ['architecture', 'bitness', 'fullVersionList', 'platformVersion'])`,
  ) as Promise<PageUserAgentData>;
}

const brandList = (brands: readonly { brand: string; version: string }[]): string =>
  brands.map(({ brand, version }) => `"${brand}";v="${version}"`).join(', ');

test.describe('client hints', () => {
  test.beforeEach(async ({ electronApp, fixtureServer }) => {
    await setSearchTemplate(electronApp, fixtureServer.url('/search?q={searchTerms}'));
    // Main reads Chromium's values from the shell once it has loaded.
    await expect
      .poll(() => clientHintsReady(electronApp), {
        message: "main should know Chromium's client-hint values",
      })
      .toBe(true);
  });

  test('a page’s navigation carries the default hints, exactly as Chromium sends them on a fetch', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const path = '/page-a.html?case=client-hints';
    const tab = await loadTab(electronApp, shell, fixtureServer.url(path));

    const onNavigation = hintsOf(lastRequestTo(fixtureServer, path));
    const onFetch = await hintsOnFetch(electronApp, tab, '/echo-headers?case=fetch');
    expect(Object.keys(onNavigation).sort()).toEqual([...DEFAULT_HINTS].sort());
    expect(onNavigation).toEqual(onFetch);

    // And they say what the page itself reads: Chromium, never Google Chrome.
    const data = await pageUserAgentData(electronApp, tab);
    expect(onNavigation['sec-ch-ua']).toBe(brandList(data.brands));
    expect(onNavigation['sec-ch-ua-platform']).toBe(`"${data.platform}"`);
    expect(onNavigation['sec-ch-ua-mobile']).toBe('?0');
    expect(onNavigation['sec-ch-ua']).toContain('"Chromium"');
    expect(onNavigation['sec-ch-ua']).not.toContain('Google Chrome');
  });

  test('a frame’s navigation carries them too', async ({ electronApp, fixtureServer, shell }) => {
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/page-a.html?case=frame'));
    const framePath = '/echo-headers?case=frame';

    await evaluateInTab(
      electronApp,
      tab.webContentsId,
      `new Promise((resolve) => {
        const frame = document.createElement('iframe');
        frame.addEventListener('load', () => resolve(true), { once: true });
        frame.src = ${JSON.stringify(framePath)};
        document.body.append(frame);
      })`,
    );

    const inFrame = hintsOf(lastRequestTo(fixtureServer, framePath));
    expect(inFrame).toEqual(await hintsOnFetch(electronApp, tab, '/echo-headers?case=fetch2'));
    expect(Object.keys(inFrame).sort()).toEqual([...DEFAULT_HINTS].sort());
  });

  test('a site that asks with Accept-CH gets the hints it asked for, and other sites don’t', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    // Before it asks: defaults only.
    const before = '/page-a.html?case=before-opt-in';
    const tab = await loadTab(electronApp, shell, fixtureServer.url(before));
    expect(Object.keys(hintsOf(lastRequestTo(fixtureServer, before))).sort()).toEqual(
      [...DEFAULT_HINTS].sort(),
    );

    // It asks, on a top-level page.
    await typeAddress(shell, fixtureServer.url('/client-hints-opt-in'));
    await waitForPage(electronApp, tab.tabId, { url: fixtureServer.url('/client-hints-opt-in') });

    // Its next navigation carries everything it asked for, with the page's own values.
    const after = '/page-b.html?case=after-opt-in';
    await typeAddress(shell, fixtureServer.url(after));
    await waitForPage(electronApp, tab.tabId, { url: fixtureServer.url(after) });
    const onNavigation = hintsOf(lastRequestTo(fixtureServer, after));
    expect(Object.keys(onNavigation).sort()).toEqual([...DEFAULT_HINTS, ...OPT_IN_HINTS].sort());
    const data = await pageUserAgentData(electronApp, tab);
    expect(onNavigation['sec-ch-ua-full-version-list']).toBe(brandList(data.fullVersionList));
    expect(onNavigation['sec-ch-ua-platform-version']).toBe(`"${data.platformVersion}"`);
    expect(onNavigation['sec-ch-ua-arch']).toBe(`"${data.architecture}"`);
    expect(onNavigation['sec-ch-ua-bitness']).toBe(`"${data.bitness}"`);

    // So do its subresources, which Chromium alone would send only the defaults.
    expect(
      Object.keys(await hintsOnFetch(electronApp, tab, '/echo-headers?case=opted-in-fetch')).sort(),
    ).toEqual([...DEFAULT_HINTS, ...OPT_IN_HINTS].sort());

    // Another site (localhost on the same server) never asked: defaults only.
    const otherSite = fixtureServer.otherSiteUrl('/page-c.html?case=other-site');
    await typeAddress(shell, otherSite);
    await waitForPage(electronApp, tab.tabId, { url: otherSite });
    const others = fixtureServer
      .requestsTo('/page-c.html')
      .filter((request) => request.url === '/page-c.html?case=other-site');
    const lastOther = others.at(-1);
    expect(lastOther).toBeDefined();
    expect(Object.keys(hintsOf(lastOther?.headers ?? {})).sort()).toEqual(
      [...DEFAULT_HINTS].sort(),
    );
  });

  test('Accept-CH from a frame opts nothing in, as in Chrome', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tab = await loadTab(
      electronApp,
      shell,
      fixtureServer.url('/page-a.html?case=framed-ask'),
    );
    await evaluateInTab(
      electronApp,
      tab.webContentsId,
      `new Promise((resolve) => {
        const frame = document.createElement('iframe');
        frame.addEventListener('load', () => resolve(true), { once: true });
        frame.src = '/client-hints-opt-in';
        document.body.append(frame);
      })`,
    );

    const next = '/page-b.html?case=after-framed-ask';
    await typeAddress(shell, fixtureServer.url(next));
    await waitForPage(electronApp, tab.tabId, { url: fixtureServer.url(next) });
    expect(Object.keys(hintsOf(lastRequestTo(fixtureServer, next))).sort()).toEqual(
      [...DEFAULT_HINTS].sort(),
    );
  });
});
