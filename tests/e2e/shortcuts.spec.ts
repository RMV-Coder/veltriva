// Reserved keyboard shortcuts, M1.3b (assessment §3.9, threat model: a page must not be able to
// take the browser's keys). Main handles them in `before-input-event`, on the shell and on every
// tab, before the page sees the key: the keyDown is cancelled (and with it the keyUp, which
// Chromium then drops itself) and the command runs once, on the first keyDown.
//
// The tab under test is usually keys.html with `preventAll` on: a hostile page that records every
// key it gets and calls `preventDefault()` on all of them. If a reserved shortcut still works and
// the page recorded nothing, the page can neither see nor block it. A shortcut that closes the very
// tab it was sent to leaves nothing to ask, so the specs also record the key in main after the
// app's handler (`recordInputs`): `prevented: true` on the keyDown is what keeps it from the page.
//
// Keys are sent from main (`sendKey`, see find.spec.ts for why Playwright's keyboard cannot do it).
import type { ElectronApplication, Page } from '@playwright/test';

import type { FixtureServer } from '../fixtures/server';
import { expect } from './expect';
import { test } from './fixtures';
import {
  evaluateInTab,
  focusedWebContents,
  holdKey,
  isDevToolsOpened,
  pageForTab,
  recordInputs,
  selectedTabId,
  sendKey,
  setSearchTemplate,
  shellContentsId,
  tabState,
  tabStates,
  webContentsRoles,
  windowInfo,
} from './hooks';
import type { InputRecord, KeyModifier, KeyTarget, TabId } from './hooks';
import { observeFor } from './launch';
import type { LoadedTab } from './shell-ui';
import {
  expectConsistent,
  fieldSelection,
  blurAddressBar,
  loadTab,
  mainIds,
  omnibox,
  palette,
  tabElement,
  tabElements,
  typeAddress,
  waitForPage,
} from './shell-ui';

test.describe.configure({ timeout: 120_000 });

interface KeyEvent {
  type: string;
  key: string;
  code: string;
  combo: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}
type KeyRecorderGlobal = typeof globalThis & {
  keyFixture: { events: KeyEvent[]; preventAll: boolean; preventCombos: string[] };
};

/** A tab on keys.html that records keys and, when `preventAll` is on, refuses every one. */
interface KeyPage {
  readonly tab: LoadedTab;
  readonly page: Page;
  /** What main saw of every key sent to this tab, after the app's own handler. */
  readonly inputs: Awaited<ReturnType<typeof recordInputs>>;
}

async function loadKeyPage(
  app: ElectronApplication,
  shell: Page,
  fixtureServer: FixtureServer,
  name: string,
  options: { readonly hostile: boolean },
): Promise<KeyPage> {
  const tab = await loadTab(app, shell, fixtureServer.url(`/keys.html?case=${name}`));
  const page = await pageForTab(app, tab.tabId);
  if (options.hostile) {
    await page.evaluate(() => {
      (globalThis as KeyRecorderGlobal).keyFixture.preventAll = true;
    });
  }
  return { tab, page, inputs: await recordInputs(app, tab.webContentsId) };
}

/** Every key event the page itself received (a swallowed key leaves this empty). */
function pageEvents(page: Page): Promise<KeyEvent[]> {
  return page.evaluate(() => [...(globalThis as KeyRecorderGlobal).keyFixture.events]);
}

/**
 * The keys recorded since `mark` (a count taken earlier) were all cancelled by the app. Polls,
 * because main reports the events a moment after the send returns.
 *
 * Only the keyDown is listed: once it is cancelled, Chromium drops the matching keyUp itself
 * (measured on Electron 44.7.2: `before-input-event` never fires for it), so the page gets neither.
 * A keyUp that does show up must be cancelled too.
 */
async function expectSwallowed(key: KeyPage, mark: number, what: string): Promise<void> {
  let records: InputRecord[] = [];
  await expect
    .poll(
      async () => {
        records = (await key.inputs.all()).slice(mark);
        return records.some((record) => record.type === 'keyDown');
      },
      { message: `main should have seen the key down of ${what}` },
    )
    .toBe(true);
  expect(
    records.filter((record) => !record.prevented),
    `${what}: no key press may be left for the page`,
  ).toEqual([]);
}

/** The key presses the app left alone, i.e. the ones the page got (down and up). */
async function expectDelivered(key: KeyPage, mark: number, what: string): Promise<void> {
  let records: InputRecord[] = [];
  await expect
    .poll(
      async () => {
        records = (await key.inputs.all()).slice(mark);
        return new Set(records.map((record) => record.type));
      },
      { message: `main should have seen both halves of ${what}` },
    )
    .toEqual(new Set(['keyDown', 'keyUp']));
  expect(
    records.filter((record) => record.prevented),
    `${what}: the app must not cancel it`,
  ).toEqual([]);
}

/** The web contents a key goes to when the selected tab is on screen: its page, else the shell. */
async function selectedTarget(app: ElectronApplication): Promise<Exclude<KeyTarget, 'focused'>> {
  const id = await selectedTabId(app);
  const state = id === null ? undefined : await tabState(app, id);
  return state?.webContentsId ?? 'shell';
}

async function sendToSelected(
  app: ElectronApplication,
  keyCode: string,
  modifiers: readonly KeyModifier[] = [],
): Promise<void> {
  await sendKey(app, await selectedTarget(app), keyCode, modifiers);
}

/** Waits until `tabId` is the selected tab, with the keyboard in its page (or the shell, if it has none). */
async function expectSelectedWithFocus(app: ElectronApplication, tabId: TabId): Promise<void> {
  await expect
    .poll(() => selectedTabId(app), { message: `tab ${tabId} should be selected` })
    .toBe(tabId);
  const contentsId = (await tabState(app, tabId))?.webContentsId ?? null;
  await expect
    .poll(
      async () => {
        const focused = await focusedWebContents(app);
        return contentsId === null
          ? focused?.isShell === true
          : focused?.webContentsId === contentsId;
      },
      {
        message:
          contentsId === null
            ? `the shell (the address bar) should have the keyboard for tab ${tabId}`
            : `the page of tab ${tabId} should have the keyboard`,
      },
    )
    .toBe(true);
}

test.describe('reserved shortcuts', () => {
  test.beforeEach(async ({ electronApp, fixtureServer, shell }) => {
    await setSearchTemplate(electronApp, fixtureServer.url('/search?q={searchTerms}'));
    await expect(tabElements(shell)).toHaveCount(1);
  });

  test('Ctrl+T opens a new tab with the address bar focused, whatever the page does', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const key = await loadKeyPage(electronApp, shell, fixtureServer, 'ctrl-t', { hostile: true });
    const before = await mainIds(electronApp);

    await sendKey(electronApp, key.tab.webContentsId, 'T', ['control']);

    await expect.poll(async () => (await mainIds(electronApp)).length).toBe(before.length + 1);
    const created = (await mainIds(electronApp)).at(-1);
    expect(await selectedTabId(electronApp)).toBe(created);
    expect((await tabState(electronApp, created ?? ''))?.page).toMatchObject({
      kind: 'internal',
      name: 'new-tab',
    });
    await expect(omnibox(shell)).toBeFocused();
    expect((await focusedWebContents(electronApp))?.isShell).toBe(true);
    await expectSwallowed(key, 0, 'Ctrl+T');
    expect(await pageEvents(key.page)).toEqual([]);
  });

  test('Ctrl+W and Ctrl+F4 close the selected tab; closing the last one leaves a fresh tab', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const [first] = await mainIds(electronApp);
    const tabA = await loadTab(electronApp, shell, fixtureServer.url('/page-a.html'));
    const hostile = await loadKeyPage(electronApp, shell, fixtureServer, 'ctrl-w', {
      hostile: true,
    });
    expect(await mainIds(electronApp)).toEqual([first, tabA.tabId, hostile.tab.tabId]);

    // Ctrl+W on the last tab: it closes and the tab before it is selected, with the keyboard.
    await sendKey(electronApp, hostile.tab.webContentsId, 'W', ['control']);
    await expect.poll(() => tabState(electronApp, hostile.tab.tabId)).toBeUndefined();
    expect(await mainIds(electronApp)).toEqual([first, tabA.tabId]);
    await expectSelectedWithFocus(electronApp, tabA.tabId);
    await expectSwallowed(hostile, 0, 'Ctrl+W');

    // Ctrl+F4 does the same.
    await sendKey(electronApp, tabA.webContentsId, 'F4', ['control']);
    await expect.poll(() => tabState(electronApp, tabA.tabId)).toBeUndefined();
    expect(await mainIds(electronApp)).toEqual([first]);
    await expectSelectedWithFocus(electronApp, first ?? '');

    // The last tab closes too, and the window gets a new one: it never has none.
    await sendKey(electronApp, 'shell', 'W', ['control']);
    await expect
      .poll(async () => (await mainIds(electronApp)).filter((id) => id !== first))
      .toHaveLength(1);
    expect(await mainIds(electronApp)).toHaveLength(1);
    expect((await tabStates(electronApp))[0]?.page).toMatchObject({ name: 'new-tab' });
    await expect(omnibox(shell)).toBeFocused();
  });

  test('Ctrl+Shift+T reopens the closed tabs, last closed first, each at its old place', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const [first] = await mainIds(electronApp);
    // Nothing closed yet: the shortcut does nothing.
    await sendKey(electronApp, 'shell', 'T', ['control', 'shift']);
    expect(await observeFor(500, async () => (await mainIds(electronApp)).length)).toEqual([1]);

    const urlA = fixtureServer.url('/page-a.html?case=reopen');
    const tabA = await loadTab(electronApp, shell, urlA);
    const hostile = await loadKeyPage(electronApp, shell, fixtureServer, 'reopen', {
      hostile: true,
    });
    const urlB = fixtureServer.url('/keys.html?case=reopen');
    const originalIds = await mainIds(electronApp);

    await sendKey(electronApp, hostile.tab.webContentsId, 'W', ['control']);
    await expect.poll(() => tabState(electronApp, hostile.tab.tabId)).toBeUndefined();
    await sendKey(electronApp, tabA.webContentsId, 'W', ['control']);
    await expect.poll(() => tabState(electronApp, tabA.tabId)).toBeUndefined();
    expect(await mainIds(electronApp)).toEqual([first]);

    // The most recent closed tab comes back first: A, at index 1, loading its URL again.
    await sendToSelected(electronApp, 'T', ['control', 'shift']);
    await expect.poll(async () => (await mainIds(electronApp)).length).toBe(2);
    const reopenedA = (await mainIds(electronApp))[1] ?? '';
    // Since M2.2a a reopened tab is the same tab again: its own id, with its history.
    expect(reopenedA).toBe(tabA.tabId);
    expect(originalIds).toContain(reopenedA);
    await waitForPage(electronApp, reopenedA, { url: urlA });
    await expectSelectedWithFocus(electronApp, reopenedA);

    // The key goes to the reopened page now; the next one is B at index 2 (hostile once, but the
    // reopened page is a fresh document, so it takes the key like any other).
    await sendToSelected(electronApp, 'T', ['control', 'shift']);
    await expect.poll(async () => (await mainIds(electronApp)).length).toBe(3);
    const reopenedB = (await mainIds(electronApp))[2] ?? '';
    await waitForPage(electronApp, reopenedB, { url: urlB });
    expect(await selectedTabId(electronApp)).toBe(reopenedB);

    // Nothing left to reopen.
    await sendToSelected(electronApp, 'T', ['control', 'shift']);
    expect(await observeFor(500, async () => (await mainIds(electronApp)).length)).toEqual([3]);
    await expectSwallowed(hostile, 0, 'Ctrl+W on the hostile page');
  });

  test('Ctrl+Tab and Ctrl+Shift+Tab move through the tabs and wrap around', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const [first] = await mainIds(electronApp);
    const tabA = await loadTab(electronApp, shell, fixtureServer.url('/page-a.html'));
    const hostile = await loadKeyPage(electronApp, shell, fixtureServer, 'cycle', {
      hostile: true,
    });
    const order = [first ?? '', tabA.tabId, hostile.tab.tabId];

    // From the last tab, forward wraps to the first, then A, then the hostile tab again.
    for (const expected of [0, 1, 2, 0]) {
      await sendToSelected(electronApp, 'Tab', ['control']);
      await expectSelectedWithFocus(electronApp, order[expected] ?? '');
    }
    // Backward from the first wraps to the last.
    for (const expected of [2, 1, 0, 2]) {
      await sendToSelected(electronApp, 'Tab', ['control', 'shift']);
      await expectSelectedWithFocus(electronApp, order[expected] ?? '');
    }
    // The hostile page was selected for the keys that left it, and saw none of them.
    await expectSwallowed(hostile, 0, 'Ctrl+Tab on the hostile page');
    expect(await pageEvents(hostile.page)).toEqual([]);
  });

  test('Ctrl+1 to Ctrl+8 select that tab and Ctrl+9 the last, keypad digits included', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const [first] = await mainIds(electronApp);
    const tabA = await loadTab(electronApp, shell, fixtureServer.url('/page-a.html?n=1'));
    const tabB = await loadTab(electronApp, shell, fixtureServer.url('/page-b.html?n=2'));
    const hostile = await loadKeyPage(electronApp, shell, fixtureServer, 'digits', {
      hostile: true,
    });
    const tabD = await loadTab(electronApp, shell, fixtureServer.url('/page-c.html?n=4'));
    const order = [first ?? '', tabA.tabId, tabB.tabId, hostile.tab.tabId, tabD.tabId];
    expect(await mainIds(electronApp)).toEqual(order);

    const steps: readonly [string, string, number][] = [
      ['Ctrl+1', '1', 0],
      ['Ctrl+3', '3', 2],
      ['Ctrl+4 (the hostile page)', '4', 3],
      ['Ctrl+2', '2', 1],
      ['Ctrl+9 (the last tab)', '9', 4],
      ['Ctrl+keypad 3', 'num3', 2],
    ];
    for (const [name, digit, index] of steps) {
      await test.step(name, async () => {
        await sendToSelected(electronApp, digit, ['control']);
        await expectSelectedWithFocus(electronApp, order[index] ?? '');
      });
    }

    // There is no eighth tab: Ctrl+8 changes nothing.
    await sendToSelected(electronApp, '8', ['control']);
    expect(await observeFor(500, () => selectedTabId(electronApp))).toEqual([order[2]]);
    await expectSwallowed(hostile, 0, 'Ctrl+2 on the hostile page');
  });

  test('Ctrl+L and Alt+D put the keyboard in the address bar with the address selected', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const key = await loadKeyPage(electronApp, shell, fixtureServer, 'focus-address', {
      hostile: true,
    });
    const address = fixtureServer.url('/keys.html?case=focus-address');
    await expectSelectedWithFocus(electronApp, key.tab.tabId);

    for (const [name, keyCode, modifiers] of [
      ['Ctrl+L', 'L', ['control']],
      ['Alt+D', 'D', ['alt']],
    ] as const) {
      // The page has the keyboard before, and the shell after.
      await blurAddressBar(shell);
      await sendKey(electronApp, key.tab.webContentsId, keyCode, modifiers);
      await expect(omnibox(shell), `${name} should focus the address bar`).toBeFocused();
      await expect(omnibox(shell)).toHaveValue(address);
      expect(await fieldSelection(omnibox(shell))).toEqual([0, address.length]);
      expect((await focusedWebContents(electronApp))?.isShell).toBe(true);
      // Back to the page for the next one (a click in the page would do it).
      await electronApp.evaluate(({ webContents }, id) => {
        webContents.fromId(id)?.focus();
      }, key.tab.webContentsId);
    }
    await expectSwallowed(key, 0, 'Ctrl+L and Alt+D');
    expect(await pageEvents(key.page)).toEqual([]);
  });

  test('F6 moves the keyboard from the page to the address bar, the sidebar and back (M6.2)', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const key = await loadKeyPage(electronApp, shell, fixtureServer, 'f6', { hostile: true });
    await expectSelectedWithFocus(electronApp, key.tab.tabId);

    // Page to address bar.
    await blurAddressBar(shell);
    await sendKey(electronApp, key.tab.webContentsId, 'F6');
    await expect(omnibox(shell)).toBeFocused();
    await expect.poll(async () => (await focusedWebContents(electronApp))?.isShell).toBe(true);

    // Address bar to the sidebar's selected tab.
    await sendKey(electronApp, 'shell', 'F6');
    await expect(tabElement(shell, key.tab.tabId)).toBeFocused();
    await expect.poll(async () => (await focusedWebContents(electronApp))?.isShell).toBe(true);

    // Sidebar to page.
    await sendKey(electronApp, 'shell', 'F6');
    await expect
      .poll(async () => (await focusedWebContents(electronApp))?.webContentsId)
      .toBe(key.tab.webContentsId);

    // And around again.
    await blurAddressBar(shell);
    await sendKey(electronApp, key.tab.webContentsId, 'F6');
    await expect(omnibox(shell)).toBeFocused();
    await expect.poll(async () => (await focusedWebContents(electronApp))?.isShell).toBe(true);
    await expectSwallowed(key, 0, 'F6');
    expect(await pageEvents(key.page)).toEqual([]);
  });

  test('F5 and Ctrl+R reload the page, whatever it does with the keys', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const path = '/keys.html?case=reload';
    const key = await loadKeyPage(electronApp, shell, fixtureServer, 'reload', { hostile: true });
    expect(fixtureServer.hits(path)).toBe(1);

    await sendKey(electronApp, key.tab.webContentsId, 'F5');
    await expect.poll(() => fixtureServer.hits(path)).toBe(2);
    await waitForPage(electronApp, key.tab.tabId, { url: fixtureServer.url(path) });

    await sendKey(electronApp, key.tab.webContentsId, 'R', ['control']);
    await expect.poll(() => fixtureServer.hits(path)).toBe(3);
    await waitForPage(electronApp, key.tab.tabId, { url: fixtureServer.url(path) });

    await expectSwallowed(key, 0, 'F5 and Ctrl+R');
  });

  test('Shift+F5, Ctrl+F5 and Ctrl+Shift+R reload ignoring the cache; F5 and Ctrl+R do not', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    // /echo-headers shows the request headers the page was loaded with.
    const path = '/echo-headers?case=bypass';
    const tab = await loadTab(electronApp, shell, fixtureServer.url(path));
    const inputs = await recordInputs(electronApp, tab.webContentsId);
    const headers = async (): Promise<Record<string, string> | null> => {
      try {
        const text = await evaluateInTab(electronApp, tab.webContentsId, 'document.body.innerText');
        return JSON.parse(String(text)) as Record<string, string>;
      } catch {
        return null; // mid-reload
      }
    };

    // Alternating, so that each reload's headers differ from those of the page it replaces.
    const reloads: readonly [string, string, readonly KeyModifier[], boolean][] = [
      ['F5', 'F5', [], false],
      ['Shift+F5', 'F5', ['shift'], true],
      ['Ctrl+R', 'R', ['control'], false],
      ['Ctrl+F5', 'F5', ['control'], true],
      ['F5', 'F5', [], false],
      ['Ctrl+Shift+R', 'R', ['control', 'shift'], true],
    ];
    let hits = fixtureServer.hits(path);
    for (const [name, keyCode, modifiers, ignoresCache] of reloads) {
      await sendKey(electronApp, tab.webContentsId, keyCode, modifiers);
      hits += 1;
      await expect
        .poll(() => fixtureServer.hits(path), { message: `${name} should reload the page` })
        .toBe(hits);
      await expect
        .poll(
          async () => {
            const seen = await headers();
            return seen === null
              ? null
              : { pragma: seen.pragma ?? null, cacheControl: seen['cache-control'] ?? null };
          },
          { message: `${name} should ${ignoresCache ? 'bypass' : 'use'} the cache` },
        )
        .toEqual(
          ignoresCache
            ? { pragma: 'no-cache', cacheControl: 'no-cache' }
            : { pragma: null, cacheControl: 'max-age=0' },
        );
    }
    expect((await inputs.all()).filter((record) => !record.prevented)).toEqual([]);
  });

  test('Alt+Left and Alt+Right go back and forward, even on a page that blocks every key', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const urlA = fixtureServer.url('/page-a.html?case=history');
    const tab = await loadTab(electronApp, shell, urlA);
    const urlKeys = fixtureServer.url('/keys.html?case=history');
    await typeAddress(shell, urlKeys);
    await waitForPage(electronApp, tab.tabId, { url: urlKeys, title: 'Key recorder' });
    const page = await pageForTab(electronApp, tab.tabId);
    await page.evaluate(() => {
      (globalThis as KeyRecorderGlobal).keyFixture.preventAll = true;
    });
    const inputs = await recordInputs(electronApp, tab.webContentsId);
    expect((await tabState(electronApp, tab.tabId))?.canGoBack).toBe(true);

    // The hostile page has the keyboard (the typed navigation committed), and cannot keep Alt+Left.
    await sendKey(electronApp, tab.webContentsId, 'Left', ['alt']);
    await waitForPage(electronApp, tab.tabId, { url: urlA, title: 'Page A' });
    expect((await tabState(electronApp, tab.tabId))?.canGoForward).toBe(true);

    await sendKey(electronApp, tab.webContentsId, 'Right', ['alt']);
    await waitForPage(electronApp, tab.tabId, { url: urlKeys, title: 'Key recorder' });

    // Both were cancelled in main, key down and key up: neither page saw them.
    const records = await inputs.all();
    for (const arrow of ['ArrowLeft', 'ArrowRight']) {
      const mine = records.filter((record) => record.alt && record.key === arrow);
      expect(mine.map((record) => record.type)).toContain('keyDown');
      expect(mine.filter((record) => !record.prevented)).toEqual([]);
    }
  });

  test('F11 toggles the window between fullscreen and normal, whatever the page does', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const key = await loadKeyPage(electronApp, shell, fixtureServer, 'f11', { hostile: true });
    expect((await windowInfo(electronApp)).fullScreen).toBe(false);

    await sendKey(electronApp, key.tab.webContentsId, 'F11');
    await expect
      .poll(async () => (await windowInfo(electronApp)).fullScreen, {
        message: 'F11 should make the window fullscreen',
      })
      .toBe(true);
    // The browser's own fullscreen keeps the browser's chrome: this is not HTML fullscreen.
    await expect(omnibox(shell)).toBeVisible();
    await expectConsistent(electronApp, shell);

    await sendKey(electronApp, key.tab.webContentsId, 'F11');
    await expect.poll(async () => (await windowInfo(electronApp)).fullScreen).toBe(false);
    await expectConsistent(electronApp, shell);

    // From the shell as well.
    await sendKey(electronApp, 'shell', 'F11');
    await expect.poll(async () => (await windowInfo(electronApp)).fullScreen).toBe(true);
    await sendKey(electronApp, 'shell', 'F11');
    await expect.poll(async () => (await windowInfo(electronApp)).fullScreen).toBe(false);

    await expectSwallowed(key, 0, 'F11');
    expect(await pageEvents(key.page)).toEqual([]);
  });

  test('F12 toggles the DevTools of a page that blocks every key', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const key = await loadKeyPage(electronApp, shell, fixtureServer, 'f12', { hostile: true });

    await sendKey(electronApp, key.tab.webContentsId, 'F12');
    await expect.poll(() => isDevToolsOpened(electronApp, key.tab.webContentsId)).toBe(true);
    expect((await webContentsRoles(electronApp)).filter((e) => e.role === 'devtools')).toHaveLength(
      1,
    );

    await sendKey(electronApp, key.tab.webContentsId, 'F12');
    await expect.poll(() => isDevToolsOpened(electronApp, key.tab.webContentsId)).toBe(false);

    await expectSwallowed(key, 0, 'F12');
    expect(await pageEvents(key.page)).toEqual([]);
  });

  test('Ctrl+Shift+K opens the memory palette (M4.2), and the page never sees it', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const key = await loadKeyPage(electronApp, shell, fixtureServer, 'ctrl-shift-k', {
      hostile: false,
    });
    const snapshot = async (): Promise<string> =>
      JSON.stringify({
        tabs: (await tabStates(electronApp)).map((tab) => [tab.id, tab.url, tab.find]),
        selected: await selectedTabId(electronApp),
        devTools: (await webContentsRoles(electronApp)).filter((e) => e.role === 'devtools').length,
        fullScreen: (await windowInfo(electronApp)).fullScreen,
      });
    const before = await snapshot();

    await sendKey(electronApp, key.tab.webContentsId, 'K', ['control', 'shift']);

    await expectSwallowed(key, 0, 'Ctrl+Shift+K');
    // The palette opens in the shell, which has the keyboard; nothing else changes.
    await expect(palette(shell)).toBeVisible();
    await expect.poll(async () => (await focusedWebContents(electronApp))?.isShell).toBe(true);
    expect(await observeFor(700, snapshot)).toEqual([before]);
    // The page, which does not even block keys, never learns of it.
    expect(await pageEvents(key.page)).toEqual([]);
  });
});

test.describe('keys that are not reserved', () => {
  test.beforeEach(async ({ electronApp, fixtureServer, shell }) => {
    await setSearchTemplate(electronApp, fixtureServer.url('/search?q={searchTerms}'));
    await expect(tabElements(shell)).toHaveCount(1);
  });

  test('AltGr (Ctrl+Alt) combinations are never shortcuts and reach the page', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const key = await loadKeyPage(electronApp, shell, fixtureServer, 'altgr', { hostile: false });
    const before = JSON.stringify(await mainIds(electronApp));
    const hostileSelected = await selectedTabId(electronApp);

    // The letters that are Ctrl shortcuts without Alt, a digit, F5 and the arrow: AltGr+T types a
    // character on many layouts, and none of these may act as the browser's command.
    const combos: readonly [string, string, string][] = [
      ['T', 'KeyT', 'AltGr+T'],
      ['W', 'KeyW', 'AltGr+W'],
      ['L', 'KeyL', 'AltGr+L'],
      ['R', 'KeyR', 'AltGr+R'],
      ['1', 'Digit1', 'AltGr+1'],
      ['F5', 'F5', 'AltGr+F5'],
      ['Left', 'ArrowLeft', 'AltGr+Left'],
    ];
    for (const [keyCode, code, name] of combos) {
      const mark = (await key.inputs.all()).length;
      await sendKey(electronApp, key.tab.webContentsId, keyCode, ['control', 'alt']);
      await expectDelivered(key, mark, name);
      await expect
        .poll(
          async () =>
            (await pageEvents(key.page)).filter(
              (event) => event.type === 'keydown' && event.code === code && event.ctrl && event.alt,
            ).length,
          { message: `${name} should reach the page` },
        )
        .toBe(1);
    }

    // Nothing happened to the browser: the same tabs, the same selection, still on the same page.
    expect(JSON.stringify(await mainIds(electronApp))).toBe(before);
    expect(await selectedTabId(electronApp)).toBe(hostileSelected);
    expect((await tabState(electronApp, key.tab.tabId))?.url).toBe(
      fixtureServer.url('/keys.html?case=altgr'),
    );
    expect(fixtureServer.hits('/keys.html?case=altgr')).toBe(1);
    expect((await windowInfo(electronApp)).fullScreen).toBe(false);
  });

  test('every other key reaches the page, including typing into one of its fields', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const key = await loadKeyPage(electronApp, shell, fixtureServer, 'others', { hostile: false });
    const ids = JSON.stringify(await mainIds(electronApp));

    const others: readonly [string, string, readonly KeyModifier[], string][] = [
      ['K', 'KeyK', ['control'], 'ctrl+k'],
      ['D', 'KeyD', ['control'], 'ctrl+d'],
      ['S', 'KeyS', ['control'], 'ctrl+s'],
      ['N', 'KeyN', ['control'], 'ctrl+n'],
      ['A', 'KeyA', ['control', 'shift'], 'ctrl+shift+a'],
      ['F2', 'F2', [], 'f2'],
      ['F8', 'F8', [], 'f8'],
      ['Left', 'ArrowLeft', ['control'], 'ctrl+arrowleft'],
      ['Tab', 'Tab', ['alt'], 'alt+tab'],
    ];
    for (const [keyCode, code, modifiers, combo] of others) {
      const mark = (await key.inputs.all()).length;
      await sendKey(electronApp, key.tab.webContentsId, keyCode, modifiers);
      await expectDelivered(key, mark, combo);
      await expect
        .poll(
          async () =>
            (await pageEvents(key.page)).filter(
              (event) => event.type === 'keydown' && event.code === code && event.combo === combo,
            ).length,
          { message: `${combo} should reach the page` },
        )
        .toBe(1);
    }
    expect(JSON.stringify(await mainIds(electronApp))).toBe(ids);
    expect(await selectedTabId(electronApp)).toBe(key.tab.tabId);

    // Typing: the characters land in the page's own field.
    await key.page.locator('#field').focus();
    for (const letter of 'hi') {
      await sendKey(electronApp, key.tab.webContentsId, letter);
    }
    await expect(key.page.locator('#field')).toHaveValue('hi');

    // A reserved shortcut still wins while a field of the page has the keyboard.
    await sendKey(electronApp, key.tab.webContentsId, 'T', ['control']);
    await expect.poll(async () => (await mainIds(electronApp)).length).toBe(3);
  });
});

test.describe('reserved shortcuts from the shell', () => {
  test.beforeEach(async ({ electronApp, fixtureServer, shell }) => {
    await setSearchTemplate(electronApp, fixtureServer.url('/search?q={searchTerms}'));
    await expect(tabElements(shell)).toHaveCount(1);
  });

  test('the same keys work while the address bar has the keyboard', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const [first] = await mainIds(electronApp);
    const tabA = await loadTab(
      electronApp,
      shell,
      fixtureServer.url('/page-a.html?case=shell-keys'),
    );
    const hostile = await loadKeyPage(electronApp, shell, fixtureServer, 'shell-keys', {
      hostile: true,
    });
    const shellId = await shellContentsId(electronApp);
    const shellInputs = await recordInputs(electronApp, shellId);

    // The keyboard is in the address bar (Ctrl+L), then Ctrl+Tab selects the next tab (wrapping to
    // the first, the new-tab page) and gives the keyboard to it.
    await sendKey(electronApp, hostile.tab.webContentsId, 'L', ['control']);
    await expect(omnibox(shell)).toBeFocused();
    await sendKey(electronApp, 'shell', 'Tab', ['control']);
    await expectSelectedWithFocus(electronApp, first ?? '');
    await sendKey(electronApp, 'shell', '3', ['control']);
    await expectSelectedWithFocus(electronApp, hostile.tab.tabId);

    // F5 from the address bar reloads the selected tab.
    const path = '/keys.html?case=shell-keys';
    expect(fixtureServer.hits(path)).toBe(1);
    await sendKey(electronApp, 'shell', 'F5');
    await expect.poll(() => fixtureServer.hits(path)).toBe(2);

    // F6 from the address bar goes to the sidebar's selected tab, and from there to the page (M6.2).
    await sendKey(electronApp, hostile.tab.webContentsId, 'L', ['control']);
    await expect(omnibox(shell)).toBeFocused();
    await sendKey(electronApp, 'shell', 'F6');
    await expect(tabElement(shell, hostile.tab.tabId)).toBeFocused();
    await sendKey(electronApp, 'shell', 'F6');
    await expect
      .poll(async () => (await focusedWebContents(electronApp))?.webContentsId)
      .toBe(hostile.tab.webContentsId);

    // Ctrl+T and Ctrl+W from the address bar.
    await sendKey(electronApp, 'shell', 'T', ['control']);
    await expect.poll(async () => (await mainIds(electronApp)).length).toBe(4);
    const created = (await mainIds(electronApp)).at(-1) ?? '';
    await sendKey(electronApp, 'shell', 'W', ['control']);
    await expect.poll(() => tabState(electronApp, created)).toBeUndefined();
    expect(await mainIds(electronApp)).toEqual([first, tabA.tabId, hostile.tab.tabId]);

    // The shell's own handler cancelled every reserved key it was sent.
    const records = await shellInputs.all();
    expect(records.length).toBeGreaterThan(0);
    expect(records.filter((record) => !record.prevented)).toEqual([]);
  });

  test('a held key repeats only for the tab move (Ctrl+Tab), not for Ctrl+T or Ctrl+W', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const [first] = await mainIds(electronApp);
    const tabA = await loadTab(electronApp, shell, fixtureServer.url('/page-a.html?case=held'));
    const tabB = await loadTab(electronApp, shell, fixtureServer.url('/page-b.html?case=held'));
    const order = [first ?? '', tabA.tabId, tabB.tabId];

    // Holding Ctrl+T opens one tab, not one per repeat.
    await holdKey(electronApp, tabB.webContentsId, 'T', ['control'], 3);
    await expect.poll(async () => (await mainIds(electronApp)).length).toBe(4);
    expect(await observeFor(500, async () => (await mainIds(electronApp)).length)).toEqual([4]);
    const fourth = (await mainIds(electronApp)).at(-1) ?? '';

    // Holding Ctrl+W closes one tab: the repeats go to the next tab, which they must not close.
    await holdKey(electronApp, 'shell', 'W', ['control'], 3);
    await expect.poll(() => tabState(electronApp, fourth)).toBeUndefined();
    expect(await observeFor(500, async () => (await mainIds(electronApp)).length)).toEqual([3]);

    // Holding Ctrl+Tab keeps moving: the key press and two repeats are three steps, which on three
    // tabs bring the selection back to where it was.
    await expectSelectedWithFocus(electronApp, tabB.tabId);
    await holdKey(electronApp, tabB.webContentsId, 'Tab', ['control'], 2);
    await expect.poll(() => selectedTabId(electronApp)).toBe(order[2]);
    // Two steps: one press and one repeat land on the second tab.
    await holdKey(electronApp, tabB.webContentsId, 'Tab', ['control'], 1);
    await expect.poll(() => selectedTabId(electronApp)).toBe(order[1]);
  });
});
