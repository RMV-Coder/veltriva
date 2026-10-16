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

async function waitForView(
  views: ScenarioContext['views'],
  tabId: TabId,
): Promise<WebContentsView> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const view = views.get(tabId);
    if (view !== undefined && !view.webContents.isLoading() && view.webContents.getURL() !== '') {
      return view;
    }
    await wait(100);
  }
  throw new Error(`Tab ${tabId} did not finish loading`);
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

const SCENARIOS: Readonly<Record<string, (context: ScenarioContext) => Promise<unknown>>> = {
  'background-tab-hidden': backgroundTabHidden,
};

export function runLifecycleScenario(name: string, context: ScenarioContext): void {
  const scenario = SCENARIOS[name];
  const finish = (result: unknown): void => {
    process.stdout.write(`${LIFECYCLE_RESULT_PREFIX}${JSON.stringify(result)}\n`);
    app.exit(0);
  };
  if (scenario === undefined) {
    finish({ error: `unknown scenario ${name}` });
    return;
  }
  scenario(context)
    .then((result) => {
      finish({ scenario: name, result });
    })
    .catch((error: unknown) => {
      finish({ scenario: name, error: error instanceof Error ? error.message : String(error) });
    });
}
