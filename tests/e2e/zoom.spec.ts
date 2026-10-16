// Page zoom, M1.3b (assessment §3.9, ADR-0005): Chrome's preset steps, kept per host, with an
// indicator in the address bar while the page is not at 100%. Each spec reads the zoom three ways:
// TabManager (`tabStates()[i].zoomPercent`), the shell (the indicator) and the page itself (its
// `innerWidth` shrinks and its `devicePixelRatio` grows by the factor), so a number that main
// reports without the page really zooming fails.
//
// Keys come from `sendKey` (see find.spec.ts for why). Ctrl+wheel is a mouse wheel event sent the
// same way; Chromium turns it into `zoom-changed`.
import type { ElectronApplication, Page } from '@playwright/test';

import { expect } from './expect';
import { test } from './fixtures';
import { pageForTab, sendKey, setSearchTemplate, tabState, tabStates } from './hooks';
import type { KeyModifier, TabId } from './hooks';
import { observeFor } from './launch';
import {
  loadTab,
  omnibox,
  openNewTab,
  tabElement,
  tabElements,
  typeAddress,
  zoomIndicator,
} from './shell-ui';

test.describe.configure({ timeout: 120_000 });

/** Chrome's presets above 100% and below it, as whole percentages (src/core/layout/zoom.ts). */
const ZOOM_IN_STEPS = [110, 125, 150, 175, 200, 250, 300, 400, 500] as const;
const ZOOM_OUT_STEPS = [90, 80, 75, 67, 50, 33, 25] as const;

type ViewportGlobal = typeof globalThis & { innerWidth: number; devicePixelRatio: number };
type KeyRecorderGlobal = typeof globalThis & {
  keyFixture: { events: { type: string; combo: string }[]; preventCombos: string[] };
};

/** What the page itself says about its size, in CSS pixels and device pixels per CSS pixel. */
function viewportOf(page: Page): Promise<{ width: number; ratio: number }> {
  return page.evaluate(() => {
    const view = globalThis as ViewportGlobal;
    return { width: view.innerWidth, ratio: view.devicePixelRatio };
  });
}

/**
 * The page's pixel ratio relative to `base`, or NaN while the page is not there (a reload destroys
 * the execution context a `page.evaluate` runs in).
 */
async function zoomFactorOf(page: Page, base: number): Promise<number> {
  try {
    return (await viewportOf(page)).ratio / base;
  } catch {
    return Number.NaN;
  }
}

async function zoomOf(app: ElectronApplication, tabId: TabId): Promise<number | undefined> {
  return (await tabState(app, tabId))?.zoomPercent;
}

test.describe('zoom', () => {
  test.beforeEach(async ({ electronApp, fixtureServer, shell }) => {
    await setSearchTemplate(electronApp, fixtureServer.url('/search?q={searchTerms}'));
    await expect(tabElements(shell)).toHaveCount(1);
  });

  test("Ctrl+= steps through Chrome's presets up to 500%, Ctrl+- down to 25%, Ctrl+0 resets", async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/page-a.html'));
    expect(await zoomOf(electronApp, tab.tabId)).toBe(100);
    await expect(zoomIndicator(shell)).toHaveCount(0);

    for (const percent of ZOOM_IN_STEPS) {
      await sendKey(electronApp, tab.webContentsId, '=', ['control']);
      await expect
        .poll(() => zoomOf(electronApp, tab.tabId), { message: `zoom in to ${String(percent)}%` })
        .toBe(percent);
      await expect(zoomIndicator(shell)).toHaveText(`${String(percent)}%`);
    }
    // 500% is the end: another press changes nothing.
    await sendKey(electronApp, tab.webContentsId, '=', ['control']);
    expect(await observeFor(500, () => zoomOf(electronApp, tab.tabId))).toEqual([500]);

    await sendKey(electronApp, tab.webContentsId, '0', ['control']);
    await expect.poll(() => zoomOf(electronApp, tab.tabId)).toBe(100);
    await expect(zoomIndicator(shell)).toHaveCount(0);

    for (const percent of ZOOM_OUT_STEPS) {
      await sendKey(electronApp, tab.webContentsId, '-', ['control']);
      await expect
        .poll(() => zoomOf(electronApp, tab.tabId), { message: `zoom out to ${String(percent)}%` })
        .toBe(percent);
      await expect(zoomIndicator(shell)).toHaveText(`${String(percent)}%`);
    }
    // 25% is the end.
    await sendKey(electronApp, tab.webContentsId, '-', ['control']);
    expect(await observeFor(500, () => zoomOf(electronApp, tab.tabId))).toEqual([25]);

    await sendKey(electronApp, tab.webContentsId, '0', ['control']);
    await expect.poll(() => zoomOf(electronApp, tab.tabId)).toBe(100);
  });

  test('Ctrl+Plus and the numeric keypad zoom as well', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/page-a.html'));
    const keys: readonly [string, string, readonly KeyModifier[], number][] = [
      ['Ctrl+Plus', 'Plus', ['control'], 110],
      ['Ctrl+numpad plus', 'numadd', ['control'], 125],
      ['Ctrl+numpad minus', 'numsub', ['control'], 110],
      ['Ctrl+minus', '-', ['control'], 100],
      ['Ctrl+numpad minus', 'numsub', ['control'], 90],
      ['Ctrl+numpad 0', 'num0', ['control'], 100],
    ];
    for (const [name, key, modifiers, expected] of keys) {
      await sendKey(electronApp, tab.webContentsId, key, modifiers);
      await expect
        .poll(() => zoomOf(electronApp, tab.tabId), {
          message: `after ${name} the zoom should be ${String(expected)}%`,
        })
        .toBe(expected);
    }
  });

  test('the page really zooms: its width shrinks and its pixel ratio grows by the factor', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/page-a.html'));
    const page = await pageForTab(electronApp, tab.tabId);
    const normal = await viewportOf(page);

    for (const [key, factor] of [
      ['=', 1.1],
      ['=', 1.25],
      ['=', 1.5],
    ] as const) {
      await sendKey(electronApp, tab.webContentsId, key, ['control']);
      await expect
        .poll(() => zoomFactorOf(page, normal.ratio), {
          message: `the page should be at ${String(factor)}`,
        })
        .toBeCloseTo(factor, 2);
      const zoomed = await viewportOf(page);
      // The same window shows fewer CSS pixels (rounded to whole pixels, so one off at most).
      expect(Math.abs(zoomed.width - normal.width / factor)).toBeLessThanOrEqual(1);
    }

    // The zoom outlives a reload (it belongs to the host), and Ctrl+0 undoes all of it.
    await sendKey(electronApp, tab.webContentsId, 'R', ['control']);
    await expect.poll(() => zoomFactorOf(page, normal.ratio)).toBeCloseTo(1.5, 2);
    await sendKey(electronApp, tab.webContentsId, '0', ['control']);
    await expect.poll(() => zoomFactorOf(page, normal.ratio)).toBeCloseTo(1, 2);
    expect(Math.abs((await viewportOf(page)).width - normal.width)).toBeLessThanOrEqual(1);

    // Zooming out shows more CSS pixels.
    await sendKey(electronApp, tab.webContentsId, '-', ['control']);
    await expect.poll(() => zoomFactorOf(page, normal.ratio)).toBeCloseTo(0.9, 2);
    expect(Math.abs((await viewportOf(page)).width - normal.width / 0.9)).toBeLessThanOrEqual(1);
  });

  test('the indicator shows the zoom, names what a click does, and a click resets', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/page-a.html'));
    const page = await pageForTab(electronApp, tab.tabId);
    const normal = await viewportOf(page);
    await expect(zoomIndicator(shell)).toHaveCount(0);

    await sendKey(electronApp, tab.webContentsId, '=', ['control']);
    await sendKey(electronApp, tab.webContentsId, '=', ['control']);
    await expect.poll(() => zoomOf(electronApp, tab.tabId)).toBe(125);
    const indicator = zoomIndicator(shell);
    await expect(indicator).toBeVisible();
    await expect(indicator).toHaveText('125%');
    await expect(indicator).toHaveAccessibleName('Zoom 125%: reset to 100%');
    // It sits in the address bar's row, next to the field.
    const field = await omnibox(shell).boundingBox();
    const badge = await indicator.boundingBox();
    expect(field).not.toBeNull();
    expect(badge).not.toBeNull();
    expect(badge?.x ?? 0).toBeGreaterThan((field?.x ?? 0) + (field?.width ?? 0) - 1);

    await indicator.click();

    await expect.poll(() => zoomOf(electronApp, tab.tabId)).toBe(100);
    await expect(indicator).toHaveCount(0);
    await expect.poll(() => zoomFactorOf(page, normal.ratio)).toBeCloseTo(1, 2);

    // Below 100% it says so too.
    await sendKey(electronApp, tab.webContentsId, '-', ['control']);
    await expect(indicator).toHaveText('90%');
    await expect(indicator).toHaveAccessibleName('Zoom 90%: reset to 100%');
  });

  test('zoom is kept per host: tabs on one host share it, another host keeps its own', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tabA = await loadTab(electronApp, shell, fixtureServer.url('/page-a.html'));
    const tabB = await loadTab(electronApp, shell, fixtureServer.url('/page-b.html'));
    // A third tab on another host name (the fixture server answers on localhost too).
    const port = new URL(fixtureServer.origin).port;
    const tabC = await loadTab(electronApp, shell, `http://localhost:${port}/page-c.html`);
    expect((await tabStates(electronApp)).map((t) => t.zoomPercent)).toEqual([100, 100, 100, 100]);

    // Zoom A. B is on the same host, so it follows; the page shows it, not only the number.
    const pageB = await pageForTab(electronApp, tabB.tabId);
    const normalB = await viewportOf(pageB);
    await tabElement(shell, tabA.tabId).click();
    await expect(tabElement(shell, tabA.tabId)).toHaveAttribute('aria-selected', 'true');
    await sendKey(electronApp, tabA.webContentsId, '=', ['control']);
    await sendKey(electronApp, tabA.webContentsId, '=', ['control']);
    await expect.poll(() => zoomOf(electronApp, tabA.tabId)).toBe(125);
    await expect.poll(() => zoomOf(electronApp, tabB.tabId)).toBe(125);
    await expect.poll(() => zoomFactorOf(pageB, normalB.ratio)).toBeCloseTo(1.25, 2);
    // localhost is another host: untouched.
    expect(await zoomOf(electronApp, tabC.tabId)).toBe(100);

    // Zoom the other host: the first one keeps its own level.
    await tabElement(shell, tabC.tabId).click();
    await expect(tabElement(shell, tabC.tabId)).toHaveAttribute('aria-selected', 'true');
    await sendKey(electronApp, tabC.webContentsId, '-', ['control']);
    await expect.poll(() => zoomOf(electronApp, tabC.tabId)).toBe(90);
    expect(await zoomOf(electronApp, tabA.tabId)).toBe(125);
    expect(await zoomOf(electronApp, tabB.tabId)).toBe(125);

    // Each tab's indicator follows the tab that is selected.
    await expect(zoomIndicator(shell)).toHaveText('90%');
    await tabElement(shell, tabB.tabId).click();
    await expect(tabElement(shell, tabB.tabId)).toHaveAttribute('aria-selected', 'true');
    await expect(zoomIndicator(shell)).toHaveText('125%');

    // A tab that opens later on a zoomed host starts at that zoom.
    const tabD = await loadTab(electronApp, shell, fixtureServer.url('/page-a.html?later=1'));
    await expect.poll(() => zoomOf(electronApp, tabD.tabId)).toBe(125);
    await expect(zoomIndicator(shell)).toHaveText('125%');

    // Navigating a tab between the hosts changes the zoom with the host, and back again.
    await typeAddress(shell, `http://localhost:${port}/page-c.html?moved=1`);
    await expect.poll(() => zoomOf(electronApp, tabD.tabId)).toBe(90);
    await expect(zoomIndicator(shell)).toHaveText('90%');
    await typeAddress(shell, fixtureServer.url('/page-b.html?back=1'));
    await expect.poll(() => zoomOf(electronApp, tabD.tabId)).toBe(125);
    await expect(zoomIndicator(shell)).toHaveText('125%');
  });

  test('a new-tab page has no zoom: the keys do nothing', async ({ electronApp, shell }) => {
    const tabId = await openNewTab(shell);

    await sendKey(electronApp, 'shell', '=', ['control']);
    await sendKey(electronApp, 'shell', '-', ['control']);
    await sendKey(electronApp, 'shell', '0', ['control']);

    expect(await observeFor(500, () => zoomOf(electronApp, tabId))).toEqual([100]);
    await expect(zoomIndicator(shell)).toHaveCount(0);
    expect((await tabStates(electronApp)).map((t) => t.zoomPercent)).toEqual([100, 100]);
    await expect(omnibox(shell)).toBeFocused();
  });

  test('page first: a page that handles the zoom keys keeps them', async ({
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

    // The page claims Ctrl+=, Ctrl+Plus, Ctrl+- and Ctrl+0, as a map or an editor would.
    await page.evaluate(() => {
      (globalThis as KeyRecorderGlobal).keyFixture.preventCombos = [
        'ctrl+=',
        'ctrl+shift++',
        'ctrl+-',
        'ctrl+0',
      ];
    });
    await sendKey(electronApp, tab.webContentsId, '=', ['control']);
    await sendKey(electronApp, tab.webContentsId, 'Plus', ['control']);
    await sendKey(electronApp, tab.webContentsId, '-', ['control']);
    await sendKey(electronApp, tab.webContentsId, '0', ['control']);
    await expect.poll(received).toEqual(['ctrl+=', 'ctrl+shift++', 'ctrl+-', 'ctrl+0']);
    expect(await observeFor(700, () => zoomOf(electronApp, tab.tabId))).toEqual([100]);
    await expect(zoomIndicator(shell)).toHaveCount(0);

    // The page lets one through: it still sees the key, and the browser zooms.
    await page.evaluate(() => {
      (globalThis as KeyRecorderGlobal).keyFixture.preventCombos = [];
    });
    await sendKey(electronApp, tab.webContentsId, '=', ['control']);
    await expect.poll(() => zoomOf(electronApp, tab.tabId)).toBe(110);
    expect((await received()).at(-1)).toBe('ctrl+=');
  });

  test('Ctrl+wheel up zooms in and down zooms out, by presets; the wheel alone does not zoom', async ({
    electronApp,
    fixtureServer,
    shell,
  }) => {
    const tab = await loadTab(electronApp, shell, fixtureServer.url('/page-a.html'));
    const page = await pageForTab(electronApp, tab.tabId);
    const normal = await viewportOf(page);

    // Chromium zooms by wheel notches, so the event carries `wheelTicksY`; without it nothing
    // happens. One synthetic wheel event makes Chromium report `zoom-changed` twice on Electron
    // 44.7.2 (measured with a bare listener on the web contents), so a step count would test the
    // harness. The direction and the presets are the contract.
    const wheel = (deltaY: number, modifiers: readonly KeyModifier[]): Promise<void> =>
      electronApp.evaluate(
        ({ webContents }, { id, delta, held }) => {
          const contents = webContents.fromId(id);
          if (contents === undefined) {
            throw new Error('The tab has no web contents.');
          }
          contents.sendInputEvent({
            type: 'mouseWheel',
            x: 60,
            y: 60,
            deltaX: 0,
            deltaY: delta,
            wheelTicksY: Math.sign(delta),
            modifiers: [...held],
            canScroll: true,
          });
        },
        { id: tab.webContentsId, delta: deltaY, held: modifiers },
      );

    // The wheel alone scrolls (here: there is nothing to scroll) and never zooms.
    await wheel(120, []);
    await wheel(-120, []);
    expect(await observeFor(500, () => zoomOf(electronApp, tab.tabId))).toEqual([100]);

    // Wheel up with Ctrl held is "in", as in Chrome.
    await wheel(120, ['control']);
    await expect.poll(() => zoomOf(electronApp, tab.tabId)).toBeGreaterThan(100);
    const zoomedIn = await zoomOf(electronApp, tab.tabId);
    expect(ZOOM_IN_STEPS).toContain(zoomedIn);
    await expect(zoomIndicator(shell)).toHaveText(`${String(zoomedIn)}%`);
    await expect
      .poll(() => zoomFactorOf(page, normal.ratio))
      .toBeCloseTo((zoomedIn ?? 100) / 100, 2);

    // Wheel down is "out": it undoes what the same wheel up did.
    await wheel(-120, ['control']);
    await expect.poll(() => zoomOf(electronApp, tab.tabId)).toBe(100);
    await expect(zoomIndicator(shell)).toHaveCount(0);

    await wheel(-120, ['control']);
    await expect.poll(() => zoomOf(electronApp, tab.tabId)).toBeLessThan(100);
    const zoomedOut = await zoomOf(electronApp, tab.tabId);
    expect(ZOOM_OUT_STEPS).toContain(zoomedOut);
    await expect(zoomIndicator(shell)).toHaveText(`${String(zoomedOut)}%`);
  });
});
