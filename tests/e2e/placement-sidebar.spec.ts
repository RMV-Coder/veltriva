// The sidebar's Sleeping and Archive sections, the Undo toast, the tab status tooltips and the
// activity log, M3.3 (assessment §4.4, §4.12, §4.13). placement.spec.ts checks main's side through
// the commands; these specs drive the shell as a user does: the tab menu (through its test hook,
// since Playwright can't click native menus), clicks on rows and buttons, and what the sidebar
// says. Hidden pages are read from main, never through Playwright (ADR-0008 item 4).
import type { ElectronApplication, Locator, Page } from '@playwright/test';

import type { FixtureServer } from '../fixtures/server';
import { expect } from './expect';
import {
  advanceLifecycleClock,
  archivedTabs,
  invokeTabMenuItem,
  lifecycleEvaluate,
  selectedTabId,
  setMemoryPressure,
  sleepingTabStates,
  tabMenuItems,
  tabState,
} from './hooks';
import type { TabId } from './hooks';
import { startWithPages, test } from './session-ui';
import type { Launcher } from './session-ui';
import { SLOW_TIMEOUT_MS, sidebarIds, tabElement, waitForLoaded } from './shell-ui';

test.describe.configure({ timeout: 180_000 });

// ── Locators (the selectors the sidebar documents in its components) ────────────────────────────

const section = (shell: Page, kind: 'sleeping' | 'archive'): Locator =>
  shell.locator(`section[data-sidebar-section="${kind}"]`);
const sectionToggle = (shell: Page, kind: 'sleeping' | 'archive'): Locator =>
  shell.locator(`button[data-section-toggle="${kind}"]`);
const sleepingRow = (shell: Page, tabId: TabId): Locator =>
  shell.locator(`button[data-sleeping-tab="${tabId}"]`);
const archivedRow = (shell: Page, tabId: TabId): Locator =>
  shell.locator(`button[data-archived-tab="${tabId}"]`);
const summary = (shell: Page): Locator => shell.locator('[data-sidebar-summary]');
const toast = (shell: Page): Locator => shell.locator('[data-undo-toast]');
const toastText = (shell: Page): Locator => shell.locator('p[data-undo-text]');

async function threePages(launcher: Launcher, fixtureServer: FixtureServer) {
  const run = await launcher.launch();
  const page = (name: string): string =>
    fixtureServer.url(`/lifecycle-plain.html?case=sidebar&tab=${name}`);
  const urls = [page('a'), page('b'), page('c')] as const;
  const ids = await startWithPages(run.app, run.shell, urls);
  return { ...run, urls, ids };
}

/** The labels of a sidebar tab's menu, without separators. */
async function menuLabels(app: ElectronApplication, tabId: TabId): Promise<string[]> {
  return (await tabMenuItems(app, tabId)).flatMap((entry) =>
    entry.type === 'item' ? [`${entry.label}${entry.enabled ? '' : ' (disabled)'}`] : [],
  );
}

// ── 1. Sleeping ─────────────────────────────────────────────────────────────────────────────────

test.describe('the Sleeping section', () => {
  test('the tab menu moves a tab there; the toast offers Undo; a click on its row brings it back next to the current tab', async ({
    launcher,
    fixtureServer,
  }) => {
    const { app, shell, ids } = await threePages(launcher, fixtureServer);
    const [a, b, c] = ids;
    await expect(summary(shell)).toHaveText('Sleeping 0 · Archived today 0');
    await expect(section(shell, 'sleeping')).toHaveAttribute('data-expanded', 'false');
    expect(await menuLabels(app, b)).toEqual(
      expect.arrayContaining(['Move to Sleeping', 'Archive tab', 'Protect from automation']),
    );

    await invokeTabMenuItem(app, b, 'shelve');
    await expect(sleepingRow(shell, b)).toBeVisible();
    await expect(section(shell, 'sleeping')).toHaveAttribute('data-expanded', 'true');
    await expect(section(shell, 'sleeping')).toHaveAttribute('data-count', '1');
    await expect(summary(shell)).toHaveText('Sleeping 1 · Archived today 0');
    expect(await sidebarIds(shell)).toEqual([a, c]);
    await expect(sleepingRow(shell, b)).toHaveAttribute(
      'title',
      /^Lifecycle plain\nSleeping — click to bring it back to Tabs/,
    );
    // The toast: the user's own move, with Undo.
    await expect(toast(shell)).toBeVisible();
    await expect(toastText(shell)).toHaveText('Moved to Sleeping');
    await expect(toast(shell)).toHaveAttribute('data-undo-automated', 'false');
    await toast(shell).getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(() => sidebarIds(shell)).toEqual([a, b, c]);
    await expect(toast(shell)).toHaveCount(0);
    await expect(toastText(shell)).toHaveText('');
    await expect(summary(shell)).toHaveText('Sleeping 0 · Archived today 0');

    // Again, and this time back by a click on its row while A is selected: next to A, selected.
    await invokeTabMenuItem(app, b, 'shelve');
    await expect(sleepingRow(shell, b)).toBeVisible();
    await tabElement(shell, a).click();
    await expect.poll(() => selectedTabId(app)).toBe(a);
    // A Sleeping tab's own menu.
    expect(await menuLabels(app, b)).toEqual([
      'Move to Tabs',
      'Archive tab',
      'Protect from automation',
      // M3.4: the page's site can be protected too.
      `Always protect ${new URL(fixtureServer.url('/')).hostname}`,
      'Close tab',
      'Reopen closed tab (disabled)',
    ]);
    await sleepingRow(shell, b).click();
    await expect.poll(() => sidebarIds(shell)).toEqual([a, b, c]);
    await expect.poll(() => selectedTabId(app)).toBe(b);
    await expect(sleepingRow(shell, b)).toHaveCount(0);
    // Empty again, the section closes by itself (the user never chose), and opened it says so.
    await expect(section(shell, 'sleeping')).toHaveAttribute('data-count', '0');
    await expect(section(shell, 'sleeping')).toHaveAttribute('data-expanded', 'false');
    await sectionToggle(shell, 'sleeping').click();
    await expect(section(shell, 'sleeping').locator('[data-empty]')).toHaveText(
      'Nothing is sleeping.',
    );
    expect(await sleepingTabStates(app)).toEqual([]);
  });
});

// ── 2. The Archive ──────────────────────────────────────────────────────────────────────────────

test.describe('the Archive section', () => {
  test('an archived tab is listed as Recently archived, counted for today, and a click restores it', async ({
    launcher,
    fixtureServer,
  }) => {
    const { app, shell, ids, urls } = await threePages(launcher, fixtureServer);
    const [a, b, c] = ids;
    await invokeTabMenuItem(app, a, 'archive');
    await expect
      .poll(async () => (await archivedTabs(app)).count, {
        timeout: SLOW_TIMEOUT_MS,
      })
      .toBe(1);
    await expect(summary(shell)).toHaveText('Sleeping 0 · Archived today 1');
    await expect(toastText(shell)).toHaveText('Archived');
    expect(await sidebarIds(shell)).toEqual([b, c]);

    // Closed until opened.
    await expect(section(shell, 'archive')).toHaveAttribute('data-expanded', 'false');
    await sectionToggle(shell, 'archive').click();
    await expect(section(shell, 'archive')).toHaveAttribute('data-expanded', 'true');
    await expect(archivedRow(shell, a)).toBeVisible();
    await expect(archivedRow(shell, a)).toContainText('Lifecycle plain');
    await expect(shell.locator(`li[data-archived-row="${a}"] [data-archived-meta]`)).toHaveText(
      /· by you$/,
    );
    await expect(section(shell, 'archive').locator('[data-archive-summary]')).toHaveText(
      'Archived today 1 · 1 in total',
    );

    // A click brings it back next to the selected tab (C), selected and loading its page.
    await archivedRow(shell, a).click();
    await expect.poll(() => sidebarIds(shell)).toEqual([b, c, a]);
    await expect.poll(() => selectedTabId(app)).toBe(a);
    await waitForLoaded(app, a);
    expect(await tabState(app, a)).toMatchObject({ url: urls[0], runtime: 'live' });
    await expect(archivedRow(shell, a)).toHaveCount(0);
    await expect(section(shell, 'archive').locator('[data-empty]')).toHaveText(
      'Nothing archived yet.',
    );
  });
});

// ── 3. Status and protection ────────────────────────────────────────────────────────────────────

test.describe('tab status', () => {
  test('the tooltip says why a tab is unloaded, plainly when it was memory pressure; a protected tab shows a shield', async ({
    launcher,
    fixtureServer,
  }) => {
    const { app, shell, ids } = await threePages(launcher, fixtureServer);
    const [a, b] = ids;
    const row = (tabId: TabId): Locator => tabElement(shell, tabId);

    // Protect A from the menu: the shield, and the tooltip says so.
    await invokeTabMenuItem(app, a, 'protect');
    await expect(row(a)).toHaveAttribute('data-user-protected', 'true');
    await expect(shell.locator(`[data-tab-id="${a}"] [data-protected-icon]`)).toHaveCount(1);
    await expect(row(a)).toHaveAttribute('title', /Protected from automation$/);
    expect(await menuLabels(app, a)).toContain('Stop protecting');

    // Critical memory pressure unloads B (hidden for 3 minutes on the lifecycle clock), and the
    // tooltip says plainly why; A stays, protected.
    await setMemoryPressure(app, 'critical');
    await advanceLifecycleClock(app, { wallMs: 3 * 60 * 1000 });
    await expect
      .poll(
        async () => {
          await lifecycleEvaluate(app);
          return (await tabState(app, b))?.runtime;
        },
        { timeout: 90_000, message: 'B should be unloaded under critical pressure' },
      )
      .toBe('unloaded');
    await setMemoryPressure(app, 'none');
    await expect(row(b)).toHaveAttribute('data-unloaded-by', 'pressure');
    await expect(row(b)).toHaveAttribute(
      'title',
      'Lifecycle plain\nUnloaded because memory was very low — click to reload',
    );
    expect(await tabState(app, a)).toMatchObject({ runtime: 'live', userProtected: true });

    // The activity log says the same, with the rule, newest first.
    await shell.locator('#activity-button').click();
    const entry = shell.locator(`li[data-activity-action="discard"]`).first();
    await expect(entry).toBeVisible({ timeout: SLOW_TIMEOUT_MS });
    await expect(entry).toHaveAttribute('data-activity-rule', 'pressure-discard');
    await expect(entry.locator('[data-activity-sentence]')).toHaveText(
      'Unloaded because memory was very low',
    );
    await expect(entry.locator('[data-activity-title]')).toHaveText('Lifecycle plain');
    // Escape closes it, and the tabs are back.
    await shell.keyboard.press('Escape');
    await expect(shell.locator('[data-activity-view]')).toHaveCount(0);
    await expect(row(a)).toBeVisible();

    // Selecting B loads it again: the reason goes with the unload.
    await row(b).click();
    await waitForLoaded(app, b);
    await expect(row(b)).not.toHaveAttribute('data-unloaded-by', /.*/);
  });
});
