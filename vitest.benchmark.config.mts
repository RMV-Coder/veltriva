import { defineConfig } from 'vitest/config';

// The benchmarks in tests/benchmarks start the built test app without Playwright, once per run:
// the memory benchmark of §9.3 (`npm run bench:memory`, over an hour) and the search benchmark of
// §5.4 (`npm run bench:search`). Run them on a quiet machine; `npm test` and the lifecycle harness
// never run them.
export default defineConfig({
  test: {
    include: ['tests/benchmarks/**/*.bench.ts'],
    environment: 'node',
    testTimeout: 6 * 60 * 60 * 1000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
