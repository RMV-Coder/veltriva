// Generated documents in a tab, M1.3a (ADR-0002 §7, src/main/web/navigation-policy.ts): data:,
// srcdoc and blob: documents load in frames, as in Chrome. A tab may show a blob: page in place
// when the blob's origin is a web origin, so the address bar names the site that made it. A
// renderer-initiated top-level data: navigation, and an opaque-origin blob (blob:null/...), stay
// blocked: they would put content on screen under no site's name.
//
// After a blocked navigation the tab's page is checked with `evaluate` and main, never with a
// locator or an action (launch.ts rule 7).
import { expect } from './expect';
import { test } from './fixtures';
import {
  frameTreeInMain,
  pageForTab,
  recordNavigations,
  setSearchTemplate,
  tabState,
  urlInMain,
  watchConsole,
} from './hooks';
import { observeFor } from './launch';
import type { PageGlobal } from './page-globals';
import {
  expectConsistent,
  loadInNewTab,
  omnibox,
  securityIndicator,
  tabElement,
  tabElements,
  waitForPage,
} from './shell-ui';

/** `window.framesFixture`, defined by tests/fixtures/pages/frames.html. */
interface FramesFixture {
  readonly blobFrameUrl: string;
  readonly opaqueBlobUrl: string | null;
  openBlobInPlace(): void;
  navigateToData(): void;
  navigateTo(url: string): void;
}
type FramesGlobal = typeof globalThis & { framesFixture: FramesFixture };

test.describe.configure({ timeout: 120_000 });

test.describe('data:, srcdoc and blob: documents', () => {
  test.beforeEach(async ({ electronApp, fixtureServer, shell }) => {
    await setSearchTemplate(electronApp, fixtureServer.url('/search?q={searchTerms}'));
    await expect(tabElements(shell)).toHaveCount(1);
  });

  test('load in frames: data:, srcdoc and a script-created blob:', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const pageUrl = fixtureServer.url('/frames.html');
    const tabId = await loadInNewTab(electronApp, shell, pageUrl);
    const webContentsId = (await tabState(electronApp, tabId))?.webContentsId;
    if (webContentsId == null) {
      throw new Error('the tab should have a web contents');
    }

    // Main's own view of the frame tree: every generated document committed under the page.
    await expect
      .poll(
        async () => {
          const frames = await frameTreeInMain(electronApp, webContentsId);
          const children = frames.filter((frame) => frame.parentUrl === pageUrl);
          return {
            main: frames.some((frame) => frame.parentUrl === null && frame.url === pageUrl),
            data: children.filter((frame) => frame.url.startsWith('data:text/html')).length,
            // The visible srcdoc frame and the sandboxed one.
            srcdoc: children.filter((frame) => frame.url === 'about:srcdoc').length,
            blob: children.filter((frame) => frame.url.startsWith(`blob:${fixtureServer.origin}/`))
              .length,
          };
        },
        { message: 'the data:, srcdoc and blob: frames should all commit', timeout: 15_000 },
      )
      .toEqual({ main: true, data: 1, srcdoc: 2, blob: 1 });

    // And they render: each frame's own document is on screen, not an empty or blocked frame.
    const page = await pageForTab(electronApp, tabId);
    await expect(page.frameLocator('#data-frame').locator('p')).toHaveText('data frame');
    await expect(page.frameLocator('#srcdoc-frame').locator('p')).toHaveText('srcdoc frame');
    await expect(page.frameLocator('#blob-frame').locator('p')).toHaveText('blob frame');

    // The frames didn't change the tab: same address, same label, still the selected view.
    await expect(omnibox(shell)).toHaveValue(pageUrl);
    await expect(tabElement(shell, tabId)).toHaveAccessibleName('Frames fixture');
    await expectConsistent(electronApp, shell);
  });

  test('a tab shows a blob: page in place when the blob has a web origin', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tabId = await loadInNewTab(electronApp, shell, fixtureServer.url('/frames.html'));
    const page = await pageForTab(electronApp, tabId);

    await page.evaluate(() => {
      (globalThis as FramesGlobal).framesFixture.openBlobInPlace();
    });

    // The tab's URL becomes blob:http://127.0.0.1:<port>/<id>: the creator's origin is named.
    const blobPrefix = `blob:${fixtureServer.origin}/`;
    await expect
      .poll(async () => (await tabState(electronApp, tabId))?.url.startsWith(blobPrefix))
      .toBe(true);
    const state = await tabState(electronApp, tabId);
    await waitForPage(electronApp, tabId, { url: state?.url ?? '', title: 'Blob page' });
    expect(state?.page).toEqual({ kind: 'web' });

    await expect(omnibox(shell)).toHaveValue(state?.url ?? '');
    await expect(tabElement(shell, tabId)).toHaveAccessibleName('Blob page');
    // A blob: document has its creator's security state, here plain http.
    await expect(securityIndicator(shell)).toHaveAttribute('data-security', 'not-secure');
    expect(await page.evaluate(() => (globalThis as PageGlobal).location.href)).toBe(state?.url);
    await expectConsistent(electronApp, shell);
  });

  test('a top-level data: navigation is blocked and the tab stays where it is', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const pageUrl = fixtureServer.url('/frames.html');
    const tabId = await loadInNewTab(electronApp, shell, pageUrl);
    const state = await tabState(electronApp, tabId);
    const webContentsId = state?.webContentsId;
    if (webContentsId == null) {
      throw new Error('the tab should have a web contents');
    }
    const page = await pageForTab(electronApp, tabId);
    const navigations = await recordNavigations(electronApp, webContentsId);
    const chromiumConsole = await watchConsole(electronApp, webContentsId);

    await page.evaluate(() => {
      (globalThis as FramesGlobal).framesFixture.navigateToData();
    });

    // The attempt was made and refused. Chromium refuses a renderer-initiated top-level data:
    // navigation itself, with a console error, before Electron's `will-frame-navigate` fires; the
    // guard's own rule (navigation-policy.ts) is the second line, so either report will do.
    await expect
      .poll(
        async () => {
          const records = await navigations.snapshot();
          const messages = await chromiumConsole.messages();
          return (
            records.some((record) => record.cancelled && record.url.startsWith('data:')) ||
            messages.some((message) =>
              message.includes('Not allowed to navigate top frame to data URL'),
            )
          );
        },
        { message: 'a refused data: navigation should be reported by Chromium or the guard' },
      )
      .toBe(true);

    // Give a navigation that wrongly went ahead time to commit. No locators from here on.
    expect(await observeFor(1_000, () => urlInMain(electronApp, webContentsId))).toEqual([pageUrl]);
    expect(await page.evaluate(() => (globalThis as PageGlobal).location.href)).toBe(pageUrl);
    expect(await page.evaluate(() => typeof (globalThis as FramesGlobal).framesFixture)).toBe(
      'object',
    );
    expect((await navigations.snapshot()).filter((record) => !record.cancelled)).toEqual([]);
    expect(await tabState(electronApp, tabId)).toMatchObject({
      url: pageUrl,
      title: 'Frames fixture',
      page: { kind: 'web' },
    });
    await expect(omnibox(shell)).toHaveValue(pageUrl);
    await expect(tabElement(shell, tabId)).toHaveAccessibleName('Frames fixture');
  });

  test('an opaque-origin blob: cannot be shown as the whole page', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const pageUrl = fixtureServer.url('/frames.html');
    const tabId = await loadInNewTab(electronApp, shell, pageUrl);
    const state = await tabState(electronApp, tabId);
    const webContentsId = state?.webContentsId;
    if (webContentsId == null) {
      throw new Error('the tab should have a web contents');
    }
    const page = await pageForTab(electronApp, tabId);

    // The sandboxed frame made a blob: URL of origin "null" and posted it to the page.
    await expect
      .poll(() => page.evaluate(() => (globalThis as FramesGlobal).framesFixture.opaqueBlobUrl))
      .toMatch(/^blob:null\//);
    const opaqueUrl = await page.evaluate(
      () => (globalThis as FramesGlobal).framesFixture.opaqueBlobUrl,
    );
    if (opaqueUrl === null) {
      throw new Error('the sandboxed frame should have posted its blob: URL');
    }

    const navigations = await recordNavigations(electronApp, webContentsId);
    const chromiumConsole = await watchConsole(electronApp, webContentsId);
    await page.evaluate((url) => {
      (globalThis as FramesGlobal).framesFixture.navigateTo(url);
    }, opaqueUrl);

    // Refused by Chromium ("Not allowed to load local resource"), which keeps the navigation from
    // reaching Electron at all, or, failing that, by the guard.
    await expect
      .poll(
        async () => {
          const records = await navigations.snapshot();
          const messages = await chromiumConsole.messages();
          return (
            records.some((record) => record.cancelled && record.url === opaqueUrl) ||
            messages.some((message) =>
              message.includes(`Not allowed to load local resource: ${opaqueUrl}`),
            )
          );
        },
        { message: 'a refused blob:null navigation should be reported by Chromium or the guard' },
      )
      .toBe(true);

    expect(await observeFor(1_000, () => urlInMain(electronApp, webContentsId))).toEqual([pageUrl]);
    expect(await page.evaluate(() => (globalThis as PageGlobal).location.href)).toBe(pageUrl);
    expect((await navigations.snapshot()).filter((record) => !record.cancelled)).toEqual([]);
    expect(await tabState(electronApp, tabId)).toMatchObject({
      url: pageUrl,
      page: { kind: 'web' },
    });
    await expect(omnibox(shell)).toHaveValue(pageUrl);
  });
});
