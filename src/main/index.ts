import { getRandomValues } from 'node:crypto';
import { join } from 'node:path';

import { app, Menu, nativeTheme, session } from 'electron';
import type { WebContents } from 'electron';

import { uuidv7 } from '../core/id/uuidv7';
import { ActivationTracker } from '../core/input/user-activation';
import { APP_USER_MODEL_ID, BROWSING_PARTITION } from '../shared/constants/app-identity';
import { cleanUserAgent } from './app/user-agent';
import { resolveUserDataDir, USER_DATA_DIR_OVERRIDE_ENV } from './app/user-data-dir';
import { createLoginHandler } from './auth/sign-in';
import { DownloadManager } from './downloads/download-manager';
import { systemFileActions } from './downloads/file-actions';
import { systemLauncher } from './external/launcher';
import { ExternalProtocolGuard } from './external/protocol-guard';
import { FocusManager } from './focus/focus-manager';
import { installPageMenu } from './input/page-menu';
import { createShortcutHandler } from './input/shortcuts';
import { createCommandHandlers } from './ipc/commands';
import { createShellEvents } from './ipc/events';
import { installIpcRouter } from './ipc/install';
import { createContextMenus } from './menus/context-menu';
import { searchEngineName, searchTemplate } from './navigation/search-engine';
import { installPermissionBroker } from './permissions/permission-broker';
import { consoleLogger } from './platform/logger';
import { BlockedPopups } from './popups/blocked-popups';
import { createWindowOpenHandler } from './popups/popup-policy';
import type { WindowOpenHandler, WindowOpenSource } from './popups/popup-policy';
import { PromptManager } from './prompts/prompt-manager';
import { SHELL_ORIGIN, SHELL_URL } from './shell/assets';
import { parseDevServerUrl } from './shell/dev-server';
import { registerShellScheme } from './shell/protocol';
import { createShellSession } from './shell/shell-session';
import { createFaviconService } from './tabs/favicons';
import { TabManager } from './tabs/tab-manager';
import { createTabRuntimes } from './tabs/tab-runtime';
import { createWorkspaceProjector } from './tabs/workspace-projector';
import { recordExternalLaunch } from './testing/external-launches';
import { exitOnUncaughtException } from './testing/fail-fast';
import { recordingFileActions, testDownloadsFolder } from './testing/test-files';
import { LIFECYCLE_SCENARIO_ENV, runLifecycleScenario } from './testing/lifecycle-scenarios';
import { installTestHooks } from './testing/test-hooks';
import { installWebContentsGuard, setExternalNavigationHandler } from './web/guard';
import {
  allowManagedDownloads,
  hardenSession,
  installSessionBaseline,
  setLoginHandler,
} from './web/session-baseline';
import { FullscreenController } from './windows/fullscreen';
import { LayoutManager } from './windows/layout-manager';
import { createMainWindow, windowBackground } from './windows/main-window';
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
}

app.on('window-all-closed', () => {
  app.quit();
});

// Development builds only: `import.meta.env.DEV` is a build-time constant, so production
// builds contain neither this branch nor the dev-server origin in the IPC allow-list.
const devServer =
  import.meta.env.DEV && !app.isPackaged && process.env.ELECTRON_RENDERER_URL !== undefined
    ? parseDevServerUrl(process.env.ELECTRON_RENDERER_URL)
    : undefined;

function start(): void {
  // No default application menu: its accelerators (Ctrl+W closes the window, Ctrl+R reloads the
  // shell) would act on the browser itself. The browser's shortcuts are below: reserved ones in
  // before-input-event, page-first ones in the window's hidden menu (assessment §3.9).
  Menu.setApplicationMenu(null);

  // Created lazily by Electron; harden them explicitly too (hardenSession is idempotent).
  hardenSession(session.defaultSession);
  const browsing = session.fromPartition(BROWSING_PARTITION);
  hardenSession(browsing);

  const shellSession = createShellSession({
    rendererRoot: join(__dirname, '../renderer'),
    devServerOrigin: devServer?.origin,
  });
  const main = createMainWindow({ shellSession, preload: join(__dirname, '../preload/shell.js') });
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
  installPermissionBroker(browsing, { prompts, tabIdOf, logger: consoleLogger });
  // HTTP authentication: a sign-in question in the strip, never stored (src/main/auth).
  setLoginHandler(createLoginHandler({ prompts, tabIdOf, logger: consoleLogger }));
  // Downloads (M1.4b): every session a page can download from. Test builds keep files in the
  // test's own profile and never open them.
  const downloads = new DownloadManager({
    folder: () =>
      import.meta.env.MODE === 'test' ? testDownloadsFolder() : app.getPath('downloads'),
    files: import.meta.env.MODE === 'test' ? recordingFileActions : systemFileActions,
    onChange: () => {
      projector.markDirty();
    },
    logger: consoleLogger,
  });
  for (const downloadable of [browsing, session.defaultSession]) {
    allowManagedDownloads(downloadable);
    downloads.attach(downloadable);
  }
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
  });
  const projector = createWorkspaceProjector({
    tabs: () => tabs.tabs(),
    selectedTabId: () => tabs.selectedTabId(),
    fullscreen: () => fullscreen.state(),
    downloads: () => downloads.list(),
    extrasFor: (tabId) => ({
      prompt: prompts.current(tabId),
      blockedPopups: blockedPopups.get(tabId),
    }),
    publish: (snapshot) => {
      events.emit('workspace.changed', snapshot);
    },
  });
  const tabs = new TabManager({
    createRuntime: runtimes.factory,
    newId: () => uuidv7(Date.now(), getRandomValues(new Uint8Array(10))),
    onChange: () => {
      showPromptsOf();
      projector.markDirty();
    },
    onFullscreenChange: (tabId) => {
      fullscreen.update(tabId);
    },
    onPageGone: (tabId) => {
      prompts.dismissAll(tabId);
      blockedPopups.clear(tabId);
    },
  });
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
  });

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
  tabs.create();

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
      searchTemplate,
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
    });
    const scenario = process.env[LIFECYCLE_SCENARIO_ENV];
    if (scenario !== undefined && scenario !== '') {
      runLifecycleScenario(scenario, { main, tabs, fullscreen, views: runtimes.views });
    }
  }

  // Last: the shell's first command can only arrive after every handler above is in place.
  main.shell.webContents.loadURL(devServer?.url ?? SHELL_URL).catch((error: unknown) => {
    console.error('The shell UI failed to load:', error);
  });
}

app
  .whenReady()
  .then(start)
  .catch((error: unknown) => {
    console.error('Veltriva failed to start:', error);
    app.exit(1);
  });
