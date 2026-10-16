import { defineConfig } from '@playwright/test';

// End-to-end tests drive the built (unpackaged) app through `_electron.launch()` (ADR-0008 §4).
// There is no web server and no browser project: tests/e2e/fixtures.ts launches Electron itself.
// Run `npm run build` first.
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',

  // One Electron instance at a time. Failures must be honest, so no retries.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,

  timeout: 60_000,
  expect: { timeout: 10_000 },

  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  outputDir: 'test-results',
});
