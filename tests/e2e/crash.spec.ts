// A crashed renderer, M1.3a (ADR-0003's runtime states, ADR-0005): main notices the death of a
// tab's renderer, detaches its view and shows the crashed page; "Reload tab" starts a new renderer
// and brings the page back. `crashTab` is the test hook that kills the renderer
// (`forcefullyCrashRenderer`). Nothing else in the window may be affected.
import { expect } from './expect';
import { test } from './fixtures';
import { crashTab, evaluateInTab, setSearchTemplate, tabState } from './hooks';
import {
  expectConsistent,
  internalPage,
  loadInNewTab,
  tabElement,
  tabElements,
  tabRow,
  waitForPage,
} from './shell-ui';

test.describe.configure({ timeout: 120_000 });

test.describe('crashed tab', () => {
  test.beforeEach(async ({ electronApp, fixtureServer, shell }) => {
    await setSearchTemplate(electronApp, fixtureServer.url('/search?q={searchTerms}'));
    await expect(tabElements(shell)).toHaveCount(1);
  });

  test('shows the crashed page, and "Reload tab" brings the page back', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const url = fixtureServer.url('/page-a.html?case=crash');
    const tabId = await loadInNewTab(electronApp, shell, url);
    const before = await tabState(electronApp, tabId);
    expect(before).toMatchObject({ attached: true, runtime: 'live' });

    await crashTab(electronApp, tabId);

    // The crashed page replaces the view, and the sidebar says so.
    const crashed = internalPage(shell, 'crashed');
    await expect(crashed).toBeVisible();
    await expect(crashed.getByRole('heading', { level: 1 })).toHaveText('This tab crashed');
    await expect(crashed.getByRole('button', { name: 'Reload tab' })).toBeVisible();
    await expect(tabRow(shell, tabId).locator('[data-tab-status="crashed"]')).toHaveCount(1);

    const state = await tabState(electronApp, tabId);
    expect(state).toMatchObject({
      runtime: 'crashed',
      attached: false,
      loading: false,
      page: { kind: 'internal', name: 'crashed' },
    });
    // Main reports why, and the page shows it.
    const reason = state?.page.kind === 'internal' ? state.page.error?.name : undefined;
    expect(reason).toBeTruthy();
    await expect(crashed).toContainText(reason ?? '');
    await expectConsistent(electronApp, shell);

    // "Reload tab" starts a new renderer in the same tab, and the page returns.
    await crashed.getByRole('button', { name: 'Reload tab' }).click();
    await waitForPage(electronApp, tabId, { url, title: 'Page A' });
    await expect(crashed).toHaveCount(0);
    await expect(tabRow(shell, tabId).locator('[data-tab-status]')).toHaveCount(0);
    await expect(tabElement(shell, tabId)).toHaveAccessibleName('Page A');

    const after = await tabState(electronApp, tabId);
    expect(after).toMatchObject({
      runtime: 'live',
      attached: true,
      page: { kind: 'web' },
      webContentsId: before?.webContentsId,
    });
    await expectConsistent(electronApp, shell);

    // The restored page is alive and is the same document. Playwright's Page for this tab
    // fired 'crash' and stays unreliable afterwards, so ask the web contents from main.
    const webContentsId = after?.webContentsId ?? 0;
    expect(await evaluateInTab(electronApp, webContentsId, '1 + 1')).toBe(2);
    expect(await evaluateInTab(electronApp, webContentsId, 'document.title')).toBe('Page A');
    expect(await evaluateInTab(electronApp, webContentsId, 'location.href')).toBe(url);
  });

  test('a crashed background tab shows as crashed and leaves the other tabs alone', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const urlA = fixtureServer.url('/page-a.html?case=crash-background');
    const urlB = fixtureServer.url('/page-b.html?case=crash-background');
    const tabA = await loadInNewTab(electronApp, shell, urlA);
    const tabB = await loadInNewTab(electronApp, shell, urlB);

    // A is hidden (B is selected). Its renderer dies.
    await crashTab(electronApp, tabA);
    await expect(tabRow(shell, tabA).locator('[data-tab-status="crashed"]')).toHaveCount(1);
    await expect.poll(async () => (await tabState(electronApp, tabA))?.runtime).toBe('crashed');

    // B is untouched: still selected, attached and showing its page.
    expect(await tabState(electronApp, tabB)).toMatchObject({
      runtime: 'live',
      attached: true,
      title: 'Page B',
    });
    await expect(internalPage(shell, 'crashed')).toHaveCount(0);
    await expectConsistent(electronApp, shell);

    // Selecting A shows the crashed page; reloading it restores A, and B is still fine.
    await tabElement(shell, tabA).click();
    const crashed = internalPage(shell, 'crashed');
    await expect(crashed).toBeVisible();
    await expectConsistent(electronApp, shell);
    await crashed.getByRole('button', { name: 'Reload tab' }).click();
    await waitForPage(electronApp, tabA, { url: urlA, title: 'Page A' });
    await expectConsistent(electronApp, shell);
    expect(await tabState(electronApp, tabB)).toMatchObject({ runtime: 'live', title: 'Page B' });
  });
});
