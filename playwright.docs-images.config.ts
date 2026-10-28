import { defineConfig } from '@playwright/test';

// The README's screenshots and GIFs (M6.4): `npm run docs:images` builds the test variant and
// runs tests/docs-images/capture.spec.ts, which writes docs/images/. Not part of the E2E suite.
export default defineConfig({
  testDir: './tests/docs-images',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 20 * 60_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  outputDir: 'test-results/docs-images',
});
