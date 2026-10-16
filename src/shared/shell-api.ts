// The object the shell preload exposes as `window.veltriva`.
// M1.1 exposes static runtime information only. M1.2 replaces it with an API generated from
// the typed IPC contract in src/shared/contracts (ADR-0005). It must never expose
// `ipcRenderer`, IPC event objects or a generic send.

export const SHELL_API_KEY = 'veltriva';

export interface RuntimeVersions {
  readonly electron: string;
  readonly chrome: string;
}

export interface ShellApi {
  readonly runtime: RuntimeVersions;
}
