// The search benchmark of assessment §5.4 (Phase 4, M4.1), run inside the app as the lifecycle
// harness runs its scenarios (ADR-0008 4a): tests/benchmarks/search.bench.ts seeds a profile's
// database with the synthetic memory (src/data/testing/search-dataset.ts) and starts the app on it,
// once per run and size. Test builds only.
//
// "First" is the first search after startup: main has read the session and settings by then, but
// nothing has touched the search index.
//
// Each sample is end to end, as the palette sees it: main's `data.call('search.query')`, the
// worker's validation, FTS5 retrieval, joins, ranking and title marks, the reply's structured
// clone, and main's validation of every result. The query set is spike S5's (30 headline
// queries in four classes, 4 stress queries, 2 keystroke ladders), so the numbers compare.
//
//   first     the first search after the worker is ready: a cold page cache (§5.4's target);
//   headline  2 warm-up passes (not kept), then 20 interleaved passes over the 30: 600 samples;
//   ladders   every keystroke of the two phrases, 5 passes;
//   stress    the 4 queries that match nearly every page, 5 passes, reported apart;
//   recent    the empty query (the recent-and-frequent list), 50 samples.
import type { ScenarioContext } from './lifecycle-scenarios';

/** Results per search: what the palette asks for. */
export const BENCH_RESULT_LIMIT = 50;
/** The time the seeded memory was made at (src/data/testing/search-dataset.ts DATASET_NOW). */
export const BENCH_NOW_ENV = 'VELTRIVA_BENCH_NOW';
/**
 * How long after the worker is ready the first search waits, in ms. 0 measures it inside the
 * app's startup, where main is still restoring the session and loading the shell; a few seconds
 * measure a cold search index in a settled app, which is when a person first opens the palette
 * and what spike S5 measured ("the first search in a fresh worker").
 */
export const BENCH_FIRST_DELAY_ENV = 'VELTRIVA_BENCH_FIRST_DELAY_MS';

export const QUERY_CLASSES = {
  oneWord: [
    'postgres',
    'react',
    'docker',
    'kubernetes',
    'rust',
    'tailwind',
    'wikipedia',
    'youtube',
    'election',
    'typescript',
  ],
  shortPrefix: ['po', 're', 'do', 'ku', 'pos', 'typ'],
  twoWords: [
    'postgres index',
    'react hooks',
    'docker compose',
    'python asyncio',
    'rust ownership',
    'css grid',
    'git rebase',
    'post ind',
  ],
  threeWords: [
    'how to install',
    'react server components',
    'postgres index performance',
    'docker compose volumes',
    'kubernetes ingress tls',
    'rust async await',
  ],
} as const;
export type QueryClass = keyof typeof QUERY_CLASSES;

export const STRESS_QUERIES = ['h', 'https', 'com', 'the'] as const;
export const LADDER_PHRASES = ['kubernetes ingress', 'postgres index'] as const;

const HEADLINE_WARMUP_PASSES = 2;
const HEADLINE_PASSES = 20;
const OTHER_PASSES = 5;
const RECENT_SAMPLES = 50;
const CALL_TIMEOUT_MS = 30_000;

/** Every prefix of a phrase, as it is typed; a trailing space gives the same search. */
function ladder(phrase: string): string[] {
  const steps: string[] = [];
  for (let end = 1; end <= phrase.length; end += 1) {
    const prefix = phrase.slice(0, end);
    if (!prefix.endsWith(' ')) {
      steps.push(prefix);
    }
  }
  return steps;
}

export interface Sample {
  readonly query: string;
  readonly ms: number;
  readonly results: number;
}

export interface SearchBenchmarkResult {
  readonly limit: number;
  /** How long the first search waited after the worker was ready. */
  readonly firstDelayMs: number;
  readonly first: Sample;
  readonly headline: readonly (Sample & { readonly class: QueryClass })[];
  readonly ladders: readonly Sample[];
  readonly stress: readonly Sample[];
  readonly recent: readonly Sample[];
  /** The worker's threadId: proof the searches ran off main's thread. */
  readonly workerThreadId: number;
}

export async function searchBenchmark({
  data,
  pauseAutomation,
}: ScenarioContext): Promise<SearchBenchmarkResult> {
  // Nothing else should write while the searches are timed.
  pauseAutomation?.();
  await data.ready;
  const now = Number(process.env[BENCH_NOW_ENV] ?? Date.now());
  const firstDelayMs = Number(process.env[BENCH_FIRST_DELAY_ENV] ?? 0);
  if (firstDelayMs > 0) {
    await new Promise((resolve) => {
      setTimeout(resolve, firstDelayMs);
    });
  }
  const search = async (query: string): Promise<Sample> => {
    const started = performance.now();
    const { results } = await data.call(
      'search.query',
      { query, now, limit: BENCH_RESULT_LIMIT },
      { timeoutMs: CALL_TIMEOUT_MS },
    );
    return { query, ms: performance.now() - started, results: results.length };
  };

  // Nothing else has asked the worker anything yet: this is the cold first search.
  const first = await search('postgres');

  const headlineQueries = Object.entries(QUERY_CLASSES).flatMap(([name, queries]) =>
    queries.map((query) => ({ class: name as QueryClass, query })),
  );
  for (let pass = 0; pass < HEADLINE_WARMUP_PASSES; pass += 1) {
    for (const { query } of headlineQueries) {
      await search(query);
    }
  }
  const headline: (Sample & { class: QueryClass })[] = [];
  for (let pass = 0; pass < HEADLINE_PASSES; pass += 1) {
    for (const entry of headlineQueries) {
      headline.push({ ...(await search(entry.query)), class: entry.class });
    }
  }

  const ladders: Sample[] = [];
  const stress: Sample[] = [];
  for (let pass = 0; pass < OTHER_PASSES; pass += 1) {
    for (const phrase of LADDER_PHRASES) {
      for (const step of ladder(phrase)) {
        ladders.push(await search(step));
      }
    }
    for (const query of STRESS_QUERIES) {
      stress.push(await search(query));
    }
  }

  const recent: Sample[] = [];
  for (let sample = 0; sample < RECENT_SAMPLES; sample += 1) {
    recent.push(await search(''));
  }

  const info = await data.call('db.info', {});
  return {
    firstDelayMs,
    limit: BENCH_RESULT_LIMIT,
    first,
    headline,
    ladders,
    stress,
    recent,
    workerThreadId: info.threadId,
  };
}
