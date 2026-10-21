// What the session-restore specs (./session.spec.ts, M2.2a) share: launching the app again on the
// same profile, quitting it as the user does or killing it as a crash would, reading back what the
// session store saved, and the few shell locators those specs need.
//
// The standard `electronApp` fixture launches one app and closes it after the test. A restore test
// needs several launches on one profile, so `launcher` (below) starts them, remembers each one and
// closes whatever is still running when the test ends, even after a failure. The rules at the top
// of ./launch.ts apply to every launch: the shell is found by its URL, the app is closed through
// `closeApp` (killed after 30 s), and the profile is the test's own `userDataDir`.
//
// What is saved is read through the `dataCall` hook, as main reads it: the rows in the database,
// not what the shell shows. A spec waits for the database to hold a change (`expectSaved`) before
// it quits or kills the app, because the session store writes 250 ms to 1 s after a change.
import { spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { ElectronApplication, Locator, Page } from '@playwright/test';

import type { Rect } from '../../src/core/layout/rect';
import type { AppNotice } from '../../src/main/notices/app-notices';
import type { DataReady } from '../../src/main/persistence/data-client';
import type { TabRow } from '../../src/shared/contracts/data-rpc';
import { expect } from './expect';
import { test as base } from './fixtures';
import { setSearchTemplate } from './hooks';
import type { TabId } from './hooks';
import { CLOSE_TIMEOUT_WARNING, closeApp, launchApp, shellPage } from './launch';
import {
  closeWithButton,
  loadInNewTab,
  SLOW_TIMEOUT_MS,
  sidebarIds,
  tabElements,
} from './shell-ui';

// ── Launching, quitting, killing ────────────────────────────────────────────────────────────────

/** One launch of the app: the Electron application and its shell page. */
export interface RunningApp {
  readonly app: ElectronApplication;
  readonly shell: Page;
}

export interface Launcher {
  /**
   * Starts the app on the test's profile and waits until the shell shows its tabs. Searches go to
   * the local fixture, so a stray Enter never reaches the internet.
   */
  launch(): Promise<RunningApp>;
  /** Quits the app as the window's close button does, and waits until its process has ended. */
  quit(run: RunningApp): Promise<void>;
  /** Kills the whole process tree at once, as a crash or a power cut would: nothing is flushed. */
  kill(run: RunningApp): Promise<void>;
  /**
   * `launch()` after a `kill()`, for the launch that really starts with the saved session. On
   * this Windows machine a launch soon after a hard kill fails about one time in three, in one of
   * two ways: the database cannot be opened (`SQLITE_IOERR_TRUNCATE`: the launch then starts with
   * one new tab and no session), or Chromium cannot create its lock file ("Access is denied")
   * and the app quits at once. Both come from files the killed process left that Windows (or a
   * scanner) still holds. This tries again, up to 6 launches, and records each failed one as an
   * annotation of the test, so the flake stays visible and does not hide what the test is about.
   */
  launchAfterKill(): Promise<RunningApp>;
}

const LAUNCH_ATTEMPTS_AFTER_KILL = 6;

/** The test, plus the `launcher` fixture. */
export const test = base.extend<{ launcher: Launcher }>({
  launcher: [
    async ({ userDataDir, fixtureServer }, use, testInfo) => {
      const running = new Set<ElectronApplication>();
      /** What each launch printed (the app logs its own warnings), kept for a failed test. */
      const outputs: string[][] = [];

      const launcher: Launcher = {
        async launch() {
          const app = await launchApp(userDataDir);
          running.add(app);
          const output: string[] = [];
          outputs.push(output);
          for (const stream of [app.process().stdout, app.process().stderr]) {
            stream?.on('data', (chunk: Buffer | string) => {
              output.push(String(chunk));
            });
          }
          const shell = await shellPage(app);
          await setSearchTemplate(app, fixtureServer.url('/search?q={searchTerms}'));
          await expect(tabElements(shell).first()).toBeVisible({ timeout: SLOW_TIMEOUT_MS });
          return { app, shell };
        },

        async quit({ app }) {
          running.delete(app);
          if ((await closeApp(app)) === 'killed') {
            testInfo.annotations.push({ type: 'warning', description: CLOSE_TIMEOUT_WARNING });
            console.warn(CLOSE_TIMEOUT_WARNING);
          }
        },

        async kill({ app }) {
          running.delete(app);
          const child = app.process();
          const ended = processEnded(child);
          const killed = killProcessTree(child.pid);
          await Promise.race([ended, delay(15_000)]);
          await waitUntilGone(killed);
          // Chromium's lock file goes when its handle closes, which Windows finishes a moment
          // after the process is gone. Until then a new launch finds "Access is denied" creating
          // it, takes the lock for another instance's and quits at once.
          await waitUntilMissing(join(userDataDir, 'lockfile'));
          // Playwright learns of the death from the closed connection. Its own `close()` may wait
          // for an event that has already fired, so it gets a short time and no more.
          await Promise.race([app.close().catch(() => undefined), delay(3_000)]);
        },

        async launchAfterKill() {
          for (let attempt = 1; ; attempt += 1) {
            let problem: string;
            try {
              const run = await launcher.launch();
              if ((await dataReadyOf(run.app)) !== null) {
                return run;
              }
              const logged = (outputs.at(-1) ?? [])
                .join('')
                .split(/\r?\n/u)
                .find((line) => line.includes('data.openFailed'));
              problem = `the database did not open (${logged?.trim() ?? 'no data.openFailed line'})`;
              await launcher.kill(run);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              problem = `the app did not start (${message.split(/\r?\n/u)[0] ?? ''})`;
            }
            const description = `Launch ${String(attempt)} after a hard kill failed: ${problem}.`;
            testInfo.annotations.push({ type: 'launch-retried-after-kill', description });
            console.warn(description);
            if (attempt === LAUNCH_ATTEMPTS_AFTER_KILL) {
              throw new Error(
                `${String(attempt)} launches in a row failed after a hard kill. The last: ${problem}.`,
              );
            }
            await delay(1_500);
          }
        },
      };

      try {
        await use(launcher);
      } finally {
        if (testInfo.status !== testInfo.expectedStatus) {
          for (const [index, output] of outputs.entries()) {
            await testInfo.attach(`app-output-launch-${String(index + 1)}`, {
              body: output.join(''),
              contentType: 'text/plain',
            });
          }
        }
        for (const app of running) {
          try {
            if ((await closeApp(app)) === 'killed') {
              testInfo.annotations.push({ type: 'warning', description: CLOSE_TIMEOUT_WARNING });
              console.warn(CLOSE_TIMEOUT_WARNING);
            }
          } catch (error) {
            console.warn('Could not close an app the test launched:', error);
          }
        }
      }
    },
    // Teardown may have to close an app that is still running: its own time budget.
    { timeout: 150_000 },
  ],
});

/** Resolves once the process has exited (at once if it already has). */
export function processEnded(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    child.once('exit', () => {
      resolve();
    });
  });
}

/**
 * On Windows Playwright starts electron through a shell, so `child.pid` may be the shell's:
 * `taskkill /T` takes the whole tree, which `ChildProcess.kill()` would not. Returns the ids of
 * the processes it killed (the root's at least), so a caller can wait until they are gone.
 */
export function killProcessTree(pid: number | undefined): number[] {
  if (pid === undefined) {
    return [];
  }
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    // One line per process: "SUCCESS: The process with PID 41208 (child process of PID 15048)
    // has been terminated." Its first PID is the one killed; the second is its parent, which may
    // be this test runner.
    const killed = result.stdout
      .split(/\r?\n/u)
      .map((line) => /\bPID\s+(\d+)/iu.exec(line)?.[1])
      .filter((id): id is string => id !== undefined)
      .map(Number);
    return [...new Set([pid, ...killed])];
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
  return [pid];
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, but is not ours to signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Waits until none of the processes exists. Killing a tree returns before Windows has torn the
 * processes down (measured: 2 to 4 s for electron's GPU and utility processes), and until then
 * the dying main process still holds the profile's database files: a launch in that gap can fail
 * to open them (`SQLITE_IOERR_TRUNCATE`, seen in about 1 launch in 3).
 */
export async function waitUntilGone(pids: readonly number[], timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pids.some(isRunning) && Date.now() < deadline) {
    await delay(100);
  }
}

/** Waits until a file does not exist (it may be deleted only once its last handle is closed). */
async function waitUntilMissing(path: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (existsSync(path) && Date.now() < deadline) {
    await delay(100);
  }
}

// ── Building a session ──────────────────────────────────────────────────────────────────────────

/**
 * Loads each URL in a tab of its own (the last one stays selected) and closes the new-tab page
 * the app starts with, so the strip holds exactly these tabs. Returns their ids in order.
 */
export async function startWithPages<const Urls extends readonly string[]>(
  app: ElectronApplication,
  shell: Page,
  urls: Urls,
): Promise<{ -readonly [Index in keyof Urls]: TabId }> {
  await expect(tabElements(shell)).toHaveCount(1);
  const [blank] = await sidebarIds(shell);
  if (blank === undefined) {
    throw new Error('The app starts with one tab.');
  }
  const ids: TabId[] = [];
  for (const url of urls) {
    ids.push(await loadInNewTab(app, shell, url));
  }
  await closeWithButton(shell, blank);
  await expect
    .poll(() => sidebarIds(shell), { message: 'only the loaded tabs should be left' })
    .toEqual(ids);
  return ids as unknown as { -readonly [Index in keyof Urls]: TabId };
}

// ── What main holds and what the database holds ─────────────────────────────────────────────────

type DataResult =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly code: string };

/** A data-worker call as main makes it. Throws if the contract or the worker refuses it. */
export async function dataValue<Value>(
  app: ElectronApplication,
  method: string,
  input: unknown,
): Promise<Value> {
  const result: DataResult = await app.evaluate(
    (_electron, request) => {
      const hooks = globalThis.__veltrivaTest;
      if (hooks === undefined) {
        throw new Error('The test hooks are missing: this is not a test build.');
      }
      return hooks.dataCall(request.method, request.input);
    },
    { method, input },
  );
  if (!result.ok) {
    throw new Error(`${method} was refused: ${result.code}`);
  }
  return result.value as Value;
}

/** What the data worker reported on opening this run (`previousExit` and the rest). */
export function dataReadyOf(app: ElectronApplication): Promise<DataReady | null> {
  return app.evaluate(() => {
    const hooks = globalThis.__veltrivaTest;
    if (hooks === undefined) {
      throw new Error('The test hooks are missing: this is not a test build.');
    }
    return hooks.dataReady();
  });
}

/** The notices main shows about Veltriva itself, oldest first. */
export function mainNotices(app: ElectronApplication): Promise<AppNotice[]> {
  return app.evaluate(() => {
    const hooks = globalThis.__veltrivaTest;
    if (hooks === undefined) {
      throw new Error('The test hooks are missing: this is not a test build.');
    }
    return hooks.notices();
  });
}

/** The strip of a notice kind (`session-recovered`, `safe-mode`), as the shell draws it. */
export function noticeStrip(shell: Page, kind: AppNotice['kind']): Locator {
  return shell.locator(`[data-notice-strip][data-notice-kind="${kind}"]`);
}

/** A candidate id for `workspaces.ensureDefault`; the default workspace already exists. */
const WORKSPACE_CANDIDATE = '0199f000-0000-7000-8000-0000000000b1';

export interface SavedSession {
  /** The strip's rows, by position. */
  readonly strip: readonly TabRow[];
  /** Recently closed, newest first. */
  readonly closed: readonly TabRow[];
  readonly selectedTabId: string | null;
  /** The `window` document, or null. */
  readonly window: unknown;
}

/** The session as the database holds it right now. */
export async function readSavedSession(app: ElectronApplication): Promise<SavedSession> {
  const { id: workspaceId } = await dataValue<{ id: string }>(app, 'workspaces.ensureDefault', {
    candidateId: WORKSPACE_CANDIDATE,
    name: 'Default',
    now: Date.now(),
  });
  const [strip, closed, session, window] = await Promise.all([
    dataValue<{ tabs: TabRow[] }>(app, 'tabs.list', {
      workspaceId,
      placement: 'strip',
      limit: 100,
    }),
    dataValue<{ tabs: TabRow[] }>(app, 'tabs.listClosed', { workspaceId, limit: 100 }),
    dataValue<{ value: { selectedTabId?: string | null } | null }>(app, 'appState.get', {
      key: 'session',
    }),
    dataValue<{ value: unknown }>(app, 'appState.get', { key: 'window' }),
  ]);
  return {
    strip: strip.tabs,
    closed: closed.tabs,
    selectedTabId: session.value?.selectedTabId ?? null,
    window: window.value,
  };
}

/**
 * What a spec expects the database to hold. Only the keys given are compared, so a spec states
 * what it cares about; each is read in the same shape.
 */
export interface ExpectedSaved {
  /** The strip's tab ids, in order. */
  readonly ids?: readonly TabId[];
  /** The ids of the pinned tabs, in order. */
  readonly pinnedIds?: readonly TabId[];
  readonly selectedTabId?: TabId | null;
  /** The ids in Recently closed, newest first. */
  readonly closedIds?: readonly TabId[];
  /** The `url` column of these tabs (strip or closed); null if there is no such row. */
  readonly urls?: Readonly<Record<TabId, string | null>>;
  /** The back/forward stack of these tabs; null if there is no such row or no stack. */
  readonly stacks?: Readonly<
    Record<TabId, { readonly index: number; readonly urls: readonly string[] } | null>
  >;
}

function project(saved: SavedSession, wanted: ExpectedSaved): ExpectedSaved {
  const rows = [...saved.strip, ...saved.closed];
  const rowOf = (id: TabId): TabRow | undefined => rows.find((row) => row.id === id);
  return {
    ...(wanted.ids === undefined ? {} : { ids: saved.strip.map((row) => row.id) }),
    ...(wanted.pinnedIds === undefined
      ? {}
      : { pinnedIds: saved.strip.filter((row) => row.pinned).map((row) => row.id) }),
    ...(wanted.selectedTabId === undefined ? {} : { selectedTabId: saved.selectedTabId }),
    ...(wanted.closedIds === undefined ? {} : { closedIds: saved.closed.map((row) => row.id) }),
    ...(wanted.urls === undefined
      ? {}
      : {
          urls: Object.fromEntries(
            Object.keys(wanted.urls).map((id) => [id, rowOf(id)?.url ?? null]),
          ),
        }),
    ...(wanted.stacks === undefined
      ? {}
      : {
          stacks: Object.fromEntries(
            Object.keys(wanted.stacks).map((id) => {
              const state = rowOf(id)?.restoreState ?? null;
              return [
                id,
                state === null
                  ? null
                  : { index: state.index, urls: state.entries.map((entry) => entry.url) },
              ];
            }),
          ),
        }),
  };
}

/**
 * Waits until the database holds what `expected` says. The session store writes at most one
 * second after a change, so a spec calls this before it quits or kills the app.
 */
export async function expectSaved(
  app: ElectronApplication,
  expected: ExpectedSaved,
  message = 'the session should be saved',
): Promise<void> {
  await expect
    .poll(async () => project(await readSavedSession(app), expected), {
      message,
      timeout: SLOW_TIMEOUT_MS,
    })
    .toEqual(expected);
}

// ── The window ──────────────────────────────────────────────────────────────────────────────────

export interface WindowGeometry {
  /** Where the window is when it is not maximized (`getNormalBounds`), whatever it is now. */
  readonly normal: Rect;
  readonly maximized: boolean;
}

/** The main window's normal bounds and whether it is maximized. */
export function windowGeometry(app: ElectronApplication): Promise<WindowGeometry> {
  return app.evaluate(({ BaseWindow }) => {
    const [window] = BaseWindow.getAllWindows();
    if (window === undefined) {
      throw new Error('There is no window.');
    }
    return { normal: window.getNormalBounds(), maximized: window.isMaximized() };
  });
}

/**
 * Moves and resizes the main window to a size the default is not, well inside the primary
 * display's work area. Returns the bounds the window ended up with.
 */
export function placeTestWindow(app: ElectronApplication): Promise<Rect> {
  return app.evaluate(({ BaseWindow, screen }) => {
    const [window] = BaseWindow.getAllWindows();
    if (window === undefined) {
      throw new Error('There is no window.');
    }
    const area = screen.getPrimaryDisplay().workArea;
    const width = Math.max(700, Math.min(980, area.width - 120));
    const height = Math.max(520, Math.min(660, area.height - 120));
    window.setBounds({ x: area.x + 60, y: area.y + 40, width, height });
    return window.getNormalBounds();
  });
}

/** The primary display's scale factor: 1.25 for a display set to 125 %. */
export function displayScaleFactor(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ screen }) => screen.getPrimaryDisplay().scaleFactor);
}

/** Maximizes the main window. */
export async function maximizeWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BaseWindow }) => {
    const [window] = BaseWindow.getAllWindows();
    if (window === undefined) {
      throw new Error('There is no window.');
    }
    window.maximize();
  });
}

/** Whether two rectangles agree to within a pixel on every side (display scaling rounds). */
export function sameBounds(actual: Rect, expected: Rect, tolerance = 1): boolean {
  return (
    Math.abs(actual.x - expected.x) <= tolerance &&
    Math.abs(actual.y - expected.y) <= tolerance &&
    Math.abs(actual.width - expected.width) <= tolerance &&
    Math.abs(actual.height - expected.height) <= tolerance
  );
}
