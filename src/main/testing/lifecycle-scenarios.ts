// Lifecycle-behavior scenarios (ADR-0008 4a): checks of what Playwright masks, such as a hidden
// tab's visibility and timer throttling. Test builds only, behind `import.meta.env.MODE`. The app
// runs the scenario named by VELTRIVA_LIFECYCLE_SCENARIO with no Playwright and no inspector
// attached, prints one result line to stdout and exits; tests/lifecycle reads that line.
import { app } from 'electron';

import type { Worker } from 'node:worker_threads';

import type { AppNotices } from '../notices/app-notices';
import type { DataClient } from '../persistence/data-client';
import type { StartupSession } from '../session/session-startup';
import { holdDataWorker } from './data-hold';
import {
  backgroundRestoreScroll,
  discardBeforeUnloadHidden,
  discardRealInputKept,
  discardRestoresPageState,
  freezeExperiment,
} from './discard-scenarios';
import { memoryBenchmark } from './benchmark-scenarios';
import { searchBenchmark } from './search-benchmark';
import { reportSession, sessionChurn } from './session-scenarios';
import type { TabId, TabManager } from '../tabs/tab-manager';
import type { FocusManager } from '../focus/focus-manager';
import type { FullscreenController } from '../windows/fullscreen';
import type { LayoutManager } from '../windows/layout-manager';
import type { MainWindow } from '../windows/main-window';
import type { WebContentsView } from 'electron';

export const LIFECYCLE_SCENARIO_ENV = 'VELTRIVA_LIFECYCLE_SCENARIO';
export const LIFECYCLE_RESULT_PREFIX = 'VELTRIVA_LIFECYCLE_RESULT ';
/** Lines printed after the result, as the app shuts down. */
export const LIFECYCLE_EVENT_PREFIX = 'VELTRIVA_LIFECYCLE_EVENT ';

export interface ScenarioContext {
  readonly main: MainWindow;
  readonly tabs: TabManager;
  readonly fullscreen: FullscreenController;
  readonly views: ReadonlyMap<TabId, WebContentsView>;
  readonly data: DataClient;
  readonly dataWorker: Worker;
  readonly notices: AppNotices;
  readonly startup: StartupSession | null;
  /** Pauses automation for this run (not saved): a measurement makes every move itself. */
  readonly pauseAutomation?: () => void;
  /** Opens the memory palette the way Ctrl+Shift+K does (M4.2). */
  readonly focus?: Pick<FocusManager, 'openPalette'>;
  /** Says what the shell is raised for (ADR-0006 A′). */
  readonly layout?: Pick<LayoutManager, 'shellRaisedFor'>;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Counts 100 ms timer ticks in a page and reports its visibility. */
const INSTALL_COUNTER = `(() => {
  window.__veltrivaTicks = 0;
  setInterval(() => { window.__veltrivaTicks += 1; }, 100);
  return true;
})()`;
const READ_COUNTER = `({ ticks: window.__veltrivaTicks, visibility: document.visibilityState })`;
const RESET_COUNTER = `(() => { window.__veltrivaTicks = 0; return true; })()`;

/** A fresh renderer on a loaded CI runner can take several seconds, even for about:blank. */
const LOAD_TIMEOUT_MS = 30_000;

async function waitForView(
  views: ScenarioContext['views'],
  tabId: TabId,
): Promise<WebContentsView> {
  const deadline = Date.now() + LOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const view = views.get(tabId);
    if (view !== undefined && !view.webContents.isLoading() && view.webContents.getURL() !== '') {
      return view;
    }
    await wait(100);
  }
  const view = views.get(tabId);
  const state =
    view === undefined
      ? 'no view'
      : `loading: ${String(view.webContents.isLoading())}, url: ${view.webContents.getURL()}`;
  throw new Error(
    `Tab ${tabId} did not finish loading in ${String(LOAD_TIMEOUT_MS)} ms (${state})`,
  );
}

/**
 * A non-selected tab is detached, so Chromium reports it `hidden` and throttles its timers to
 * about one tick per second; the selected tab stays `visible` and unthrottled.
 */
async function backgroundTabHidden({ main, tabs, views }: ScenarioContext): Promise<unknown> {
  // ADR-0008 4a: keep the window on top so native occlusion tracking can't skew the result.
  main.window.setAlwaysOnTop(true);
  const foreground = tabs.create();
  tabs.navigate(foreground, 'about:blank');
  const background = tabs.create();
  tabs.navigate(background, 'about:blank');
  const [foregroundView, backgroundView] = await Promise.all([
    waitForView(views, foreground),
    waitForView(views, background),
  ]);
  tabs.select(foreground);

  await foregroundView.webContents.executeJavaScript(INSTALL_COUNTER);
  await backgroundView.webContents.executeJavaScript(INSTALL_COUNTER);
  // Let Chromium notice the hidden tab before measuring.
  await wait(2_000);
  await foregroundView.webContents.executeJavaScript(RESET_COUNTER);
  await backgroundView.webContents.executeJavaScript(RESET_COUNTER);
  const windowMs = 3_000;
  await wait(windowMs);
  const [selected, hidden] = (await Promise.all([
    foregroundView.webContents.executeJavaScript(READ_COUNTER),
    backgroundView.webContents.executeJavaScript(READ_COUNTER),
  ])) as unknown[];
  return { windowMs, selected, hidden };
}

/**
 * Two tabs with live documents, so closing the window has views and renderers to tear down. The
 * scenario ends by closing the window as a user would; the harness times the quit that follows.
 */
async function closeWithLiveTabs({ main, tabs, views }: ScenarioContext): Promise<unknown> {
  main.window.setAlwaysOnTop(true);
  const first = tabs.create();
  tabs.navigate(first, 'about:blank');
  const second = tabs.create();
  tabs.navigate(second, 'about:blank');
  await Promise.all([waitForView(views, first), waitForView(views, second)]);
  return { liveTabs: views.size };
}

/**
 * M2.1b: the worker is inside a statement that runs far past the 3 s shutdown cap, and the window
 * closes. The quit must still end at the cap, with a hard exit (ADR-0004 item 5).
 */
async function quitWithBusyDatabase({ data, dataWorker }: ScenarioContext): Promise<unknown> {
  const ready = await data.ready;
  holdDataWorker(dataWorker, 20_000);
  // Let the worker enter the statement before the quit starts.
  await wait(300);
  return { runId: ready.runId };
}

/** M2.1b: what the data worker reported on opening, and the notices it led to. */
async function reportDataStartup({ data, notices }: ScenarioContext): Promise<unknown> {
  const ready = await data.ready.catch(() => null);
  return { ready, notices: notices.list() };
}

/** M2.1b: some data, then the daily backup, as upkeep would take it while the user is away. */
async function writeAndBackUp({ data }: ScenarioContext): Promise<unknown> {
  await data.ready;
  await data.call('appState.set', { key: 'session', value: { written: 'before the backup' } });
  const upkeep = await data.call(
    'maintenance.run',
    { now: Date.now(), visitRetentionDays: 365 },
    { timeoutMs: 60_000 },
  );
  return { upkeep };
}

interface Scenario {
  run(context: ScenarioContext): Promise<unknown>;
  /** After reporting, close the window and let the app quit on its own, not `app.exit()`. */
  readonly endsByClosingWindow?: boolean;
}

/**
 * ADR-0006 A′: with the shell raised above it, the page must stay `visible` and unthrottled.
 * Chromium hides a page under an opaque view (spike S1), and it takes a view's opacity from its
 * document's root background, so A′ works only while the shell's html and body are transparent.
 * The scenario therefore takes the real path: the page goes fullscreen, the shell draws only the
 * notice (transparent around it) and asks to be raised, and the page is measured under it.
 */
async function raisedShellKeepsPageVisible({
  main,
  tabs,
  views,
  fullscreen,
}: ScenarioContext): Promise<unknown> {
  main.window.setAlwaysOnTop(true);
  const tab = tabs.create();
  tabs.navigate(tab, 'about:blank');
  const view = await waitForView(views, tab);
  await view.webContents.executeJavaScript(INSTALL_COUNTER);
  await view.webContents.executeJavaScript('document.documentElement.requestFullscreen()', true);
  const deadline = Date.now() + 5_000;
  while (!fullscreen.shellRaised()) {
    if (Date.now() > deadline) {
      throw new Error('The shell was not raised for the fullscreen notice');
    }
    await wait(50);
  }
  // Measure while the notice is up: it stays for NOTICE_MS (4 s) after the raise.
  await wait(500);
  await view.webContents.executeJavaScript(RESET_COUNTER);
  const windowMs = 2_500;
  await wait(windowMs);
  const raised = (await view.webContents.executeJavaScript(READ_COUNTER)) as unknown;
  return { windowMs, raised, stillRaised: fullscreen.shellRaised() };
}

/**
 * ADR-0006 A′ for the memory palette (M4.2): Ctrl+Shift+K's path, through the shell, which paints
 * the palette on a transparent page and asks to be raised. The page under it must stay `visible`
 * and unthrottled, as under the fullscreen notice.
 */
async function paletteKeepsPageVisible({
  main,
  tabs,
  views,
  focus,
  layout,
}: ScenarioContext): Promise<unknown> {
  if (focus === undefined || layout === undefined) {
    throw new Error('The palette scenario needs the focus manager and the layout');
  }
  main.window.setAlwaysOnTop(true);
  const tab = tabs.create();
  tabs.navigate(tab, 'about:blank');
  const view = await waitForView(views, tab);
  await view.webContents.executeJavaScript(INSTALL_COUNTER);
  // The shell must be up to hear the event: its page loads alongside the scenario.
  const shellDeadline = Date.now() + LOAD_TIMEOUT_MS;
  while (main.shell.webContents.isLoading() || main.shell.webContents.getURL() === '') {
    if (Date.now() > shellDeadline) {
      throw new Error('The shell did not load');
    }
    await wait(100);
  }
  await wait(1_000);
  focus.openPalette();
  const deadline = Date.now() + 10_000;
  while (!layout.shellRaisedFor().has('palette')) {
    if (Date.now() > deadline) {
      throw new Error('The shell was not raised for the palette');
    }
    await wait(50);
  }
  await wait(500);
  await view.webContents.executeJavaScript(RESET_COUNTER);
  const windowMs = 2_500;
  await wait(windowMs);
  const raised = (await view.webContents.executeJavaScript(READ_COUNTER)) as unknown;
  return { windowMs, raised, stillRaised: layout.shellRaisedFor().has('palette') };
}

const SCENARIOS: ReadonlyMap<string, Scenario> = new Map([
  ['raised-shell-keeps-page-visible', { run: raisedShellKeepsPageVisible }],
  ['palette-keeps-page-visible', { run: paletteKeepsPageVisible }],
  ['background-tab-hidden', { run: backgroundTabHidden }],
  ['close-with-live-tabs', { run: closeWithLiveTabs, endsByClosingWindow: true }],
  ['quit-with-busy-database', { run: quitWithBusyDatabase, endsByClosingWindow: true }],
  ['report-data-startup', { run: reportDataStartup, endsByClosingWindow: true }],
  ['write-and-back-up', { run: writeAndBackUp, endsByClosingWindow: true }],
  // Ends only when the test kills it (tests/lifecycle/hard-kill.test.ts).
  ['session-churn', { run: sessionChurn }],
  ['report-session', { run: reportSession, endsByClosingWindow: true }],
  // M3.1: the discard and restore (./discard-scenarios.ts).
  ['discard-restores-page-state', { run: discardRestoresPageState }],
  ['discard-beforeunload-hidden', { run: discardBeforeUnloadHidden }],
  ['discard-real-input-kept', { run: discardRealInputKept }],
  ['background-restore-scroll', { run: backgroundRestoreScroll }],
  ['freeze-experiment', { run: freezeExperiment }],
  // Phase 3: the §9.3 memory benchmark (./benchmark-scenarios.ts, tests/benchmarks).
  ['memory-benchmark', { run: memoryBenchmark }],
  // Phase 4: the §5.4 search benchmark (./search-benchmark.ts, tests/benchmarks/search.bench.ts).
  ['search-benchmark', { run: searchBenchmark }],
]);

export function runLifecycleScenario(name: string, context: ScenarioContext): void {
  const scenario = SCENARIOS.get(name);
  // will-quit comes after every before-quit handler has let the quit through, so the data
  // client's state here shows whether quitting waited for the database to close (ADR-0004).
  app.once('will-quit', () => {
    const event = { event: 'will-quit', dataState: context.data.state };
    process.stdout.write(`${LIFECYCLE_EVENT_PREFIX}${JSON.stringify(event)}\n`);
  });
  const finish = (report: unknown, closeWindow = false): void => {
    process.stdout.write(`${LIFECYCLE_RESULT_PREFIX}${JSON.stringify(report)}\n`);
    if (closeWindow) {
      context.main.window.close();
    } else {
      app.exit(0);
    }
  };
  if (scenario === undefined) {
    finish({ error: `unknown scenario ${name}` });
    return;
  }
  scenario
    .run(context)
    .then((result) => {
      finish({ scenario: name, result }, scenario.endsByClosingWindow);
    })
    .catch((error: unknown) => {
      finish({ scenario: name, error: error instanceof Error ? error.message : String(error) });
    });
}
