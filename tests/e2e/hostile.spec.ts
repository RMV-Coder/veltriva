// A hostile page in a tab (ADR-0002, ADR-0008 §6). tests/fixtures/pages/hostile.html tries what a
// malicious site would try against the shell, and each test checks, from outside the page, that
// the attempt failed. The page is a normal tab: role `tab`, `persist:browsing`, no preload.
//
// After the app cancels a navigation, Playwright keeps waiting for it (ADR-0008, M1.1 rule), so
// every check that follows one uses `evaluate` or main, never a locator.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import type { ElectronApplication } from '@playwright/test';

import { BROWSING_PARTITION } from '../../src/shared/constants/app-identity';
import { DOWNLOAD_FILE_NAME } from '../fixtures/server';
import { expect, test } from './fixtures';
import { frameUrlsInMain, testDownloadsFolder, urlInMain, webContentsRoles } from './hooks';
import { workspaceSnapshot } from './prompt-ui';
import { observeFor } from './launch';
import type { PageGlobal } from './page-globals';

/** `window.hostile`, defined by tests/fixtures/pages/hostile.html. Everything is JSON-friendly. */
interface HostileApi {
  globals(): Record<string, string>;
  navigateTo(url: string): void;
  openWindow(url: string): { opened: boolean };
  embedFrame(url: string): string;
  frameLocation(id: string): string;
  fetchUrl(
    url: string,
    mode: 'cors' | 'no-cors',
  ): Promise<
    { settled: 'resolved'; type: string; status: number } | { settled: 'rejected'; name: string }
  >;
  requestPowers(): Promise<{
    notificationRequest: string;
    notificationPermission: string;
    geolocationState: string;
    getUserMedia:
      { settled: 'resolved' } | { settled: 'rejected'; name: string; isDomException: boolean };
  }>;
  userAgent(): string;
  requestHeaders(): Promise<Record<string, string | undefined>>;
}
type HostileGlobal = typeof globalThis & { hostile: HostileApi };

/** One `will-frame-navigate` event, as the main process saw it. */
interface NavigationRecord {
  readonly url: string;
  readonly isMainFrame: boolean;
  /** True if an earlier listener (the guard's) had already called `preventDefault()`. */
  readonly cancelled: boolean;
}

/**
 * Records every `will-frame-navigate` of a web contents. The guard's handler is registered first
 * (when the contents is created), so `defaultPrevented` tells whether it cancelled the navigation.
 * The returned handle points at an array in main that keeps growing; `jsonValue()` snapshots it.
 */
async function recordNavigations(app: ElectronApplication, webContentsId: number) {
  const handle = await app.evaluateHandle(({ webContents }, id) => {
    const records: NavigationRecord[] = [];
    webContents.fromId(id)?.on('will-frame-navigate', (event) => {
      records.push({
        url: event.url,
        isMainFrame: event.isMainFrame,
        cancelled: event.defaultPrevented,
      });
    });
    return records;
  }, webContentsId);
  return {
    snapshot: () => handle.jsonValue(),
    /** Resolves once at least `count` navigations have been recorded. */
    async untilCount(count: number): Promise<NavigationRecord[]> {
      await expect
        .poll(async () => (await handle.jsonValue()).length)
        .toBeGreaterThanOrEqual(count);
      return handle.jsonValue();
    },
  };
}

test.describe('hostile page in a tab', () => {
  test('has no preload API and no Node', async ({ electronApp, fixtureServer, openTab }) => {
    const tab = await openTab(fixtureServer.url('/hostile.html'));

    const roles = await webContentsRoles(electronApp);
    expect(roles.find((entry) => entry.webContentsId === tab.webContentsId)?.role).toBe('tab');
    const inBrowsingSession = await electronApp.evaluate(
      ({ session, webContents }, { id, partition }) =>
        webContents.fromId(id)?.session === session.fromPartition(partition),
      { id: tab.webContentsId, partition: BROWSING_PARTITION },
    );
    expect(inBrowsingSession).toBe(true);

    const globals = await tab.page.evaluate(() => (globalThis as HostileGlobal).hostile.globals());
    expect(globals).toEqual({
      veltriva: 'undefined',
      require: 'undefined',
      process: 'undefined',
      module: 'undefined',
      Buffer: 'undefined',
      ipcRenderer: 'undefined',
      ipcProbe: 'undefined',
    });
  });

  test('cannot navigate itself to app:// or veltriva://', async ({
    electronApp,
    fixtureServer,
    openTab,
  }) => {
    const hostileUrl = fixtureServer.url('/hostile.html');
    const tab = await openTab(hostileUrl);
    const navigations = await recordNavigations(electronApp, tab.webContentsId);
    const targets = ['app://shell/index.html', 'veltriva://settings'];

    for (const [index, target] of targets.entries()) {
      await tab.page.evaluate((url) => {
        (globalThis as HostileGlobal).hostile.navigateTo(url);
      }, target);

      // The guard saw the attempt and cancelled it.
      const records = await navigations.untilCount(index + 1);
      expect(records[index]).toEqual({ url: target, isMainFrame: true, cancelled: true });
    }

    // Give a navigation that wrongly went ahead time to commit; then look through main and through
    // the page. No locators: Playwright still thinks the main frame is navigating.
    expect(await observeFor(1_000, () => urlInMain(electronApp, tab.webContentsId))).toEqual([
      hostileUrl,
    ]);
    expect(await tab.page.evaluate(() => (globalThis as PageGlobal).location.href)).toBe(
      hostileUrl,
    );
    // Still the same page, with its script: nothing replaced it.
    expect(await tab.page.evaluate(() => typeof (globalThis as HostileGlobal).hostile)).toBe(
      'object',
    );
    expect((await navigations.snapshot()).filter((record) => !record.cancelled)).toEqual([]);
  });

  test('cannot open windows', async ({ electronApp, fixtureServer, openTab }) => {
    const tab = await openTab(fixtureServer.url('/hostile.html'));
    const idsBefore = (await webContentsRoles(electronApp)).map((entry) => entry.webContentsId);
    const windowsBefore = electronApp.windows().length;

    const results = await tab.page.evaluate(() => {
      const { hostile } = globalThis as HostileGlobal;
      return [
        hostile.openWindow('app://shell/'),
        hostile.openWindow('veltriva://settings'),
        hostile.openWindow('https://example.invalid/'),
      ];
    });
    expect(results).toEqual([{ opened: false }, { opened: false }, { opened: false }]);

    // No new web contents, and no new Page, appears.
    const idLists = await observeFor(1_000, async () =>
      (await webContentsRoles(electronApp)).map((entry) => entry.webContentsId).join(),
    );
    expect(idLists).toEqual([idsBefore.join()]);
    expect(electronApp.windows().length).toBe(windowsBefore);
  });

  test('cannot embed the shell in a frame', async ({ electronApp, fixtureServer, openTab }) => {
    const tab = await openTab(fixtureServer.url('/hostile.html'));
    const navigations = await recordNavigations(electronApp, tab.webContentsId);

    // A control first: an ordinary http frame does load, so the checks below can see a frame.
    const controlUrl = fixtureServer.url('/blank.html');
    await tab.page.evaluate((url) => {
      (globalThis as HostileGlobal).hostile.embedFrame(url);
    }, controlUrl);
    await expect.poll(() => frameUrlsInMain(electronApp, tab.webContentsId)).toContain(controlUrl);

    const shellFrameId = await tab.page.evaluate(() =>
      (globalThis as HostileGlobal).hostile.embedFrame('app://shell/index.html'),
    );

    // The guard saw the frame navigation and cancelled it. The control was allowed.
    const records = await navigations.untilCount(2);
    expect(records).toEqual([
      { url: controlUrl, isMainFrame: false, cancelled: false },
      { url: 'app://shell/index.html', isMainFrame: false, cancelled: true },
    ]);

    // No frame anywhere in the tab has an app:// URL, and the page itself can't see one either.
    const frameUrls = await observeFor(500, async () =>
      (await frameUrlsInMain(electronApp, tab.webContentsId)).join(' '),
    );
    expect(frameUrls).toHaveLength(1);
    expect(frameUrls[0]).not.toContain('app://');
    expect(frameUrls[0]).toContain(controlUrl);
    expect(
      await tab.page.evaluate(
        (id) => (globalThis as HostileGlobal).hostile.frameLocation(id),
        shellFrameId,
      ),
    ).not.toContain('app://');
  });

  test('cannot fetch app://shell', async ({ electronApp, fixtureServer, openTab, shell }) => {
    const tab = await openTab(fixtureServer.url('/hostile.html'));

    // The scheme is registered for every session, but its handler exists only on the shell's. A
    // plain fetch is refused by CORS whether or not a handler exists, so it proves little by
    // itself. The 'no-cors' fetch and main's own view of the sessions show that nothing answers
    // app:// in the browsing session: a handled request would resolve (as an opaque response).
    const [cors, noCors] = await tab.page.evaluate(async () => {
      const { hostile } = globalThis as HostileGlobal;
      return [
        await hostile.fetchUrl('app://shell/index.html', 'cors'),
        await hostile.fetchUrl('app://shell/index.html', 'no-cors'),
      ];
    });
    expect(cors).toEqual({ settled: 'rejected', name: 'TypeError' });
    expect(noCors).toEqual({ settled: 'rejected', name: 'TypeError' });

    const handled = await electronApp.evaluate(
      ({ webContents }, { tabId, shellUrl }) => {
        const shellContents = webContents.getAllWebContents().find((c) => c.getURL() === shellUrl);
        return {
          shell: shellContents?.session.protocol.isProtocolHandled('app'),
          tab: webContents.fromId(tabId)?.session.protocol.isProtocolHandled('app'),
        };
      },
      { tabId: tab.webContentsId, shellUrl: shell.url() },
    );
    expect(handled).toEqual({ shell: true, tab: false });
  });

  test('is denied every permission', async ({ fixtureServer, openTab }, testInfo) => {
    const tab = await openTab(fixtureServer.url('/hostile.html'));
    const powers = await tab.page.evaluate(() =>
      (globalThis as HostileGlobal).hostile.requestPowers(),
    );

    expect(powers.notificationRequest).toBe('denied');
    expect(powers.notificationPermission).toBe('denied');
    expect(powers.geolocationState).toBe('denied');
    // The camera request is refused with a DOMException. NotAllowedError is the permission being
    // denied (seen on a machine with a camera). A machine without any camera can report
    // NotFoundError instead, whatever the permission policy says; the notification and
    // geolocation checks above cover that case.
    expect(powers.getUserMedia).toMatchObject({ settled: 'rejected', isDomException: true });
    expect(['NotAllowedError', 'NotFoundError']).toContain(
      'name' in powers.getUserMedia ? powers.getUserMedia.name : undefined,
    );
    // Keep the exact name in the report.
    testInfo.annotations.push({
      type: 'getUserMedia',
      description: JSON.stringify(powers.getUserMedia),
    });
  });

  test('sends no Electron or Veltriva token in its user agent', async ({
    electronApp,
    fixtureServer,
    openTab,
  }) => {
    const tab = await openTab(fixtureServer.url('/hostile.html'));
    const [scriptAgent, headers, fallback] = await Promise.all([
      tab.page.evaluate(() => (globalThis as HostileGlobal).hostile.userAgent()),
      tab.page.evaluate(() => (globalThis as HostileGlobal).hostile.requestHeaders()),
      electronApp.evaluate(({ app }) => app.userAgentFallback),
    ]);

    for (const userAgent of [scriptAgent, headers['user-agent'], fallback]) {
      expect(userAgent).toMatch(/^Mozilla\/5\.0 .* Chrome\/\d+/);
      expect(userAgent).not.toMatch(/electron|veltriva/i);
    }
    // The header is what the page's own request carried, and it is the same string.
    expect(headers['user-agent']).toBe(scriptAgent);
    // No other header gives the app away either (client hints, for one).
    expect(JSON.stringify(headers)).not.toMatch(/electron|veltriva/i);
  });

  test('a download it starts goes to the download manager: into the profile folder, with no dialog', async ({
    electronApp,
    fixtureServer,
    openTab,
    shell,
  }) => {
    // M1.4b: downloads are handled, not refused (before, the session cancelled every one). A page
    // still chooses nothing about where its file goes.
    const hostileUrl = fixtureServer.url('/hostile.html');
    const tab = await openTab(hostileUrl);
    const folder = await testDownloadsFolder(electronApp);

    // Watch the session's `will-download`. The download manager's handler is registered first (at
    // startup), so by now it has set the save path, which is what keeps Electron's save dialog away,
    // and `defaultPrevented` says whether anything cancelled the download.
    const downloads = await electronApp.evaluateHandle(({ webContents }, id) => {
      const records: { filename: string; savePath: string; cancelledByBaseline: boolean }[] = [];
      webContents.fromId(id)?.session.on('will-download', (event, item) => {
        records.push({
          filename: item.getFilename(),
          savePath: item.getSavePath(),
          cancelledByBaseline: event.defaultPrevented,
        });
      });
      return records;
    }, tab.webContentsId);

    // A unique query string lets the server say whether this very request arrived.
    const downloadPath = `/download?run=${String(Date.now())}`;
    await tab.page.evaluate((url) => {
      (globalThis as HostileGlobal).hostile.navigateTo(url);
    }, fixtureServer.url(downloadPath));

    await expect.poll(async () => (await downloads.jsonValue()).length).toBe(1);
    expect(fixtureServer.hits(downloadPath)).toBe(1);
    expect(await downloads.jsonValue()).toEqual([
      {
        filename: DOWNLOAD_FILE_NAME,
        savePath: join(folder, DOWNLOAD_FILE_NAME),
        cancelledByBaseline: false,
      },
    ]);

    // The file lands in the test profile's own folder and the shell lists it, never in the user's
    // Downloads folder, the tab is still on its page, and the app still answers.
    await expect
      .poll(() => existsSync(join(folder, DOWNLOAD_FILE_NAME)), {
        message: 'the download should finish in the profile folder',
      })
      .toBe(true);
    await expect
      .poll(async () =>
        (await workspaceSnapshot(shell)).downloads.map((d) => [d.fileName, d.state]),
      )
      .toEqual([[DOWNLOAD_FILE_NAME, 'completed']]);
    // Test builds point Electron's Downloads path at the test profile too, so the user's real
    // Downloads folder (Windows' default) is never touched, not even by Chromium's temp files.
    const appDownloads = await electronApp.evaluate(({ app }) => app.getPath('downloads'));
    expect(appDownloads).toBe(await testDownloadsFolder(electronApp));
    expect(existsSync(join(homedir(), 'Downloads', DOWNLOAD_FILE_NAME))).toBe(false);
    expect(await observeFor(500, () => urlInMain(electronApp, tab.webContentsId))).toEqual([
      hostileUrl,
    ]);
    expect(await electronApp.evaluate(() => 1 + 1)).toBe(2);
    expect(await shell.evaluate(() => 1 + 1)).toBe(2);
    expect(await tab.page.evaluate(() => 1 + 1)).toBe(2);
  });
});
