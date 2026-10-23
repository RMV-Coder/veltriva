// M5.3: the diagnostics page's additions (memory per tab, pressure history, the database, the log),
// "Export diagnostics", diagnostic logging, and scroll positions across a restart. What the export
// would save and what the log holds are read from where they go: the test build's record of the
// export, and the log file in the profile.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ElectronApplication, Page } from '@playwright/test';

import { expect } from './expect';
import { evaluateInTab, selectedTabId, setMemoryPressure, tabState } from './hooks';
import type { TabId } from './hooks';
import { dataValue, test } from './session-ui';
import {
  internalPage,
  loadInNewTab,
  omnibox,
  openTabAt,
  tabElement,
  typeAddress,
  waitForLoaded,
} from './shell-ui';

function diagnosticsPage(shell: Page) {
  return internalPage(shell, 'diagnostics');
}

async function openDiagnostics(shell: Page): Promise<void> {
  await openTabAt(shell, 'veltriva://diagnostics');
  await expect(diagnosticsPage(shell)).toHaveAttribute('data-diagnostics-state', 'ready');
}

/** What "Export diagnostics" would have saved, as recorded by the test build. */
function recordedExports(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => globalThis.__veltrivaTest?.diagnosticsExports() ?? []);
}

/** The log file's events, parsed (none when there is no file yet). */
function logEvents(userDataDir: string): Record<string, unknown>[] {
  const file = join(userDataDir, 'logs', 'veltriva.log');
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function showTab(app: ElectronApplication, shell: Page, tabId: TabId): Promise<void> {
  await tabElement(shell, tabId).click();
  await expect.poll(() => selectedTabId(app)).toBe(tabId);
}

/** An address on this machine where nothing listens: the load fails at once. */
const UNREACHABLE = 'http://127.0.0.1:9/unreachable';

test.describe('the diagnostics page (M5.3)', () => {
  test('shows each tab’s memory, pressure changes, the database and the log', async ({
    electronApp,
    shell,
    fixtureServer,
  }) => {
    const tab = await loadInNewTab(
      electronApp,
      shell,
      fixtureServer.url('/page-a.html?case=memory'),
    );
    await setMemoryPressure(electronApp, 'moderate');
    await setMemoryPressure(electronApp, 'none');
    await openDiagnostics(shell);
    const page = diagnosticsPage(shell);

    const row = page.locator(`[data-tab-memory="${tab}"]`);
    await expect(row).toContainText('Page A');
    await expect(row.locator('[data-tab-memory-field="memory"]')).toHaveText(
      /^(\d[\d,]* MB|Under 1 MB)/,
    );
    await expect(page.locator('[data-diagnostics-field="browser-memory"]')).toHaveText(/MB$/);
    // Newest first: back to normal, after it was low.
    await expect(page.locator('[data-diagnostics-field="pressure-history"] li')).toHaveCount(2);
    await expect(page.locator('[data-diagnostics-field="pressure-history"]')).toContainText(
      /Normal[\s\S]*Low/,
    );
    await expect(page.locator('[data-diagnostics-field="database-size"]')).toHaveText(/MB$/);
    await expect(page.locator('[data-diagnostics-field="database-backup"]')).toHaveText('Not yet');
    await expect(page.locator('[data-diagnostics-field="logging"]')).toHaveText(
      'Off: no page addresses',
    );
    await expect(page.locator('[data-diagnostics-field="log-file"]')).toContainText('veltriva.log');

    await page.locator('[data-diagnostics-open-log]').click();
    await expect
      .poll(() => electronApp.evaluate(() => globalThis.__veltrivaTest?.openedPaths() ?? []))
      .toEqual([expect.stringMatching(/[\\/]logs$/)]);
  });

  test('"Export diagnostics" holds no address unless asked, and never a title', async ({
    electronApp,
    shell,
    fixtureServer,
  }) => {
    const address = fixtureServer.url('/page-b.html?case=export-secret');
    await loadInNewTab(electronApp, shell, address);
    await openDiagnostics(shell);
    const page = diagnosticsPage(shell);

    await page.locator('[data-diagnostics-export]').click();
    await expect(page.locator('[data-diagnostics-exported]')).toHaveText('Saved.');
    const [plain] = await recordedExports(electronApp);
    const document = JSON.parse(plain ?? '{}') as {
      version: number;
      includesAddresses: boolean;
      tabs: Record<string, unknown>[];
    };
    expect(document.version).toBe(1);
    expect(document.includesAddresses).toBe(false);
    expect(document.tabs.length).toBeGreaterThan(0);
    expect(document.tabs.every((entry) => !('address' in entry))).toBe(true);
    expect(plain).not.toContain('export-secret');
    expect(plain).not.toContain('Page B');

    await page.locator('[data-diagnostics-include-addresses]').check();
    await page.locator('[data-diagnostics-export]').click();
    await expect.poll(async () => (await recordedExports(electronApp)).length).toBe(2);
    const withAddresses = (await recordedExports(electronApp))[1] ?? '';
    expect(withAddresses).toContain(address);
    expect(withAddresses).not.toContain('Page B');
  });

  test('the log names a failed load’s address only while diagnostic logging is on', async ({
    electronApp,
    shell,
    userDataDir,
  }) => {
    const tab = await openTabAt(shell, UNREACHABLE);
    await expect
      .poll(() => logEvents(userDataDir).filter((e) => e.event === 'tab.loadFailed'))
      .toEqual([expect.objectContaining({ level: 'warn', url: '[hidden]' })]);

    // Diagnostic logging on, in Settings.
    await shell.locator('[data-settings-button]').click();
    const settings = internalPage(shell, 'settings');
    await expect(settings).toHaveAttribute('data-settings-state', 'ready');
    await settings.locator('[data-setting="diagnostic-logging"]').check();
    await expect
      .poll(
        async () =>
          (
            await dataValue<{ value: { diagnostics?: { logging?: boolean } } | null }>(
              electronApp,
              'settings.get',
              {},
            )
          ).value?.diagnostics?.logging,
      )
      .toBe(true);

    await showTab(electronApp, shell, tab);
    // The address bar takes the selected tab's address a moment after the selection: typing before
    // that appended to it (seen once under load).
    await expect(omnibox(shell)).toHaveValue(UNREACHABLE);
    await typeAddress(shell, UNREACHABLE);
    await expect
      .poll(() =>
        logEvents(userDataDir)
          .filter((e) => e.event === 'tab.loadFailed')
          .map((e) => e.url),
      )
      .toEqual(['[hidden]', UNREACHABLE]);
  });
});

test.describe('scroll positions across a restart (M5.3)', () => {
  test('a restored tab comes back where it was scrolled; a sensitive page does not', async ({
    launcher,
    fixtureServer,
  }) => {
    const first = await launcher.launch();
    const article = await loadInNewTab(
      first.app,
      first.shell,
      fixtureServer.url('/lifecycle-article.html?case=scroll'),
    );
    const articleContents = (await tabState(first.app, article))?.webContentsId ?? 0;
    await evaluateInTab(first.app, articleContents, 'window.scrollTo(0, 1500); window.scrollY');
    const sensitive = await loadInNewTab(
      first.app,
      first.shell,
      fixtureServer.url('/lifecycle-sensitive.html?case=scroll'),
    );
    const sensitiveContents = (await tabState(first.app, sensitive))?.webContentsId ?? 0;
    await evaluateInTab(
      first.app,
      sensitiveContents,
      "document.body.style.height = '4000px'; window.scrollTo(0, 800); window.scrollY",
    );
    // Hiding each one is when it is read: select another tab.
    await showTab(first.app, first.shell, article);
    await launcher.quit(first);

    const second = await launcher.launch();
    const stored = await dataValue<{ value: { tabs?: Record<string, { y: number }> } | null }>(
      second.app,
      'appState.get',
      { key: 'scroll' },
    );
    expect(Object.keys(stored.value?.tabs ?? {})).toEqual([article]);
    await showTab(second.app, second.shell, article);
    await waitForLoaded(second.app, article);
    const contents = (await tabState(second.app, article))?.webContentsId ?? 0;
    await expect
      .poll(async () => Number(await evaluateInTab(second.app, contents, 'window.scrollY')))
      .toBeGreaterThan(1400);
  });
});
