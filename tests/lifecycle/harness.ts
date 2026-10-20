// The lifecycle-behavior harness (ADR-0008 4a). It starts the built test app with no Playwright,
// no inspector and no CDP session attached, because those mask what these tests measure: focus
// emulation keeps hidden pages "visible" and Playwright's loader disables renderer backgrounding
// (spike S6). The app runs one scenario from src/main/testing/lifecycle-scenarios.ts, prints one
// result line on stdout and exits; `runScenario` returns that result.
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

export interface ScenarioRun<T> {
  readonly result: T;
  /** From the result line to the app's exit: how long it took to quit after reporting. */
  readonly exitMs: number;
  /** The names in the profile folder once the app has exited. */
  readonly profileFiles: readonly string[];
  /** What the app printed as it shut down, after the result (LIFECYCLE_EVENT_PREFIX lines). */
  readonly events: readonly unknown[];
}

/**
 * Runs a scenario in a fresh app with a fresh profile and returns what it reported. Throws if the
 * app reports an error, exits with a non-zero code (70: an uncaught exception in main, see
 * src/main/testing/fail-fast.ts) or doesn't exit in time.
 */
export async function runScenario<T>(name: string): Promise<ScenarioRun<T>> {
  const binary = electronBinary();
  const userDataDir = mkdtempSync(join(tmpdir(), 'veltriva-lifecycle-'));
  try {
    const { code, stdout, stderr, reportedAt, exitedAt } = await runApp(binary, {
      ...envWithoutRunAsNode(),
      [SCENARIO_ENV]: name,
      [USER_DATA_DIR_ENV]: userDataDir,
    });
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
    if (code !== 0) {
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
    removeProfile(userDataDir);
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

function runApp(binary: string, env: Record<string, string>): Promise<AppRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [REPO_ROOT], {
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
          `The app did not exit within ${String(SCENARIO_TIMEOUT_MS)} ms; killed it.\n` +
            `stdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    }, SCENARIO_TIMEOUT_MS);
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
function removeProfile(userDataDir: string): void {
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
