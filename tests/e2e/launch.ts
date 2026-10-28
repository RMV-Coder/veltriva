// Launch helpers for the Electron E2E suite. They enforce ADR-0008 item 4 and the rules from
// spike S6 (docs/spikes/s6-test-reach.md), so a spec never has to remember them:
//
//  1. Fail fast when the app isn't built, or is built without the test hooks: out/main, out/preload
//     and out/renderer must exist, and out/main/index.js must contain the hooks' marker.
//  2. Launch with `executablePath` (the unpackaged electron binary) and the repo root as the app
//     argument, never in Playwright's loader mode. The loader adds `disable-renderer-backgrounding`
//     and `disable-backgrounding-occluded-windows`, which changes the behavior under test.
//  3. Delete `ELECTRON_RUN_AS_NODE` from the child's env (an empty string still counts as set) and
//     assert that it is gone. Otherwise the failure is a generic "Process failed to launch!".
//  4. Give every launch a fresh VELTRIVA_USER_DATA_DIR, so tests never touch the real profile.
//  5. Find pages by identity, never by position: `shellPage` polls `app.windows()` for the shell
//     URL. `firstWindow()` and `windows()[0]` are random. Do the same for tabs in M1.3: add
//     `pageForTab(app, tabId)`, which matches the tab's DevTools target ID
//     (`getOrCreateDevToolsTargetId()`, returned by the `getTabStates()` test hook) against
//     `Target.getTargetInfo` from a CDP session on each page.
//  6. Always close the app, even after a failure. If `close()` takes longer than 30 s, kill the
//     process tree and record a warning instead of failing the test: with Playwright's inspector
//     and CDP attached, teardown on a loaded machine took up to ~100 s, against ~25 ms for the same
//     `app.quit()` without Playwright (M1.1). Shutdown speed is tested outside Playwright
//     (ADR-0008 4a). Never call `page.close()` on the shell or on a tab.
//  7. After the app cancels a navigation (`will-navigate`), Playwright keeps waiting for it:
//     actions such as `click()` hang on "waiting for navigation to finish". Check the page with
//     `evaluate` from then on.
//
// Tabs (see S6): `openTab` in ./hooks.ts registers `electronApp.waitForEvent('window')` before it
// opens a test tab and confirms the Page by URL. Act on a tab (click, screenshot) only while it is
// attached, and never assert hidden-tab behavior (visibility, timer throttling) through a
// Playwright Page: its focus emulation masks it. For M1.3, add `pageForTab(app, tabId)` (rule 5).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { SHELL_URL } from '../../src/main/shell/assets';

/** The first launch on a CI runner can be slow. */
const LAUNCH_TIMEOUT_MS = 60_000;
const SHELL_TIMEOUT_MS = 30_000;
/** S6 measured 7 to 10 s per close() under load. */
const CLOSE_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 100;

const RUN_AS_NODE_ENV = 'ELECTRON_RUN_AS_NODE';
/** Mirrors USER_DATA_DIR_OVERRIDE_ENV in src/main/app/user-data-dir.ts (honored when unpackaged). */
const USER_DATA_DIR_ENV = 'VELTRIVA_USER_DATA_DIR';

/** Every file the app needs at runtime. The paths are relative to the repo root. */
const BUILD_OUTPUTS = [
  'out/main/index.js',
  'out/main/data-worker.js',
  'out/preload/shell.js',
  'out/renderer/index.html',
];

/**
 * Only `--mode test` builds contain the test hooks (src/main/testing/test-hooks.ts), and the
 * production build check refuses a build that does. Hard-coded: importing the constant would load
 * the hooks' Electron imports into the test runner.
 */
const TEST_HOOKS_MARKER = '__veltrivaTest';
const BUILD_HINT = 'Run `npm run test:e2e`, which builds the test variant.';

export interface AppPaths {
  /** The directory with package.json. Its `main` is out/main/index.js. */
  readonly repoRoot: string;
  /** What `require('electron')` returns in Node: the path of the electron binary. */
  readonly electronBinary: string;
}

const REPO_ROOT = resolve(__dirname, '..', '..');

let cachedPaths: AppPaths | undefined;

/** Checks the build and locates electron. Throws a clear error if anything is missing. */
export function appPaths(): AppPaths {
  cachedPaths ??= resolveAppPaths();
  return cachedPaths;
}

function resolveAppPaths(): AppPaths {
  const missing = BUILD_OUTPUTS.filter((relative) => !existsSync(join(REPO_ROOT, relative)));
  if (missing.length > 0) {
    throw new Error(`The app is not built: missing ${missing.join(', ')}. ${BUILD_HINT}`);
  }
  // A production build also runs, but without the hooks every spec would fail in a confusing way.
  if (!readFileSync(join(REPO_ROOT, 'out/main/index.js'), 'utf8').includes(TEST_HOOKS_MARKER)) {
    throw new Error(
      `out/main/index.js is not a test build: it has no ${TEST_HOOKS_MARKER} hooks. ${BUILD_HINT}`,
    );
  }

  return { repoRoot: REPO_ROOT, electronBinary: resolveElectronBinary() };
}

/**
 * The electron package exports the path of its binary. Its TypeScript type says it is the
 * Electron API, so read it at runtime and check what we got.
 */
function resolveElectronBinary(): string {
  const requireFromRepo = createRequire(join(REPO_ROOT, 'package.json'));
  let exported: unknown;
  try {
    exported = requireFromRepo('electron');
  } catch (error) {
    throw new Error('Cannot load the `electron` package. Run `npm run setup`.', { cause: error });
  }
  if (typeof exported !== 'string') {
    throw new Error(
      `require('electron') returned ${typeof exported}, but the path of the electron binary was ` +
        'expected. Launching without executablePath would change Chromium switches (S6).',
    );
  }
  if (!existsSync(exported)) {
    throw new Error(`The electron binary is missing: ${exported}. Run \`npm run setup\`.`);
  }
  return exported;
}

/**
 * The environment for the child process: `process.env` without `ELECTRON_RUN_AS_NODE`, plus a
 * fresh profile directory. Throws if the variable could still reach the app.
 */
export function buildLaunchEnv(userDataDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Windows variable names are case-insensitive, so match every spelling.
    if (value !== undefined && key.toUpperCase() !== RUN_AS_NODE_ENV) {
      env[key] = value;
    }
  }
  env[USER_DATA_DIR_ENV] = userDataDir;

  if (Object.keys(env).some((key) => key.toUpperCase() === RUN_AS_NODE_ENV)) {
    throw new Error(`${RUN_AS_NODE_ENV} must not be set for the app under test.`);
  }
  return env;
}

export interface LaunchOptions {
  /**
   * Chromium or Electron switches, put before the app's path (where Electron reads them). Only for
   * a spec that must change one thing about the browser: say why next to the switch.
   */
  readonly switches?: readonly string[];
  /** More environment variables for the app, such as a test build's VELTRIVA_TEST_FIRST_RUN. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Switches every launch gets. Chromium's fake camera and microphone: on a machine without them,
 * such as CI's runner, Chromium refuses `getUserMedia` with NotFoundError before it asks, so the
 * permission specs would never see their question. The question still comes, and is still
 * answered by the spec: never `--use-fake-ui-for-media-stream`, which would answer it itself.
 * It also keeps the specs off a real camera.
 */
const DEFAULT_SWITCHES = ['--use-fake-device-for-media-stream'] as const;

export async function launchApp(
  userDataDir: string,
  options: LaunchOptions = {},
): Promise<ElectronApplication> {
  const { repoRoot, electronBinary } = appPaths();
  const app = await electron.launch({
    executablePath: electronBinary,
    args: [...DEFAULT_SWITCHES, ...(options.switches ?? []), repoRoot],
    cwd: repoRoot,
    env: { ...buildLaunchEnv(userDataDir), ...options.env },
    timeout: LAUNCH_TIMEOUT_MS,
  });
  // Electron is ready before the app is: since M2.2a, main reads the saved session before it
  // creates the window and the test hooks. A spec may use a hook as soon as this returns.
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  while (!(await app.evaluate(() => globalThis.__veltrivaTest !== undefined))) {
    if (Date.now() > deadline) {
      await closeApp(app);
      throw new Error('The app started, but its test hooks never appeared.');
    }
    await delay(POLL_INTERVAL_MS);
  }
  // And the shell's page exists: a spec that waits for the next window (a test tab's) must not
  // get the shell's instead.
  await shellPage(app);
  return app;
}

/** True if `url` is the shell page, app://shell/index.html. Ignores the query and hash. */
export function isShellUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false; // e.g. an empty string
  }
  const shell = new URL(SHELL_URL);
  // Node gives non-special schemes an opaque origin, so compare the parts instead.
  return (
    parsed.protocol === shell.protocol &&
    parsed.host === shell.host &&
    parsed.pathname === shell.pathname
  );
}

/** The shell page if it exists right now. Matched by URL, never by position. */
export function findShellPage(app: ElectronApplication): Page | undefined {
  return app.windows().find((page) => isShellUrl(page.url()));
}

/** Polls `app.windows()` until the shell page exists. */
export async function shellPage(
  app: ElectronApplication,
  timeoutMs = SHELL_TIMEOUT_MS,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const page = findShellPage(app);
    if (page !== undefined) {
      await page.waitForLoadState('domcontentloaded');
      return page;
    }
    if (Date.now() >= deadline) {
      const seen = app.windows().map((candidate) => candidate.url());
      throw new Error(
        `The shell page (${SHELL_URL}) did not appear ` +
          `within ${String(timeoutMs)} ms. URLs seen: ${seen.length > 0 ? seen.join(', ') : 'none'}.`,
      );
    }
    await delay(POLL_INTERVAL_MS);
  }
}

/**
 * Closes the app. If `close()` takes longer than `CLOSE_TIMEOUT_MS`, kills the process tree and
 * returns 'killed' (see rule 6 above). Throws, after killing the tree, if `close()` fails.
 */
export async function closeApp(app: ElectronApplication): Promise<'closed' | 'killed'> {
  let child: ReturnType<ElectronApplication['process']>;
  try {
    child = app.process();
  } catch {
    // A spec that closed the app's last window has already quit it (M1.4a): Playwright drops its
    // handle on the process once the app is gone, and there is nothing left to close.
    return 'closed';
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolveTimeout) => {
    timer = setTimeout(() => {
      resolveTimeout('timeout');
    }, CLOSE_TIMEOUT_MS);
  });

  const closing = app.close().then(() => 'closed' as const);
  // After a timeout the kill below makes `close()` fail later. That failure is already reported.
  closing.catch(() => undefined);

  let outcome: 'closed' | 'timeout';
  try {
    outcome = await Promise.race([closing, timeout]);
  } catch (error) {
    killProcessTree(child.pid);
    throw new Error('app.close() failed; killed the app process tree.', { cause: error });
  } finally {
    clearTimeout(timer);
  }

  if (outcome === 'timeout') {
    killProcessTree(child.pid);
    return 'killed';
  }
  return 'closed';
}

export const CLOSE_TIMEOUT_WARNING =
  `app.close() took longer than ${String(CLOSE_TIMEOUT_MS)} ms, so the app's process tree was ` +
  'killed. Teardown with Playwright attached is slow on a loaded machine; shutdown speed is not ' +
  'measured by these tests.';

/**
 * On Windows Playwright starts electron through a shell, so `child.pid` is the shell's.
 * `ChildProcess.kill()` would leave electron.exe running; `taskkill /T` takes the whole tree.
 */
function killProcessTree(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

/** Samples `read` every `intervalMs` for `durationMs`. Returns every distinct value seen. */
export async function observeFor<T>(
  durationMs: number,
  read: () => T | Promise<T>,
  intervalMs = POLL_INTERVAL_MS,
): Promise<T[]> {
  const seen = new Set<T>();
  const deadline = Date.now() + durationMs;
  do {
    seen.add(await read());
    await delay(intervalMs);
  } while (Date.now() < deadline);
  return [...seen];
}
