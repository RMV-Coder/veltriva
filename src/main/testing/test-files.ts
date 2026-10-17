// Test builds only (behind `import.meta.env.MODE`): downloads go to a folder in the test's own
// profile, never the user's Downloads, and opening a file or showing it in Explorer is recorded
// instead of done. The test hooks expose both.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { app } from 'electron';

import type { FileActions } from '../downloads/download-manager';

const recorded: { readonly action: 'open' | 'show'; readonly path: string }[] = [];

export const recordingFileActions: FileActions = {
  openPath: (path) => {
    recorded.push({ action: 'open', path });
    return Promise.resolve('');
  },
  showItemInFolder: (path) => {
    recorded.push({ action: 'show', path });
  },
};

export function recordedFileActions(): {
  readonly action: 'open' | 'show';
  readonly path: string;
}[] {
  return [...recorded];
}

export function testDownloadsFolder(): string {
  const folder = join(app.getPath('userData'), 'test-downloads');
  mkdirSync(folder, { recursive: true });
  return folder;
}
