import { app } from 'electron';

import { APP_USER_MODEL_ID } from '../shared/constants/app-identity';
import { resolveUserDataDir, USER_DATA_DIR_OVERRIDE_ENV } from './app/user-data-dir';
import { createMainWindow } from './windows/main-window';

// Before `ready`: the profile location, the Windows identity and the sandbox for every renderer
// (ADR-0002 §5, ADR-0007 §6). Moving any of these after `ready` silently stops them applying.
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

app.on('window-all-closed', () => {
  app.quit();
});

app
  .whenReady()
  .then(() => {
    createMainWindow();
  })
  .catch((error: unknown) => {
    console.error('Veltriva failed to start:', error);
    app.exit(1);
  });
