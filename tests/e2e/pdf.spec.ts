// The built-in PDF viewer must work inside the guard (spike S7, ADR-0002 §4): the tab guard allows
// the viewer's own frames, `chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/`, and nothing else
// of its kind. Blocking them leaves the viewer's toolbar and no document.
import { PDF_VIEWER_EXTENSION_ID } from '../../src/main/web/navigation-policy';
import { expect, test } from './fixtures';
import { frameTreeInMain, setSearchTemplate, tabState } from './hooks';
import {
  expectConsistent,
  internalPage,
  omnibox,
  openTabAt,
  securityIndicator,
  tabElements,
} from './shell-ui';

/** Chromium loads the viewer asynchronously after the PDF response arrives. */
const VIEWER_TIMEOUT_MS = 15_000;

test.describe('PDF viewer', () => {
  test('loads the built-in viewer and its document frame in a tab', async ({
    electronApp,
    fixtureServer,
    openTab,
  }) => {
    const pdfUrl = fixtureServer.url('/sample.pdf');
    const tab = await openTab(pdfUrl);
    const viewerPrefix = `chrome-extension://${PDF_VIEWER_EXTENSION_ID}/`;

    // The viewer frame alone is not enough: the toolbar frame appears even when the guard blocks
    // the viewer's other frames (checked by blocking them). The frame that holds the document
    // is a child frame that commits the PDF's own URL; when it is blocked, its URL stays empty.
    const readFrames = async () => {
      const frames = await frameTreeInMain(electronApp, tab.webContentsId);
      return {
        viewerFrame: frames.some((frame) => frame.url.startsWith(viewerPrefix)),
        documentFrame: frames.some((frame) => frame.parentUrl !== null && frame.url === pdfUrl),
      };
    };
    await expect
      .poll(readFrames, {
        message: `the viewer frame (${viewerPrefix}) and a child frame at ${pdfUrl} should exist`,
        timeout: VIEWER_TIMEOUT_MS,
      })
      .toEqual({ viewerFrame: true, documentFrame: true });

    // The tab itself stayed on the PDF.
    expect(tab.page.url()).toBe(pdfUrl);
  });

  test('opens a PDF in a real tab through the address bar', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    // Typing into the address bar: searches must stay on the local fixture.
    await setSearchTemplate(electronApp, fixtureServer.url('/search?q={searchTerms}'));
    await expect(tabElements(shell)).toHaveCount(1);

    const pdfUrl = fixtureServer.url('/sample.pdf');
    const tabId = await openTabAt(shell, pdfUrl);
    const viewerPrefix = `chrome-extension://${PDF_VIEWER_EXTENSION_ID}/`;

    // The tab's web contents id comes from TabManager's state; the PDF viewer needs a moment
    // to build its frames after the response arrives.
    await expect
      .poll(async () => (await tabState(electronApp, tabId))?.webContentsId ?? null, {
        message: 'the tab should get a web contents',
      })
      .not.toBeNull();
    const webContentsId = (await tabState(electronApp, tabId))?.webContentsId ?? 0;

    // As for a test tab: the viewer frame, and the child frame that commits the PDF's own URL.
    // Blocking the viewer's frames would leave its toolbar and no document.
    await expect
      .poll(
        async () => {
          const frames = await frameTreeInMain(electronApp, webContentsId);
          return {
            viewerFrame: frames.some((frame) => frame.url.startsWith(viewerPrefix)),
            documentFrame: frames.some((frame) => frame.parentUrl !== null && frame.url === pdfUrl),
          };
        },
        {
          message: `the viewer frame (${viewerPrefix}) and a child frame at ${pdfUrl} should exist`,
          timeout: VIEWER_TIMEOUT_MS,
        },
      )
      .toEqual({ viewerFrame: true, documentFrame: true });

    // The tab is a web tab on the PDF, with its view attached: no error page took its place.
    await expect(internalPage(shell, 'network-error')).toHaveCount(0);
    await expect(omnibox(shell)).toHaveValue(pdfUrl);
    await expect(securityIndicator(shell)).toHaveAttribute('data-security', 'not-secure');
    expect(await tabState(electronApp, tabId)).toMatchObject({
      url: pdfUrl,
      page: { kind: 'web' },
      runtime: 'live',
      attached: true,
    });
    await expectConsistent(electronApp, shell);
  });
});
