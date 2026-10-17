// Clipboard access from a tab, M1.3a (ADR-0002 §7): a site's copy button works without a prompt
// (`clipboard-sanitized-write` is granted to the browsing session), and reading the clipboard is
// not granted. Since M1.4a a read asks the user first (the strip, ADR-0002 item 9) and the page
// gets nothing until they allow it; here the user says "Block". The specs touch the real system
// clipboard, so each one saves its text first and puts it back afterwards, even when the test
// fails.
import type { ElectronApplication } from '@playwright/test';

import { expect } from './expect';
import { test } from './fixtures';
import { pageForTab, setSearchTemplate } from './hooks';
import { clickNow, stripSentence, waitForStrip } from './prompt-ui';
import { loadInNewTab, tabElements } from './shell-ui';

test.describe.configure({ timeout: 120_000 });

/** The text `copy` writes (tests/fixtures/pages/clipboard.html). */
const FIXTURE_TEXT = 'Veltriva clipboard fixture text';

function readClipboard(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ clipboard }) => clipboard.readText());
}

async function writeClipboard(app: ElectronApplication, text: string): Promise<void> {
  await app.evaluate(async ({ clipboard }, value) => {
    if (value === '') {
      clipboard.clear();
    } else {
      await clipboard.writeText(value);
    }
  }, text);
}

test.describe('clipboard in a tab', () => {
  test.beforeEach(async ({ electronApp, fixtureServer, shell }) => {
    await setSearchTemplate(electronApp, fixtureServer.url('/search?q={searchTerms}'));
    await expect(tabElements(shell)).toHaveCount(1);
  });

  test('a site can write to the clipboard but not read it', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const saved = await readClipboard(electronApp);
    try {
      // Something else is on the clipboard first, so that what we find later came from the page.
      await writeClipboard(electronApp, 'veltriva-clipboard-before');

      const tabId = await loadInNewTab(electronApp, shell, fixtureServer.url('/clipboard.html'));
      const page = await pageForTab(electronApp, tabId);

      // Writing: a click on the page's copy button puts its text on the system clipboard.
      await page.locator('#copy').click();
      await expect(page.locator('#write-result')).toHaveAttribute('data-result', 'written');
      await expect.poll(() => readClipboard(electronApp)).toBe(FIXTURE_TEXT);

      // Reading: denied, by the browser's permission and not for lack of focus. Put something the
      // page must never see on the clipboard first.
      await writeClipboard(electronApp, 'veltriva-clipboard-secret');
      await page.locator('#read').click();
      const result = page.locator('#read-result');
      // M1.4a: the read asks first. Until the user answers, the page is told nothing, and the
      // clipboard's content never reaches it.
      await waitForStrip(shell, 'permission');
      await expect(stripSentence(shell)).toContainText('wants to see text and images you copied');
      await expect(result).toHaveAttribute('data-result', 'none');
      await clickNow(shell, 'Block');
      await expect(result).toHaveAttribute('data-result', 'denied');
      await expect(result).toHaveAttribute('data-permission', 'denied');
      await expect(result).not.toContainText('veltriva-clipboard-secret');
      // The failed read left the clipboard as it was.
      expect(await readClipboard(electronApp)).toBe('veltriva-clipboard-secret');
    } finally {
      try {
        await writeClipboard(electronApp, saved);
      } catch (error) {
        console.warn('Could not restore the clipboard text:', error);
      }
    }
  });
});
