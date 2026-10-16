import type { ShellApi } from '../shared/shell-api';

declare global {
  interface Window {
    /** Exposed by src/preload/shell.ts. Frozen; the shell's only bridge to main. */
    readonly veltriva: ShellApi;
  }
}
