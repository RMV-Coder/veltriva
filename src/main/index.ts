import { getRandomValues } from 'node:crypto';
import { join } from 'node:path';

import { app, Menu, nativeTheme, session } from 'electron';

import { uuidv7 } from '../core/id/uuidv7';
import { APP_USER_MODEL_ID, BROWSING_PARTITION } from '../shared/constants/app-identity';
import { cleanUserAgent } from './app/user-agent';
import { resolveUserDataDir, USER_DATA_DIR_OVERRIDE_ENV } from './app/user-data-dir';
import { createCommandHandlers } from './ipc/commands';
import { createShellEvents } from './ipc/events';
import { installIpcRouter } from './ipc/install';
import { searchTemplate } from './navigation/search-engine';
import { consoleLogger } from './platform/logger';
import { SHELL_ORIGIN, SHELL_URL } from './shell/assets';
import { parseDevServerUrl } from './shell/dev-server';
import { registerShellScheme } from './shell/protocol';
import { createShellSession } from './shell/shell-session';
import { createFaviconService } from './tabs/favicons';
import { TabManager } from './tabs/tab-manager';
import { createTabRuntimes } from './tabs/tab-runtime';
import { createWorkspaceProjector } from './tabs/workspace-projector';
import { LIFECYCLE_SCENARIO_ENV, runLifecycleScenario } from './testing/lifecycle-scenarios';
import { installTestHooks } from './testing/test-hooks';
import { installWebContentsGuard } from './web/guard';
import { grantTabPermissions, hardenSession, installSessionBaseline } from './web/session-baseline';
import { LayoutManager } from './windows/layout-manager';
import { createMainWindow, windowBackground } from './windows/main-window';

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
  // shell) would act on the browser itself. Browser shortcuts arrive with M1.3b.
  Menu.setApplicationMenu(null);

  // Created lazily by Electron; harden them explicitly too (hardenSession is idempotent).
  hardenSession(session.defaultSession);
  const browsing = session.fromPartition(BROWSING_PARTITION);
  grantTabPermissions(browsing);

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
  const runtimes = createTabRuntimes({ host: layout, favicons, logger: consoleLogger });
  // The projector reads TabManager lazily and TabManager only notifies it, so each can refer to
  // the other.
  const projector = createWorkspaceProjector({
    tabs: () => tabs.tabs(),
    selectedTabId: () => tabs.selectedTabId(),
    publish: (snapshot) => {
      events.emit('workspace.changed', snapshot);
    },
  });
  const tabs = new TabManager({
    createRuntime: runtimes.factory,
    newId: () => uuidv7(Date.now(), getRandomValues(new Uint8Array(10))),
    onChange: () => {
      projector.markDirty();
    },
  });
  tabs.create();

  installIpcRouter({
    handlers: createCommandHandlers({ tabs, layout, projector, searchTemplate }),
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
    tabs.closeAll();
    main.shell.webContents.close();
  });

  if (import.meta.env.MODE === 'test') {
    installTestHooks({ main, tabs, layout, views: runtimes.views });
    const scenario = process.env[LIFECYCLE_SCENARIO_ENV];
    if (scenario !== undefined && scenario !== '') {
      runLifecycleScenario(scenario, { main, tabs, views: runtimes.views });
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
