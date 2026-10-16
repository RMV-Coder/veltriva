import { defineConfig } from 'vitest/config';

// Lifecycle behavior tests (ADR-0008 4a) start the built test app without Playwright. Run them
// with `npm run test:lifecycle`, which builds the test variant first; `npm test` doesn't run them.
export default defineConfig({
  test: {
    include: ['tests/lifecycle/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    // One app at a time: two would compete for the screen and the CPU they measure.
    fileParallelism: false,
  },
});
