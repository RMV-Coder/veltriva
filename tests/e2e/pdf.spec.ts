// The built-in PDF viewer must work inside the guard (spike S7, ADR-0002 §4): the tab guard allows
// the viewer's own frames, `chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/`, and nothing else
// of its kind. Blocking them leaves the viewer's toolbar and no document.
import { PDF_VIEWER_EXTENSION_ID } from '../../src/main/web/navigation-policy';
import { expect, test } from './fixtures';
import { frameTreeInMain } from './hooks';

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
});
