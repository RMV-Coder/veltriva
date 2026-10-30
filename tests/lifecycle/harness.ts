// The lifecycle-behavior harness (ADR-0008 4a). It starts the built test app with no Playwright,
// no inspector and no CDP session attached, because those mask what these tests measure: focus
// emulation keeps hidden pages "visible" and Playwright's loader disables renderer backgrounding
// (spike S6). The app runs one scenario from src/main/testing/lifecycle-scenarios.ts, prints one
// result line on stdout and exits; `runScenario` returns that result. Every app it starts has
// Chromium's native window occlusion turned off (HARNESS_SWITCHES).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// These mirror src/main/testing/lifecycle-scenarios.ts and src/main/app/user-data-dir.ts.
// Importing them would load Electron's modules into the test runner.
const SCENARIO_ENV = 'VELTRIVA_LIFECYCLE_SCENARIO';
const RESULT_PREFIX = 'VELTRIVA_LIFECYCLE_RESULT ';
const EVENT_PREFIX = 'VELTRIVA_LIFECYCLE_EVENT ';
const USER_DATA_DIR_ENV = 'VELTRIVA_USER_DATA_DIR';
const RUN_AS_NODE_ENV = 'ELECTRON_RUN_AS_NODE';
/** Only `--mode test` builds contain the hooks, and with them the scenario runner. */
const TEST_HOOKS_MARKER = '__veltrivaTest';
const BUILD_HINT = 'Run `npm run test:lifecycle`, which builds the test variant.';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** Startup plus the scenario. A first launch on a CI runner can be slow. */
const SCENARIO_TIMEOUT_MS = 90_000;

/**
 * Put before the app's path on every launch (ADR-0008 4a). Chromium on Windows works out whether
 * other windows cover each of its windows (native window occlusion) and reports every page in a
 * covered window `hidden`: the selected tab, the shell (so no animation frame runs, and an overlay
 * is never raised), a page shown again. A page that loads while its window counts as covered and
 * is never shown also drops real clicks and keys. Keeping the window on top was not enough on a
 * desktop in use: one visibility or typing check failed per run on the development laptop.
 *
 * Turning the calculation off removes only the other windows from the checks. A tab that isn't
 * selected is still hidden, because its view is removed from the window, and a page under an
 * opaque view in the same window still goes hidden, which the raised-shell checks need: both come
 * from Chromium's occlusion inside the window, which this feature doesn't control. Measured with
 * Electron 45.0.0. `--disable-backgrounding-occluded-windows` would not do: it reports any
 * occluded page visible, a page under an opaque view included.
 *
 * A caller's own `--disable-features` would replace this one: Chromium keeps the last.
 */
const HARNESS_SWITCHES = ['--disable-features=CalculateNativeWinOcclusion'] as const;

export interface ScenarioRun<T> {
  readonly result: T;
  /** From the result line to the app's exit: how long it took to quit after reporting. */
  readonly exitMs: number;
  /** The names in the profile folder once the app has exited. */
  readonly profileFiles: readonly string[];
  /** What the app printed as it shut down, after the result (LIFECYCLE_EVENT_PREFIX lines). */
  readonly events: readonly unknown[];
}

export interface ScenarioOptions {
  /**
   * A profile the caller made with `makeProfile` and removes with `removeProfile`, for checks
   * that span launches. By default each run gets a fresh one, removed afterwards.
   */
  readonly userDataDir?: string;
  /** The exit code the scenario must end with: 1 for a hard exit (`process.kill`). Default 0. */
  readonly exitCode?: number;
  /** More environment for the app, such as a scenario's settings. */
  readonly env?: Readonly<Record<string, string>>;
  /** Chromium or Electron switches, put before the app's path (the benchmark maps its sites). */
  readonly switches?: readonly string[];
  /** How long the scenario may take; 90 s by default (the benchmark takes minutes). */
  readonly timeoutMs?: number;
}

export function makeProfile(): string {
  return mkdtempSync(join(tmpdir(), 'veltriva-lifecycle-'));
}

/**
 * Runs a scenario in a fresh app and returns what it reported. Throws if the app reports an error,
 * exits with any other code than expected (70: an uncaught exception in main, see
 * src/main/testing/fail-fast.ts) or doesn't exit in time.
 */
export async function runScenario<T>(
  name: string,
  options: ScenarioOptions = {},
): Promise<ScenarioRun<T>> {
  const binary = electronBinary();
  const userDataDir = options.userDataDir ?? makeProfile();
  const expectedCode = options.exitCode ?? 0;
  try {
    const { code, stdout, stderr, reportedAt, exitedAt } = await runApp(
      binary,
      {
        ...envWithoutRunAsNode(),
        [SCENARIO_ENV]: name,
        [USER_DATA_DIR_ENV]: userDataDir,
        ...options.env,
      },
      { switches: options.switches ?? [], timeoutMs: options.timeoutMs ?? SCENARIO_TIMEOUT_MS },
    );
    const output = `stdout:\n${stdout}\nstderr:\n${stderr}`;
    const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith(RESULT_PREFIX));
    if (line === undefined || reportedAt === undefined) {
      throw new Error(`Scenario ${name} printed no result (exit code ${String(code)}).\n${output}`);
    }
    const report = JSON.parse(line.slice(RESULT_PREFIX.length)) as {
      scenario?: string;
      result?: T;
      error?: string;
    };
    if (report.error !== undefined || report.scenario !== name || report.result === undefined) {
      throw new Error(`Scenario ${name} failed: ${report.error ?? JSON.stringify(report)}`);
    }
    if (code !== expectedCode) {
      throw new Error(`Scenario ${name} reported, then exited with ${String(code)}.\n${output}`);
    }
    return {
      result: report.result,
      exitMs: exitedAt - reportedAt,
      profileFiles: readdirSync(userDataDir).sort(),
      events: stdout
        .split(/\r?\n/)
        .filter((candidate) => candidate.startsWith(EVENT_PREFIX))
        .map((candidate): unknown => JSON.parse(candidate.slice(EVENT_PREFIX.length))),
    };
  } finally {
    if (options.userDataDir === undefined) {
      removeProfile(userDataDir);
    }
  }
}

interface AppRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** When the result line arrived (`Date.now()`), if it did. */
  readonly reportedAt: number | undefined;
  readonly exitedAt: number;
}

function runApp(
  binary: string,
  env: Record<string, string>,
  options: { readonly switches: readonly string[]; readonly timeoutMs: number },
): Promise<AppRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...HARNESS_SWITCHES, ...options.switches, REPO_ROOT], {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let reportedAt: number | undefined;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      if (reportedAt === undefined && stdout.includes(RESULT_PREFIX)) {
        reportedAt = Date.now();
      }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      killProcessTree(child.pid);
      reject(
        new Error(
          `The app did not exit within ${String(options.timeoutMs)} ms; killed it.\n` +
            `stdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    }, options.timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, reportedAt, exitedAt: Date.now() });
    });
  });
}

/**
 * Best effort: a killed app's processes can hold profile files for a moment, and a cleanup error
 * must not hide the failure that led to the kill.
 */
export function removeProfile(userDataDir: string): void {
  try {
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    console.warn(`Could not remove the test profile ${userDataDir}:`, error);
  }
}

/** Checks that out/ holds a test build, and returns the electron binary's path. */
function electronBinary(): string {
  const main = join(REPO_ROOT, 'out/main/index.js');
  if (!existsSync(main)) {
    throw new Error(`The app is not built: ${main} is missing. ${BUILD_HINT}`);
  }
  if (!readFileSync(main, 'utf8').includes(TEST_HOOKS_MARKER)) {
    throw new Error(`out/main/index.js is not a test build. ${BUILD_HINT}`);
  }
  // In Node, the electron package exports the path of its binary.
  const exported: unknown = createRequire(join(REPO_ROOT, 'package.json'))('electron');
  if (typeof exported !== 'string' || !existsSync(exported)) {
    throw new Error('The electron binary is missing. Run `npm run setup`.');
  }
  return exported;
}

/** `process.env` without ELECTRON_RUN_AS_NODE, in any spelling: it would start Node, not the app. */
function envWithoutRunAsNode(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key.toUpperCase() !== RUN_AS_NODE_ENV) {
      env[key] = value;
    }
  }
  return env;
}

/** `ChildProcess.kill()` would leave electron.exe's children running; `taskkill /T` takes all. */
export interface KilledRun {
  /** Every LIFECYCLE_EVENT_PREFIX line the app printed before it was killed. */
  readonly events: readonly unknown[];
  /** How long after the start event the kill came. */
  readonly killedAfterMs: number;
}

/**
 * Runs a scenario that never ends by itself, and hard-kills the whole process tree `killAfterMs`
 * after it prints the event `{ event: startEvent }`: what a power cut or Task Manager does.
 */
export async function runUntilKilled(
  name: string,
  options: {
    readonly userDataDir: string;
    readonly killAfterMs: number;
    readonly startEvent: string;
    readonly env?: Readonly<Record<string, string>>;
  },
): Promise<KilledRun> {
  const binary = electronBinary();
  const child = spawn(binary, [...HARNESS_SWITCHES, REPO_ROOT], {
    cwd: REPO_ROOT,
    env: {
      ...envWithoutRunAsNode(),
      [SCENARIO_ENV]: name,
      [USER_DATA_DIR_ENV]: options.userDataDir,
      ...options.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const events: unknown[] = [];
  let pending = '';
  let stderr = '';
  let startedAt: number | undefined;
  let killedAt: number | undefined;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      killProcessTree(child.pid);
      reject(new Error(`${name} never printed ${options.startEvent}.\nstderr:\n${stderr}`));
    }, SCENARIO_TIMEOUT_MS);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith(EVENT_PREFIX)) {
          continue;
        }
        const event: unknown = JSON.parse(line.slice(EVENT_PREFIX.length));
        if (killedAt === undefined) {
          events.push(event);
        }
        if (
          startedAt === undefined &&
          (event as { event?: unknown }).event === options.startEvent
        ) {
          startedAt = Date.now();
          setTimeout(() => {
            killedAt = Date.now();
            killProcessTree(child.pid);
          }, options.killAfterMs);
        }
      }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', () => {
      clearTimeout(timeout);
      if (startedAt === undefined || killedAt === undefined) {
        reject(new Error(`${name} exited before it was killed.\nstderr:\n${stderr}`));
        return;
      }
      resolve({ events, killedAfterMs: killedAt - startedAt });
    });
  });
}

function killProcessTree(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  } else {
    process.kill(pid, 'SIGKILL');
  }
}
