// Favicon requests and the local network (threat T5, M6.1). Main fetches page-declared favicons
// itself, so it checks every request: the host as written, every address it resolves to with the
// browsing session's resolver, and every redirect hop again (src/main/tabs/favicons.ts).
//
// To have a page on a "public" host without leaving the machine:
// - `--host-resolver-rules` gives `pub.test` a documentation address (203.0.113.10, TEST-NET-3,
//   never routed) and `loop.test` this machine's;
// - the browsing session's proxy is the fixture server, which answers proxied requests like its
//   own. Loopback addresses bypass a proxy, so `127.0.0.1` is reached directly.
// Each icon's query is unique, so the fixture server's log shows whether main asked for it.
import { expect } from './expect';
import { test } from './fixtures';
import { tabState } from './hooks';
import { observeFor } from './launch';
import { SLOW_TIMEOUT_MS, loadInNewTab } from './shell-ui';

test.use({
  appSwitches: ['--host-resolver-rules=MAP pub.test 203.0.113.10, MAP loop.test 127.0.0.1'],
});

/** A page whose <link rel="icon"> is `icon`. */
const pageWithIcon = (origin: string, title: string, icon: string): string =>
  `${origin}/memory/page?title=${encodeURIComponent(title)}&icon=${encodeURIComponent(icon)}`;

/** A redirect on the page's own origin to `to`. */
const redirectTo = (to: string): string => `/memory/redirect?to=${encodeURIComponent(to)}`;

test.describe('favicons and the local network (M6.1, T5)', () => {
  test.beforeEach(async ({ electronApp, fixtureServer }) => {
    const proxy = new URL(fixtureServer.origin).host;
    await electronApp.evaluate(async ({ session }, rules) => {
      await session.fromPartition('persist:browsing').setProxy({ proxyRules: rules });
    }, `http=${proxy}`);
  });

  /** Whether a request for `pathname` with `name=value` in its query reached the server. */
  const reached = (
    requests: readonly { url: string }[],
    name: string,
    value: (found: string) => boolean,
  ): boolean =>
    requests.some((request) => {
      const found = new URL(request.url, 'http://x.invalid').searchParams.get(name);
      return found !== null && value(found);
    });
  /** Whether main asked the fixture server for /memory/icon.png with the color `c`. */
  const askedFor = (requests: readonly { url: string }[], color: string): boolean =>
    reached(requests, 'c', (found) => found === color);

  test('a redirect on the same kind of host is followed, hop by hop', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tabId = await loadInNewTab(
      electronApp,
      shell,
      pageWithIcon(fixtureServer.origin, 'Loopback', redirectTo('/memory/icon.png?c=10,20,30')),
    );
    await expect
      .poll(async () => (await tabState(electronApp, tabId))?.favicon ?? null, {
        timeout: SLOW_TIMEOUT_MS,
      })
      .toMatch(/^data:image\/png;base64,/);
    expect(askedFor(fixtureServer.requestsTo('/memory/icon.png'), '10,20,30')).toBe(true);
  });

  test('a public page’s icon may redirect to another public host, and is shown', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const pub = `http://pub.test:${new URL(fixtureServer.origin).port}`;
    const tabId = await loadInNewTab(
      electronApp,
      shell,
      pageWithIcon(pub, 'Public', redirectTo(`${pub}/memory/icon.png?c=40,50,60`)),
    );
    // The control: through the proxy, the whole chain works, so a refusal below is a decision.
    await expect
      .poll(async () => (await tabState(electronApp, tabId))?.favicon ?? null, {
        timeout: SLOW_TIMEOUT_MS,
      })
      .toMatch(/^data:image\/png;base64,/);
    expect(askedFor(fixtureServer.requestsTo('/memory/icon.png'), '40,50,60')).toBe(true);
  });

  test('a public page’s icon never redirects main to this machine', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const pub = `http://pub.test:${new URL(fixtureServer.origin).port}`;
    const tabId = await loadInNewTab(
      electronApp,
      shell,
      pageWithIcon(
        pub,
        'Redirects home',
        redirectTo(fixtureServer.url('/memory/icon.png?c=70,80,90')),
      ),
    );
    // Main made the first request, and stopped at the redirect.
    await expect
      .poll(
        () =>
          reached(fixtureServer.requestsTo('/memory/redirect'), 'to', (to) =>
            to.includes('70,80,90'),
          ),
        { timeout: SLOW_TIMEOUT_MS },
      )
      .toBe(true);
    const icons = await observeFor(
      1_500,
      async () => (await tabState(electronApp, tabId))?.favicon ?? null,
    );
    expect(icons).toEqual([null]);
    expect(askedFor(fixtureServer.requestsTo('/memory/icon.png'), '70,80,90')).toBe(false);
  });

  test('a public name that resolves to this machine gets no request at all', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const port = new URL(fixtureServer.origin).port;
    const pub = `http://pub.test:${port}`;
    const tabId = await loadInNewTab(
      electronApp,
      shell,
      pageWithIcon(pub, 'Rebinds', `http://loop.test:${port}/memory/icon.png?c=100,110,120`),
    );
    // The page itself loaded (through the proxy) before its icon was judged.
    expect(
      reached(fixtureServer.requestsTo('/memory/page'), 'title', (title) => title === 'Rebinds'),
    ).toBe(true);
    const icons = await observeFor(
      1_500,
      async () => (await tabState(electronApp, tabId))?.favicon ?? null,
    );
    expect(icons).toEqual([null]);
    expect(askedFor(fixtureServer.requestsTo('/memory/icon.png'), '100,110,120')).toBe(false);
  });
});
