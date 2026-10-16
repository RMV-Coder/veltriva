// Wires the IpcRouter to Electron: one `ipcMain.handle` on the single invoke channel, and the
// facts the sender check needs, read from the event Electron gives us.
import { ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';

import { INVOKE_CHANNEL } from '../../shared/contracts/ipc';
import type { Logger } from '../platform/logger';
import { roleOf } from '../web/roles';
import { createIpcRouter } from './router';
import type { CommandHandlers } from './router';
import { checkShellSender } from './sender';
import type { SenderFacts } from './sender';

function senderFacts(event: IpcMainInvokeEvent): SenderFacts {
  // `senderFrame` is null once the frame has navigated away or been destroyed.
  const frame = event.senderFrame;
  return {
    role: roleOf(event.sender),
    hasFrame: frame !== null,
    isMainFrame: frame !== null && frame.parent === null,
    origin: frame?.origin,
  };
}

export function installIpcRouter(options: {
  readonly handlers: CommandHandlers;
  /** `app://shell`, plus the Vite dev-server origin in development builds only. */
  readonly allowedOrigins: ReadonlySet<string>;
  readonly logger: Logger;
}): void {
  const route = createIpcRouter<IpcMainInvokeEvent>({
    handlers: options.handlers,
    verifySender: (event) => checkShellSender(senderFacts(event), options.allowedOrigins),
    logger: options.logger,
  });
  ipcMain.handle(INVOKE_CHANNEL, (event, command: unknown, input: unknown) =>
    route(event, command, input),
  );
}
