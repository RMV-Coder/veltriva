// The only places Veltriva opens a downloaded file or shows it in Explorer, on the user's click,
// with a path from the download manager's own records. Test builds record these instead
// (src/main/testing/test-files.ts).
import { shell } from 'electron';

import type { FileActions } from './download-manager';

export const systemFileActions: FileActions = {
  openPath: (path) => shell.openPath(path),
  showItemInFolder: (path) => {
    shell.showItemInFolder(path);
  },
};
