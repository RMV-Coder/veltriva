import { configDefaults, defineConfig } from 'vitest/config';

// Unit tests run on plain Node 24, next to the code they test (ADR-0008 §1).
// Playwright specs live in tests/e2e and are run by `npm run test:e2e`, not here.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // `npm run test:coverage` (`--coverage`) measures the pure core and the data layer and fails
    // below ADR-0008's floors: src/core 90% of lines and branches, src/data 80% (assessment §9.4).
    // Every file counts, tested or not. Test helpers and fixtures don't.
    coverage: {
      provider: 'v8',
      include: ['src/core/**/*.ts', 'src/data/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/*.d.ts',
        'src/data/testing/**',
        'src/data/migrations/fixtures/**',
        'src/data/repos/test-database.ts',
      ],
      reporter: ['text-summary', 'text', 'html'],
      thresholds: {
        'src/core/**': { lines: 90, branches: 90 },
        'src/data/**': { lines: 80, branches: 80 },
      },
    },
    // The data layer's tests work on real SQLite files (ADR-0008 §3). On GitHub's runner, under
    // coverage, one of them now and then took 6 to 13 s where the same test usually takes well
    // under one, and failed at vitest's 5 s default (integrity, repos/search, server), or a hook
    // that opens a database failed at the 10 s one (maintenance). They get 30 s for a test and
    // for a hook; everything else keeps the defaults.
    projects: [
      {
        // Not inherited: the root's `include` would be added to this one, not replaced by it.
        extends: false,
        test: {
          name: 'data',
          include: ['src/data/**/*.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'unit',
          exclude: [...configDefaults.exclude, 'src/data/**'],
        },
      },
    ],
  },
});
