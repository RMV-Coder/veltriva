// Fixtures for the E2E specs. Each test gets its own app instance and a fresh profile directory.
// The rules they follow are listed at the top of ./launch.ts.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test as base } from '@playwright/test';
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';

import { startFixtureServer } from '../fixtures/server';
import type { FixtureServer } from '../fixtures/server';
import { closeTestTabsInMain, openTab as openTabInApp } from './hooks';
import type { TestTab } from './hooks';
import { CLOSE_TIMEOUT_WARNING, closeApp, findShellPage, launchApp, shellPage } from './launch';

export { expect } from '@playwright/test';

export type ThemeSource = 'system' | 'light' | 'dark';

interface Fixtures {
  /**
   * Chromium switches the app starts with (none by default). Set with `test.use`, only in a spec
   * that has to change one thing about the browser, as certificates.spec.ts does to trust one
   * throwaway key.
   */
  appSwitches: readonly string[];
  /** A new, empty directory used as the app's userData. Removed after the app has closed. */
  userDataDir: string;
  /** The launched app. Always closed after the test, even when the test fails. */
  electronApp: ElectronApplication;
  /** The shell page, found by its URL. Never close it. */
  shell: Page;
  /**
   * Opens a tab-role view on `url` and returns it as a Page (see `openTab` in ./hooks.ts).
   * Every tab it opened is closed through the test hook when the test ends. Never `page.close()`.
   */
  openTab: (url: string, options?: { readonly preload?: string }) => Promise<TestTab>;
  /**
   * Sets `nativeTheme.themeSource` in the app. Whatever the test did, the source is set back to
   * 'system' afterwards, so a failure can't leave the machine's theme overridden.
   */
  setThemeSource: (source: ThemeSource) => Promise<void>;
}

interface WorkerFixtures {
  /** A local HTTP server for fixture pages (tests/fixtures). One per worker. */
  fixtureServer: FixtureServer;
}

/**
 * Setup (launch, up to 60 s) and teardown (close, up to 30 s) get their own time budget, so a
 * slow first launch on a CI runner doesn't eat into the 60 s the test body has.
 */
const APP_FIXTURE_TIMEOUT_MS = 150_000;

export const test = base.extend<Fixtures, WorkerFixtures>({
  fixtureServer: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const server = await startFixtureServer();
      try {
        await use(server);
      } finally {
        await server.close();
      }
    },
    { scope: 'worker' },
  ],

  // Playwright needs the destructuring pattern to see that this fixture has no dependencies.
  // eslint-disable-next-line no-empty-pattern
  userDataDir: async ({}, use) => {
    const dir = await mkdtemp(join(tmpdir(), 'veltriva-e2e-'));
    try {
      await use(dir);
    } finally {
      // Torn down after `electronApp`, i.e. after the app has exited. Windows can hold the
      // files for a moment longer, hence the retries.
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(
        (error: unknown) => {
          console.warn(`Could not remove the temporary profile ${dir}:`, error);
        },
      );
    }
  },

  appSwitches: [[], { option: true }],

  electronApp: [
    async ({ userDataDir, appSwitches }, use, testInfo) => {
      const app = await launchApp(userDataDir, { switches: appSwitches });
      try {
        await use(app);
      } finally {
        await attachShellScreenshotOnFailure(app, testInfo);
        if ((await closeApp(app)) === 'killed') {
          testInfo.annotations.push({ type: 'warning', description: CLOSE_TIMEOUT_WARNING });
          console.warn(CLOSE_TIMEOUT_WARNING);
        }
      }
    },
    { timeout: APP_FIXTURE_TIMEOUT_MS },
  ],

  shell: async ({ electronApp }, use) => {
    await use(await shellPage(electronApp));
  },

  openTab: async ({ electronApp }, use) => {
    // An object, so the checker sees that the closure below can change it.
    const state = { opened: false };
    await use(async (url, options) => {
      state.opened = true;
      return openTabInApp(electronApp, url, options);
    });
    if (state.opened) {
      try {
        await closeTestTabsInMain(electronApp);
      } catch (error) {
        console.warn('Could not close the test tabs:', error);
      }
    }
  },

  setThemeSource: async ({ electronApp }, use) => {
    const apply = (source: ThemeSource): Promise<void> =>
      electronApp.evaluate(({ nativeTheme }, themeSource) => {
        nativeTheme.themeSource = themeSource;
      }, source);

    const state = { changed: false };
    await use(async (source) => {
      state.changed = true;
      await apply(source);
    });
    if (state.changed) {
      try {
        await apply('system');
      } catch (error) {
        console.warn("Could not set nativeTheme.themeSource back to 'system':", error);
      }
    }
  },
});

/** A screenshot of the shell is the quickest way to see why a test failed. */
async function attachShellScreenshotOnFailure(
  app: ElectronApplication,
  testInfo: TestInfo,
): Promise<void> {
  if (testInfo.status === testInfo.expectedStatus) {
    return;
  }
  try {
    const page = findShellPage(app);
    if (page === undefined) {
      return;
    }
    // Saved in the test's output folder, so it is on disk for any reporter.
    const path = testInfo.outputPath('shell-on-failure.png');
    await page.screenshot({ path, timeout: 10_000 });
    await testInfo.attach('shell-on-failure', { path, contentType: 'image/png' });
  } catch (error) {
    console.warn('Could not capture a screenshot of the shell:', error);
  }
}
