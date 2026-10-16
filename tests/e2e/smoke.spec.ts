// Smoke tests for the M1.1 placeholder shell. Each test launches its own app (see ./fixtures.ts).
// They are deterministic and use no network. They check app state, not timing or visibility
// behavior, which Playwright masks (spike S6).
import { normalize } from 'node:path';

import type { Page } from '@playwright/test';
import type { WebContents, WebPreferences } from 'electron';

import type { ShellApi } from '../../src/shared/shell-api';
import { expect, test } from './fixtures';
import { observeFor } from './launch';

// The page runs in a browser, but the Node-only tsconfig has no DOM types. In the page, `globalThis`
// is the window, so describe the few globals the tests use.
interface PageGlobals {
  veltriva: ShellApi;
  location: { href: string };
  open(url: string): unknown;
  document: {
    querySelector(
      selector: string,
    ): { textContent: string | null; checkVisibility(): boolean } | null;
  };
}
type PageGlobal = typeof globalThis & PageGlobals;

// Present on every WebContents at runtime, but missing from Electron's typings.
interface HasLastWebPreferences {
  getLastWebPreferences(): Pick<WebPreferences, 'sandbox' | 'contextIsolation' | 'nodeIntegration'>;
}

/** Reads `window.veltriva.runtime` as the page sees it. */
function readRuntime(shell: Page): Promise<ShellApi['runtime']> {
  return shell.evaluate(() => {
    const { electron, chrome } = (globalThis as PageGlobal).veltriva.runtime;
    return { electron, chrome };
  });
}

/** The page's `<h1>`, read with `evaluate`. See the navigation test for why not a locator. */
function readHeading(shell: Page): Promise<{ text: string | null; visible: boolean }> {
  return shell.evaluate(() => {
    const h1 = (globalThis as PageGlobal).document.querySelector('h1');
    return { text: h1?.textContent ?? null, visible: h1?.checkVisibility() ?? false };
  });
}

test.describe('Veltriva shell', () => {
  test('shows the placeholder shell in a single window', async ({ electronApp, shell }) => {
    await expect(shell.getByRole('heading', { level: 1, name: 'Veltriva Browser' })).toBeVisible();
    await expect(shell.locator('h1')).toHaveCount(1);
    await expect(shell.getByText('Browse freely. Remember effortlessly.')).toBeVisible();

    const windowCount = await electronApp.evaluate(
      ({ BaseWindow }) => BaseWindow.getAllWindows().length,
    );
    expect(windowCount).toBe(1);
  });

  test('"About this build" reveals the Electron and Chromium versions', async ({
    electronApp,
    shell,
  }) => {
    const toggle = shell.getByRole('button', { name: 'About this build' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(shell.getByRole('region', { name: 'Build details' })).toHaveCount(0);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    const runtime = await readRuntime(shell);
    const details = shell.getByRole('region', { name: 'Build details' });
    await expect(details).toContainText(`Electron ${runtime.electron}`);
    await expect(details).toContainText(`Chromium ${runtime.chrome}`);

    // What the preload exposes must be what the main process runs on.
    const mainVersions = await electronApp.evaluate(() => ({
      electron: process.versions.electron,
      chrome: process.versions.chrome,
    }));
    expect(runtime).toEqual(mainVersions);
  });

  test('keeps the shell sandboxed, isolated and without Node', async ({
    electronApp,
    shell,
    userDataDir,
  }) => {
    // In the page: no Node globals, and a frozen bridge object.
    const page = await shell.evaluate(() => {
      const { veltriva } = globalThis as PageGlobal;
      return {
        require: typeof require,
        process: typeof process,
        module: typeof module,
        apiFrozen: Object.isFrozen(veltriva),
        runtimeFrozen: Object.isFrozen(veltriva.runtime),
      };
    });
    expect(page).toEqual({
      require: 'undefined',
      process: 'undefined',
      module: 'undefined',
      apiFrozen: true,
      runtimeFrozen: true,
    });

    // In main: the shell's web contents is matched by URL, never by index.
    const main = await electronApp.evaluate(({ app, webContents }, shellUrl) => {
      const shells = webContents.getAllWebContents().filter((wc) => wc.getURL() === shellUrl);
      const preferences = shells.map((wc) => {
        const { sandbox, contextIsolation, nodeIntegration } = (
          wc as WebContents & HasLastWebPreferences
        ).getLastWebPreferences();
        return { sandbox, contextIsolation, nodeIntegration };
      });
      return {
        sandboxSwitch: app.commandLine.hasSwitch('enable-sandbox'),
        preferences,
        userData: app.getPath('userData'),
      };
    }, shell.url());

    expect(main.sandboxSwitch).toBe(true);
    expect(main.preferences).toEqual([
      { sandbox: true, contextIsolation: true, nodeIntegration: false },
    ]);
    expect(normalize(main.userData)).toBe(normalize(userDataDir));
  });

  test('cannot navigate away or open windows', async ({ electronApp, shell }) => {
    const shellUrl = shell.url();
    await expect(shell.getByRole('heading', { level: 1, name: 'Veltriva Browser' })).toBeVisible();

    // Count the `will-navigate` events the shell sees. The app's own handler is registered first,
    // so `defaultPrevented` tells whether it cancelled the navigation.
    const navigations = await electronApp.evaluateHandle(({ webContents }, url) => {
      const counts = { attempted: 0, cancelled: 0 };
      for (const wc of webContents.getAllWebContents()) {
        if (wc.getURL() === url) {
          wc.on('will-navigate', (event) => {
            counts.attempted += 1;
            if (event.defaultPrevented) {
              counts.cancelled += 1;
            }
          });
        }
      }
      return counts;
    }, shellUrl);

    // `.invalid` never resolves, and the navigation is cancelled before any request is made.
    await shell.evaluate(() => {
      (globalThis as PageGlobal).location.href = 'https://example.invalid/';
    });
    await expect
      .poll(async () => (await navigations.jsonValue()).attempted, { timeout: 5_000 })
      .toBe(1);
    expect(await navigations.jsonValue()).toEqual({ attempted: 1, cancelled: 1 });

    // Give a navigation that wrongly went ahead time to commit.
    expect(await observeFor(1_000, () => shell.url())).toEqual([shellUrl]);

    // From here on, no locator: Playwright never learns that the app cancelled the navigation. It
    // keeps the main frame "navigating", and locator actions and assertions wait for that
    // forever. `evaluate` doesn't wait.
    expect(await readHeading(shell)).toEqual({ text: 'Veltriva Browser', visible: true });

    // The window-open handler denies, so `window.open` returns null and no page appears.
    const popup = await shell.evaluate(
      () => (globalThis as PageGlobal).open('https://example.invalid/') === null,
    );
    expect(popup).toBe(true);
    expect(await observeFor(1_000, () => electronApp.windows().length)).toEqual([1]);
    expect(shell.url()).toBe(shellUrl);
  });
});
