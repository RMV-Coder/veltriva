// M5.0: a page whose `beforeunload` objects can no longer silently stop the user. Electron answers
// a navigation or a reload that the page objects to by cancelling it, with no dialog; Veltriva
// asks "Leave page?" in the toolbar (the same question as for a close, M3.3), and Leave does it
// again, overriding the page once. And Ctrl+P prints (the page may claim the key first).
//
// Rules from ADR-0008 item 4: real clicks and keys are `sendInputEvent` from main (`clickElement`,
// `sendKey`), so the page gets user activation, which `beforeunload` needs; test builds record a
// print request instead of opening the system dialog (src/main/testing/print-requests.ts).
import { expect } from './expect';
import { test } from './fixtures';
import {
  clickElement,
  evaluateInTab,
  invokeContextMenuItem,
  sendKey,
  setSearchTemplate,
  tabState,
} from './hooks';
import type { ElectronApplication } from '@playwright/test';
import { clickNow, clickYes, expectNoStrip, stripSentence, waitForStrip } from './prompt-ui';
import { loadTab, typeAddress } from './shell-ui';
import type { LoadedTab } from './shell-ui';

/** The tabs whose page main was asked to print. */
function printRequests(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => globalThis.__veltrivaTest?.printRequests() ?? []);
}

test.describe('"Leave page?" for a navigation the page objects to', () => {
  test.beforeEach(async ({ electronApp, fixtureServer }) => {
    await setSearchTemplate(electronApp, fixtureServer.url('/search?q={searchTerms}'));
  });

  /** A selected page that objects to every unload, which the user has clicked in. */
  async function objectingPage(
    electronApp: ElectronApplication,
    shell: Parameters<typeof loadTab>[1],
    url: string,
  ): Promise<LoadedTab> {
    const tab = await loadTab(electronApp, shell, url);
    await clickElement(electronApp, tab.webContentsId, '#button');
    expect(
      await evaluateInTab(electronApp, tab.webContentsId, 'navigator.userActivation.hasBeenActive'),
    ).toBe(true);
    return tab;
  }

  test('an address typed in the address bar: the page objects, Stay keeps it, Leave goes there', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const url = fixtureServer.url('/lifecycle-unload.html?mode=always');
    const target = fixtureServer.url('/page-b.html');
    const tab = await objectingPage(electronApp, shell, url);

    await typeAddress(shell, target);
    await waitForStrip(shell, 'leave-page');
    const host = new URL(url).host;
    await expect(stripSentence(shell)).toHaveText(
      `Leave ${host}? Changes you made may not be saved.`,
    );
    expect((await tabState(electronApp, tab.tabId))?.url).toBe(url);

    await clickNow(shell, 'Stay');
    await expectNoStrip(shell, 'Stay should take the question down');
    expect((await tabState(electronApp, tab.tabId))?.url).toBe(url);

    await typeAddress(shell, target);
    await waitForStrip(shell, 'leave-page');
    await clickYes(shell, 'Leave');
    await expect.poll(async () => (await tabState(electronApp, tab.tabId))?.url).toBe(target);
    await expectNoStrip(shell);
  });

  test('a reload (F5) the page objects to is asked about, and Leave reloads', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tab = await objectingPage(
      electronApp,
      shell,
      fixtureServer.url('/lifecycle-unload.html?mode=always'),
    );
    await evaluateInTab(electronApp, tab.webContentsId, 'window.__reloadMark = 1');

    await sendKey(electronApp, tab.webContentsId, 'F5');
    await waitForStrip(shell, 'leave-page');
    // Not reloaded yet: the page and its mark are still there.
    expect(await evaluateInTab(electronApp, tab.webContentsId, 'window.__reloadMark')).toBe(1);

    await clickYes(shell, 'Leave');
    await expect
      .poll(() => evaluateInTab(electronApp, tab.webContentsId, 'window.__reloadMark ?? null'))
      .toBeNull();
  });

  // A known limit (M5.0): a link inside the page is the page's own navigation. Its handler runs in
  // the renderer before main hears of any navigation, so Electron gives no target to go to again,
  // and the page's objection stands, as before. The address bar still asks (the test above).
  test('a link inside the page that objects keeps the page: nothing is asked (a known limit)', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const url = fixtureServer.url('/lifecycle-unload.html?mode=always');
    const tab = await objectingPage(electronApp, shell, url);
    await evaluateInTab(
      electronApp,
      tab.webContentsId,
      `(() => { const a = document.createElement('a'); a.id = 'away'; a.href = ${JSON.stringify(fixtureServer.url('/page-c.html'))}; a.textContent = 'Away'; a.style.cssText = 'position:fixed;left:20px;top:120px;padding:12px'; document.body.append(a); return 1; })()`,
    );

    await clickElement(electronApp, tab.webContentsId, '#away');
    await expect
      .poll(() => evaluateInTab(electronApp, tab.webContentsId, 'window.__veltrivaUnload.objected'))
      .toBe(1);
    await expectNoStrip(shell);
    expect((await tabState(electronApp, tab.tabId))?.url).toBe(url);
  });

  test('a page that never objects navigates as before, with no question', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tab = await objectingPage(
      electronApp,
      shell,
      fixtureServer.url('/lifecycle-unload.html?mode=never'),
    );
    const target = fixtureServer.url('/page-b.html');

    await typeAddress(shell, target);
    await expect.poll(async () => (await tabState(electronApp, tab.tabId))?.url).toBe(target);
    await expectNoStrip(shell);
  });
});

test.describe('printing (M5.0)', () => {
  test('Ctrl+P prints the page, and so does the page menu\'s "Print…"', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/page-a.html'));

    await sendKey(electronApp, tab.webContentsId, 'P', ['control']);
    await expect.poll(() => printRequests(electronApp)).toEqual([tab.tabId]);

    await invokeContextMenuItem(electronApp, tab.tabId, {}, 'print');
    await expect.poll(() => printRequests(electronApp)).toEqual([tab.tabId, tab.tabId]);
  });

  test('a page that handles Ctrl+P itself keeps it: nothing is printed', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/page-a.html'));
    await evaluateInTab(
      electronApp,
      tab.webContentsId,
      "document.addEventListener('keydown', (event) => { if (event.ctrlKey && event.key.toLowerCase() === 'p') { event.preventDefault(); window.__ownPrint = (window.__ownPrint ?? 0) + 1; } }); 1",
    );

    await sendKey(electronApp, tab.webContentsId, 'P', ['control']);
    await expect
      .poll(() => evaluateInTab(electronApp, tab.webContentsId, 'window.__ownPrint ?? 0'))
      .toBe(1);
    expect(await printRequests(electronApp)).toEqual([]);
  });
});
