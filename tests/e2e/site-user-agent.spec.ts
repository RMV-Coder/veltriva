// The per-site user agent (src/core/net/site-user-agent.ts, src/main/web/request-headers.ts):
// requests to accounts.google.com carry Firefox's user agent, as in Min browser, because Google's
// sign-in warned "This browser or app may not be secure" even with honest client hints (manual
// check M1). Nothing here reaches Google:
//   - `--host-resolver-rules` maps accounts.google.com to 127.0.0.1 and makes every other name
//     unresolvable, so a mistake fails to connect instead of reaching the internet;
//   - the local HTTPS fixture server answers with this run's throwaway certificate, which the app
//     trusts through `--ignore-certificate-errors-spki-list` (as tests/e2e/certificates.spec.ts
//     does). The name mismatch is one of the errors that switch ignores.
// The server's port is chosen at run time, so the pages are https://accounts.google.com:<port>/.
import type { ElectronApplication } from '@playwright/test';

import { createServerIdentity } from '../fixtures/certificate';
import { startHttpsFixtureServer } from '../fixtures/https-server';
import type { HttpsFixtureServer } from '../fixtures/https-server';
import { expect } from './expect';
import { test } from './fixtures';
import { evaluateInTab, setSearchTemplate } from './hooks';
import { loadTab } from './shell-ui';
import type { LoadedTab } from './shell-ui';

test.describe.configure({ timeout: 120_000 });

/** Firefox's user agent on 64-bit Windows, any version from 158 on. */
const FIREFOX =
  /^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64; rv:(\d+)\.0\) Gecko\/20100101 Firefox\/\1\.0$/;

const identity = createServerIdentity();

/** The last request the server got for `pathAndQuery`. */
function lastRequest(server: HttpsFixtureServer, pathAndQuery: string) {
  const request = server
    .requests()
    .filter((candidate) => candidate.url === pathAndQuery)
    .at(-1);
  if (request === undefined) {
    throw new Error(`The HTTPS fixture server got no request for ${pathAndQuery}`);
  }
  return request;
}

/** A fetch from the tab's page to `pathAndQuery` on its own origin (the response isn't read). */
async function fetchFrom(
  app: ElectronApplication,
  tab: LoadedTab,
  pathAndQuery: string,
): Promise<void> {
  await evaluateInTab(
    app,
    tab.webContentsId,
    `fetch(${JSON.stringify(pathAndQuery)}).then((response) => response.status)`,
  );
}

test.describe('the per-site user agent', () => {
  test.use({
    appSwitches: [
      `--ignore-certificate-errors-spki-list=${identity.spkiSha256}`,
      '--host-resolver-rules=MAP accounts.google.com 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
    ],
  });

  let server: HttpsFixtureServer;
  test.beforeEach(async ({ electronApp, fixtureServer }) => {
    await setSearchTemplate(electronApp, fixtureServer.url('/search?q={searchTerms}'));
    server = await startHttpsFixtureServer({ identity });
  });
  test.afterEach(async () => {
    await server.close();
  });

  /** The fixture server under Google's sign-in host name. */
  const googleUrl = (pathAndQuery: string): string =>
    `https://accounts.google.com:${new URL(server.origin).port}${pathAndQuery}`;

  test('accounts.google.com gets Firefox’s user agent on the page and on its requests', async ({
    electronApp,
    shell,
  }) => {
    const tab = await loadTab(electronApp, shell, googleUrl('/signin?case=navigation'));

    const navigation = lastRequest(server, '/signin?case=navigation');
    expect(navigation.headers.host).toBe(`accounts.google.com:${new URL(server.origin).port}`);
    const userAgent = navigation.headers['user-agent'] ?? '';
    expect(userAgent).toMatch(FIREFOX);
    expect(Number(FIREFOX.exec(userAgent)?.[1])).toBeGreaterThanOrEqual(158);

    await fetchFrom(electronApp, tab, '/data?case=fetch');
    expect(lastRequest(server, '/data?case=fetch').headers['user-agent']).toBe(userAgent);

    // As in Min, only the header changes: client hints and the page's own view stay Chromium's.
    expect(navigation.headers['sec-ch-ua']).toContain('"Chromium"');
    const pageUserAgent = (await evaluateInTab(
      electronApp,
      tab.webContentsId,
      'navigator.userAgent',
    )) as string;
    expect(pageUserAgent).toContain('Chrome/');
    expect(pageUserAgent).not.toContain('Firefox');
  });

  test('every other host keeps Veltriva’s own user agent', async ({ electronApp, shell }) => {
    // The same server, under its own address.
    const tab = await loadTab(electronApp, shell, server.url('/page?case=other-host'));

    const userAgent = lastRequest(server, '/page?case=other-host').headers['user-agent'] ?? '';
    expect(userAgent).toContain('Chrome/');
    expect(userAgent).not.toMatch(/Firefox|Electron|Veltriva/);
    expect(userAgent).toBe(
      await evaluateInTab(electronApp, tab.webContentsId, 'navigator.userAgent'),
    );
  });
});
