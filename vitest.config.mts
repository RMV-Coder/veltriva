import { defineConfig } from 'vitest/config';

// Unit tests run on plain Node 24, next to the code they test (ADR-0008 §1).
// Playwright specs live in tests/e2e and are run by `npm run test:e2e`, not here.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
