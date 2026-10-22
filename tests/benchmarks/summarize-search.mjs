// Summarizes raw readings of the search benchmark (tests/benchmarks/search.bench.ts) into the
// tables of docs/benchmarks/search.md: per size, each run's percentiles, then the median over the
// runs that finished (§5.4: the median of 3 runs), against §5.4's targets. Failed runs are listed.
// Nothing is computed that the raw files don't hold.
//
//   node tests/benchmarks/summarize-search.mjs docs/benchmarks/data/phase-4-search-<...>.json [...]
import console from 'node:console';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node tests/benchmarks/summarize-search.mjs <raw json> [<raw json> ...]');
  process.exit(2);
}
const raws = files.map((file) => JSON.parse(readFileSync(file, 'utf8')));
const all = raws.flatMap((raw) => raw.results);
const sizes = [...new Set(all.map((run) => run.size))].sort((a, b) => a - b);

/** Nearest-rank percentile, as S5 reported them. */
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
};
const median = (values) => percentile(values, 50);
const round = (value, digits = 1) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};
const range = (values) =>
  values.length === 0
    ? 'n/a'
    : `${String(round(median(values)))} (${String(round(Math.min(...values)))}–${String(round(Math.max(...values)))})`;

/** §5.4's targets, ms, by size; null where §5.4 sets none. */
const TARGETS = {
  10000: { p95: 30, p99: null, first: null },
  50000: { p95: 50, p99: 60, first: 100 },
};

for (const raw of raws) {
  console.log(`Machine: ${JSON.stringify(raw.machine)}`);
  console.log(
    `Sizes ${raw.sizes.join(', ')}: ${String(raw.runs)} runs each; first search ${raw.firstDelayMs === undefined ? 'at once when the worker was ready (before the delay setting existed)' : `${String(raw.firstDelayMs)} ms after the worker was ready`}`,
  );
}
console.log('');

for (const size of sizes) {
  const attempted = all.filter((run) => run.size === size);
  const finished = attempted.filter((run) => run.reading !== undefined);
  console.log(
    `### ${size.toLocaleString('en-US')} pages (${String(finished.length)} of ${String(attempted.length)} runs finished)\n`,
  );
  for (const run of attempted.filter((entry) => entry.reading === undefined)) {
    console.log(`- Run ${String(run.run)} failed: ${run.error}`);
  }
  if (finished.length === 0) {
    console.log('');
    continue;
  }
  console.log(
    '| Run | Free MB / commit at start | CPU load at start | First search | Headline p50 / p95 / p99 | Ladders p95 | Recent p50 / p95 | Stress p50 |',
  );
  console.log('|---|---|---|---|---|---|---|---|');
  const perRun = finished.map((run) => {
    const { reading, loadAtStart } = run;
    const headline = reading.headline.map((sample) => sample.ms);
    const row = {
      first: reading.first.ms,
      p50: percentile(headline, 50),
      p95: percentile(headline, 95),
      p99: percentile(headline, 99),
      ladders95: percentile(
        reading.ladders.map((sample) => sample.ms),
        95,
      ),
      recent50: percentile(
        reading.recent.map((sample) => sample.ms),
        50,
      ),
      recent95: percentile(
        reading.recent.map((sample) => sample.ms),
        95,
      ),
      stress50: percentile(
        reading.stress.map((sample) => sample.ms),
        50,
      ),
      byClass: Object.fromEntries(
        [...new Set(reading.headline.map((sample) => sample.class))].map((name) => [
          name,
          percentile(
            reading.headline.filter((sample) => sample.class === name).map((sample) => sample.ms),
            95,
          ),
        ]),
      ),
    };
    const commit =
      loadAtStart.commitMb === null
        ? 'commit unknown'
        : `${String(round(loadAtStart.commitMb / 1024))} / ${String(round(loadAtStart.commitLimitMb / 1024))} GB`;
    console.log(
      `| ${String(run.run)} | ${String(loadAtStart.freeMb)} MB, ${commit} | ${loadAtStart.cpuPercent === null ? 'n/a' : `${String(loadAtStart.cpuPercent)}%`} | ${String(round(row.first))} ms | ${String(round(row.p50))} / ${String(round(row.p95))} / ${String(round(row.p99))} ms | ${String(round(row.ladders95))} ms | ${String(round(row.recent50))} / ${String(round(row.recent95))} ms | ${String(round(row.stress50))} ms |`,
    );
    return row;
  });
  const medianOf = (key) => median(perRun.map((row) => row[key]));
  console.log('');
  console.log(
    `- Median of the runs: first ${String(round(medianOf('first')))} ms; headline p50 ${String(round(medianOf('p50')))}, p95 ${String(round(medianOf('p95')))}, p99 ${String(round(medianOf('p99')))} ms; ladders p95 ${String(round(medianOf('ladders95')))} ms; recent p50 ${String(round(medianOf('recent50')))} ms; stress p50 ${String(round(medianOf('stress50')))} ms (ranges over runs: p95 ${range(perRun.map((row) => row.p95))}, p99 ${range(perRun.map((row) => row.p99))})`,
  );
  const classes = Object.keys(perRun[0].byClass);
  console.log(
    `- p95 by class (median of runs): ${classes.map((name) => `${name} ${String(round(median(perRun.map((row) => row.byClass[name]))))} ms`).join(', ')}`,
  );
  const target = TARGETS[size];
  if (target !== undefined) {
    const verdict = (value, limit) =>
      limit === null
        ? null
        : `${String(round(value))} ms against ≤ ${String(limit)} ms: ${value <= limit ? 'met' : 'MISSED'}`;
    const lines = [
      verdict(medianOf('p95'), target.p95) && `p95 ${verdict(medianOf('p95'), target.p95)}`,
      verdict(medianOf('p99'), target.p99) && `p99 ${verdict(medianOf('p99'), target.p99)}`,
      verdict(medianOf('first'), target.first) &&
        `first search ${verdict(medianOf('first'), target.first)}`,
    ].filter(Boolean);
    console.log(`- §5.4 targets: ${lines.join('; ')}`);
  }
  console.log(
    `- Results per search: ${String(finished[0].reading.limit)}; samples per run: headline ${String(finished[0].reading.headline.length)}, ladders ${String(finished[0].reading.ladders.length)}, stress ${String(finished[0].reading.stress.length)}, recent ${String(finished[0].reading.recent.length)}; seeding took ${String(round(finished[0].seedMs / 1000))} s\n`,
  );
}
