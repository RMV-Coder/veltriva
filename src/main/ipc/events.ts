// Main → shell events (ADR-0005 §2). Payloads are validated against the contract before they
// leave main, and they go to the shell's web contents only, never to a tab.
import type { WebContents } from 'electron';

import { EVENT_CHANNEL } from '../../shared/contracts/ipc';
import type { EventName } from '../../shared/contracts/ipc';
import { eventSchemas } from '../../shared/contracts/schemas';
import type { EventPayload } from '../../shared/contracts/schemas';

export interface ShellEvents {
  emit<E extends EventName>(event: E, payload: EventPayload<E>): void;
}

export function createShellEvents(getShell: () => WebContents | undefined): ShellEvents {
  return {
    emit(event, payload) {
      // Throws on a contract violation: that's a bug in main, not something to send.
      const checked: unknown = eventSchemas[event].parse(payload);
      const shell = getShell();
      if (shell !== undefined && !shell.isDestroyed()) {
        shell.send(EVENT_CHANNEL, event, checked);
      }
    },
  };
}
