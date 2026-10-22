import { getRandomValues } from 'node:crypto';
import { join } from 'node:path';

import { app, Menu, nativeTheme, powerMonitor, session } from 'electron';
import { performance } from 'node:perf_hooks';
import type { WebContents } from 'electron';

import { uuidv7 } from '../core/id/uuidv7';
import { displayUrl, originLabel } from '../core/url/display';
import {
  isPreviewActive,
  PRESET_VALUES,
  PREVIEW_ACTIVE_DAYS,
  resolveLifecycleSettings,
} from '../core/lifecycle/policy';
import type { LifecycleClock, LifecycleSettings, MemoryPressure } from '../core/lifecycle/policy';
import { originOf } from '../core/permissions/permission-policy';
import { SEARCH_ENGINES } from '../core/url/search-engines';
import { siteFromInput, siteOf } from '../core/url/site';
import { ActivationTracker } from '../core/input/user-activation';
import { ClientHintOptIns } from '../core/net/client-hints';
import { PermissionDecisions } from '../core/permissions/permission-decisions';
import type { SettingsView } from '../shared/contracts/schemas';
import {
  DEFAULT_PRESSURE_PERCENT,
  DEFAULT_SETTINGS,
  OVERRIDE_LIMITS,
  pressurePercent,
} from '../shared/contracts/settings';
import type { LifecycleSettingsDocument, Settings } from '../shared/contracts/settings';
import { APP_USER_MODEL_ID, BROWSING_PARTITION } from '../shared/constants/app-identity';
import { cleanUserAgent } from './app/user-agent';
import { resolveUserDataDir, USER_DATA_DIR_OVERRIDE_ENV } from './app/user-data-dir';
import { createLoginHandler } from './auth/sign-in';
import { DownloadManager, MAX_LISTED_DOWNLOADS } from './downloads/download-manager';
import { createDownloadStore } from './downloads/download-store';
import { systemFileActions } from './downloads/file-actions';
import { systemLauncher } from './external/launcher';
import { ExternalProtocolGuard } from './external/protocol-guard';
import { FocusManager } from './focus/focus-manager';
import { HistoryRecorder } from './history/history-recorder';
import {
  EngagementSampler,
  engagementWriter,
  readStoredEngagement,
} from './lifecycle/engagement-sampler';
import { ActivityLog, activityWriter, readStoredActivity } from './lifecycle/activity-log';
import { MemoryPressureMonitor } from './lifecycle/memory-pressure';
import { createPlacementActions } from './lifecycle/placement-actions';
import { readStoredRegret, RegretTracker, regretWriter } from './lifecycle/regret';
import { ProtectionSignals } from './lifecycle/protection-signals';
import { LifecycleScheduler } from './lifecycle/scheduler';
import type { ActionRecord } from './lifecycle/scheduler';
import { UndoManager } from './lifecycle/undo';
import { SYSTEM_TIMERS } from './platform/timers';
import { installPageMenu } from './input/page-menu';
import { createShortcutHandler } from './input/shortcuts';
import { createCommandHandlers } from './ipc/commands';
import { createMemoryCommands } from './memory/memory-commands';
import type { LifecycleCommands, SettingsCommands } from './ipc/commands';
import { createShellEvents } from './ipc/events';
import { installIpcRouter } from './ipc/install';
import { createContextMenus } from './menus/context-menu';
import { searchEngineName, searchTemplate, setSearchTemplate } from './navigation/search-engine';
import { installPermissionBroker } from './permissions/permission-broker';
import { AppNotices } from './notices/app-notices';
import { DataLifecycle } from './persistence/data-lifecycle';
import { closeDataOnQuit, startDataWorker } from './persistence/data-worker';
import {
  ClientHintsWriter,
  decisionWriters,
  EMPTY_STORED_STATE,
  readStoredState,
} from './persistence/stored-state';
import { readSessionAtStartup } from './session/session-startup';
import { SessionStore } from './session/session-store';
import { consoleLogger } from './platform/logger';
import { BlockedPopups } from './popups/blocked-popups';
import { createWindowOpenHandler } from './popups/popup-policy';
import type { WindowOpenHandler, WindowOpenSource } from './popups/popup-policy';
import { SiteRules } from './privacy/site-rules';
import { PromptManager } from './prompts/prompt-manager';
import { SHELL_ORIGIN, SHELL_URL } from './shell/assets';
import { parseDevServerUrl } from './shell/dev-server';
import { registerShellScheme } from './shell/protocol';
import { createShellSession } from './shell/shell-session';
import { SettingsService } from './settings/settings-service';
import { createFaviconService } from './tabs/favicons';
import { TabManager } from './tabs/tab-manager';
import { createTabRuntimes } from './tabs/tab-runtime';
import { createWorkspaceProjector } from './tabs/workspace-projector';
import { recordExternalLaunch } from './testing/external-launches';
import { recordPrintRequest } from './testing/print-requests';
import { recordRuntimeTransition } from './testing/runtime-transitions';
import { testClockAdjustment, testIsCaptured, testMemoryPressure } from './testing/test-clock';
import { exitOnUncaughtException } from './testing/fail-fast';
import { testFirstRun } from './testing/first-run';
import { recordingFileActions, testDownloadsFolder } from './testing/test-files';
import { LIFECYCLE_SCENARIO_ENV, runLifecycleScenario } from './testing/lifecycle-scenarios';
import { installTestHooks } from './testing/test-hooks';
import { ClientHints } from './web/client-hints';
import { installWebContentsGuard, setExternalNavigationHandler } from './web/guard';
import { installRequestHeaders } from './web/request-headers';
import {
  allowManagedDownloads,
  hardenSession,
  installSessionBaseline,
  setLoginHandler,
} from './web/session-baseline';
import { FullscreenController } from './windows/fullscreen';
import { LayoutManager } from './windows/layout-manager';
import { createMainWindow, savedWindowOf, windowBackground } from './windows/main-window';
import { PopupWindows } from './windows/popup-windows';

// ── Before `ready` (ADR-0002 §4–5, ADR-0007 §6). Moving any of these later silently weakens them.
// The profile location, the Windows identity and the sandbox for every renderer.
app.setPath(
  'userData',
  resolveUserDataDir({
    appData: app.getPath('appData'),
    isPackaged: app.isPackaged,
    override: process.env[USER_DATA_DIR_OVERRIDE_ENV],
  }),
);
app.setAppUserModelId(APP_USER_MODEL_ID);
app.enableSandbox();
// No Electron or app-name tokens in any session, worker or request header (spike S7).
app.userAgentFallback = cleanUserAgent(app.userAgentFallback);
// app://shell gets its privileges now; its handler goes on the shell session only.
registerShellScheme();
// Every web contents and every session gets its policy the moment it exists.
installWebContentsGuard(consoleLogger);
installSessionBaseline();
// Test builds only: an uncaught exception fails the run instead of opening a modal dialog.
if (import.meta.env.MODE === 'test') {
  exitOnUncaughtException();
  // Chromium also creates temporary files in the Downloads folder (found by E2E): a test build's
  // is in its own profile, so a test never touches the user's.
  app.setPath('downloads', testDownloadsFolder());
}

app.on('window-all-closed', () => {
  app.quit();
});

// One Veltriva per profile (M2.2a): a second launch hands over to the first and quits, so two
// processes never write the same session. Electron keys the lock on the userData path set above.
// Right after a hard kill, Windows can refuse the lock file for a moment ("Access is denied",
// measured by the session E2E): the launch tries again for about two seconds before it gives up,
// so restarting after a crash doesn't silently do nothing. A running Veltriva is told each time.
const INSTANCE_LOCK_RETRY_MS: readonly number[] = [250, 400, 600, 800];
let hasInstanceLock = app.requestSingleInstanceLock();

async function acquireInstanceLock(): Promise<boolean> {
  for (const delay of INSTANCE_LOCK_RETRY_MS) {
    if (hasInstanceLock) {
      return true;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, delay);
    });
    hasInstanceLock = app.requestSingleInstanceLock();
  }
  return hasInstanceLock;
}

// Development builds only: `import.meta.env.DEV` is a build-time constant, so production
// builds contain neither this branch nor the dev-server origin in the IPC allow-list.
const devServer =
  import.meta.env.DEV && !app.isPackaged && process.env.ELECTRON_RENDERER_URL !== undefined
    ? parseDevServerUrl(process.env.ELECTRON_RENDERER_URL)
    : undefined;

async function start(): Promise<void> {
  // No default application menu: its accelerators (Ctrl+W closes the window, Ctrl+R reloads the
  // shell) would act on the browser itself. The browser's shortcuts are below: reserved ones in
  // before-input-event, page-first ones in the window's hidden menu (assessment §3.9).
  Menu.setApplicationMenu(null);

  // Phase 2: the data worker opens (and if needed checks, recovers or migrates) the database in
  // the profile folder, off main's thread. Nothing reads it yet. The lifecycle keeps the run's
  // heartbeat, does upkeep while the user is away, and holds the quit until it has closed.
  const notices = new AppNotices();
  /** The settings document (M2.2b); its defaults until it has been read. */
  let settings: Settings = DEFAULT_SETTINGS;
  const { client: data, worker: dataWorker } = startDataWorker(
    app.getPath('userData'),
    consoleLogger,
  );
  const dataLifecycle = new DataLifecycle({
    client: data,
    logger: consoleLogger,
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    visitRetentionDays: () => settings.history.retentionDays,
    onRecovered: (recovery) => {
      notices.show(
        recovery.kind === 'restored'
          ? {
              kind: 'database-restored',
              backupAt: recovery.backupAt,
              corruptFile: recovery.corruptFile,
            }
          : { kind: 'database-reset', corruptFile: recovery.corruptFile },
      );
    },
  });
  closeDataOnQuit(dataLifecycle, consoleLogger);
  // The saved session decides where the window opens and which tabs it has, so it is read first
  // (bounded; without it the app starts as new, and writes nothing over what was saved).
  const startup = await readSessionAtStartup(data, consoleLogger);
  // Then the rest of what was kept: settings, decisions, opt-ins, download history. Without the
  // database (startup failed), everything starts empty, as before Phase 2.
  const stored =
    startup === null
      ? EMPTY_STORED_STATE
      : await readStoredState(data, consoleLogger, { downloads: MAX_LISTED_DOWNLOADS });
  settings = stored.settings;
  // M5.1: the settings document's one writer, and the user's site rules. A change applies at once
  // (applySettings, below, once everything it reaches exists; nothing calls it before then).
  const settingsService = new SettingsService({
    initial: settings,
    data,
    logger: consoleLogger,
    onChange: (next, previous) => {
      settings = next;
      applySettings(next, previous);
    },
  });
  const siteRules = new SiteRules({
    data,
    logger: consoleLogger,
    stored: stored.siteRules,
    // Automation looks again (a protected or excluded site changes what it may do), and so does
    // the "why" of each tab.
    onChange: () => {
      projector.markDirty();
      automation.scheduler?.trigger();
    },
  });
  // The engagement clock (assessment §4.6), from where it stopped. A new profile starts at zero.
  const storedEngagement =
    startup === null ? null : await readStoredEngagement(data, consoleLogger);
  // What automation did, and why (M3.3): the local activity log.
  const storedActivity = startup === null ? [] : await readStoredActivity(data, consoleLogger);
  // The regret metric's totals (M3.4, §4.13), for the local diagnostics page.
  const storedRegret = startup === null ? null : await readStoredRegret(data, consoleLogger);
  setSearchTemplate(settings.search.template);
  const writeDecision = decisionWriters(data, consoleLogger);

  // Created lazily by Electron; harden them explicitly too (hardenSession is idempotent).
  hardenSession(session.defaultSession);
  const browsing = session.fromPartition(BROWSING_PARTITION);
  hardenSession(browsing);

  const shellSession = createShellSession({
    rendererRoot: join(__dirname, '../renderer'),
    devServerOrigin: devServer?.origin,
  });
  const main = createMainWindow({
    shellSession,
    preload: join(__dirname, '../preload/shell.js'),
    saved: startup?.loaded.window ?? null,
  });
  app.on('second-instance', () => {
    if (main.window.isMinimized()) {
      main.window.restore();
    }
    main.window.focus();
  });
  const layout = new LayoutManager(main.window, main.shell);
  const events = createShellEvents(() => main.shell.webContents);

  // Favicons are fetched through the tabs' own session, then validated (threat T5).
  const favicons = createFaviconService(
    (url, init) => browsing.fetch(url, { signal: init.signal }),
    consoleLogger,
  );
  // The parts below refer to each other through closures that run only after start() returns:
  // TabManager notifies the projector and the fullscreen controller, which read it back.

  // M1.4: what pages may ask of the user (ADR-0002 §4). Trusted input per web contents decides
  // whether a popup or another app's link had a gesture; questions go to the toolbar.
  const activation = new ActivationTracker<number>();
  const prompts = new PromptManager({
    onChange: () => {
      projector.markDirty();
    },
    // The sign-in form is typed into: the shell takes the keyboard (the form focuses its field).
    onShown: (prompt) => {
      if (prompt.kind === 'http-auth' && !main.shell.webContents.isDestroyed()) {
        main.shell.webContents.focus();
      }
    },
  });
  const blockedPopups = new BlockedPopups({
    onChange: () => {
      projector.markDirty();
    },
  });
  const external = new ExternalProtocolGuard({
    prompts,
    appNameFor: (url) => app.getApplicationNameForProtocol(url),
    // Test builds never launch a real app.
    launch: import.meta.env.MODE === 'test' ? recordExternalLaunch : systemLauncher,
    logger: consoleLogger,
    alwaysAllowed: stored.alwaysAllowed,
    onAlwaysAllowed: writeDecision.alwaysAllow,
  });
  const tabIdOf = (contents: WebContents): string | undefined => {
    for (const [tabId, view] of runtimes.views) {
      if (view.webContents === contents) {
        return tabId;
      }
    }
    return undefined;
  };
  // Before any tab exists: the broker replaces the baseline's deny-all on the browsing session.
  // Decisions are kept (M2.2b); the dismissal embargo is for the run only.
  const decisions = new PermissionDecisions({
    stored: stored.decisions,
    onDecided: writeDecision.permission,
  });
  installPermissionBroker(browsing, {
    prompts,
    decisions,
    tabIdOf,
    logger: consoleLogger,
    // M3.4: a page granted the camera or microphone may be capturing (§4.10).
    onMediaGranted: (contents) => {
      signals.mediaGranted(contents);
    },
  });
  // HTTP authentication: a sign-in question in the strip, never stored (src/main/auth).
  setLoginHandler(createLoginHandler({ prompts, tabIdOf, logger: consoleLogger }));
  // Downloads (M1.4b): the browsing session, the only one a page can download from: tabs and
  // popup windows use it, the shell has its own session, and DevTools save files without a
  // download. The default session keeps the baseline's deny-all, so the surface stays small.
  // Test builds keep files in the test's own profile and never open them.
  const downloads = new DownloadManager({
    folder: () =>
      import.meta.env.MODE === 'test' ? testDownloadsFolder() : app.getPath('downloads'),
    files: import.meta.env.MODE === 'test' ? recordingFileActions : systemFileActions,
    onChange: () => {
      projector.markDirty();
    },
    logger: consoleLogger,
    // The history (M2.2b): every change is written through; ids are the rows' keys.
    store: createDownloadStore({ data, logger: consoleLogger }),
    newId: () => uuidv7(Date.now(), getRandomValues(new Uint8Array(10))),
  });
  allowManagedDownloads(browsing);
  downloads.attach(browsing);
  // Client hints: navigations carry the Sec-CH-UA headers Chrome sends, with Chromium's own
  // values, read from the shell once it has loaded. Google's sign-in still warned without a
  // Firefox user agent for accounts.google.com (manual check M1), so that host gets one.
  const clientHintsWriter = new ClientHintsWriter({
    data,
    logger: consoleLogger,
    document: () => optIns.toDocument(),
  });
  const optIns = new ClientHintOptIns({
    stored: stored.clientHints,
    onChange: () => {
      clientHintsWriter.changed();
    },
  });
  dataLifecycle.addFlush(() => clientHintsWriter.flush());
  const clientHints = new ClientHints(consoleLogger, optIns);
  installRequestHeaders(browsing, { clientHints });
  main.shell.webContents.once('did-finish-load', () => {
    void clientHints.readFrom(main.shell.webContents);
  });
  setExternalNavigationHandler((contents, url) => {
    const tabId = tabIdOf(contents);
    if (tabId === undefined) {
      // Popup windows don't open other apps (their prompt would have nowhere trusted to go).
      consoleLogger.warn('external.fromPopupRefused');
      return;
    }
    void external.request({
      tabId,
      url,
      pageUrl: contents.getURL(),
      gesture: activation.consume(contents.id, Date.now()),
    });
  });
  const windowOpenHandler = (source: WindowOpenSource): WindowOpenHandler =>
    createWindowOpenHandler(
      {
        activation,
        now: Date.now,
        tabs: () => tabs,
        blocked: blockedPopups,
        external,
        popupWindows: () => popupWindows,
        logger: consoleLogger,
      },
      source,
    );
  const popupWindows: PopupWindows = new PopupWindows({
    parent: () => main.window,
    shellSession,
    barUrl:
      devServer === undefined
        ? `${SHELL_ORIGIN}/popup-bar.html`
        : new URL('popup-bar.html', devServer.url).href,
    activation,
    windowOpenHandler,
    tabFor: (openerTabId) =>
      tabs.has(openerTabId) ? openerTabId : (tabs.selectedTabId() ?? undefined),
    logger: consoleLogger,
  });

  const runtimes = createTabRuntimes({
    host: layout,
    favicons,
    logger: consoleLogger,
    input: {
      beforeInput: (tabId, event, input) => {
        handleShortcut({ tabId }, event, input);
      },
      contextMenu: (tabId, params) => {
        contextMenus.forTab(tabId, params);
      },
    },
    activation,
    windowOpenHandler,
    // The protection monitor watches each tab's page from its first moment (M3.4).
    onContentsCreated: (_tabId, contents) => {
      signals.attach(contents);
    },
  });
  const projector = createWorkspaceProjector({
    tabs: () => tabs.tabs(),
    selectedTabId: () => tabs.selectedTabId(),
    fullscreen: () => fullscreen.state(),
    downloads: () => downloads.list(),
    notices,
    extrasFor: (tabId) => ({
      prompt: prompts.current(tabId),
      blockedPopups: blockedPopups.get(tabId),
      // M3.4's "why": what keeps the tab awake, and what preview would do to it.
      keptAwake: tabs.keptAwake(tabId),
      previewMove: automation.scheduler?.previewMoves().get(tabId) ?? null,
    }),
    // M3.3: Sleeping, the Archive, the sidebar's counts and Undo.
    sleeping: () => tabs.sleepingTabs(),
    archived: () => tabs.archivedTabs(),
    counts: () => {
      const startOfDay = new Date(lifecycleClock().wallNow).setHours(0, 0, 0, 0);
      return {
        sleeping: tabs.sleepingTabs().length,
        archived: tabs.archivedCount(),
        // The archived tabs in memory: the newest MAX_ARCHIVED_IN_MEMORY.
        archivedToday: tabs.archivedTabs().filter((tab) => tab.archivedAt >= startOfDay).length,
      };
    },
    undo: () => undo.current(),
    activityVersion: () => activity.version(),
    automation: () => ({
      paused: lifecycleSettings.paused,
      preview: previewActive(),
      previewUntilDay: PREVIEW_ACTIVE_DAYS,
      activeDay: lifecycleClock().activeDay,
      pressure: pressureLevel(),
    }),
    publish: (snapshot) => {
      events.emit('workspace.changed', snapshot);
    },
  });
  // The stored download history (M2.2b). Here, not where the manager is made: restoring calls
  // onChange, which marks the projector dirty, so the projector must exist first (an E2E restart
  // after a download found the start aborting). No tab exists yet, so nothing has downloaded.
  downloads.restore(stored.downloads);
  // Created once the session is restored, below; until then TabManager's changes are its own.
  let sessionStore: SessionStore | undefined;
  /** The workspace the session loaded (M4.2: the Archive list's rows); null without data. */
  let workspaceId: string | null = null;
  // The memory (§5.5): visits, titles and icons, as tabs commit them.
  const historyRecorder = new HistoryRecorder({
    data,
    logger: consoleLogger,
    // "Pause memory" (M5.1): nothing is recorded while it is on.
    recording: () => !settings.memory.paused,
  });
  dataLifecycle.addFlush(() => historyRecorder.flush());
  // Lifecycle automation (M3.2, assessment §4.6–§4.8): the engagement clock, memory pressure, the
  // protections it must respect, and the scheduler, created below once the session is restored.
  // Test builds can fast-forward the clock and set the pressure (src/main/testing/test-clock.ts).
  const engagement = new EngagementSampler({
    system: {
      idleState: (threshold) => powerMonitor.getSystemIdleState(threshold),
      on: (event, listener) => {
        // One literal per call: Electron's overloads take no union of event names.
        switch (event) {
          case 'suspend':
            powerMonitor.on('suspend', listener);
            break;
          case 'resume':
            powerMonitor.on('resume', listener);
            break;
          case 'lock-screen':
            powerMonitor.on('lock-screen', listener);
            break;
          case 'unlock-screen':
            powerMonitor.on('unlock-screen', listener);
            break;
        }
      },
    },
    monotonic: () => performance.now(),
    wall: Date.now,
    timezoneOffset: (wallMs) => new Date(wallMs).getTimezoneOffset(),
    timers: SYSTEM_TIMERS,
    stored: storedEngagement,
    persist: engagementWriter(data),
    onResume: () => {
      automation.scheduler?.trigger();
    },
    logger: consoleLogger,
  });
  dataLifecycle.addFlush(() => engagement.flush());
  const lifecycleClock = (): LifecycleClock => {
    const adjust =
      import.meta.env.MODE === 'test'
        ? testClockAdjustment()
        : { wallMs: 0, engagedMs: 0, activeDays: 0 };
    const now = engagement.now();
    return {
      wallNow: Date.now() + adjust.wallMs,
      // Whole milliseconds: engaged time adds up `performance.now()` steps, and what is stamped
      // with it is stored as an integer (a fraction made every session save while the user was
      // active fail, found by E2E in M3.4).
      engagedNow: Math.floor(now.engagedMs + adjust.engagedMs),
      activeDay: now.activeDay + adjust.activeDays,
    };
  };
  let lifecycleDocument: LifecycleSettingsDocument = settings.lifecycle;
  let lifecycleSettings: LifecycleSettings = resolveLifecycleSettings(lifecycleDocument);
  /** Preview mode (§4.13): the first active days, unless the user started automation early. */
  const previewActive = (): boolean =>
    isPreviewActive(lifecycleDocument.preview, lifecycleClock().activeDay);
  /** Saves a change to the lifecycle section (Pause, preview); applySettings applies it. */
  const saveLifecycle = (next: LifecycleSettingsDocument): void => {
    settingsService.setLifecycle(next);
  };
  /**
   * What a kept settings change does at once (M5.1): the omnibox's engine, automation's settings
   * (and an evaluation with them), the pressure thresholds (read at the next poll), Pause memory
   * (read at the next commit). The shell sees it in the next snapshot.
   */
  const applySettings = (next: Settings, previous: Settings): void => {
    if (next.search.template !== previous.search.template) {
      setSearchTemplate(next.search.template);
    }
    if (next.lifecycle !== previous.lifecycle) {
      lifecycleDocument = next.lifecycle;
      lifecycleSettings = resolveLifecycleSettings(next.lifecycle);
      automation.scheduler?.trigger();
    }
    projector.markDirty();
  };
  // The regret metric (M3.4, §4.13): local only, read by the diagnostics page.
  const regret = new RegretTracker({
    stored: storedRegret,
    persist: regretWriter(data),
    clock: lifecycleClock,
    timers: SYSTEM_TIMERS,
    logger: consoleLogger,
  });
  dataLifecycle.addFlush(() => regret.flush());
  const pressure = new MemoryPressureMonitor({
    read: () => process.getSystemMemoryInfo(),
    // M5.1: the settings' thresholds, in percent; kept in order by the settings document.
    thresholds: () => {
      const percent = pressurePercent(lifecycleDocument.overrides);
      return { moderate: percent.moderate / 100, critical: percent.critical / 100 };
    },
    timers: SYSTEM_TIMERS,
    monotonic: () => performance.now(),
    onChange: () => {
      projector.markDirty();
      automation.scheduler?.trigger();
    },
  });
  /** The pressure automation acts on: the monitor's, or what a test set. */
  const pressureLevel = (): MemoryPressure =>
    (import.meta.env.MODE === 'test' ? testMemoryPressure() : null) ?? pressure.level();
  app.on('render-process-gone', (_event, _contents, details) => {
    pressure.rendererGone(details.reason);
  });
  const signals: ProtectionSignals = new ProtectionSignals({
    contentsOf: (tabId) => runtimes.views.get(tabId)?.webContents,
    hasOpenPopup: (tabId) => popupWindows.hasOpenPopupFor(tabId),
    now: () => lifecycleClock().wallNow,
    ...(import.meta.env.MODE === 'test' ? { isCaptured: testIsCaptured } : {}),
    // M3.4: the rest of §4.10's table. The address is TabManager's: an unloaded tab has one too.
    urlOf: (tabId): string => (tabs.has(tabId) ? tabs.get(tabId).url : ''),
    notificationsAllowed: (url) =>
      decisions.get(originOf(url) ?? 'null', 'notifications') === 'allow',
    siteProtected: (url) => siteRules.protectsUrl(url),
    // M5.1: a tab on a site excluded from the memory is never archived.
    siteExcluded: (url) => siteRules.excludesUrl(url),
    onChange: () => {
      projector.markDirty();
    },
    timers: SYSTEM_TIMERS,
  });
  /** The scheduler, created once the session is restored; until then nothing is automated. */
  const automation: { scheduler?: LifecycleScheduler } = {};
  /** The selected tab as of the last change: a switch hides one, which may call for action. */
  let lastSelected: string | null = null;
  const tabs = new TabManager({
    createRuntime: runtimes.factory,
    newId: () => uuidv7(Date.now(), getRandomValues(new Uint8Array(10))),
    onChange: () => {
      showPromptsOf();
      projector.markDirty();
      sessionStore?.changed();
      const selected = tabs.selectedTabId();
      if (selected !== lastSelected) {
        lastSelected = selected;
        automation.scheduler?.trigger();
      }
    },
    activityClock: lifecycleClock,
    protections: (tabId) => signals.protectionsOf(tabId),
    onFullscreenChange: (tabId) => {
      fullscreen.update(tabId);
    },
    onPageGone: (tabId) => {
      prompts.dismissAll(tabId);
      blockedPopups.clear(tabId);
    },
    // M3.3: the page objected to the user closing its tab. The site is main's own label.
    confirmLeave: async (tabId): Promise<boolean> => {
      const site = originLabel(tabs.get(tabId).url);
      const answer = await prompts.ask(tabId, { kind: 'leave-page', site });
      return answer.decision === 'allow';
    },
    history: historyRecorder,
    // M5.1: closing a tab on a site excluded from the memory keeps no record of it.
    keepsNoRecord: (url) => siteRules.excludesUrl(url),
    // M3.4: a tab automation unloaded, shown again within the hour, is a regret (§4.13).
    onAutomaticUnloadShown: (tabId) => {
      regret.reloaded(tabId);
    },
    // Test builds record the runtime transitions for the specs (M3.1).
    ...(import.meta.env.MODE === 'test'
      ? { onTransition: recordRuntimeTransition, printPage: recordPrintRequest }
      : {}),
  });
  // M3.3: Undo for moves, the user's own moves, and the activity log of what automation did.
  const undo = new UndoManager({
    timers: SYSTEM_TIMERS,
    undoMoves: (moves) => tabs.undoMoves(moves),
    onChange: () => {
      projector.markDirty();
    },
  });
  const placement = createPlacementActions({
    tabs,
    undo,
    now: () => lifecycleClock().wallNow,
    // A tab brought back soon after automation moved it is a regret (§4.13).
    onRestored: (tabId) => {
      regret.restored(tabId, 'restore');
    },
  });
  const activity = new ActivityLog({
    stored: storedActivity,
    persist: activityWriter(data),
    timers: SYSTEM_TIMERS,
    logger: consoleLogger,
    // The open log view refreshes on the snapshot's activityVersion.
    onChange: () => {
      projector.markDirty();
    },
  });
  dataLifecycle.addFlush(() => activity.flush());
  /** A tab as the activity log names it: live, Sleeping or archived. Null if it is gone. */
  const describeTab = (
    tabId: string,
  ): { title: string; address: string; ephemeral: boolean } | null => {
    if (tabs.has(tabId)) {
      const tab = tabs.get(tabId);
      return {
        title: tab.title,
        address: tab.url === '' ? '' : displayUrl(tab.url).text,
        ephemeral: tab.ephemeral,
      };
    }
    const archived = tabs.archivedTabs().find((tab) => tab.id === tabId);
    return archived === undefined
      ? null
      : { title: archived.title, address: displayUrl(archived.url).text, ephemeral: false };
  };
  /** Logs what an automated action changed (§4.12): skips, blocks and limits change nothing. */
  const logAction = (record: ActionRecord): void => {
    const { outcome } = record.result;
    if (outcome !== 'discarded' && outcome !== 'frozen' && outcome !== 'moved') {
      return;
    }
    // The regret metric watches each move and unload for an engaged hour (§4.13).
    if (record.kind !== 'freeze') {
      regret.automated(record.tabId, record.kind, record.rule);
    }
    const tab = describeTab(record.tabId);
    if (tab === null) {
      return;
    }
    activity.add(
      {
        at: lifecycleClock().wallNow,
        action: record.kind,
        rule: record.rule,
        pressure:
          record.rule === 'pressure-discard' && record.pressure !== 'none' ? record.pressure : null,
        tabId: record.tabId,
        title: tab.title,
        address: tab.address,
        batchId: record.batchId,
      },
      { ephemeral: tab.ephemeral },
    );
  };
  const lifecycleCommands: LifecycleCommands = {
    undo: (batchId) => {
      const offer = undo.current();
      const undone = undo.undo(batchId);
      if (undone === null) {
        return 0;
      }
      // Undoing automation is part of its story; the user's own moves aren't logged.
      if (offer?.automated === true) {
        for (const move of undone) {
          regret.restored(move.tabId, 'undo');
          const tab = describeTab(move.tabId);
          if (tab !== null) {
            activity.add(
              {
                at: lifecycleClock().wallNow,
                action: 'undo',
                rule: null,
                pressure: null,
                tabId: move.tabId,
                title: tab.title,
                address: tab.address,
                batchId,
              },
              { ephemeral: tab.ephemeral },
            );
          }
        }
      }
      return undone.length;
    },
    dismissUndo: (batchId) => {
      undo.dismiss(batchId);
    },
    activity: () => activity.entries(),
    setPaused: (paused) => {
      saveLifecycle({ ...lifecycleDocument, paused });
    },
    endPreview: () => {
      saveLifecycle({ ...lifecycleDocument, preview: 'off' });
    },
    setSiteProtected: (tabId, on) => {
      const site = siteOf(tabs.get(tabId).url);
      return site !== null && siteRules.set(site, { protect: on }) ? site : null;
    },
    diagnostics: () => {
      const state = regret.state();
      const engaged = engagement.now();
      const memory = process.getSystemMemoryInfo();
      return {
        regret: { since: state.since, ...state.counts, events: [...state.events] },
        engagement: { activeDay: engaged.activeDay, engagedMs: engaged.engagedMs },
        settings: {
          preset: lifecycleDocument.preset,
          paused: lifecycleDocument.paused,
          preview: previewActive(),
          protectedSites: siteRules
            .list()
            .filter((rule) => rule.protect)
            .map((rule) => rule.site),
        },
        pressure: pressureLevel(),
        memory: {
          totalMb: Math.round(memory.total / 1024),
          availableMb: Math.round(memory.free / 1024),
        },
      };
    },
  };
  const focus = new FocusManager({ shell: main.shell, tabs: () => tabs, events });
  const fullscreen = new FullscreenController({
    layout,
    window: main.window,
    urlOf: (tabId) => tabs.get(tabId).url,
    focusPage: (tabId) => {
      if (tabs.has(tabId)) {
        tabs.focusPage(tabId);
      }
    },
    onChange: () => {
      showPromptsOf();
      projector.markDirty();
    },
  });
  /** The tab whose question is on screen: the selected one, unless a page fills the window. */
  const showPromptsOf = (): void => {
    prompts.setVisibleTab(fullscreen.state() === null ? tabs.selectedTabId() : null);
  };
  const contextMenus = createContextMenus({
    window: main.window,
    shell: main.shell,
    tabs: () => tabs,
    views: runtimes.views,
    searchTemplate,
    searchEngine: searchEngineName,
    placement: () => placement,
    siteOf,
    isSiteProtected: (site) => siteRules.isProtected(site),
    setSiteProtected: (tabId, on) => {
      lifecycleCommands.setSiteProtected(tabId, on);
    },
    // M5.1: excluding the tab's site from the memory, from its menu.
    isSiteExcluded: (site) => siteRules.isExcluded(site),
    setSiteExcluded: (tabId, on) => {
      const site = siteOf(tabs.get(tabId).url);
      if (site !== null) {
        siteRules.set(site, { excludeMemory: on });
      }
    },
  });
  /** What the settings page shows (M5.1). */
  const settingsView = (): SettingsView => ({
    settings: settingsService.current(),
    previewActive: previewActive(),
    siteRules: siteRules.list(),
    presets: PRESET_VALUES,
    limits: OVERRIDE_LIMITS,
    pressureDefaults: DEFAULT_PRESSURE_PERCENT,
    searchEngines: [...SEARCH_ENGINES],
  });
  const settingsCommands: SettingsCommands = {
    view: settingsView,
    update: (change) => {
      settingsService.update(change);
      return settingsView();
    },
    setSiteRule: (text, change) => {
      const site = siteFromInput(text);
      return site !== null && siteRules.set(site, change) ? settingsView() : null;
    },
    // Settings is one page: its open tab is selected, else a new tab shows it.
    open: () => {
      const open = tabs
        .tabs()
        .find((tab) => tab.page.kind === 'internal' && tab.page.name === 'settings');
      if (open !== undefined) {
        tabs.select(open.id);
        return;
      }
      tabs.showInternal(tabs.create(), 'settings');
    },
  };

  // Reserved shortcuts, before the shell or any page sees the key (assessment §3.9).
  const handleShortcut = createShortcutHandler({ tabs: () => tabs, focus, fullscreen });
  main.shell.webContents.on('before-input-event', (event, input) => {
    handleShortcut('shell', event, input);
  });
  main.shell.webContents.on('context-menu', (_event, params) => {
    contextMenus.forShell(params);
  });
  // Find and zoom: the page's own handlers come first.
  installPageMenu(main.window, {
    print: () => {
      const selected = tabs.selectedTabId();
      if (selected !== null) {
        tabs.print(selected);
      }
    },
    find: () => {
      const selected = tabs.selectedTabId();
      if (selected !== null && tabs.openFind(selected)) {
        focus.focusFindBar();
      }
    },
    findNext: (forward) => {
      const selected = tabs.selectedTabId();
      if (selected === null) {
        return;
      }
      if (tabs.get(selected).find === null) {
        if (tabs.openFind(selected)) {
          focus.focusFindBar();
        }
      } else {
        tabs.findNext(selected, forward);
      }
    },
    zoom: (direction) => {
      const selected = tabs.selectedTabId();
      if (selected !== null) {
        tabs.zoom(selected, direction);
      }
    },
  });
  // Development builds only: Ctrl+Shift+I opens the shell's own DevTools. Pages get theirs (F12).
  if (import.meta.env.DEV) {
    main.shell.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.control && input.shift && input.code === 'KeyI') {
        event.preventDefault();
        main.shell.webContents.openDevTools({ mode: 'detach' });
      }
    });
  }
  // Session restore (assessment §5.9): every tab comes back unloaded, and only the selected one
  // loads; in safe mode none does. Without a readable database: one new tab, as before Phase 2.
  if (startup === null) {
    tabs.create();
  } else {
    const { loaded, ready, safeMode } = startup;
    // M5.1: "Start with a new tab" (Settings). Safe mode leaves the session as it was.
    const startFresh = settings.startup === 'new-tab' && !safeMode;
    tabs.restoreSession({
      tabs: loaded.tabs,
      selectedTabId: loaded.selectedTabId,
      closed: loaded.closed,
      loadSelected: !safeMode && !startFresh,
      shelf: loaded.shelf,
      archived: loaded.archived,
      archivedCount: loaded.archivedCount,
    });
    if (startFresh) {
      // A new tab is selected; the tabs that were open go to the Archive, where the memory still
      // finds them, and nothing of theirs loads. Pinned tabs stay; a new-tab page has nothing to
      // keep, so it closes. Sleeping stays as it was.
      const fresh = tabs.create();
      for (const tab of tabs.tabs()) {
        if (tab.id === fresh || tab.pinned) {
          continue;
        }
        if (tab.url === '') {
          tabs.close(tab.id);
        } else {
          void tabs.archive(tab.id, { origin: 'user' });
        }
      }
    }
    // M5.1: first-run onboarding (§7.2) on a new profile: search engine, preset, preview mode.
    if (
      ready.previousExit === 'none' &&
      loaded.tabs.length === 0 &&
      (import.meta.env.MODE === 'test' ? testFirstRun() : true)
    ) {
      const selected = tabs.selectedTabId();
      if (selected !== null) {
        tabs.showInternal(selected, 'welcome');
      }
    }
    if (safeMode) {
      notices.show({ kind: 'safe-mode' });
    } else if (ready.previousExit === 'crash' && loaded.tabs.length > 0) {
      notices.show({ kind: 'session-recovered' });
    }
    const store = new SessionStore({
      source: tabs,
      data,
      workspaceId: loaded.workspaceId,
      logger: consoleLogger,
      loaded: loaded.rows,
    });
    sessionStore = store;
    workspaceId = loaded.workspaceId;
    // The restored state (and any repair restoreSession made) is written once at the start.
    store.changed();
    dataLifecycle.addFlush(() => store.flush());
    const saveWindow = (): void => {
      store.windowChanged(savedWindowOf(main.window));
    };
    main.window.on('resize', saveWindow);
    main.window.on('move', saveWindow);
    main.window.on('maximize', saveWindow);
    main.window.on('unmaximize', saveWindow);
  }

  // Automation starts after the restore, quietly for its first 2 minutes (§4.8).
  const lifecycle = new LifecycleScheduler({
    tabs,
    settings: () => lifecycleSettings,
    clock: lifecycleClock,
    pressure: pressureLevel,
    timers: SYSTEM_TIMERS,
    logger: consoleLogger,
    onAction: logAction,
    onBatch: (batch) => {
      undo.offer(batch, { automated: true });
    },
    // M3.4: preview mode for the first active days (§4.13).
    preview: previewActive,
    onPreviewChange: () => {
      projector.markDirty();
    },
  });
  automation.scheduler = lifecycle;
  engagement.start();
  pressure.start();
  lifecycle.start();

  installIpcRouter({
    handlers: createCommandHandlers({
      tabs,
      layout,
      projector,
      focus,
      fullscreen,
      contextMenus,
      prompts,
      blockedPopups,
      external,
      downloads,
      notices,
      searchTemplate,
      placement,
      lifecycle: lifecycleCommands,
      memory: createMemoryCommands({
        data,
        tabs,
        placement,
        workspaceId: () => workspaceId,
        flushSession: () => sessionStore?.flush() ?? Promise.resolve(),
      }),
      settings: settingsCommands,
    }),
    allowedOrigins: new Set(
      devServer === undefined ? [SHELL_ORIGIN] : [SHELL_ORIGIN, devServer.origin],
    ),
    logger: consoleLogger,
  });

  const onThemeUpdated = (): void => {
    const dark = nativeTheme.shouldUseDarkColors;
    main.window.setBackgroundColor(windowBackground(dark));
    events.emit('app.themeChanged', { dark });
  };
  nativeTheme.on('updated', onThemeUpdated);

  // A BaseWindow never destroys its views' web contents (ADR-0002 §2): close them explicitly.
  main.window.on('closed', () => {
    nativeTheme.off('updated', onThemeUpdated);
    projector.dispose();
    fullscreen.dispose();
    prompts.dispose();
    popupWindows.closeAll();
    // Before the tabs go: closing them all here is shutdown, not the user closing tabs.
    // Automation stops first (§4.11 item 5): nothing new starts while the tabs go.
    lifecycle.stop();
    undo.stop();
    activity.stop();
    regret.stop();
    pressure.stop();
    engagement.stop();
    sessionStore?.freeze();
    tabs.closeAll();
    main.shell.webContents.close();
  });

  if (import.meta.env.MODE === 'test') {
    installTestHooks({
      main,
      tabs,
      layout,
      views: runtimes.views,
      contextMenus,
      fullscreen,
      popupWindows,
      clientHints,
      data,
      dataWorker,
      dataLifecycle,
      notices,
      lifecycle: {
        scheduler: lifecycle,
        clock: lifecycleClock,
        setSettings: (changes) => {
          saveLifecycle({ ...lifecycleDocument, ...changes });
        },
        undo,
        activity,
      },
    });
    const scenario = process.env[LIFECYCLE_SCENARIO_ENV];
    if (scenario !== undefined && scenario !== '') {
      runLifecycleScenario(scenario, {
        main,
        tabs,
        fullscreen,
        views: runtimes.views,
        data,
        dataWorker,
        notices,
        startup,
        pauseAutomation: () => {
          lifecycleDocument = { ...lifecycleDocument, paused: true };
          lifecycleSettings = resolveLifecycleSettings(lifecycleDocument);
        },
        focus,
        layout,
      });
    }
  }

  // Last: the shell's first command can only arrive after every handler above is in place.
  main.shell.webContents.loadURL(devServer?.url ?? SHELL_URL).catch((error: unknown) => {
    console.error('The shell UI failed to load:', error);
  });
}

app
  .whenReady()
  .then(async () => {
    if (await acquireInstanceLock()) {
      await start();
    } else {
      app.quit();
    }
  })
  .catch((error: unknown) => {
    console.error('Veltriva failed to start:', error);
    app.exit(1);
  });
