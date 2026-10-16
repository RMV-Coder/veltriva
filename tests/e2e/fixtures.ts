// Fixtures for the E2E specs. Each test gets its own app instance and a fresh profile directory.
// The rules they follow are listed at the top of ./launch.ts.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test as base } from '@playwright/test';
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';

import { CLOSE_TIMEOUT_WARNING, closeApp, findShellPage, launchApp, shellPage } from './launch';

export { expect } from '@playwright/test';

interface Fixtures {
  /** A new, empty directory used as the app's userData. Removed after the app has closed. */
  userDataDir: string;
  /** The launched app. Always closed after the test, even when the test fails. */
  electronApp: ElectronApplication;
  /** The shell page, found by its URL. Never close it. */
  shell: Page;
}

/**
 * Setup (launch, up to 60 s) and teardown (close, up to 30 s) get their own time budget, so a
 * slow first launch on a CI runner doesn't eat into the 60 s the test body has.
 */
const APP_FIXTURE_TIMEOUT_MS = 150_000;

export const test = base.extend<Fixtures>({
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

  electronApp: [
    async ({ userDataDir }, use, testInfo) => {
      const app = await launchApp(userDataDir);
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
