// Summarizes raw readings of the memory benchmark (tests/benchmarks/memory.bench.ts) into the
// tables of docs/benchmarks: per size and phase, the median and the range over the measured runs
// that finished (warm-up runs are left out, failed runs are counted), as §9.3 asks. Nothing is
// computed that the raw files don't hold.
//
//   node tests/benchmarks/summarize-memory.mjs docs/benchmarks/data/phase-3-memory-<...>.json [...]
import console from 'node:console';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node tests/benchmarks/summarize-memory.mjs <raw json> [<raw json> ...]');
  process.exit(2);
}
const raws = files.map((file) => JSON.parse(readFileSync(file, 'utf8')));
const all = raws.flatMap((raw) => raw.results);
const finished = all.filter((run) => !run.warmUp && run.reading !== undefined);
const sizes = [...new Set(all.map((run) => run.size))].sort((a, b) => a - b);

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const round = (value, digits = 0) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};
/** "median (min–max)", over the values that exist. */
const stat = (values, digits = 0) => {
  const present = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  return present.length === 0
    ? 'n/a'
    : `${String(round(median(present), digits))} (${String(round(Math.min(...present), digits))}–${String(round(Math.max(...present), digits))})`;
};

const PHASES = [
  ['empty', 'Empty (start)'],
  ['allLive', 'A: all live'],
  ['collapsed', 'B: moved to Sleeping, live'],
  ['discarded', 'C: unloaded'],
];

for (const raw of raws) {
  console.log(`Machine: ${JSON.stringify(raw.machine)}`);
  console.log(
    `Sizes ${raw.sizes.join(', ')}: ${String(raw.runs)} measured runs (+1 warm-up) each; settle ${String(raw.settleMs)} ms; CPU window ${String(raw.cpuMs)} ms`,
  );
}
console.log('');

for (const size of sizes) {
  const runs = finished.filter((run) => run.size === size);
  const attempted = all.filter((run) => run.size === size && !run.warmUp);
  const failed = attempted.filter((run) => run.reading === undefined);
  const cpuMs = raws.find((raw) => raw.sizes.includes(size))?.cpuMs ?? 0;
  console.log(
    `### ${String(size)} tabs (${String(runs.length)} of ${String(attempted.length)} measured runs finished)\n`,
  );
  for (const run of failed) {
    console.log(`- Run ${String(run.run)} failed: ${run.error}`);
  }
  if (runs.length === 0) {
    console.log('');
    continue;
  }
  console.log(
    `| Phase | Live tabs | Private MB, total | Tab renderers, private MB | Working set MB | CPU % (${String(cpuMs / 1000)} s quiet) |`,
  );
  console.log('|---|---|---|---|---|---|');
  for (const [key, label] of PHASES) {
    const phases = runs.map((run) => run.reading[key]);
    const cpu = phases.map((phase) => phase.cpuPercent);
    console.log(
      `| ${label} | ${stat(phases.map((phase) => phase.liveTabs))} | ${stat(phases.map((phase) => phase.privateMb))} | ${stat(phases.map((phase) => phase.byGroup.tabs?.privateMb ?? 0))} | ${stat(phases.map((phase) => phase.workingSetMb))} | ${key === 'empty' ? '—' : stat(cpu, 2)} |`,
    );
  }
  const reading = (run) => run.reading;
  const saved = runs.map(
    (run) => reading(run).allLive.privateMb - reading(run).discarded.privateMb,
  );
  const collapsedDelta = runs.map(
    (run) => reading(run).collapsed.privateMb - reading(run).allLive.privateMb,
  );
  const perTab = runs.map(
    (run) =>
      (reading(run).allLive.byGroup.tabs?.privateMb ?? 0) /
      Math.max(1, reading(run).allLive.byGroup.tabs?.count ?? 1),
  );
  const perUnloaded = runs.map(
    (run) =>
      (reading(run).allLive.privateMb - reading(run).discarded.privateMb) /
      Math.max(1, reading(run).allLive.liveTabs - reading(run).discarded.liveTabs),
  );
  console.log('');
  console.log(`- Freed by unloading (A − C): ${stat(saved)} MB private`);
  console.log(`- Freed per unloaded tab: ${stat(perUnloaded, 1)} MB`);
  console.log(`- A tab renderer in A: ${stat(perTab, 1)} MB private`);
  console.log(`- B − A (moving to Sleeping alone): ${stat(collapsedDelta, 1)} MB`);
  console.log(
    `- Switch to a live hidden tab: ${stat(
      runs.map((run) => reading(run).switchLiveMs),
      1,
    )} ms; to an unloaded one (it reloads): ${stat(
      runs.map((run) => reading(run).switchUnloadedMs),
      1,
    )} ms; switches over 120 s: ${String(runs.reduce((sum, run) => sum + (reading(run).switchTimeouts ?? 0), 0))}`,
  );
  console.log(
    `- Loading all ${String(size)}: ${stat(runs.map((run) => reading(run).loadAllMs))} ms; unloading ${String(size - 1)}: ${stat(runs.map((run) => reading(run).discardAllMs))} ms`,
  );
  const retries = runs.reduce((sum, run) => sum + (reading(run).discardRetries ?? 0), 0);
  console.log(`- Probes asked again after missing their 100 ms (all runs): ${String(retries)}`);
  console.log(
    `- Free memory at each run's start: ${stat(attempted.map((run) => run.freeMbAtStart))} MB\n`,
  );
}
