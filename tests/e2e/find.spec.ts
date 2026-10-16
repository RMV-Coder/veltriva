// Find in page, M1.3b (assessment §3.9, ADR-0005): the find bar is per tab, main does the searching
// (`findInPage`) and the shell shows what main reports. Every spec reads the result twice: from
// TabManager (`tabStates()[i].find`) and from what the bar shows.
//
// Browser shortcuts are sent from main with `sendKey` (`webContents.sendInputEvent`): Playwright's
// keyboard goes through CDP and never reaches `before-input-event` (ADR-0008 item 4). Typing into
// the find field is the shell's own business, so that uses Playwright's keyboard.
//
// Fixture pages: find.html has "zebra" exactly 4 times in any case (the second is "Zebra") and
// "quokka" once; find-b.html has "zebra" twice; keys.html records keys and can refuse them.
import { startFixtureServer } from '../fixtures/server';
import { expect } from './expect';
import { test } from './fixtures';
import {
  focusedWebContents,
  pageForTab,
  sendKey,
  setSearchTemplate,
  tabState,
  tabStates,
} from './hooks';
import type { TabId } from './hooks';
import { observeFor } from './launch';
import type { PageGlobal } from './page-globals';
import {
  findBar,
  findCloseButton,
  findCount,
  findField,
  fieldSelection,
  findNextButton,
  findPreviousButton,
  internalPage,
  loadTab,
  omnibox,
  openNewTab,
  tabElement,
  tabElements,
  typeAddress,
} from './shell-ui';

test.describe.configure({ timeout: 120_000 });

/** The tab's find state, as TabManager has it. */
async function findOf(
  app: Parameters<typeof tabState>[0],
  tabId: TabId,
): Promise<{ text: string; activeMatch: number; matches: number } | null> {
  return (await tabState(app, tabId))?.find ?? null;
}

type KeyRecorderGlobal = typeof globalThis & {
  keyFixture: { events: { type: string; combo: string }[]; preventCombos: string[] };
};

test.describe('find in page', () => {
  test.beforeEach(async ({ electronApp, fixtureServer, shell }) => {
    // Nothing here searches, but a stray Enter in the address bar must never reach the internet.
    await setSearchTemplate(electronApp, fixtureServer.url('/search?q={searchTerms}'));
    await expect(tabElements(shell)).toHaveCount(1);
  });

  test('Ctrl+F opens the find bar on a web page and gives its field the keyboard', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/find.html'));
    await expect(findBar(shell)).toHaveCount(0);
    expect(await findOf(electronApp, tab.tabId)).toBeNull();
    // The page has the keyboard before Ctrl+F.
    expect((await focusedWebContents(electronApp))?.webContentsId).toBe(tab.webContentsId);

    await sendKey(electronApp, tab.webContentsId, 'F', ['control']);

    await expect
      .poll(() => findOf(electronApp, tab.tabId))
      .toEqual({ text: '', activeMatch: 0, matches: 0 });
    await expect(findBar(shell)).toBeVisible();
    await expect(findField(shell)).toBeFocused();
    await expect(findField(shell)).toHaveValue('');
    await expect(findCount(shell)).toHaveText('');
    // The keyboard is in the shell, not in the page behind it.
    await expect.poll(async () => (await focusedWebContents(electronApp))?.isShell).toBe(true);
  });

  test('typing searches from the top; Enter, Shift+Enter and the buttons step, wrapping around', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/find.html'));
    await sendKey(electronApp, tab.webContentsId, 'F', ['control']);
    await expect(findField(shell)).toBeFocused();

    // Typed one key at a time, as a user does: every prefix searches again, the last one counts.
    await findField(shell).pressSequentially('zebra');
    await expect
      .poll(() => findOf(electronApp, tab.tabId))
      .toEqual({ text: 'zebra', activeMatch: 1, matches: 4 });
    await expect(findCount(shell)).toHaveText('1 of 4');

    const field = findField(shell);
    const steps: readonly [string, () => Promise<void>, number][] = [
      ['Enter', () => field.press('Enter'), 2],
      ['Enter', () => field.press('Enter'), 3],
      ['Enter', () => field.press('Enter'), 4],
      ['Enter wraps to the first match', () => field.press('Enter'), 1],
      ['Shift+Enter wraps back to the last', () => field.press('Shift+Enter'), 4],
      ['Shift+Enter', () => field.press('Shift+Enter'), 3],
      ['Next match button', () => findNextButton(shell).click(), 4],
      ['Next match button wraps', () => findNextButton(shell).click(), 1],
      ['Previous match button wraps', () => findPreviousButton(shell).click(), 4],
      ['Previous match button', () => findPreviousButton(shell).click(), 3],
    ];
    for (const [name, step, expected] of steps) {
      await step();
      await expect
        .poll(async () => (await findOf(electronApp, tab.tabId))?.activeMatch, {
          message: `after ${name} the active match should be ${String(expected)} of 4`,
        })
        .toBe(expected);
      await expect(findCount(shell)).toHaveText(`${String(expected)} of 4`);
      expect((await findOf(electronApp, tab.tabId))?.matches).toBe(4);
    }
  });

  test('the search ignores case, counts one match, and says so when there is none', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/find.html'));
    await sendKey(electronApp, tab.webContentsId, 'F', ['control']);
    const field = findField(shell);
    await expect(field).toBeFocused();

    await field.fill('ZEBRA');
    await expect
      .poll(() => findOf(electronApp, tab.tabId))
      .toEqual({ text: 'ZEBRA', activeMatch: 1, matches: 4 });

    await field.fill('quokka');
    await expect
      .poll(() => findOf(electronApp, tab.tabId))
      .toEqual({ text: 'quokka', activeMatch: 1, matches: 1 });
    await expect(findCount(shell)).toHaveText('1 of 1');
    await expect(findNextButton(shell)).toBeEnabled();

    await field.fill('absentword');
    await expect
      .poll(() => findOf(electronApp, tab.tabId))
      .toEqual({ text: 'absentword', activeMatch: 0, matches: 0 });
    await expect(findCount(shell)).toHaveText('No results');
    await expect(findNextButton(shell)).toBeDisabled();
    await expect(findPreviousButton(shell)).toBeDisabled();
    // Enter with nothing to find changes nothing.
    await field.press('Enter');
    expect(
      await observeFor(500, async () => JSON.stringify(await findOf(electronApp, tab.tabId))),
    ).toEqual([JSON.stringify({ text: 'absentword', activeMatch: 0, matches: 0 })]);

    // An empty field clears the search.
    await field.fill('');
    await expect
      .poll(() => findOf(electronApp, tab.tabId))
      .toEqual({ text: '', activeMatch: 0, matches: 0 });
    await expect(findCount(shell)).toHaveText('');
  });

  test('Escape closes the bar, gives the keyboard back to the page and keeps the last match selected', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/find.html'));
    await sendKey(electronApp, tab.webContentsId, 'F', ['control']);
    await findField(shell).fill('zebra');
    // The second match is "Zebra": the page's selection will tell which one was active.
    await findField(shell).press('Enter');
    await expect.poll(async () => (await findOf(electronApp, tab.tabId))?.activeMatch).toBe(2);

    await findField(shell).press('Escape');

    await expect.poll(() => findOf(electronApp, tab.tabId)).toBeNull();
    await expect(findBar(shell)).toHaveCount(0);
    await expect
      .poll(async () => (await focusedWebContents(electronApp))?.webContentsId)
      .toBe(tab.webContentsId);
    // As in Chrome, closing leaves the active match selected in the page.
    const page = await pageForTab(electronApp, tab.tabId);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const selection = (
            globalThis as PageGlobal & { getSelection(): { toString(): string } }
          ).getSelection();
          return selection.toString();
        }),
      )
      .toBe('Zebra');
  });

  test('the "Close find bar" button closes it and the page gets the keyboard', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/find.html'));
    await sendKey(electronApp, tab.webContentsId, 'F', ['control']);
    await findField(shell).fill('zebra');
    await expect.poll(async () => (await findOf(electronApp, tab.tabId))?.matches).toBe(4);

    await findCloseButton(shell).click();

    await expect.poll(() => findOf(electronApp, tab.tabId)).toBeNull();
    await expect(findBar(shell)).toHaveCount(0);
    await expect
      .poll(async () => (await focusedWebContents(electronApp))?.webContentsId)
      .toBe(tab.webContentsId);
  });

  test('reopening the bar offers the last text, selected, and searches for it again', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/find.html'));
    await sendKey(electronApp, tab.webContentsId, 'F', ['control']);
    await findField(shell).fill('zebra');
    await expect.poll(async () => (await findOf(electronApp, tab.tabId))?.matches).toBe(4);
    await findField(shell).press('Escape');
    await expect.poll(() => findOf(electronApp, tab.tabId)).toBeNull();

    await sendKey(electronApp, tab.webContentsId, 'F', ['control']);

    await expect(findField(shell)).toBeFocused();
    await expect(findField(shell)).toHaveValue('zebra');
    // Which match is active depends on the selection Escape left in the page: Chromium starts a new
    // search from it, as Chrome does. The text and the count are what the bar offers again.
    await expect
      .poll(() => findOf(electronApp, tab.tabId))
      .toMatchObject({ text: 'zebra', matches: 4 });
    expect((await findOf(electronApp, tab.tabId))?.activeMatch).toBeGreaterThanOrEqual(1);
    await expect(findCount(shell)).toHaveText(/^[1-4] of 4$/);
    // Selected, so typing replaces it.
    expect(await fieldSelection(findField(shell))).toEqual([0, 5]);
  });

  test('Ctrl+F with the bar already open puts the keyboard in the field again', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/find.html'));
    await sendKey(electronApp, tab.webContentsId, 'F', ['control']);
    await findField(shell).fill('zebra');
    await expect.poll(async () => (await findOf(electronApp, tab.tabId))?.matches).toBe(4);

    // The user clicks into the page (it takes the keyboard), then presses Ctrl+F again.
    await sendKey(electronApp, tab.webContentsId, 'F', ['control']);

    await expect(findField(shell)).toBeFocused();
    expect(await findOf(electronApp, tab.tabId)).toMatchObject({ text: 'zebra', matches: 4 });
    expect(await fieldSelection(findField(shell))).toEqual([0, 5]);
  });

  // A new document closes the bar, as in Chrome. Found by this suite in M1.3b: when the bar stayed
  // open across the navigation, the first search on find-b.html (2 matches) reported 2 of 2, as
  // Chromium's find state carried over. Main now stops it on the commit.
  test('a navigation closes the bar; Ctrl+F brings the text back and searches the new page from the top', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/find.html'));
    await sendKey(electronApp, tab.webContentsId, 'F', ['control']);
    await findField(shell).fill('zebra');
    await expect.poll(async () => (await findOf(electronApp, tab.tabId))?.matches).toBe(4);

    const next = fixtureServer.url('/find-b.html');
    await typeAddress(shell, next);
    await expect
      .poll(async () => (await tabState(electronApp, tab.tabId))?.url, { timeout: 30_000 })
      .toBe(next);
    await expect
      .poll(async () => (await tabState(electronApp, tab.tabId))?.title)
      .toBe('Find fixture B');

    // The old page's search ended with it.
    await expect.poll(() => findOf(electronApp, tab.tabId)).toBeNull();
    await expect(findBar(shell)).toHaveCount(0);

    // Ctrl+F offers the last text and searches the new page: 1 of 2, not the old page's 4.
    await sendKey(electronApp, tab.webContentsId, 'F', ['control']);
    await expect(findField(shell)).toBeFocused();
    await expect(findField(shell)).toHaveValue('zebra');
    await expect
      .poll(() => findOf(electronApp, tab.tabId))
      .toEqual({ text: 'zebra', activeMatch: 1, matches: 2 });
    await expect(findCount(shell)).toHaveText('1 of 2');

    // The new page's search steps and wraps like any other.
    await findField(shell).press('Enter');
    await expect
      .poll(() => findOf(electronApp, tab.tabId))
      .toEqual({ text: 'zebra', activeMatch: 2, matches: 2 });
    await findField(shell).press('Enter');
    await expect
      .poll(() => findOf(electronApp, tab.tabId))
      .toEqual({ text: 'zebra', activeMatch: 1, matches: 2 });
  });

  test('a same-document navigation (a #fragment) keeps the bar and its results', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/find.html'));
    await sendKey(electronApp, tab.webContentsId, 'F', ['control']);
    await findField(shell).fill('zebra');
    await expect
      .poll(() => findOf(electronApp, tab.tabId))
      .toEqual({ text: 'zebra', activeMatch: 1, matches: 4 });

    const page = await pageForTab(electronApp, tab.tabId);
    await page.evaluate(() => {
      (globalThis as unknown as { location: { hash: string } }).location.hash = 'third';
    });
    await expect
      .poll(async () => (await tabState(electronApp, tab.tabId))?.url)
      .toBe(fixtureServer.url('/find.html#third'));

    await expect(findBar(shell)).toBeVisible();
    await expect(findCount(shell)).toHaveText('1 of 4');
    expect(await findOf(electronApp, tab.tabId)).toEqual({
      text: 'zebra',
      activeMatch: 1,
      matches: 4,
    });
  });

  test('each tab has its own find bar', async ({ electronApp, fixtureServer, shell }) => {
    const tabA = await loadTab(electronApp, shell, fixtureServer.url('/find.html'));
    await sendKey(electronApp, tabA.webContentsId, 'F', ['control']);
    await findField(shell).fill('zebra');
    await expect.poll(async () => (await findOf(electronApp, tabA.tabId))?.matches).toBe(4);

    // Tab B has no bar, whatever tab A did.
    const tabB = await loadTab(electronApp, shell, fixtureServer.url('/find-b.html'));
    await expect(findBar(shell)).toHaveCount(0);
    expect(await findOf(electronApp, tabB.tabId)).toBeNull();

    // B's own search is independent of A's.
    await sendKey(electronApp, tabB.webContentsId, 'F', ['control']);
    await findField(shell).fill('zebra');
    await expect
      .poll(() => findOf(electronApp, tabB.tabId))
      .toEqual({ text: 'zebra', activeMatch: 1, matches: 2 });
    expect(await findOf(electronApp, tabA.tabId)).toMatchObject({ text: 'zebra', matches: 4 });

    // Back to A: its bar, its text and its count are as it left them.
    await tabElement(shell, tabA.tabId).click();
    await expect(tabElement(shell, tabA.tabId)).toHaveAttribute('aria-selected', 'true');
    await expect(findBar(shell)).toBeVisible();
    await expect(findField(shell)).toHaveValue('zebra');
    await expect(findCount(shell)).toHaveText('1 of 4');

    // Closing A's bar leaves B's alone.
    await findCloseButton(shell).click();
    await expect.poll(() => findOf(electronApp, tabA.tabId)).toBeNull();
    expect(await findOf(electronApp, tabB.tabId)).toMatchObject({ text: 'zebra', matches: 2 });
  });

  test('a new-tab page has no find: Ctrl+F and F3 do nothing', async ({ electronApp, shell }) => {
    const tabId = await openNewTab(shell);
    await expect(internalPage(shell, 'new-tab')).toBeVisible();

    await sendKey(electronApp, 'shell', 'F', ['control']);
    await sendKey(electronApp, 'shell', 'F3');
    await sendKey(electronApp, 'shell', 'G', ['control']);

    // The keys were delivered and handled by nobody: nothing opens, the address bar keeps the keyboard.
    expect(
      await observeFor(700, async () =>
        JSON.stringify((await tabStates(electronApp)).map((t) => t.find)),
      ),
    ).toEqual([JSON.stringify([null, null])]);
    await expect(findBar(shell)).toHaveCount(0);
    expect(await findOf(electronApp, tabId)).toBeNull();
    await expect(omnibox(shell)).toBeFocused();
  });

  test('a failed load closes the find bar', async ({ electronApp, fixtureServer, shell }) => {
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/find.html'));
    await sendKey(electronApp, tab.webContentsId, 'F', ['control']);
    await findField(shell).fill('zebra');
    await expect.poll(async () => (await findOf(electronApp, tab.tabId))?.matches).toBe(4);

    // A port nothing listens on refuses the connection.
    const closed = await startFixtureServer();
    const refused = closed.url('/page-a.html?case=find-failed-load');
    await closed.close();
    await typeAddress(shell, refused);

    await expect(internalPage(shell, 'network-error')).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => findOf(electronApp, tab.tabId)).toBeNull();
    await expect(findBar(shell)).toHaveCount(0);
  });

  test('F3 and Ctrl+G open the bar when it is closed and step when it is open', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/find.html'));

    // Closed: F3 opens it and gives the keyboard to the field, as Ctrl+F does.
    await sendKey(electronApp, tab.webContentsId, 'F3');
    await expect
      .poll(() => findOf(electronApp, tab.tabId))
      .toEqual({ text: '', activeMatch: 0, matches: 0 });
    await expect(findField(shell)).toBeFocused();

    await findField(shell).fill('zebra');
    await expect
      .poll(() => findOf(electronApp, tab.tabId))
      .toEqual({ text: 'zebra', activeMatch: 1, matches: 4 });

    // Open, with the keyboard in the page: the keys step.
    const keys: readonly [string, string, readonly ('shift' | 'control')[], number][] = [
      ['F3', 'F3', [], 2],
      ['Ctrl+G', 'G', ['control'], 3],
      ['Shift+F3', 'F3', ['shift'], 2],
      ['Ctrl+Shift+G', 'G', ['control', 'shift'], 1],
      ['Shift+F3 wraps to the last', 'F3', ['shift'], 4],
      ['F3 wraps to the first', 'F3', [], 1],
    ];
    for (const [name, key, modifiers, expected] of keys) {
      await sendKey(electronApp, tab.webContentsId, key, modifiers);
      await expect
        .poll(async () => (await findOf(electronApp, tab.tabId))?.activeMatch, {
          message: `after ${name} the active match should be ${String(expected)} of 4`,
        })
        .toBe(expected);
    }
    // Stepping from the page leaves the bar open.
    await expect(findBar(shell)).toBeVisible();
    await expect(findCount(shell)).toHaveText('1 of 4');

    // The same keys work while the keyboard is in the find field.
    await sendKey(electronApp, 'shell', 'F3');
    await expect.poll(async () => (await findOf(electronApp, tab.tabId))?.activeMatch).toBe(2);
    await sendKey(electronApp, 'shell', 'G', ['control']);
    await expect.poll(async () => (await findOf(electronApp, tab.tabId))?.activeMatch).toBe(3);
  });

  test('Ctrl+G with the bar closed opens it too', async ({ electronApp, fixtureServer, shell }) => {
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/find.html'));
    await sendKey(electronApp, tab.webContentsId, 'G', ['control']);
    await expect
      .poll(() => findOf(electronApp, tab.tabId))
      .toEqual({ text: '', activeMatch: 0, matches: 0 });
    await expect(findField(shell)).toBeFocused();
  });

  test('page first: a page that handles Ctrl+F or F3 keeps it, and one that does not gets the browser find', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/keys.html'));
    const page = await pageForTab(electronApp, tab.tabId);
    const received = (): Promise<string[]> =>
      page.evaluate(() =>
        (globalThis as KeyRecorderGlobal).keyFixture.events
          .filter((event) => event.type === 'keydown')
          .map((event) => event.combo),
      );

    // The page claims Ctrl+F and F3, as Google Docs claims Ctrl+F.
    await page.evaluate(() => {
      (globalThis as KeyRecorderGlobal).keyFixture.preventCombos = ['ctrl+f', 'f3', 'ctrl+g'];
    });
    await sendKey(electronApp, tab.webContentsId, 'F', ['control']);
    await sendKey(electronApp, tab.webContentsId, 'F3');
    await sendKey(electronApp, tab.webContentsId, 'G', ['control']);
    await expect.poll(received).toEqual(['ctrl+f', 'f3', 'ctrl+g']);
    // The page took them, so the browser did not.
    expect(
      await observeFor(700, async () =>
        JSON.stringify((await tabStates(electronApp)).map((t) => t.find)),
      ),
    ).toEqual([JSON.stringify([null, null])]);
    await expect(findBar(shell)).toHaveCount(0);

    // The page lets Ctrl+F through: it still sees the key, and the browser's find opens.
    await page.evaluate(() => {
      (globalThis as KeyRecorderGlobal).keyFixture.preventCombos = [];
    });
    await sendKey(electronApp, tab.webContentsId, 'F', ['control']);
    await expect.poll(received).toEqual(['ctrl+f', 'f3', 'ctrl+g', 'ctrl+f']);
    await expect(findBar(shell)).toBeVisible();
    await expect(findField(shell)).toBeFocused();
  });
});
