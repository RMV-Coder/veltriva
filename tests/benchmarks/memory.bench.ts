// The memory benchmark of assessment §9.3, Phase 3: what automation's discards free, against all
// tabs live and against tabs only moved out of sight. It runs the `memory-benchmark` scenario
// (src/main/testing/benchmark-scenarios.ts) in the built test app, with no Playwright attached,
// once per run and size: one warm-up run per size, discarded, then BENCH_RUNS measured runs, each
// a fresh launch on a fresh profile. Every tab is the fixture server's controlled-cost page
// (10 MB of heap, 100 KB of DOM, spike S8's page) on a site of its own, `m<i>.test`, which the
// host-resolver switch maps to the fixture server.
//
// It records the machine (CPU, memory, Windows build, power, Defender) and the free memory at each
// run's start, and writes every run's raw reading to docs/benchmarks/data/, as JSON and CSV, after
// each run: a run that fails is recorded with its error and the next one starts, so a machine too
// loaded for some runs still leaves what it measured. The write-up in docs/benchmarks/ reports
// medians and ranges from those files (tests/benchmarks/summarize-memory.mjs), and nothing else.
//
//   npm run bench:memory                     sizes 10, 25 and 50, 5 runs each
//   BENCH_SIZES=10 BENCH_RUNS=1 npm run bench:memory    a quick check of the harness
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, freemem, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startFixtureServer } from '../fixtures/server';
import type { FixtureServer } from '../fixtures/server';
import { runScenario } from '../lifecycle/harness';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** Where the raw readings go; a smoke run of the harness points BENCH_OUT_DIR elsewhere. */
const OUT_DIR = process.env.BENCH_OUT_DIR ?? join(REPO_ROOT, 'docs', 'benchmarks', 'data');

const SIZES = (process.env.BENCH_SIZES ?? '10,25,50')
  .split(',')
  .map(Number)
  .filter((size) => Number.isInteger(size) && size >= 2);
const RUNS = Number(process.env.BENCH_RUNS ?? 5);
const SETTLE_MS = Number(process.env.BENCH_SETTLE_MS ?? 10_000);
const CPU_MS = Number(process.env.BENCH_CPU_MS ?? 60_000);

interface Group {
  readonly count: number;
  readonly privateMb: number;
  readonly workingSetMb: number;
  readonly cpuPercent: number;
}

interface Phase {
  readonly privateMb: number;
  readonly workingSetMb: number;
  readonly cpuPercent: number | null;
  readonly processes: number;
  readonly byGroup: Readonly<Record<string, Group>>;
  readonly liveTabs: number;
}

interface Reading {
  readonly tabs: number;
  readonly settleMs: number;
  readonly cpuWindowMs: number;
  readonly empty: Phase;
  readonly allLive: Phase;
  readonly collapsed: Phase;
  readonly discarded: Phase;
  readonly switchLiveMs: number | null;
  readonly switchUnloadedMs: number | null;
  readonly switchTimeouts: number;
  readonly loadAllMs: number;
  readonly discardAllMs: number;
  readonly discardRetries: number;
}

type Run = {
  readonly size: number;
  readonly run: number;
  readonly warmUp: boolean;
  readonly freeMbAtStart: number;
} & ({ readonly reading: Reading } | { readonly error: string });

/** A read-only PowerShell query; '' when it fails (the field is then reported unknown). */
function powershell(command: string): string {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    }).trim();
  } catch {
    return '';
  }
}

function environment() {
  return {
    cpu: cpus()[0]?.model.trim() ?? 'unknown',
    logicalCpus: cpus().length,
    totalMemoryMb: Math.round(totalmem() / 2 ** 20),
    windows:
      powershell(
        '$o = Get-CimInstance Win32_OperatingSystem; "$($o.Caption) $($o.Version) build $($o.BuildNumber)"',
      ) || `Windows ${release()}`,
    // BatteryStatus 2 is "on AC"; a desktop has no battery.
    power:
      powershell(
        '$b = Get-CimInstance Win32_Battery; if ($null -eq $b) { "no battery" } elseif ($b.BatteryStatus -eq 2) { "AC power" } else { "battery (status $($b.BatteryStatus))" }',
      ) || 'unknown',
    powerPlan: powershell('powercfg /getactivescheme') || 'unknown',
    defenderRealTime:
      powershell('(Get-MpComputerStatus).RealTimeProtectionEnabled') || 'unknown (not readable)',
    electron: 'see package.json',
  };
}

let server: FixtureServer;
const runs: Run[] = [];

beforeAll(async () => {
  server = await startFixtureServer();
});

afterAll(async () => {
  await server.close();
});

describe('memory benchmark (§9.3)', () => {
  it(`measures ${SIZES.join(', ')} tabs, one warm-up and ${String(RUNS)} runs each`, async () => {
    const machine = environment();
    mkdirSync(OUT_DIR, { recursive: true });
    const name = `phase-3-memory-${new Date().toISOString().slice(0, 10)}-${SIZES.join('-')}`;
    const save = (): void => {
      writeFileSync(
        join(OUT_DIR, `${name}.json`),
        `${JSON.stringify({ machine, sizes: SIZES, runs: RUNS, settleMs: SETTLE_MS, cpuMs: CPU_MS, results: runs }, null, 2)}\n`,
      );
      writeFileSync(join(OUT_DIR, `${name}.csv`), toCsv(runs));
    };
    for (const size of SIZES) {
      for (let run = 0; run <= RUNS; run += 1) {
        const freeMbAtStart = Math.round(freemem() / 2 ** 20);
        const base = { size, run, warmUp: run === 0, freeMbAtStart };
        try {
          const { result } = await runScenario<Reading>('memory-benchmark', {
            env: {
              VELTRIVA_FIXTURE_ORIGIN: server.origin,
              VELTRIVA_BENCH_TABS: String(size),
              VELTRIVA_BENCH_SETTLE_MS: String(SETTLE_MS),
              VELTRIVA_BENCH_CPU_MS: String(CPU_MS),
            },
            switches: ['--host-resolver-rules=MAP *.test 127.0.0.1'],
            timeoutMs: 10 * 60_000 + size * 20_000 + 3 * CPU_MS,
          });
          runs.push({ ...base, reading: result });
        } catch (error) {
          // Recorded, not hidden: the write-up says how many runs a loaded machine lost.
          const message = error instanceof Error ? error.message : String(error);
          runs.push({ ...base, error: message.split('\n')[0] ?? 'unknown' });
        }
        save();
      }
    }
    // Each size needs at least one measured run to report anything.
    for (const size of SIZES) {
      expect(
        runs.some((entry) => entry.size === size && !entry.warmUp && 'reading' in entry),
        `${String(size)} tabs: no measured run finished`,
      ).toBe(true);
    }
  });
});

const PHASES = [
  ['empty', 'empty'],
  ['A', 'allLive'],
  ['B', 'collapsed'],
  ['C', 'discarded'],
] as const;
const GROUPS = ['browser', 'gpu', 'utility', 'shell', 'tabs'] as const;

function toCsv(all: readonly Run[]): string {
  const header = [
    'size',
    'run',
    'warm_up',
    'free_mb_at_start',
    'phase',
    'live_tabs',
    'processes',
    'private_mb',
    'working_set_mb',
    'cpu_percent',
    ...GROUPS.flatMap((group) => [`${group}_count`, `${group}_private_mb`]),
    'error',
    'switch_live_ms',
    'switch_unloaded_ms',
    'switch_timeouts',
    'load_all_ms',
    'discard_all_ms',
    'discard_retries',
  ];
  const rows = all.flatMap((entry) => {
    if (!('reading' in entry)) {
      const error = `"${entry.error.replaceAll('"', "'")}"`;
      return [
        [entry.size, entry.run, entry.warmUp, entry.freeMbAtStart, '', '', '', '', '', '']
          .concat(GROUPS.flatMap(() => ['', '']))
          .concat([error, '', '', '', '', '', ''])
          .join(','),
      ];
    }
    const { reading } = entry;
    return PHASES.map(([label, key]) => {
      const phase = reading[key];
      return [
        entry.size,
        entry.run,
        entry.warmUp,
        entry.freeMbAtStart,
        label,
        phase.liveTabs,
        phase.processes,
        phase.privateMb,
        phase.workingSetMb,
        phase.cpuPercent ?? '',
        ...GROUPS.flatMap((group) => [
          phase.byGroup[group]?.count ?? 0,
          phase.byGroup[group]?.privateMb ?? 0,
        ]),
        '',
        reading.switchLiveMs ?? '',
        reading.switchUnloadedMs ?? '',
        reading.switchTimeouts,
        reading.loadAllMs,
        reading.discardAllMs,
        reading.discardRetries,
      ].join(',');
    });
  });
  return `${[header.join(','), ...rows].join('\n')}\n`;
}
