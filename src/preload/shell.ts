// Shell preload. It runs sandboxed with context isolation, so it can only use `electron`'s
// renderer modules. Web pages (tabs) never get a preload (ADR-0002).
import { contextBridge } from 'electron';

import { SHELL_API_KEY } from '../shared/shell-api';
import type { ShellApi } from '../shared/shell-api';

const api: ShellApi = Object.freeze({
  runtime: Object.freeze({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  }),
});

contextBridge.exposeInMainWorld(SHELL_API_KEY, api);
