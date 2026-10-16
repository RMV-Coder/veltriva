import { join } from 'node:path';

import { app, nativeTheme, session } from 'electron';

import { APP_USER_MODEL_ID, BROWSING_PARTITION } from '../shared/constants/app-identity';
import { cleanUserAgent } from './app/user-agent';
import { resolveUserDataDir, USER_DATA_DIR_OVERRIDE_ENV } from './app/user-data-dir';
import { createCommandHandlers } from './ipc/commands';
import { createShellEvents } from './ipc/events';
import { installIpcRouter } from './ipc/install';
import { consoleLogger } from './platform/logger';
import { SHELL_ORIGIN, SHELL_URL } from './shell/assets';
import { parseDevServerUrl } from './shell/dev-server';
import { registerShellScheme } from './shell/protocol';
import { createShellSession } from './shell/shell-session';
import { installTestHooks } from './testing/test-hooks';
import { installWebContentsGuard } from './web/guard';
import { hardenSession, installSessionBaseline } from './web/session-baseline';
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
  // Created lazily by Electron; harden them explicitly too (hardenSession is idempotent).
  hardenSession(session.defaultSession);
  hardenSession(session.fromPartition(BROWSING_PARTITION));

  const shellSession = createShellSession({
    rendererRoot: join(__dirname, '../renderer'),
    devServerOrigin: devServer?.origin,
  });
  installIpcRouter({
    handlers: createCommandHandlers(),
    allowedOrigins: new Set(
      devServer === undefined ? [SHELL_ORIGIN] : [SHELL_ORIGIN, devServer.origin],
    ),
    logger: consoleLogger,
  });

  const main = createMainWindow({
    shellSession,
    shellUrl: devServer?.url ?? SHELL_URL,
    preload: join(__dirname, '../preload/shell.js'),
  });
  const events = createShellEvents(() => main.shell.webContents);

  const onThemeUpdated = (): void => {
    const dark = nativeTheme.shouldUseDarkColors;
    main.window.setBackgroundColor(windowBackground(dark));
    events.emit('app.themeChanged', { dark });
  };
  nativeTheme.on('updated', onThemeUpdated);
  main.window.on('closed', () => {
    nativeTheme.off('updated', onThemeUpdated);
  });

  if (import.meta.env.MODE === 'test') {
    installTestHooks(() => main);
  }
}

app
  .whenReady()
  .then(start)
  .catch((error: unknown) => {
    console.error('Veltriva failed to start:', error);
    app.exit(1);
  });
