// M5.2: clearing data (one entry, a site, a time range) and the stored answers to sites, through
// Settings and the palette. What each spec checks is what main and the database keep: the memory
// read back through the data worker, the archive and recently closed lists, the raw bytes of the
// profile's database, the browsing session's cookies. The deletion itself (rows, index entries,
// file shrink, raw bytes after a checkpoint) is unit-tested in src/data/repos/forget.test.ts.
import type { ElectronApplication, Page } from '@playwright/test';

import { BROWSING_PARTITION } from '../../src/shared/constants/app-identity';
import { expect } from './expect';
import {
  archivedTabs,
  evaluateInTab,
  focusedWebContents,
  invokeTabMenuItem,
  selectedTabId,
  sendKey,
  tabMenuItems,
} from './hooks';
import type { TabId } from './hooks';
import { readMemory } from './memory-ui';
import type { PageGlobal } from './page-globals';
import { profileDbBytes, readProfileDb } from './profile-db';
import { clickYes, expectNoStrip, waitForStrip } from './prompt-ui';
import { dataValue, test } from './session-ui';
import { internalPage, loadInNewTab, loadTab, sidebarIds, tabElement } from './shell-ui';

function settingsPage(shell: Page) {
  return internalPage(shell, 'settings');
}

function setting(shell: Page, name: string, value?: string) {
  return settingsPage(shell).locator(
    value === undefined ? `[data-setting="${name}"]` : `[data-setting="${name}"][value="${value}"]`,
  );
}

async function openSettings(shell: Page): Promise<void> {
  await shell.locator('[data-settings-button]').click();
  await expect(settingsPage(shell)).toHaveAttribute('data-settings-state', 'ready');
}

/** Selects a tab with a click, and waits until the shell shows it selected. */
async function showTab(shell: Page, tabId: TabId): Promise<void> {
  await tabElement(shell, tabId).click();
  await expect(tabElement(shell, tabId)).toHaveAttribute('aria-selected', 'true');
}

async function pageUrls(app: ElectronApplication): Promise<string[]> {
  return (await readMemory(app)).pages.map((page) => page.url);
}

/** Sends a command straight to main, as any code in the shell could. */
function sendToMain(shell: Page, name: 'clear' | 'forgetSite', input: unknown) {
  return shell.evaluate(
    async ([method, payload]) => {
      const { veltriva } = globalThis as PageGlobal;
      return method === 'clear'
        ? veltriva.privacy.clear(payload as never)
        : veltriva.privacy.forgetSite(payload as never);
    },
    [name, input] as const,
  );
}

/** The browsing session's cookies, as main sees them. */
function cookies(app: ElectronApplication): Promise<{ name: string; domain: string }[]> {
  return app.evaluate(async ({ session }, partition) => {
    const all = await session.fromPartition(partition).cookies.get({});
    return all.map((cookie) => ({ name: cookie.name, domain: cookie.domain ?? '' }));
  }, BROWSING_PARTITION);
}

test.describe('clearing data (M5.2)', () => {
  test('"Everything" removes the memory, the archived and closed tabs, and the words from the file; open tabs stay', async ({
    electronApp,
    shell,
    fixtureServer,
    userDataDir,
  }) => {
    // A word of its own for each: the open tab keeps its address in the session, by design.
    const archived = await loadInNewTab(
      electronApp,
      shell,
      fixtureServer.url('/page-a.html?case=Zanzibararchived'),
    );
    const closed = await loadInNewTab(
      electronApp,
      shell,
      fixtureServer.url('/page-b.html?case=Zanzibarclosed'),
    );
    const open = await loadInNewTab(
      electronApp,
      shell,
      fixtureServer.url('/page-c.html?case=Zanzibaropen'),
    );
    await expect.poll(async () => (await pageUrls(electronApp)).length).toBe(3);
    await invokeTabMenuItem(electronApp, archived, 'archive');
    await expect.poll(async () => (await archivedTabs(electronApp)).entries.length).toBe(1);
    await invokeTabMenuItem(electronApp, closed, 'close');
    await expect.poll(() => sidebarIds(shell)).not.toContain(closed);
    // The session store has written both rows (it does within a second): the count below is exact.
    await expect
      .poll(() =>
        readProfileDb(
          userDataDir,
          "SELECT placement FROM tabs WHERE placement IN ('archive', 'closed') ORDER BY placement",
        ).map((row) => row.placement),
      )
      .toEqual(['archive', 'closed']);

    await openSettings(shell);
    await setting(shell, 'clear-range', 'all').check();
    await setting(shell, 'clear-tabs').check();
    await setting(shell, 'clear').click();
    // It asks once more, with the keyboard on the button that clears.
    const confirm = settingsPage(shell).locator('[data-settings-confirm-yes]');
    await expect(confirm).toBeFocused();
    await confirm.click();
    await expect(settingsPage(shell).locator('[data-settings-cleared]')).toHaveText(
      /^Removed 3 pages, 3 visits and 2 archived or closed tabs\.$/,
    );

    expect(await pageUrls(electronApp)).toEqual([]);
    expect((await archivedTabs(electronApp)).count).toBe(0);
    expect(
      (await tabMenuItems(electronApp, open)).some(
        (entry) => entry.type === 'item' && entry.id === 'reopen-closed' && entry.enabled,
      ),
    ).toBe(false);
    // The open tab is the user's: it stays, on its page.
    expect(await sidebarIds(shell)).toContain(open);
    // The archived and closed tabs' words are gone from the database and its log, not only
    // hidden: their rows, their pages and their index entries. The open tab's row keeps its own.
    await expect
      .poll(() => {
        const bytes = profileDbBytes(userDataDir);
        return ['Zanzibararchived', 'zanzibararchived', 'Zanzibarclosed', 'zanzibarclosed'].filter(
          (word) => bytes.includes(word),
        );
      })
      .toEqual([]);
    expect(profileDbBytes(userDataDir).includes('Zanzibaropen')).toBe(true);
  });

  test('a time range keeps what is older; nothing chosen, or a site that is none, is refused by main', async ({
    electronApp,
    shell,
    fixtureServer,
  }) => {
    // An old visit, as if made 3 hours ago.
    const old = fixtureServer.url('/page-a.html?case=three-hours-ago');
    await dataValue(electronApp, 'history.recordVisit', {
      page: { urlKey: old, url: old, host: '127.0.0.1', site: '127.0.0.1', title: 'Old' },
      transition: 'link',
      visitedAt: Date.now() - 3 * 60 * 60 * 1000,
      tabId: null,
    });
    const recent = fixtureServer.url('/page-b.html?case=just-now');
    await loadInNewTab(electronApp, shell, recent);
    await expect.poll(() => pageUrls(electronApp)).toContain(recent);

    await openSettings(shell);
    await setting(shell, 'clear-range', 'hour').check();
    await setting(shell, 'clear').click();
    await settingsPage(shell).locator('[data-settings-confirm-yes]').click();
    await expect(settingsPage(shell).locator('[data-settings-cleared]')).toContainText('Removed');
    expect(await pageUrls(electronApp)).toEqual([old]);

    const invalid = { ok: false, code: 'invalid_input' };
    expect(
      await sendToMain(shell, 'clear', {
        range: 'all',
        memory: false,
        tabs: false,
        siteData: false,
        cache: false,
      }),
    ).toEqual(invalid);
    expect(
      await sendToMain(shell, 'forgetSite', {
        site: 'not a site',
        siteData: true,
        permissions: true,
      }),
    ).toEqual(invalid);
    expect(await pageUrls(electronApp)).toEqual([old]);
  });

  test("forgetting a site removes its memory and cookies, and leaves another site's", async ({
    electronApp,
    shell,
    fixtureServer,
  }) => {
    const here = await loadTab(
      electronApp,
      shell,
      fixtureServer.url('/page-a.html?case=forget-me'),
    );
    await evaluateInTab(
      electronApp,
      here.webContentsId,
      "document.cookie = 'forgetme=1; max-age=3600; path=/'; 1",
    );
    const otherUrl = fixtureServer.otherSiteUrl('/page-b.html?case=keep-me');
    const other = await loadTab(electronApp, shell, otherUrl);
    await evaluateInTab(
      electronApp,
      other.webContentsId,
      "document.cookie = 'keepme=1; max-age=3600; path=/'; 1",
    );
    await expect.poll(async () => (await pageUrls(electronApp)).length).toBe(2);
    await expect
      .poll(async () => (await cookies(electronApp)).map((cookie) => cookie.name).sort())
      .toEqual(['forgetme', 'keepme']);

    await openSettings(shell);
    await setting(shell, 'forget-site').fill(fixtureServer.url('/'));
    await setting(shell, 'forget').click();
    await settingsPage(shell).locator('[data-settings-confirm-yes]').click();
    await expect(settingsPage(shell).locator('[data-settings-forgotten]')).toContainText(
      'Forgot 127.0.0.1. Removed 1 page and 1 visit. Its cookies, storage and cached files are cleared. Its permissions are removed.',
    );

    expect(await pageUrls(electronApp)).toEqual([otherUrl]);
    await expect
      .poll(async () => (await cookies(electronApp)).map((cookie) => cookie.name))
      .toEqual(['keepme']);
  });

  test('Shift+Delete in the palette forgets the active result', async ({
    electronApp,
    shell,
    fixtureServer,
  }) => {
    const gone = fixtureServer.url('/page-a.html?case=quetzalpalette');
    await loadInNewTab(electronApp, shell, gone);
    await expect.poll(() => pageUrls(electronApp)).toContain(gone);

    const focused = await focusedWebContents(electronApp);
    await sendKey(electronApp, focused === null ? 'shell' : 'focused', 'K', ['control', 'shift']);
    const palette = shell.locator('[data-palette-layer]');
    await expect(palette).toBeVisible();
    await palette.getByRole('combobox').fill('quetzalpalette');
    await expect(palette.locator('[data-palette-results] [role="option"]')).toHaveCount(1);
    await shell.keyboard.press('Shift+Delete');

    await expect(palette.locator('[data-palette-hint]')).toHaveText(
      /^Removed “.+” from the memory$/,
    );
    await expect(palette.locator('[data-palette-results] [role="option"]')).toHaveCount(0);
    expect(await pageUrls(electronApp)).not.toContain(gone);
  });
});

test.describe('site permissions (M5.2)', () => {
  test('a stored answer is listed, changed and removed, and the site asks again', async ({
    electronApp,
    shell,
    fixtureServer,
  }) => {
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/permissions.html'));
    await evaluateInTab(
      electronApp,
      tab.webContentsId,
      "permissionsFixture.start('notifications')",
    );
    await waitForStrip(shell, 'permission');
    await clickYes(shell, 'Allow');
    await expectNoStrip(shell);
    const stored = async () =>
      (
        await dataValue<{ decisions: { origin: string; permission: string; decision: string }[] }>(
          electronApp,
          'permissions.list',
          { limit: 100 },
        )
      ).decisions.map(({ origin, permission, decision }) => ({ origin, permission, decision }));
    const origin = fixtureServer.origin;
    await expect.poll(stored).toEqual([{ origin, permission: 'notifications', decision: 'allow' }]);

    await openSettings(shell);
    const settingsTab = await selectedTabId(electronApp);
    const row = settingsPage(shell).locator(
      `[data-permission-origin="${origin}"] [data-permission="notifications"]`,
    );
    await expect(row.locator('[data-permission-decision]')).toHaveValue('allow');

    await row.locator('[data-permission-decision]').selectOption('block');
    await expect.poll(stored).toEqual([{ origin, permission: 'notifications', decision: 'block' }]);

    await row.locator('[data-permission-remove]').click();
    await expect(row).toHaveCount(0);
    await expect.poll(stored).toEqual([]);
    await expect(
      settingsPage(shell).locator('[data-settings-message="no-permissions"]'),
    ).toBeVisible();

    // The page asks again.
    await showTab(shell, tab.tabId);
    await evaluateInTab(
      electronApp,
      tab.webContentsId,
      "permissionsFixture.start('notifications')",
    );
    await waitForStrip(shell, 'permission');
    expect(settingsTab).not.toBeNull();
  });

  test('the retention is kept, and a number out of range is refused next to the field', async ({
    electronApp,
    shell,
  }) => {
    await openSettings(shell);
    const field = setting(shell, 'retentionDays');
    await expect(field).toHaveValue('365');

    await field.fill('0');
    await field.press('Enter');
    await expect(settingsPage(shell).locator('[data-settings-error="retentionDays"]')).toHaveText(
      'Enter a whole number of days from 1 to 36,500.',
    );

    await field.fill('30');
    await field.press('Enter');
    await expect
      .poll(
        async () =>
          (
            await dataValue<{ value: { history?: { retentionDays?: number } } | null }>(
              electronApp,
              'settings.get',
              {},
            )
          ).value?.history?.retentionDays,
      )
      .toBe(30);
    await expect(field).toHaveValue('30');
  });
});
