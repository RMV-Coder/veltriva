// The memory benchmark of assessment §9.3 (Phase 3), run inside the app with no Playwright, no
// inspector and no CDP attached, as the lifecycle harness runs its scenarios (ADR-0008 4a):
// tests/benchmarks/memory.bench.ts starts it once per run and size. Test builds only.
//
// One run, N tabs of the controlled-cost fixture page (`/cost/page?heapMB=&domKB=`), each on its
// own site (`m<i>.test`, mapped to the fixture server by the runner's host-resolver switch), so
// every tab gets a renderer of its own as real sites do:
//   empty   the app as it starts: one new-tab page, nothing loaded;
//   A       all N live, the last one selected, automation paused;
//   B       N − 1 moved to Sleeping by the user's own command, still live: "visually collapsed";
//   C       those N − 1 discarded (unloaded), as automation would.
// Each phase settles, then reads `app.getAppMetrics()`: private bytes (the headline, S8),
// working set, per process type, the shell's renderer apart from the tabs'. CPU is averaged over
// a quiet window per phase: this module is the only caller of `getAppMetrics()` during a run (it
// resets the CPU interval for every caller, §9.3). Tab-switch latency is measured in A (a live
// hidden tab) and C (an unloaded one, which reloads).
import { app } from 'electron';

import type { TabId } from '../tabs/tab-manager';
import { FIXTURE_ORIGIN_ENV } from './discard-scenarios';
import type { ScenarioContext } from './lifecycle-scenarios';

export const BENCH_TABS_ENV = 'VELTRIVA_BENCH_TABS';
export const BENCH_SETTLE_ENV = 'VELTRIVA_BENCH_SETTLE_MS';
export const BENCH_CPU_ENV = 'VELTRIVA_BENCH_CPU_MS';

const LOAD_TIMEOUT_MS = 60_000;
/** Switches measured per phase: the median is reported. */
const SWITCH_SAMPLES = 3;

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function waitFor(what: string, done: () => boolean): Promise<void> {
  const deadline = Date.now() + LOAD_TIMEOUT_MS;
  while (!done()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await wait(25);
  }
}

export interface ProcessGroup {
  readonly count: number;
  readonly privateMb: number;
  readonly workingSetMb: number;
  readonly cpuPercent: number;
}

export interface PhaseReading {
  readonly privateMb: number;
  readonly workingSetMb: number;
  /** Summed over the process tree, averaged over the quiet window; null when not measured. */
  readonly cpuPercent: number | null;
  readonly processes: number;
  readonly byGroup: Readonly<Record<string, ProcessGroup>>;
  /** Tabs whose page is loaded (a renderer of their own). */
  readonly liveTabs: number;
}

export interface MemoryBenchmarkResult {
  readonly tabs: number;
  readonly settleMs: number;
  readonly cpuWindowMs: number;
  readonly empty: PhaseReading;
  readonly allLive: PhaseReading;
  readonly collapsed: PhaseReading;
  readonly discarded: PhaseReading;
  /** Median ms from selecting a tab to two rendered frames: live in A, unloaded (reload) in C. */
  readonly switchLiveMs: number;
  readonly switchUnloadedMs: number;
  readonly loadAllMs: number;
  readonly discardAllMs: number;
}

const mb = (kb: number): number => Math.round((kb / 1024) * 10) / 10;

/** One reading of the whole process tree, grouped: browser, GPU, utility, shell, tabs. */
function readMetrics(shellPid: number): Omit<PhaseReading, 'cpuPercent' | 'liveTabs'> & {
  readonly cpuPercent: number;
} {
  const metrics = app.getAppMetrics();
  const groups = new Map<
    string,
    { count: number; privateKb: number; workingSetKb: number; cpu: number }
  >();
  let privateKb = 0;
  let workingSetKb = 0;
  let cpu = 0;
  for (const metric of metrics) {
    const group =
      metric.type === 'Tab'
        ? metric.pid === shellPid
          ? 'shell'
          : 'tabs'
        : metric.type === 'Browser'
          ? 'browser'
          : metric.type === 'GPU'
            ? 'gpu'
            : 'utility';
    const entry = groups.get(group) ?? { count: 0, privateKb: 0, workingSetKb: 0, cpu: 0 };
    const privateBytes = metric.memory.privateBytes ?? 0;
    entry.count += 1;
    entry.privateKb += privateBytes;
    entry.workingSetKb += metric.memory.workingSetSize;
    entry.cpu += metric.cpu.percentCPUUsage;
    groups.set(group, entry);
    privateKb += privateBytes;
    workingSetKb += metric.memory.workingSetSize;
    cpu += metric.cpu.percentCPUUsage;
  }
  return {
    privateMb: mb(privateKb),
    workingSetMb: mb(workingSetKb),
    cpuPercent: Math.round(cpu * 100) / 100,
    processes: metrics.length,
    byGroup: Object.fromEntries(
      [...groups].map(([name, entry]) => [
        name,
        {
          count: entry.count,
          privateMb: mb(entry.privateKb),
          workingSetMb: mb(entry.workingSetKb),
          cpuPercent: Math.round(entry.cpu * 100) / 100,
        },
      ]),
    ),
  };
}

/**
 * Settles, then reads memory; with a CPU window, reads once to start it (the call resets the
 * interval), waits it out and reads again: that reading's CPU is the window's average.
 */
async function measure(
  context: ScenarioContext,
  settleMs: number,
  cpuWindowMs: number,
): Promise<PhaseReading> {
  await wait(settleMs);
  const shellPid = context.main.shell.webContents.getOSProcessId();
  let reading = readMetrics(shellPid);
  let cpuPercent: number | null = null;
  if (cpuWindowMs > 0) {
    await wait(cpuWindowMs);
    reading = readMetrics(shellPid);
    cpuPercent = reading.cpuPercent;
  }
  const liveTabs = [...context.tabs.tabs(), ...context.tabs.sleepingTabs()].filter(
    (tab) => tab.runtime === 'live',
  ).length;
  return { ...reading, cpuPercent, liveTabs };
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

/** Selects a tab and waits until its page is live and has drawn two frames. */
async function switchTo(context: ScenarioContext, tabId: TabId): Promise<number> {
  const started = performance.now();
  context.tabs.select(tabId, { focus: false });
  await waitFor(`tab ${tabId} to show its page`, () => {
    const tab = context.tabs.get(tabId);
    return tab.runtime === 'live' && !tab.loading && context.views.has(tabId);
  });
  const view = context.views.get(tabId);
  await view?.webContents.executeJavaScript(
    'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  );
  return Math.round((performance.now() - started) * 10) / 10;
}

export async function memoryBenchmark(context: ScenarioContext): Promise<MemoryBenchmarkResult> {
  const origin = process.env[FIXTURE_ORIGIN_ENV];
  if (origin === undefined || origin === '') {
    throw new Error(`${FIXTURE_ORIGIN_ENV} is not set: the runner starts the fixture server.`);
  }
  const { port } = new URL(origin);
  const tabCount = envNumber(BENCH_TABS_ENV, 10);
  const settleMs = envNumber(BENCH_SETTLE_ENV, 10_000);
  const cpuWindowMs = envNumber(BENCH_CPU_ENV, 60_000);
  const { tabs } = context;
  // Automation stays out of the measurement (memory pressure on this laptop would discard tabs
  // mid-phase): the scenario makes every move itself.
  context.pauseAutomation?.();
  const [blank] = tabs.tabs().map((tab) => tab.id);

  const empty = await measure(context, settleMs, 0);

  // A: N live tabs, each its own site; the last stays selected.
  const loadStarted = performance.now();
  const ids: TabId[] = [];
  for (let index = 0; index < tabCount; index += 1) {
    const url = `http://m${String(index)}.test:${port}/cost/page?heapMB=10&domKB=100&title=M${String(index)}`;
    const tabId = tabs.create({ select: index === tabCount - 1 });
    tabs.navigate(tabId, url, { focus: false });
    ids.push(tabId);
    await waitFor(`m${String(index)}.test to load`, () => {
      const tab = tabs.get(tabId);
      return tab.runtime === 'live' && !tab.loading && tab.url === url;
    });
  }
  const loadAllMs = Math.round(performance.now() - loadStarted);
  if (blank !== undefined) {
    tabs.close(blank);
  }
  const allLive = await measure(context, settleMs, cpuWindowMs);

  // Switching to a live hidden tab and back, a few times.
  const selected = ids.at(-1);
  const hidden = ids.slice(0, -1);
  const liveSwitches: number[] = [];
  for (let sample = 0; sample < Math.min(SWITCH_SAMPLES, hidden.length); sample += 1) {
    const target = hidden[sample];
    if (target !== undefined && selected !== undefined) {
      liveSwitches.push(await switchTo(context, target));
      await switchTo(context, selected);
    }
  }

  // B: the hidden tabs moved to Sleeping, still live.
  for (const tabId of hidden) {
    tabs.shelve(tabId, { origin: 'user' });
  }
  const collapsed = await measure(context, settleMs, cpuWindowMs);

  // C: the Sleeping tabs discarded, one after the other, as automation would.
  const discardStarted = performance.now();
  for (const tabId of hidden) {
    const outcome = await tabs.discard(tabId, { origin: 'user' });
    if (outcome.outcome !== 'discarded') {
      throw new Error(`Tab ${tabId} was not discarded: ${JSON.stringify(outcome)}`);
    }
  }
  const discardAllMs = Math.round(performance.now() - discardStarted);
  const discarded = await measure(context, settleMs, cpuWindowMs);

  // Bringing an unloaded tab back: it reloads its page.
  const unloadedSwitches: number[] = [];
  for (let sample = 0; sample < Math.min(SWITCH_SAMPLES, hidden.length); sample += 1) {
    const target = hidden[hidden.length - 1 - sample];
    if (target !== undefined) {
      unloadedSwitches.push(await switchTo(context, target));
    }
  }

  return {
    tabs: tabCount,
    settleMs,
    cpuWindowMs,
    empty,
    allLive,
    collapsed,
    discarded,
    switchLiveMs: median(liveSwitches),
    switchUnloadedMs: median(unloadedSwitches),
    loadAllMs,
    discardAllMs,
  };
}
