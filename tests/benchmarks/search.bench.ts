// The search benchmark of assessment §5.4, Phase 4 (M4.1): end-to-end `search.query` latency at
// 1k, 10k and 50k pages of the synthetic memory (src/data/testing/search-dataset.ts, spike S5's
// generator, seed 20261016). Per size the memory is generated and seeded into a database once;
// each run copies it into a fresh profile and starts the built test app on it, with no Playwright
// attached, to run the `search-benchmark` scenario (src/main/testing/search-benchmark.ts). §5.4
// asks for the median of 3 runs.
//
// It records the machine and how loaded it was at each run's start (free memory, commit charge,
// processor load), and writes every run's raw samples to docs/benchmarks/data/ after each run; a
// failed run is recorded with its error. tests/benchmarks/summarize-search.mjs turns the file into
// the tables of docs/benchmarks/search.md, and nothing else goes there.
//
//   npm run bench:search                          1k, 10k and 50k pages, 3 runs each
//   BENCH_SIZES=1000 BENCH_RUNS=1 npm run bench:search    a quick check of the harness
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DATASET_NOW,
  generateSearchDataset,
  seedSearchDatabase,
} from '../../src/data/testing/search-dataset';
import { makeProfile, removeProfile, runScenario } from '../lifecycle/harness';
import { currentLoad, environment } from './machine';
import type { Load } from './machine';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT_DIR = process.env.BENCH_OUT_DIR ?? join(REPO_ROOT, 'docs', 'benchmarks', 'data');

const SIZES = (process.env.BENCH_SIZES ?? '1000,10000,50000')
  .split(',')
  .map(Number)
  .filter((size) => Number.isInteger(size) && size >= 1);
const RUNS = Number(process.env.BENCH_RUNS ?? 3);
/**
 * How long the first search waits after the worker is ready (search-benchmark.ts): 5 s by
 * default, a settled app; BENCH_FIRST_DELAY_MS=0 measures it inside startup instead.
 */
const FIRST_DELAY_MS = Number(process.env.BENCH_FIRST_DELAY_MS ?? 5000);
/** The database file the app opens (src/main/persistence/data-worker.ts DATABASE_FILE). */
const DATABASE_FILE = 'veltriva.db';

interface Sample {
  readonly query: string;
  readonly ms: number;
  readonly results: number;
}

interface Reading {
  readonly firstDelayMs: number;
  readonly limit: number;
  readonly first: Sample;
  readonly headline: readonly (Sample & { readonly class: string })[];
  readonly ladders: readonly Sample[];
  readonly stress: readonly Sample[];
  readonly recent: readonly Sample[];
  readonly workerThreadId: number;
}

type Run = {
  readonly size: number;
  readonly run: number;
  readonly loadAtStart: Load;
  readonly seedMs: number;
} & ({ readonly reading: Reading } | { readonly error: string });

describe('search benchmark (§5.4)', () => {
  it(`measures ${SIZES.join(', ')} pages, ${String(RUNS)} runs each`, async () => {
    const machine = environment();
    mkdirSync(OUT_DIR, { recursive: true });
    const name = `phase-4-search-${new Date().toISOString().slice(0, 10)}-${SIZES.join('-')}-first-after-${String(FIRST_DELAY_MS)}ms`;
    const runs: Run[] = [];
    const save = (): void => {
      writeFileSync(
        join(OUT_DIR, `${name}.json`),
        `${JSON.stringify({ machine, sizes: SIZES, runs: RUNS, datasetNow: DATASET_NOW, firstDelayMs: FIRST_DELAY_MS, results: runs }, null, 2)}\n`,
      );
    };
    for (const size of SIZES) {
      const seedFolder = mkdtempSync(join(tmpdir(), 'veltriva-search-seed-'));
      const template = join(seedFolder, DATABASE_FILE);
      const seedStarted = performance.now();
      try {
        await seedSearchDatabase(template, generateSearchDataset({ pages: size }));
        const seedMs = Math.round(performance.now() - seedStarted);
        for (let run = 1; run <= RUNS; run += 1) {
          const profile = makeProfile();
          const base = { size, run, loadAtStart: currentLoad(), seedMs };
          try {
            copyFileSync(template, join(profile, DATABASE_FILE));
            const { result } = await runScenario<Reading>('search-benchmark', {
              userDataDir: profile,
              env: {
                VELTRIVA_BENCH_NOW: String(DATASET_NOW),
                VELTRIVA_BENCH_FIRST_DELAY_MS: String(FIRST_DELAY_MS),
              },
              timeoutMs: 15 * 60_000,
            });
            runs.push({ ...base, reading: result });
          } catch (error) {
            // Recorded, not hidden: the write-up says how many runs a loaded machine lost.
            const message = error instanceof Error ? error.message : String(error);
            runs.push({ ...base, error: message.split('\n')[0] ?? 'unknown' });
          } finally {
            removeProfile(profile);
          }
          save();
        }
      } finally {
        rmSync(seedFolder, { recursive: true, force: true });
      }
    }
    for (const size of SIZES) {
      expect(
        runs.some((entry) => entry.size === size && 'reading' in entry),
        `${String(size)} pages: no run finished`,
      ).toBe(true);
    }
  });
});
