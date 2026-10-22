// Refuses to package a build that contains E2E test hooks (ADR-0008 §4, threat T15).
// `npm run test:e2e` builds out/ in `--mode test`, which compiles the hooks in; a production
// build (`npm run build`) folds them away. Run after a production build, before packaging.
import console from 'node:console';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

const OUT = 'out';
/**
 * Names that exist only in test builds. Strings (the hooks' global, env names, scenario names,
 * messages) survive minification; function names are a second net. `setSearchTemplate` is not
 * here on purpose: production code exports it for a future search-engine setting.
 */
const MARKERS = [
  // src/main/testing/test-hooks.ts
  '__veltrivaTest',
  'installTestHooks',
  'openTestTab',
  'closeTestTabs',
  'webContentsRoles',
  'crashTab',
  'forcefullyCrashRenderer',
  'contextMenuItems',
  'invokeContextMenuItem',
  'tabMenuItems',
  'invokeTabMenuItem',
  'viewStack',
  'externalLaunches',
  'clientHintsReady',
  'dataCall',
  'dataState',
  'mainNativeModules',
  'dataReady',
  'holdDataWorker',
  'showNotice',
  // (the hook `lifecycleFacts` is not here: production TabManager has a method of that name)
  'discardTab',
  'freezeTab',
  'runtimeTransitions',
  'advanceLifecycleClock',
  'lifecyclePlan',
  'lifecycleEvaluate',
  'lifecycleLog',
  'setMemoryPressure',
  'setLifecycleSettings',
  // src/main/testing/test-clock.ts: the accelerated lifecycle clock (M3.2)
  'testClockAdjustment',
  'advanceTestClock',
  'testMemoryPressure',
  'setTestMemoryPressure',
  'testIsCaptured',
  'setTestCaptured',
  'setCaptured',
  // src/main/testing/runtime-transitions.ts
  'recordRuntimeTransition',
  'recordedRuntimeTransitions',
  // src/main/testing/data-hold.ts and src/data/testing/hold.ts: holding the data worker
  'veltriva-test-hold',
  'holdThread',
  'isHoldMessage',
  // src/main/testing/external-launches.ts: test builds record app launches instead of making them
  'recordExternalLaunch',
  'recordedExternalLaunches',
  // src/main/testing/test-files.ts: test builds download into their own profile, open nothing
  'recordingFileActions',
  'recordedFileActions',
  'testDownloadsFolder',
  // src/main/testing/lifecycle-scenarios.ts
  'VELTRIVA_LIFECYCLE',
  'runLifecycleScenario',
  'background-tab-hidden',
  'close-with-live-tabs',
  'raised-shell-keeps-page-visible',
  'quit-with-busy-database',
  'report-data-startup',
  'write-and-back-up',
  'session-churn',
  'report-session',
  'VELTRIVA_CHURN',
  'churn-started',
  // src/main/testing/discard-scenarios.ts
  'VELTRIVA_FIXTURE_ORIGIN',
  'discard-restores-page-state',
  'discardRestoresPageState',
  'discard-beforeunload-hidden',
  'discardBeforeUnloadHidden',
  'discard-real-input-kept',
  'discardRealInputKept',
  'background-restore-scroll',
  'backgroundRestoreScroll',
  'freeze-experiment',
  'freezeExperiment',
  'veltriva-tick',
  // src/main/testing/fail-fast.ts
  'exitOnUncaughtException',
  'Uncaught exception in main',
];

async function* files(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* files(path);
    } else if (/\.(js|mjs|cjs|html)$/.test(entry.name)) {
      yield path;
    }
  }
}

const found = [];
for await (const path of files(OUT)) {
  const text = await readFile(path, 'utf8');
  for (const marker of MARKERS) {
    if (text.includes(marker)) {
      found.push(`${path}: ${marker}`);
    }
  }
}

if (found.length > 0) {
  console.error(
    'out/ contains E2E test hooks, so it is not a production build:\n' +
      found.map((line) => `  ${line}`).join('\n') +
      '\nRun `npm run build` and try again.',
  );
  process.exit(1);
}
console.log('out/ is a production build: no test hooks found.');
