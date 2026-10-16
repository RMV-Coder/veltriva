// The shell's own session (ADR-0002 §1). In memory (no `persist:` prefix): the shell keeps no
// web storage, and clearing browsing data can never touch it. It serves app://shell and, in
// development builds only, lets the shell load the Vite dev server under a dev CSP.
import { session } from 'electron';
import type { Session } from 'electron';

import { hardenSession } from '../web/session-baseline';
import { devShellCsp } from './csp';
import { handleShellProtocol } from './protocol';

const SHELL_PARTITION = 'veltriva-shell';

export function createShellSession(options: {
  readonly rendererRoot: string;
  /** Development builds only: the Vite dev-server origin, e.g. `http://localhost:5173`. */
  readonly devServerOrigin: string | undefined;
}): Session {
  const shellSession = session.fromPartition(SHELL_PARTITION);
  hardenSession(shellSession);
  handleShellProtocol(shellSession, options.rendererRoot);

  if (options.devServerOrigin !== undefined) {
    const csp = devShellCsp(options.devServerOrigin);
    shellSession.webRequest.onHeadersReceived(
      { urls: [`${options.devServerOrigin}/*`] },
      (details, callback) => {
        const headers = Object.fromEntries(
          Object.entries(details.responseHeaders ?? {}).filter(
            ([name]) => name.toLowerCase() !== 'content-security-policy',
          ),
        );
        callback({ responseHeaders: { ...headers, 'Content-Security-Policy': [csp] } });
      },
    );
  }
  return shellSession;
}
