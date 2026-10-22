import { defineConfig } from 'vitest/config';

// The memory benchmark of assessment §9.3 (tests/benchmarks) starts the built test app without
// Playwright, once per run, for over an hour in all. Run it with `npm run bench:memory` on a quiet
// machine; `npm test` and the lifecycle harness never run it.
export default defineConfig({
  test: {
    include: ['tests/benchmarks/**/*.bench.ts'],
    environment: 'node',
    testTimeout: 6 * 60 * 60 * 1000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
