// The SQLite repositories: one factory per area, composed into the handlers the data server calls.
// Every statement is prepared once, here, when the worker starts; a call only binds and runs it.
import type { DatabaseConnection } from 'better-sqlite3/win32-x64';

import type { RepositoryHandlers } from '../handlers';
import { appRunHandlers } from './app-runs';
import { appStateHandlers } from './app-state';
import { downloadHandlers } from './downloads';
import { faviconHandlers } from './favicons';
import { historyHandlers } from './history';
import { permissionHandlers } from './permissions';
import { settingsHandlers } from './settings';
import { tabHandlers } from './tabs';
import { workspaceHandlers } from './workspaces';

/** The return type makes TypeScript prove that every non-`db.*` method has a handler. */
export function createRepositoryHandlers(db: DatabaseConnection): RepositoryHandlers {
  return {
    ...workspaceHandlers(db),
    ...tabHandlers(db),
    ...appStateHandlers(db),
    ...appRunHandlers(db),
    ...settingsHandlers(db),
    ...permissionHandlers(db),
    ...downloadHandlers(db),
    ...historyHandlers(db),
    ...faviconHandlers(db),
  };
}
