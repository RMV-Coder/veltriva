// Lifecycle-behavior scenarios (ADR-0008 4a): checks of what Playwright masks, such as a hidden
// tab's visibility and timer throttling. Test builds only, behind `import.meta.env.MODE`. The app
// runs the scenario named by VELTRIVA_LIFECYCLE_SCENARIO with no Playwright and no inspector
// attached, prints one result line to stdout and exits; tests/lifecycle reads that line.
import { app } from 'electron';

import type { TabId, TabManager } from '../tabs/tab-manager';
import type { MainWindow } from '../windows/main-window';
import type { WebContentsView } from 'electron';

export const LIFECYCLE_SCENARIO_ENV = 'VELTRIVA_LIFECYCLE_SCENARIO';
export const LIFECYCLE_RESULT_PREFIX = 'VELTRIVA_LIFECYCLE_RESULT ';

interface ScenarioContext {
  readonly main: MainWindow;
  readonly tabs: TabManager;
  readonly views: ReadonlyMap<TabId, WebContentsView>;
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

interface Scenario {
  run(context: ScenarioContext): Promise<unknown>;
  /** After reporting, close the window and let the app quit on its own, not `app.exit()`. */
  readonly endsByClosingWindow?: boolean;
}

const SCENARIOS: ReadonlyMap<string, Scenario> = new Map([
  ['background-tab-hidden', { run: backgroundTabHidden }],
  ['close-with-live-tabs', { run: closeWithLiveTabs, endsByClosingWindow: true }],
]);

export function runLifecycleScenario(name: string, context: ScenarioContext): void {
  const scenario = SCENARIOS.get(name);
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
