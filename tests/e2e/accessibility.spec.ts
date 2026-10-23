// Accessibility of the shell's own pages (M6.2, assessment §7.3 and §9.2, ADR-0008 item 7).
// axe-core checks the shell page in each state a user can reach, in the light and the dark theme,
// against WCAG 2.2 A and AA. The web pages in tabs are other people's documents and aren't
// scanned. What axe can't judge (whether a screen reader says the right thing, whether the
// keyboard order makes sense) is in docs/testing/accessibility.md, for a person with Narrator.
//
// A violation fails the test with every node axe named, so a fix can start from the log.
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import { expect } from './expect';
import { test } from './fixtures';
import { openDownloadsPanel, waitForDownload } from './downloads-ui';
import { clickElement, evaluateInTab } from './hooks';
import { closeApp, launchApp, shellPage } from './launch';
import { promptStrip, waitForStrip } from './prompt-ui';
import {
  SLOW_TIMEOUT_MS,
  internalPage,
  loadTab,
  omnibox,
  openTabAt,
  palette,
  searchMemoryButton,
  suggestionList,
} from './shell-ui';

/** The WCAG levels the shell must meet. */
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
const SCHEMES = ['light', 'dark'] as const;
/** The popup windows' address bar (src/main/windows/popup-windows.ts). */
const POPUP_BAR_URL = 'app://shell/popup-bar.html';

/**
 * Scans `page` in both themes. The shell switches by a `dark` class it sets from the media query
 * (lib/color-scheme.ts), so the scan waits for it; the popup bar uses the media query directly.
 */
async function scan(
  page: Page,
  what: string,
  options: { readonly themeClass?: boolean } = {},
): Promise<void> {
  for (const colorScheme of SCHEMES) {
    await page.emulateMedia({ colorScheme });
    if (options.themeClass !== false) {
      await expect(page.locator('html')).toHaveClass(
        colorScheme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b)/,
      );
    }
    // Legacy mode: axe's default opens a blank page to merge frame results, which Electron's
    // CDP refuses (Target.createTarget). The shell has no frames, so nothing is lost.
    const results = await new AxeBuilder({ page }).withTags(WCAG).setLegacyMode(true).analyze();
    const found = results.violations.map((violation) => ({
      rule: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.map(
        (node) => `${node.target.join(' ')}: ${node.failureSummary ?? ''}`,
      ),
    }));
    expect(found, `${what} (${colorScheme}): ${JSON.stringify(found, null, 2)}`).toEqual([]);
    // The scan checked text against its background: a page axe couldn't read would pass vacuously.
    expect(results.passes.map((rule) => rule.id)).toContain('color-contrast');
  }
}

test.describe('accessibility of the shell (M6.2, axe-core, WCAG 2.2 AA)', () => {
  test('the new-tab page, the toolbar and the sidebar', async ({ shell }) => {
    await expect(internalPage(shell, 'new-tab')).toBeVisible({ timeout: SLOW_TIMEOUT_MS });
    await scan(shell, 'the new-tab page');
  });

  test('Settings', async ({ shell }) => {
    await shell.locator('[data-settings-button]').click();
    await expect(internalPage(shell, 'settings')).toHaveAttribute('data-settings-state', 'ready');
    await scan(shell, 'Settings');
  });

  test('Diagnostics', async ({ shell }) => {
    await openTabAt(shell, 'veltriva://diagnostics');
    await expect(internalPage(shell, 'diagnostics')).toBeVisible({ timeout: SLOW_TIMEOUT_MS });
    await scan(shell, 'Diagnostics');
  });

  test('About, with the third-party notices open (M6.3)', async ({ shell }) => {
    await openTabAt(shell, 'veltriva://about');
    const about = internalPage(shell, 'about');
    await expect(about).toHaveAttribute('data-about-state', 'ready', { timeout: SLOW_TIMEOUT_MS });
    await about.locator('summary', { hasText: 'Third-party notices' }).click();
    await expect(about.locator('[data-about-notices]')).toBeVisible();
    await scan(shell, 'About');
  });

  test('the update notice (M6.3)', async ({ electronApp, shell }) => {
    // The notice itself, as main shows it for a newer version; no feed is contacted.
    await electronApp.evaluate(() => {
      globalThis.__veltrivaTest?.showNotice({ kind: 'update-available', version: '99.0.0' });
    });
    await expect(shell.locator('[data-notice-kind="update-available"]')).toBeVisible({
      timeout: SLOW_TIMEOUT_MS,
    });
    await scan(shell, 'the update notice');
  });

  test('the memory palette', async ({ shell }) => {
    await searchMemoryButton(shell).click();
    await expect(palette(shell)).toBeVisible();
    await scan(shell, 'the palette');
  });

  test('the address bar with its suggestions', async ({ electronApp, fixtureServer, shell }) => {
    await loadTab(electronApp, shell, fixtureServer.url('/page-a.html'));
    await omnibox(shell).click();
    await omnibox(shell).fill('page');
    await expect(suggestionList(shell)).toBeVisible({ timeout: SLOW_TIMEOUT_MS });
    await scan(shell, 'the suggestions');
  });

  test('a permission prompt in the toolbar', async ({ electronApp, fixtureServer, shell }) => {
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/permissions.html'));
    await evaluateInTab(
      electronApp,
      tab.webContentsId,
      `permissionsFixture.start("notifications")`,
    );
    await waitForStrip(shell, 'permission');
    await expect(promptStrip(shell)).toBeVisible();
    await scan(shell, 'a permission prompt');
  });

  test('the downloads panel, with a finished download', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    // The button appears with the first download.
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/downloads.html'));
    await clickElement(electronApp, tab.webContentsId, '#link-report');
    await waitForDownload(shell, 'report.pdf', 'completed');
    await openDownloadsPanel(shell);
    await scan(shell, 'the downloads panel');
  });

  test('a network error page', async ({ shell }) => {
    await openTabAt(shell, 'http://127.0.0.1:9/');
    await expect(internalPage(shell, 'network-error')).toBeVisible({ timeout: SLOW_TIMEOUT_MS });
    await scan(shell, 'a network error page');
  });

  test('a popup window’s read-only address bar', async ({ electronApp, fixtureServer, shell }) => {
    const opener = await loadTab(electronApp, shell, fixtureServer.url('/popup-opener.html'));
    await clickElement(electronApp, opener.webContentsId, '#open-popup');
    // Its page, on the shell's origin with no preload, loads after the window appears.
    const findBar = (): Page | undefined =>
      electronApp.windows().find((page) => page.url() === POPUP_BAR_URL);
    await expect.poll(() => findBar() !== undefined, { timeout: SLOW_TIMEOUT_MS }).toBe(true);
    const bar = findBar();
    if (bar === undefined) {
      throw new Error('unreachable: the poll passed with no address bar');
    }
    await expect(bar.locator('#address')).not.toBeEmpty({ timeout: SLOW_TIMEOUT_MS });
    await scan(bar, 'the popup address bar', { themeClass: false });
  });

  test('the welcome page on a new profile', async ({ userDataDir }) => {
    const app = await launchApp(userDataDir, { env: { VELTRIVA_TEST_FIRST_RUN: '1' } });
    try {
      const shell = await shellPage(app);
      await expect(internalPage(shell, 'welcome')).toBeVisible({ timeout: SLOW_TIMEOUT_MS });
      await scan(shell, 'the welcome page');
    } finally {
      await closeApp(app);
    }
  });
});
