// The memory's shell, M4.2 (assessment §5.4, §7.3, §7.4; ADR-0006 A′): the palette (Ctrl+Shift+K),
// the address bar's suggestions with "Switch to tab", and the virtual Archive list. The search
// itself is main's and is tested elsewhere (search-golden, data-worker); these specs drive the
// shell as a user does and look at what main did.
//
// Rules from ADR-0008 item 4 that matter here:
//  - A browser shortcut (Ctrl+Shift+K, Ctrl+L, Ctrl+Enter) is `sendKey` from main: Playwright's
//    keyboard goes through CDP and never reaches main's `before-input-event`. Typing text into a
//    field is Playwright's.
//  - What a page underneath does while the shell is raised is read from main (`evaluateInTab`),
//    never through a Playwright Page, whose focus emulation would hide a throttled page.
//  - The memory is written behind the page (a title only once it has been stable for 2 s, a tab
//    row up to 1 s after a change), so a spec waits for the database before it searches.
import { randomBytes } from 'node:crypto';

import type { ElectronApplication, Locator, Page } from '@playwright/test';

import { uuidv7 } from '../../src/core/id/uuidv7';
import type { TabRow } from '../../src/shared/contracts/data-rpc';
import type { FixtureServer } from '../fixtures/server';
import { expect } from './expect';
import {
  clearNetworkRequests,
  evaluateInTab,
  focusedWebContents,
  networkRequests,
  selectedTabId,
  sendKey,
  tabState,
  tabStates,
  viewStack,
} from './hooks';
import type { TabId } from './hooks';
import { observeFor } from './launch';
import { storedTitle } from './memory-ui';
import type { PageGlobal } from './page-globals';
import { archiveTab, readSavedPlacement, shelveTab } from './placement-ui';
import { WORKSPACE_CANDIDATE, dataValue, readSavedSession, test } from './session-ui';
import {
  SLOW_TIMEOUT_MS,
  archiveRows,
  archiveScroller,
  loadTab,
  omnibox,
  palette,
  paletteFilter,
  paletteInput,
  paletteOptions,
  searchMemoryButton,
  sidebarIds,
  sidebarTabs,
  suggestionList,
  suggestionOptions,
  waitForPage,
} from './shell-ui';
import type { LoadedTab } from './shell-ui';

// Archiving a live tab discards it first (seconds here), and some specs start the app twice.
test.describe.configure({ timeout: 180_000 });

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────

/** A page of the memory fixture (tests/fixtures/memory-routes.ts) with this title. */
function pageUrl(server: FixtureServer, title: string, site: 'main' | 'other' = 'main'): string {
  const path = `/memory/page?title=${encodeURIComponent(title)}`;
  return site === 'main' ? server.url(path) : server.otherSiteUrl(path);
}

/**
 * Loads the page in a new tab and waits until the memory holds its title: the title is written
 * once it has been stable for 2 s, and a search for its words finds nothing before that.
 */
async function rememberedTab(
  app: ElectronApplication,
  shell: Page,
  url: string,
  title: string,
): Promise<LoadedTab> {
  const tab = await loadTab(app, shell, url);
  await expect
    .poll(() => storedTitle(app, url), {
      message: `the memory should hold the title of ${url}`,
      timeout: SLOW_TIMEOUT_MS,
    })
    .toBe(title);
  return tab;
}

type Placement = 'strip' | 'shelf' | 'archive';

/** Waits until the database holds each tab where it should be, linked to its page (searchable). */
async function waitUntilSaved(
  app: ElectronApplication,
  expected: Readonly<Record<TabId, Placement>>,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const [session, placement] = await Promise.all([
          readSavedSession(app),
          readSavedPlacement(app),
        ]);
        const rows = [...session.strip, ...placement.shelf, ...placement.archived];
        return Object.fromEntries(
          Object.keys(expected).map((id) => {
            const row = rows.find((candidate) => candidate.id === id);
            return [id, row !== undefined && row.pageId !== null ? row.placement : null];
          }),
        );
      },
      { message: 'the database should hold the tabs where they are', timeout: SLOW_TIMEOUT_MS },
    )
    .toEqual(expected);
}

/**
 * Ctrl+Shift+K in whichever web contents has the keyboard (the shell, when none has: after the
 * selected tab went to the Archive, nothing was focused), then waits for the palette.
 */
async function openPalette(app: ElectronApplication, shell: Page): Promise<void> {
  const focused = await focusedWebContents(app);
  await sendKey(app, focused === null ? 'shell' : 'focused', 'K', ['control', 'shift']);
  await expect(palette(shell)).toBeVisible();
  await expect(paletteInput(shell)).toBeFocused();
  // Main raised the shell once the palette had painted (the handshake): the shell is on top.
  await expectShellRaised(app, true);
}

/** Whether the shell is the top view of the window, above the selected tab's page. */
async function expectShellRaised(app: ElectronApplication, raised: boolean): Promise<void> {
  await expect
    .poll(async () => (await viewStack(app)).at(-1) === 'shell', {
      message: raised ? 'the shell should be above the page' : 'the page should be above the shell',
      timeout: SLOW_TIMEOUT_MS,
    })
    .toBe(raised);
}

/** Types `text` into the palette's field, one key at a time, as a user does. */
async function typeInPalette(shell: Page, text: string): Promise<void> {
  await paletteInput(shell).pressSequentially(text);
}

/** The page's own visibility, read from main (a Playwright Page would fake it). */
async function visibility(app: ElectronApplication, tab: LoadedTab): Promise<unknown> {
  return evaluateInTab(app, tab.webContentsId, 'document.visibilityState');
}

// ── 1. Archive, search, restore ─────────────────────────────────────────────────────────────────

test.describe('the memory palette', () => {
  test('a tab the user archived is found by a few partial words of its title, and Enter brings it back', async ({
    launcher,
    fixtureServer,
  }) => {
    const { app, shell } = await launcher.launch();
    const title = 'Zanzibar lighthouse maintenance handbook';
    const url = pageUrl(fixtureServer, title);
    const tab = await rememberedTab(app, shell, url, title);

    // The user archives the tab: it leaves the strip and the page is unloaded.
    expect(await archiveTab(shell, tab.tabId)).toBe(true);
    await expect.poll(() => sidebarIds(shell)).not.toContain(tab.tabId);
    await waitUntilSaved(app, { [tab.tabId]: 'archive' });

    // Ctrl+Shift+K: main hands the shell the keyboard, and the palette opens on it.
    await openPalette(app, shell);
    expect((await focusedWebContents(app))?.isShell).toBe(true);
    // Empty, the field lists the recent and frequent pages: this one is among them.
    await expect(paletteOptions(shell).filter({ hasText: title })).toHaveCount(1);

    // A few partial words of the title. The result is the archived tab, with the typed parts marked.
    await typeInPalette(shell, 'zanz light');
    const option = paletteOptions(shell).filter({ hasText: title });
    await expect(paletteOptions(shell)).toHaveCount(1);
    await expect(option).toHaveAttribute('aria-selected', 'true');
    await expect(option.locator('[data-state-badge]')).toHaveText('Archived');
    await expect(option.locator('mark')).toHaveText(['Zanz', 'light']);
    await expect(option.locator('[data-result-site]')).toHaveText('127.0.0.1');
    await expect(option.locator('[data-result-visited]')).toHaveText(
      /^visited (just now|\d+ \w+ ago)$/,
    );
    // The combobox points at the option and says the list is open.
    await expect(paletteInput(shell)).toHaveAttribute('aria-expanded', 'true');
    await expect(paletteInput(shell)).toHaveAttribute(
      'aria-activedescendant',
      (await option.getAttribute('id')) ?? 'missing',
    );

    // The debug view (assessment §5.4): the five weighted terms and the score, two decimals.
    // Alt+S shows it (Alt+D is main's: it focuses the address bar) and the button does too.
    const breakdown = palette(shell).locator('[data-score-breakdown]');
    const scoreToggle = palette(shell).locator('[data-debug-toggle]');
    await expect(breakdown).toHaveCount(0);
    await expect(scoreToggle).toHaveAttribute('aria-pressed', 'false');
    await sendKey(app, 'focused', 'S', ['alt']);
    await expect(breakdown).toBeVisible();
    await expect(scoreToggle).toHaveAttribute('aria-pressed', 'true');
    await expect(paletteInput(shell)).toBeFocused();
    for (const term of ['text', 'frecency', 'titleExact', 'siteMatch', 'state', 'score']) {
      await expect(breakdown.locator(`[data-term="${term}"]`)).toHaveText(/^-?\d+\.\d{2}$/);
    }
    // An archived page earns the Archived boost (+0.20); it has no site match for these words.
    await expect(breakdown.locator('[data-term="state"]')).toHaveText('0.20');
    await sendKey(app, 'focused', 'S', ['alt']);
    await expect(breakdown).toHaveCount(0);
    await scoreToggle.click();
    await expect(breakdown).toBeVisible();
    await scoreToggle.click();
    await expect(breakdown).toHaveCount(0);
    await expect(scoreToggle).toHaveAttribute('aria-pressed', 'false');

    // Enter: the tab is back in the strip, selected, on that page; the palette is gone.
    await sendKey(app, 'focused', 'Enter');
    await expect(palette(shell)).toHaveCount(0);
    await expect
      .poll(
        async () => {
          const id = await selectedTabId(app);
          const state = id === null ? undefined : await tabState(app, id);
          return state === undefined ? null : { placement: state.placement, url: state.url };
        },
        { message: 'the restored tab should be selected, on the page', timeout: SLOW_TIMEOUT_MS },
      )
      .toEqual({ placement: 'strip', url });
    await expect
      .poll(async () => (await sidebarTabs(shell)).find((entry) => entry.selected)?.label)
      .toBe(title);
    // The lowered shell, the transparent document made opaque again, and the page has the keyboard.
    await expectShellRaised(app, false);
    await expect(shell.locator('html[data-overlay]')).toHaveCount(0);
    await expect
      .poll(async () => (await focusedWebContents(app))?.isShell, {
        message: 'main should have focused the restored page',
        timeout: SLOW_TIMEOUT_MS,
      })
      .toBe(false);
  });

  test('a raised palette leaves the page visible and live; Esc closes it and the page has the keyboard again', async ({
    launcher,
    fixtureServer,
  }) => {
    const { app, shell } = await launcher.launch();
    const tab = await loadTab(app, shell, fixtureServer.url('/lifecycle-plain.html?case=palette'));
    const other = await loadTab(app, shell, fixtureServer.url('/page-b.html?case=palette'));

    // The click on "Search memory…" in the sidebar opens it as well.
    await searchMemoryButton(shell).click();
    await expect(palette(shell)).toBeVisible();
    await expect(paletteInput(shell)).toBeFocused();
    await expectShellRaised(app, true);
    await expect(shell.locator('html[data-overlay~="palette"]')).toHaveCount(1);
    await expect(shell.locator('html')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(shell.locator('body')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(shell.locator('#content-area')).toBeVisible();
    // The toolbar and the sidebar still paint their own backgrounds.
    await expect(shell.locator('header')).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(shell.locator('aside')).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');

    // The selected page is under the raised shell, and it is neither hidden nor throttled: ten
    // 100 ms timers fire in about a second (a throttled page fires them once a second).
    expect(await visibility(app, other)).toBe('visible');
    const elapsed = await evaluateInTab(
      app,
      other.webContentsId,
      `new Promise((resolve) => {
        const start = performance.now();
        let ticks = 0;
        const timer = setInterval(() => {
          ticks += 1;
          if (ticks === 10) {
            clearInterval(timer);
            resolve(performance.now() - start);
          }
        }, 100);
      })`,
    );
    expect(elapsed).toBeLessThan(3_000);

    // Empty field: the recent-and-frequent list, which holds the pages visited so far. A search
    // that finds nothing says so.
    await expect(paletteOptions(shell).first()).toBeVisible();
    await typeInPalette(shell, 'qqqxzv');
    await expect(paletteOptions(shell)).toHaveCount(0);
    await expect(palette(shell).locator('[data-palette-empty]')).toHaveText('No pages match');
    await expect(paletteInput(shell)).toHaveAttribute('aria-expanded', 'false');

    // A tab switch while it is open does not close it.
    await shell.evaluate(
      (id) => (globalThis as PageGlobal).veltriva.tabs.select({ tabId: id }),
      tab.tabId,
    );
    await expect.poll(() => selectedTabId(app)).toBe(tab.tabId);
    await expect(palette(shell)).toBeVisible();
    expect(await visibility(app, tab)).toBe('visible');
    // Main gave the new tab's page the keyboard as it selected it; the palette took it back.
    await expect
      .poll(async () => (await focusedWebContents(app))?.isShell, {
        message: 'the shell should have the keyboard again',
      })
      .toBe(true);
    await expect(paletteInput(shell)).toBeFocused();
    await expectShellRaised(app, true);

    // Esc: the palette closes, the shell goes back under the page, and the page has the keyboard.
    await sendKey(app, 'focused', 'Escape');
    await expect(palette(shell)).toHaveCount(0);
    await expectShellRaised(app, false);
    await expect(shell.locator('html[data-overlay]')).toHaveCount(0);
    await expect
      .poll(async () => {
        const focused = await focusedWebContents(app);
        return focused?.webContentsId;
      })
      .toBe(tab.webContentsId);
    expect(await visibility(app, tab)).toBe('visible');
  });

  test('the palette says so when there is nothing to remember, and a press on the scrim closes it', async ({
    launcher,
  }) => {
    const { app, shell } = await launcher.launch();
    await openPalette(app, shell);
    await expect(palette(shell).locator('[data-palette-empty]')).toHaveText(
      'Nothing remembered yet',
    );
    await expect(palette(shell).getByRole('status')).toHaveText('Nothing remembered yet');

    // A press outside the panel, on the scrim, dismisses it.
    await shell.mouse.click(5, 5);
    await expect(palette(shell)).toHaveCount(0);
    await expect(shell.locator('html[data-overlay]')).toHaveCount(0);
  });

  test('Tab steps the filters, a site: word shows a chip that removes it, and Ctrl+Enter opens a new tab', async ({
    launcher,
    fixtureServer,
  }) => {
    const { app, shell } = await launcher.launch();
    const open = await rememberedTab(
      app,
      shell,
      pageUrl(fixtureServer, 'Quokka alpha open guide'),
      'Quokka alpha open guide',
    );
    const sleeping = await rememberedTab(
      app,
      shell,
      pageUrl(fixtureServer, 'Quokka beta sleeping guide'),
      'Quokka beta sleeping guide',
    );
    const archived = await rememberedTab(
      app,
      shell,
      pageUrl(fixtureServer, 'Quokka gamma archived guide'),
      'Quokka gamma archived guide',
    );
    const elsewhere = await rememberedTab(
      app,
      shell,
      pageUrl(fixtureServer, 'Quokka delta other site guide', 'other'),
      'Quokka delta other site guide',
    );
    expect(await shelveTab(shell, sleeping.tabId)).toBe(true);
    expect(await archiveTab(shell, archived.tabId)).toBe(true);
    await waitUntilSaved(app, {
      [open.tabId]: 'strip',
      [sleeping.tabId]: 'shelf',
      [archived.tabId]: 'archive',
      [elsewhere.tabId]: 'strip',
    });

    await openPalette(app, shell);
    await typeInPalette(shell, 'quokka');
    await expect(paletteOptions(shell)).toHaveCount(4);
    // The filters are a labelled radio group, with "All" on.
    const group = palette(shell).getByRole('radiogroup');
    await expect(group.getByRole('radio')).toHaveText([
      'All',
      'Open',
      'Sleeping',
      'Archived',
      'Today',
      'This week',
    ]);
    await expect(paletteFilter(shell, 'All')).toHaveAttribute('aria-checked', 'true');

    // Tab steps through them while the field keeps the focus.
    const badges = (): Locator => paletteOptions(shell).locator('[data-state-badge]');
    await sendKey(app, 'focused', 'Tab');
    await expect(paletteFilter(shell, 'Open')).toHaveAttribute('aria-checked', 'true');
    await expect(paletteFilter(shell, 'All')).toHaveAttribute('aria-checked', 'false');
    await expect(paletteOptions(shell)).toHaveCount(2);
    await expect(badges()).toHaveText(['Open', 'Open']);
    await expect(paletteInput(shell)).toBeFocused();

    await sendKey(app, 'focused', 'Tab');
    await expect(paletteFilter(shell, 'Sleeping')).toHaveAttribute('aria-checked', 'true');
    await expect(paletteOptions(shell)).toHaveCount(1);
    await expect(badges()).toHaveText(['Sleeping']);

    await sendKey(app, 'focused', 'Tab');
    await expect(paletteFilter(shell, 'Archived')).toHaveAttribute('aria-checked', 'true');
    await expect(paletteOptions(shell)).toHaveCount(1);
    await expect(badges()).toHaveText(['Archived']);
    await expect(paletteOptions(shell).first()).toContainText('Quokka gamma archived guide');

    // Shift+Tab goes back; a click on a filter sets it (and the field keeps the keyboard).
    await sendKey(app, 'focused', 'Tab', ['shift']);
    await expect(paletteFilter(shell, 'Sleeping')).toHaveAttribute('aria-checked', 'true');
    await paletteFilter(shell, 'This week').click();
    await expect(paletteFilter(shell, 'This week')).toHaveAttribute('aria-checked', 'true');
    await expect(paletteOptions(shell)).toHaveCount(4);
    await expect(paletteInput(shell)).toBeFocused();
    // Past the last filter Tab wraps to the first.
    await sendKey(app, 'focused', 'Tab');
    await expect(paletteFilter(shell, 'All')).toHaveAttribute('aria-checked', 'true');

    // A site: word keeps the results on that site and shows a chip.
    await paletteInput(shell).fill('quokka site:localhost');
    const chip = palette(shell).locator('[data-site-chip]');
    await expect(chip).toHaveText('site: localhost');
    await expect(chip).toHaveAccessibleName('Remove the site filter localhost');
    await expect(paletteOptions(shell)).toHaveCount(1);
    await expect(paletteOptions(shell).first()).toContainText('Quokka delta other site guide');
    // Removing the chip removes the word from the query, and the other pages come back.
    await chip.click();
    await expect(paletteInput(shell)).toHaveValue('quokka');
    await expect(chip).toHaveCount(0);
    await expect(paletteOptions(shell)).toHaveCount(4);

    // Ctrl+Enter opens the active result in a new tab, whatever tab shows it.
    await paletteInput(shell).fill('quokka alpha');
    await expect(paletteOptions(shell)).toHaveCount(1);
    const before = await sidebarIds(shell);
    await sendKey(app, 'focused', 'Enter', ['control']);
    await expect(palette(shell)).toHaveCount(0);
    await expect.poll(async () => (await sidebarIds(shell)).length).toBe(before.length + 1);
    const created = (await sidebarIds(shell)).find((id) => !before.includes(id));
    expect(created).toBeDefined();
    expect(created).not.toBe(open.tabId);
    await expect.poll(() => selectedTabId(app)).toBe(created);
    await expect
      .poll(async () => (created === undefined ? '' : ((await tabState(app, created))?.url ?? '')))
      .toBe(pageUrl(fixtureServer, 'Quokka alpha open guide'));
    // The tab that already showed the page is still there.
    expect(await sidebarIds(shell)).toContain(open.tabId);
  });
});

// ── 2. The address bar's suggestions ────────────────────────────────────────────────────────────

test.describe('the address bar suggestions', () => {
  test('"Switch to tab" selects the tab that shows the page instead of loading it again', async ({
    launcher,
    fixtureServer,
  }) => {
    const { app, shell } = await launcher.launch();
    const title = 'Narwhal tusk anatomy guide';
    const url = pageUrl(fixtureServer, title);
    const narwhal = await rememberedTab(app, shell, url, title);
    const walrus = await rememberedTab(
      app,
      shell,
      pageUrl(fixtureServer, 'Walrus tusk comparison'),
      'Walrus tusk comparison',
    );
    await waitUntilSaved(app, { [narwhal.tabId]: 'strip', [walrus.tabId]: 'strip' });
    expect(await selectedTabId(app)).toBe(walrus.tabId);
    const loadsOfThePage = fixtureServer.hits(new URL(url).pathname + new URL(url).search);
    const tabsBefore = await sidebarIds(shell);

    await sendKey(app, 'focused', 'L', ['control']);
    await expect(omnibox(shell)).toBeFocused();
    await omnibox(shell).pressSequentially('narwhal tusk');

    // The suggestion names the page, marks the typed words and offers to switch to its tab.
    await expect(suggestionOptions(shell)).toHaveCount(1);
    const suggestion = suggestionOptions(shell).first();
    await expect(suggestion).toContainText(title);
    await expect(suggestion.locator('mark')).toHaveText(['Narwhal', 'tusk']);
    await expect(suggestion.locator('[data-switch-to-tab]')).toHaveText('Switch to tab');
    await expect(omnibox(shell)).toHaveAttribute('aria-expanded', 'true');
    // While it shows, the shell is above the page, and the selected page is still visible.
    await expectShellRaised(app, true);
    await expect(shell.locator('html[data-overlay~="suggestions"]')).toHaveCount(1);
    expect(await visibility(app, walrus)).toBe('visible');

    // Nothing is selected until the user presses Down; then Enter opens that suggestion.
    await expect(suggestion).toHaveAttribute('aria-selected', 'false');
    await omnibox(shell).press('ArrowDown');
    await expect(suggestion).toHaveAttribute('aria-selected', 'true');
    await expect(omnibox(shell)).toHaveAttribute(
      'aria-activedescendant',
      (await suggestion.getAttribute('id')) ?? 'missing',
    );
    await omnibox(shell).press('Enter');

    await expect.poll(() => selectedTabId(app)).toBe(narwhal.tabId);
    await expect(suggestionList(shell)).toHaveCount(0);
    await expectShellRaised(app, false);
    await expect(shell.locator('html[data-overlay]')).toHaveCount(0);
    // The existing tab was selected: nothing was loaded, and no tab was added.
    expect(fixtureServer.hits(new URL(url).pathname + new URL(url).search)).toBe(loadsOfThePage);
    expect(await sidebarIds(shell)).toEqual(tabsBefore);
    await expect(omnibox(shell)).toHaveValue(url);
  });

  test('a suggestion for a page no tab shows loads it in the current tab', async ({
    launcher,
    fixtureServer,
  }) => {
    const { app, shell } = await launcher.launch();
    const title = 'Axolotl regeneration notes';
    const url = pageUrl(fixtureServer, title);
    const first = await rememberedTab(app, shell, url, title);
    const second = await rememberedTab(
      app,
      shell,
      pageUrl(fixtureServer, 'Capybara habitat notes'),
      'Capybara habitat notes',
    );
    // The page's tab goes to the Archive: no strip tab shows it any more.
    expect(await archiveTab(shell, first.tabId)).toBe(true);
    await waitUntilSaved(app, { [first.tabId]: 'archive', [second.tabId]: 'strip' });

    await sendKey(app, 'focused', 'L', ['control']);
    await omnibox(shell).pressSequentially('axolotl');
    await expect(suggestionOptions(shell)).toHaveCount(1);
    // The answer to the whole word, not to a shorter one still on screen: it marks the word whole.
    await expect(suggestionOptions(shell).first().locator('mark')).toHaveText(['Axolotl']);
    await expect(suggestionOptions(shell).first().locator('[data-switch-to-tab]')).toHaveCount(0);
    await omnibox(shell).press('ArrowDown');
    await omnibox(shell).press('Enter');

    // The selected tab goes there, as if the address were typed; no tab is added or restored.
    await waitForPage(app, second.tabId, { url, title });
    expect(await selectedTabId(app)).toBe(second.tabId);
    await expect(suggestionList(shell)).toHaveCount(0);
    expect((await tabStates(app)).filter((tab) => tab.url === url)).toHaveLength(1);
  });

  test('Escape closes the list and keeps the text; a second Escape reverts the field', async ({
    launcher,
    fixtureServer,
  }) => {
    const { app, shell } = await launcher.launch();
    const title = 'Pangolin scale structure';
    const remembered = await rememberedTab(app, shell, pageUrl(fixtureServer, title), title);
    const current = await rememberedTab(
      app,
      shell,
      fixtureServer.url('/page-a.html?case=escape'),
      'Page A',
    );
    await waitUntilSaved(app, { [remembered.tabId]: 'strip', [current.tabId]: 'strip' });
    const address = fixtureServer.url('/page-a.html?case=escape');
    await expect(omnibox(shell)).toHaveValue(address);

    await sendKey(app, 'focused', 'L', ['control']);
    await omnibox(shell).pressSequentially('pangolin');
    await expect(suggestionOptions(shell)).toHaveCount(1);

    await omnibox(shell).press('Escape');
    await expect(suggestionList(shell)).toHaveCount(0);
    await expectShellRaised(app, false);
    await expect(omnibox(shell)).toBeFocused();
    await expect(omnibox(shell)).toHaveValue('pangolin');
    expect((await focusedWebContents(app))?.isShell).toBe(true);

    await omnibox(shell).press('Escape');
    await expect(omnibox(shell)).toHaveValue(address);

    // Typing more brings the list back; Enter with nothing selected submits the typed text.
    await omnibox(shell).pressSequentially('pangolin sc');
    await expect(suggestionOptions(shell)).toHaveCount(1);
    await omnibox(shell).press('Enter');
    await waitForPage(app, current.tabId, {
      url: fixtureServer.url('/search?q=pangolin%20sc'),
      title: 'Search results for: pangolin sc',
    });
    await expect(suggestionList(shell)).toHaveCount(0);
  });

  test('a click on the page area closes the list and gives the page the keyboard', async ({
    launcher,
    fixtureServer,
  }) => {
    const { app, shell } = await launcher.launch();
    const title = 'Okapi stripe patterns';
    const remembered = await rememberedTab(app, shell, pageUrl(fixtureServer, title), title);
    const current = await rememberedTab(
      app,
      shell,
      fixtureServer.url('/page-b.html?case=outside'),
      'Page B',
    );
    await waitUntilSaved(app, { [remembered.tabId]: 'strip', [current.tabId]: 'strip' });

    await sendKey(app, 'focused', 'L', ['control']);
    await omnibox(shell).pressSequentially('okapi');
    await expect(suggestionOptions(shell)).toHaveCount(1);
    await expectShellRaised(app, true);

    // The raised shell has the whole content area: the click lands on it and goes no further.
    const box = await shell.locator('#content-area').boundingBox();
    if (box === null) {
      throw new Error('The content area has no box.');
    }
    await shell.mouse.click(box.x + box.width / 2, box.y + box.height - 20);
    await expect(suggestionList(shell)).toHaveCount(0);
    await expectShellRaised(app, false);
    await expect
      .poll(async () => (await focusedWebContents(app))?.webContentsId, {
        message: 'the page should have the keyboard after a click on it',
      })
      .toBe(current.webContentsId);
  });

  test('typing in the address bar sends nothing anywhere: no request leaves the app', async ({
    launcher,
    fixtureServer,
  }) => {
    const { app, shell } = await launcher.launch();
    const title = 'Narwhal tusk guide';
    const remembered = await rememberedTab(app, shell, pageUrl(fixtureServer, title), title);
    const current = await rememberedTab(
      app,
      shell,
      fixtureServer.url('/page-a.html?case=no-network'),
      'Page A',
    );
    await waitUntilSaved(app, { [remembered.tabId]: 'strip', [current.tabId]: 'strip' });

    // Let the pages' own requests (an icon, late subresources) finish, then start counting.
    await expect
      .poll(
        async () =>
          (await observeFor(1_000, async () => (await networkRequests(app)).length)).length,
      )
      .toBe(1);
    await clearNetworkRequests(app);
    const served = fixtureServer.totalRequests();

    await sendKey(app, 'focused', 'L', ['control']);
    // Ten characters, one at a time, with a pause between them: each one asks the memory.
    await omnibox(shell).pressSequentially('narwhal gu', { delay: 40 });
    await expect(suggestionOptions(shell)).toHaveCount(1);
    await expect(suggestionOptions(shell).first()).toContainText(title);
    await expectShellRaised(app, true);
    // The list has been shown and the shell raised and lowered: still nothing went out.
    await omnibox(shell).press('Escape');
    await expectShellRaised(app, false);

    expect(await networkRequests(app)).toEqual([]);
    expect(fixtureServer.totalRequests()).toBe(served);
  });
});

// ── 3. The Archive list at 10,000 ───────────────────────────────────────────────────────────────

test.describe('the Archive list', () => {
  test('lists 10,000 archived tabs with a few dozen rows in the page; the last ones load and restore', async ({
    launcher,
    fixtureServer,
  }) => {
    const total = 10_000;
    const batch = 1_000;

    // Seed the Archive straight into the database, as a long time of automation would leave it.
    const seeding = await launcher.launch();
    const { id: workspaceId } = await dataValue<{ id: string }>(
      seeding.app,
      'workspaces.ensureDefault',
      { candidateId: WORKSPACE_CANDIDATE, name: 'Default', now: Date.now() },
    );
    const newest = Date.now() - 60_000;
    const row = (index: number): TabRow => ({
      // Newest first: row 0 was archived last.
      id: uuidv7(newest - index * 1_000 - 1_000, randomBytes(10)),
      workspaceId,
      placement: 'archive',
      position: index,
      pinned: false,
      userProtected: false,
      pageId: null,
      url: fixtureServer.url(`/page-a.html?seed=${String(index)}`),
      title: `Seeded archive ${String(index)}`,
      faviconId: null,
      restoreState: null,
      openerTabId: null,
      createdAt: newest - index * 1_000 - 1_000,
      lastUsedAt: newest - index * 1_000,
      lastUsedEngaged: 0,
      lastUsedActiveDay: 0,
      placementChangedAt: newest - index * 1_000,
      archivedAt: newest - index * 1_000,
      archiveReason: 'auto',
      closedAt: null,
    });
    for (let from = 0; from < total; from += batch) {
      await dataValue(seeding.app, 'tabs.upsertMany', {
        tabs: Array.from({ length: batch }, (_, offset) => row(from + offset)),
      });
    }
    await launcher.quit(seeding);

    // The app starts on the same profile: the snapshot carries the newest 200, the database all.
    const { app, shell } = await launcher.launch();
    await shell.locator('button[data-section-toggle="archive"]').click();
    await expect(shell.locator('[data-archive-summary]')).toContainText('10000 in total');
    await expect(shell.locator('section[data-sidebar-section="archive"]')).toHaveAttribute(
      'data-count',
      String(total),
    );

    // The scroll height is every row; the page holds a few dozen at most.
    await expect(archiveRows(shell).first()).toContainText('Seeded archive 0');
    const drawn = await archiveRows(shell).count();
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThanOrEqual(60);
    const heights = await archiveScroller(shell).evaluate(
      (box: { scrollHeight: number; clientHeight: number }) => ({
        scroll: box.scrollHeight,
        client: box.clientHeight,
      }),
    );
    expect(heights.scroll).toBe(total * 44);
    expect(heights.client).toBeLessThan(heights.scroll);

    // Up from the first row wraps to the last: scrolled into view, and focused, loaded or not.
    const rowButton = (index: number) => shell.locator(`button[data-row-index="${String(index)}"]`);
    await rowButton(0).focus();
    await shell.keyboard.press('ArrowUp');
    await expect(rowButton(total - 1)).toBeFocused();
    // The last rows arrive from the database, and still only a few dozen are in the page.
    await expect(rowButton(total - 1)).toContainText(`Seeded archive ${String(total - 1)}`);
    await expect(rowButton(total - 1)).not.toHaveAttribute('aria-disabled', 'true');
    expect(await archiveRows(shell).count()).toBeLessThanOrEqual(60);
    await expect(archiveRows(shell).last()).toHaveAttribute('aria-posinset', String(total));
    await expect(archiveRows(shell).last()).toHaveAttribute('aria-setsize', String(total));

    // Enter on a row brings that tab back by keyboard, and focus goes to the row that takes its
    // place (the first row is gone, so the second is first now).
    await archiveScroller(shell).evaluate((box: { scrollTop: number }) => {
      box.scrollTop = 0;
    });
    await expect(rowButton(0)).toContainText('Seeded archive 0');
    await rowButton(0).focus();
    await shell.keyboard.press('Enter');
    await expect(shell.locator('[data-row-list="archived"]')).toHaveAttribute(
      'data-archive-total',
      String(total - 1),
    );
    await expect(rowButton(0)).toContainText('Seeded archive 1');
    await expect(rowButton(0)).toBeFocused();
    const firstUrl = fixtureServer.url('/page-a.html?seed=0');
    await expect
      .poll(async () => (await tabStates(app)).some((tab) => tab.url === firstUrl), {
        message: 'the first archived tab should be back in the strip',
        timeout: SLOW_TIMEOUT_MS,
      })
      .toBe(true);

    // To the end of a list that is one shorter now: the windows fetched before the tab left are
    // out of date by one row, so the rows are fetched again and the last one is the right tab.
    const last = total - 2;
    await archiveScroller(shell).evaluate((box: { scrollTop: number; scrollHeight: number }) => {
      box.scrollTop = box.scrollHeight;
    });
    await expect(rowButton(last)).toContainText(`Seeded archive ${String(total - 1)}`);
    expect(await archiveRows(shell).count()).toBeLessThanOrEqual(60);

    // A click on the last row brings that tab back to the strip, selected, loading its page.
    const lastUrl = fixtureServer.url(`/page-a.html?seed=${String(total - 1)}`);
    await rowButton(last).click();
    await expect
      .poll(
        async () => {
          const id = await selectedTabId(app);
          const state = id === null ? undefined : await tabState(app, id);
          return state === undefined ? null : { placement: state.placement, url: state.url };
        },
        { message: 'the restored tab should be selected', timeout: SLOW_TIMEOUT_MS },
      )
      .toEqual({ placement: 'strip', url: lastUrl });
    await expect(shell.locator('[data-archive-summary]')).toContainText(
      `${String(total - 2)} in total`,
    );
    // And the list is two shorter: both restored tabs are gone from it.
    await expect(shell.locator('[data-row-list="archived"]')).toHaveAttribute(
      'data-archive-total',
      String(total - 2),
    );
  });
});
