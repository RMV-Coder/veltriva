// M5.1: Settings (`veltriva://settings`) and first-run onboarding (`veltriva://welcome`), drawn by
// the shell. What each spec checks is what main keeps: the stored settings document and site rules,
// read back through the data worker, never the page's own state. Main validates every change; the
// page only says why before asking, so the rejections are checked on both paths: the page's
// fields, and the commands sent straight to main.
import type { ElectronApplication, Page } from '@playwright/test';

import type { FixtureServer } from '../fixtures/server';
import { expect } from './expect';
import { archivedTabs, invokeTabMenuItem, selectedTabId, tabMenuItems, tabState } from './hooks';
import { closeApp, launchApp, shellPage } from './launch';
import { readMemory } from './memory-ui';
import type { PageGlobal } from './page-globals';
import { workspaceSnapshot } from './prompt-ui';
import { dataValue, test } from './session-ui';
import {
  internalPage,
  loadInNewTab,
  sidebarIds,
  tabElement,
  tabElements,
  typeAddress,
  waitForPage,
} from './shell-ui';
import type { TabId } from './hooks';

const DUCKDUCKGO = 'https://duckduckgo.com/?q={searchTerms}';
const GOOGLE = 'https://www.google.com/search?q={searchTerms}';

function settingsPage(shell: Page) {
  return internalPage(shell, 'settings');
}

function setting(shell: Page, name: string, value?: string) {
  return settingsPage(shell).locator(
    value === undefined ? `[data-setting="${name}"]` : `[data-setting="${name}"][value="${value}"]`,
  );
}

/** Opens Settings with the sidebar's button and waits for main's answer to show. */
async function openSettings(shell: Page): Promise<void> {
  await shell.locator('[data-settings-button]').click();
  await expect(settingsPage(shell)).toHaveAttribute('data-settings-state', 'ready');
}

/** The settings document as the database holds it (null before anything was written). */
async function stored(app: ElectronApplication): Promise<Record<string, unknown> | null> {
  return (await dataValue<{ value: Record<string, unknown> | null }>(app, 'settings.get', {}))
    .value;
}

/** The site rules as the database holds them. */
async function storedRules(app: ElectronApplication) {
  return (
    await dataValue<{ rules: { site: string; protect: boolean; excludeMemory: boolean }[] }>(
      app,
      'siteRules.list',
      { limit: 100 },
    )
  ).rules.map(({ site, protect, excludeMemory }) => ({ site, protect, excludeMemory }));
}

/** Sends a settings command straight to main, as any code in the shell could. */
function sendToMain(shell: Page, method: 'update' | 'setSiteRule', input: unknown) {
  return shell.evaluate(
    async ([name, payload]) => {
      const { veltriva } = globalThis as PageGlobal;
      return name === 'update'
        ? veltriva.settings.update(payload as never)
        : veltriva.settings.setSiteRule(payload as never);
    },
    [method, input] as const,
  );
}

/** A section of the stored document, or null. */
function section(
  document: Record<string, unknown> | null,
  name: 'search' | 'memory' | 'lifecycle',
): Record<string, unknown> | null {
  const value = document?.[name];
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

const lifecycleOf = (document: Record<string, unknown> | null) => section(document, 'lifecycle');

/** The id of the tab at this place in the sidebar. */
async function tabAt(shell: Page, index: number): Promise<TabId> {
  const id = (await sidebarIds(shell))[index];
  if (id === undefined) {
    throw new Error(`No tab at ${String(index)}`);
  }
  return id;
}

/** Selects a tab with a click, and waits until the shell shows it selected. */
async function showTab(shell: Page, tabId: TabId): Promise<void> {
  await tabElement(shell, tabId).click();
  await expect(tabElement(shell, tabId)).toHaveAttribute('aria-selected', 'true');
}

/** The selected tab's id. */
async function selected(app: ElectronApplication): Promise<TabId> {
  const id = await selectedTabId(app);
  if (id === null) {
    throw new Error('No tab is selected');
  }
  return id;
}

/** A page on the fixture server, on another site when `host` is given. */
const pageAt = (server: FixtureServer, path: string, host = '127.0.0.1'): string => {
  const url = new URL(server.url(path));
  url.hostname = host;
  return url.href;
};

test.describe('the settings page (M5.1)', () => {
  test('opens from the sidebar, and once: the button selects the Settings tab already open', async ({
    electronApp,
    shell,
  }) => {
    await openSettings(shell);
    const settingsTab = await selected(electronApp);
    await expect(tabElement(shell, settingsTab)).toContainText('Settings');
    const tabs = await sidebarIds(shell);

    // Again from another tab: the same tab is selected, and no other opens.
    await showTab(shell, await tabAt(shell, 0));
    await openSettings(shell);
    expect(await selectedTabId(electronApp)).toBe(settingsTab);
    expect(await sidebarIds(shell)).toEqual(tabs);

    // The address works too.
    await showTab(shell, await tabAt(shell, 0));
    await typeAddress(shell, 'veltriva://settings');
    await expect(settingsPage(shell)).toHaveAttribute('data-settings-state', 'ready');
  });

  test('a preset, the switches and an advanced value are applied and kept; a value refused changes nothing', async ({
    electronApp,
    shell,
  }) => {
    await openSettings(shell);
    await setting(shell, 'preset', 'gentle').check();
    await expect.poll(async () => lifecycleOf(await stored(electronApp))?.preset).toBe('gentle');

    await settingsPage(shell).locator('[data-settings-advanced] summary').click();
    // Gentle keeps 15 tabs.
    await expect(setting(shell, 'stripCap')).toHaveValue('15');

    // Out of range: said next to the field, and nothing is kept.
    await setting(shell, 'stripCap').fill('0');
    await setting(shell, 'stripCap').press('Enter');
    await expect(settingsPage(shell).locator('[data-settings-error="stripCap"]')).toHaveText(
      'Enter a whole number from 1 to 500 (tabs).',
    );
    await expect(setting(shell, 'stripCap')).toHaveAttribute('aria-invalid', 'true');
    expect(lifecycleOf(await stored(electronApp))?.overrides).toEqual({});

    await setting(shell, 'stripCap').fill('25');
    await setting(shell, 'stripCap').press('Enter');
    await expect
      .poll(async () => lifecycleOf(await stored(electronApp))?.overrides)
      .toEqual({ stripCap: 25 });
    await expect(settingsPage(shell).locator('[data-setting-reset="stripCap"]')).toBeVisible();

    // "Very low" at or above "low" (10%): refused before main is asked.
    await setting(shell, 'criticalPressurePercent').fill('12');
    await setting(shell, 'criticalPressurePercent').press('Enter');
    await expect(
      settingsPage(shell).locator('[data-settings-error="criticalPressurePercent"]'),
    ).toContainText('"Very low" must be below "low"');
    expect(lifecycleOf(await stored(electronApp))?.overrides).toEqual({ stripCap: 25 });

    // Reset goes back to the preset's value.
    await settingsPage(shell).locator('[data-setting-reset="stripCap"]').click();
    await expect.poll(async () => lifecycleOf(await stored(electronApp))?.overrides).toEqual({});
    await expect(setting(shell, 'stripCap')).toHaveValue('15');

    await setting(shell, 'auto-archive').uncheck();
    await expect.poll(async () => lifecycleOf(await stored(electronApp))?.autoArchive).toBe(false);

    // Pause automation here is the sidebar's switch too.
    await setting(shell, 'automation-paused').check();
    await expect.poll(async () => (await workspaceSnapshot(shell)).automation.paused).toBe(true);
    await expect(shell.locator('[data-automation-status]')).toHaveAttribute(
      'data-automation-paused',
      'true',
    );
  });

  test('main rejects an invalid change sent straight to it, whole, and keeps the document as it was', async ({
    electronApp,
    shell,
  }) => {
    const invalid = { ok: false, code: 'invalid_input' };
    for (const change of [
      // Out of its range.
      { lifecycle: { overrides: { stripCap: 0 } } },
      // Valid alone, but it would make critical pressure not below moderate.
      { lifecycle: { overrides: { criticalPressurePercent: 10 } } },
      // Valid parts and an invalid one: nothing of it is kept.
      { startup: 'new-tab', lifecycle: { overrides: { moderatePressurePercent: 3 } } },
      // Plain http to another host, and no {searchTerms}.
      { search: { template: 'http://search.example/?q={searchTerms}' } },
      { search: { template: 'https://search.example/?q=' } },
      // A field main doesn't know, and the M3.4 list that lives in site_rules now.
      { theme: 'dark' },
      { lifecycle: { protectedSites: ['example.com'] } },
    ]) {
      expect(await sendToMain(shell, 'update', change), JSON.stringify(change)).toEqual(invalid);
    }
    expect(await sendToMain(shell, 'setSiteRule', { site: 'not a site', protect: true })).toEqual(
      invalid,
    );
    expect(await sendToMain(shell, 'setSiteRule', { site: 'mailto:me@example.com' })).toEqual(
      invalid,
    );

    // Nothing was written.
    expect(await stored(electronApp)).toBeNull();
    expect(await storedRules(electronApp)).toEqual([]);

    // And a valid change still works.
    const answer = await sendToMain(shell, 'update', { startup: 'new-tab' });
    expect(answer).toMatchObject({ ok: true, value: { settings: { startup: 'new-tab' } } });
    await expect.poll(async () => (await stored(electronApp))?.startup).toBe('new-tab');
  });

  test('a custom search engine is checked, kept and used by the address bar; a named one replaces it', async ({
    electronApp,
    shell,
    fixtureServer,
  }) => {
    await openSettings(shell);
    await expect(setting(shell, 'engine', 'duckduckgo')).toBeChecked();
    await setting(shell, 'engine', 'custom').check();

    await setting(shell, 'custom-template').fill('http://search.example/?q={searchTerms}');
    await setting(shell, 'use-custom').click();
    await expect(settingsPage(shell).locator('[data-settings-error="template"]')).toContainText(
      "Veltriva can't search with that address",
    );
    expect(await stored(electronApp)).toBeNull();

    const template = fixtureServer.url('/search?q={searchTerms}');
    await setting(shell, 'custom-template').fill(template);
    await setting(shell, 'use-custom').click();
    await expect
      .poll(async () => section(await stored(electronApp), 'search')?.template)
      .toBe(template);

    const before = fixtureServer.pathHits('/search');
    const tab = await loadInNewTab(electronApp, shell, 'settings search');
    await waitForPage(electronApp, tab, { title: 'Search results for: settings search' });
    expect(fixtureServer.pathHits('/search')).toBe(before + 1);

    await showTab(shell, await tabAt(shell, 1));
    await expect(settingsPage(shell)).toHaveAttribute('data-settings-state', 'ready');
    await setting(shell, 'engine', 'google').check();
    await expect
      .poll(async () => section(await stored(electronApp), 'search')?.template)
      .toBe(GOOGLE);
    await setting(shell, 'engine', 'duckduckgo').check();
    await expect
      .poll(async () => section(await stored(electronApp), 'search')?.template)
      .toBe(DUCKDUCKGO);
  });

  test('Pause memory: no page is remembered while it is on, and pages are again once it is off', async ({
    electronApp,
    shell,
    fixtureServer,
  }) => {
    await openSettings(shell);
    await setting(shell, 'memory-paused').check();
    await expect.poll(async () => section(await stored(electronApp), 'memory')?.paused).toBe(true);

    const paused = fixtureServer.url('/page-a.html?case=memory-paused');
    await loadInNewTab(electronApp, shell, paused);

    await showTab(shell, await tabAt(shell, 1));
    await setting(shell, 'memory-paused').uncheck();
    await expect.poll(async () => section(await stored(electronApp), 'memory')?.paused).toBe(false);
    const resumed = fixtureServer.url('/page-b.html?case=memory-resumed');
    await loadInNewTab(electronApp, shell, resumed);

    // Visits are written in order: once the later page is there, the earlier one never will be.
    await expect
      .poll(async () => (await readMemory(electronApp)).pages.map((page) => page.url))
      .toContain(resumed);
    expect((await readMemory(electronApp)).pages.map((page) => page.url)).not.toContain(paused);
  });

  test('site rules: an excluded site is never remembered, its tab not archived nor kept when closed; rules come from Settings and the tab menu', async ({
    electronApp,
    shell,
    fixtureServer,
  }) => {
    await openSettings(shell);
    const settingsTab = await selected(electronApp);

    // What the field refuses, said there.
    await setting(shell, 'site').fill('not a site');
    await setting(shell, 'add-site').click();
    await expect(settingsPage(shell).locator('[data-settings-error="site"]')).toContainText(
      "That isn't a site Veltriva can name",
    );

    // An address names its site: 127.0.0.1, not remembered (and not protected).
    await setting(shell, 'site').fill(fixtureServer.url('/page-a.html'));
    await setting(shell, 'site-protect').uncheck();
    await setting(shell, 'site-exclude').check();
    await setting(shell, 'add-site').click();
    const row = settingsPage(shell).locator('[data-site-rule="127.0.0.1"]');
    await expect(row.locator('[data-site-rule-field="exclude"]')).toBeChecked();
    await expect(row.locator('[data-site-rule-field="protect"]')).not.toBeChecked();
    await expect
      .poll(() => storedRules(electronApp))
      .toEqual([{ site: '127.0.0.1', protect: false, excludeMemory: true }]);

    const excluded = await loadInNewTab(
      electronApp,
      shell,
      fixtureServer.url('/page-a.html?case=excluded'),
    );
    // Its tab is kept out of the Archive, and the "why" says so.
    await expect
      .poll(async () => {
        const tab = (await workspaceSnapshot(shell)).tabs.find((entry) => entry.id === excluded);
        return tab?.keptAwake;
      })
      .toContain('excluded-site');
    const labels = (await tabMenuItems(electronApp, excluded)).flatMap((entry) =>
      entry.type === 'item' ? [entry.label] : [],
    );
    expect(labels).toContain('Remember 127.0.0.1 again');

    // Another site is remembered; once it is, the excluded page never will be.
    const other = pageAt(fixtureServer, '/page-b.html?case=other-site', 'localhost');
    const otherTab = await loadInNewTab(electronApp, shell, other);
    await expect
      .poll(async () => (await readMemory(electronApp)).pages.map((page) => page.url))
      .toContain(other);
    expect(
      (await readMemory(electronApp)).pages.filter((page) => page.site === '127.0.0.1'),
    ).toEqual([]);

    // Closing its tab keeps no record: nothing to reopen.
    await invokeTabMenuItem(electronApp, excluded, 'close');
    await expect.poll(() => sidebarIds(shell)).not.toContain(excluded);
    expect(
      (await tabMenuItems(electronApp, otherTab)).some(
        (entry) => entry.type === 'item' && entry.id === 'reopen-closed' && entry.enabled,
      ),
    ).toBe(false);

    // From the tab menu: protect localhost. Settings lists it when its tab is shown again.
    await invokeTabMenuItem(electronApp, otherTab, 'protect-site');
    await expect
      .poll(() => storedRules(electronApp))
      .toEqual([
        { site: '127.0.0.1', protect: false, excludeMemory: true },
        { site: 'localhost', protect: true, excludeMemory: false },
      ]);
    await showTab(shell, settingsTab);
    await expect(
      settingsPage(shell).locator('[data-site-rule="localhost"] [data-site-rule-field="protect"]'),
    ).toBeChecked();

    // Remove takes both rules of a site away.
    await settingsPage(shell)
      .locator('[data-site-rule="127.0.0.1"] [data-site-rule-remove]')
      .click();
    await expect(settingsPage(shell).locator('[data-site-rule="127.0.0.1"]')).toHaveCount(0);
    await expect
      .poll(() => storedRules(electronApp))
      .toEqual([{ site: 'localhost', protect: true, excludeMemory: false }]);
  });

  test('"Start with a new tab": the tabs that were open go to the Archive, a pinned one stays, a new tab is selected', async ({
    launcher,
    fixtureServer,
  }) => {
    const first = await launcher.launch();
    const pinned = await loadInNewTab(
      first.app,
      first.shell,
      fixtureServer.url('/page-a.html?case=startup-pinned'),
    );
    await invokeTabMenuItem(first.app, pinned, 'pin');
    const b = fixtureServer.url('/page-b.html?case=startup-b');
    const c = fixtureServer.url('/page-c.html?case=startup-c');
    await loadInNewTab(first.app, first.shell, b);
    await loadInNewTab(first.app, first.shell, c);
    await openSettings(first.shell);
    await setting(first.shell, 'startup', 'new-tab').check();
    await expect.poll(async () => (await stored(first.app))?.startup).toBe('new-tab');
    await launcher.quit(first);

    const second = await launcher.launch();
    const ids = await sidebarIds(second.shell);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(pinned);
    expect(await selectedTabId(second.app)).toBe(ids[1]);
    await expect(internalPage(second.shell, 'new-tab')).toBeVisible();
    // The pinned tab came back unloaded, as a restored tab does.
    expect(await tabState(second.app, pinned)).toMatchObject({ runtime: 'unloaded' });
    await expect
      .poll(async () => (await archivedTabs(second.app)).entries.map((entry) => entry.url))
      .toEqual(expect.arrayContaining([b, c]));
  });
});

test.describe('first-run onboarding (M5.1)', () => {
  test('a new profile opens Welcome; its choices are kept, and Start browsing opens the new-tab page', async ({
    userDataDir,
  }) => {
    const firstRun = { env: { VELTRIVA_TEST_FIRST_RUN: '1' } };
    const app = await launchApp(userDataDir, firstRun);
    try {
      const shell = await shellPage(app);
      const welcome = internalPage(shell, 'welcome');
      await expect(welcome).toBeVisible();
      await expect(tabElements(shell)).toHaveCount(1);
      // DuckDuckGo, Balanced and "Show me first" are what nothing chosen means.
      await expect(welcome.locator('[data-welcome="engine"][value="duckduckgo"]')).toBeChecked();
      await expect(welcome.locator('[data-welcome="preset"][value="balanced"]')).toBeChecked();
      await expect(welcome.locator('[data-welcome="preview"][value="auto"]')).toBeChecked();

      await welcome.locator('[data-welcome="engine"][value="google"]').check();
      await welcome.locator('[data-welcome="preset"][value="gentle"]').check();
      await welcome.locator('[data-welcome="preview"][value="off"]').check();
      await welcome.locator('[data-welcome="start"]').click();

      await expect(internalPage(shell, 'new-tab')).toBeVisible();
      await expect
        .poll(async () => {
          const document = await stored(app);
          return {
            template: section(document, 'search')?.template,
            preset: lifecycleOf(document)?.preset,
            preview: lifecycleOf(document)?.preview,
          };
        })
        .toEqual({ template: GOOGLE, preset: 'gentle', preview: 'off' });
    } finally {
      await closeApp(app);
    }

    // Not a first run any more: the session comes back, and Welcome doesn't.
    const again = await launchApp(userDataDir, firstRun);
    try {
      const shell = await shellPage(again);
      await expect(internalPage(shell, 'new-tab')).toBeVisible();
      await expect(internalPage(shell, 'welcome')).toHaveCount(0);
    } finally {
      await closeApp(again);
    }
  });

  test('without the first-run flag a test build starts on the new-tab page, as every other spec expects', async ({
    shell,
  }) => {
    await expect(internalPage(shell, 'new-tab')).toBeVisible();
    await expect(internalPage(shell, 'welcome')).toHaveCount(0);
  });
});
