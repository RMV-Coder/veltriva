// Test builds only (ADR-0008 §4): an uncaught exception in main ends the app with exit code 70
// and its stack on stderr. Electron's default is a modal "A JavaScript error occurred in the main
// process" dialog with the app left running, which a harness only sees as a hang: Playwright's
// teardown times out and merely warns, and a lifecycle scenario never exits.
import { app } from 'electron';

/** EX_SOFTWARE in sysexits.h: an internal software error. */
export const UNCAUGHT_EXCEPTION_EXIT_CODE = 70;

export function exitOnUncaughtException(): void {
  let exiting = false;
  process.on('uncaughtException', (error) => {
    process.stderr.write(
      `[veltriva] Uncaught exception in main: ${error.stack ?? String(error)}\n`,
    );
    // Exiting closes the window, whose handlers could throw again: report those, exit once.
    if (!exiting) {
      exiting = true;
      app.exit(UNCAUGHT_EXCEPTION_EXIT_CODE);
    }
  });
}
