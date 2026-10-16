// IpcRouter (ADR-0005 §5): one entry point for every shell command. For each message it
//   1. verifies the sender (shell main frame, shell origin), and drops anything else;
//   2. checks the command name against the contract;
//   3. parses the input with the command's strict schema;
//   4. runs the handler, validates its output, and returns `{ ok, value }` or `{ ok: false, code }`.
// Stack traces and error messages never reach the renderer. No Electron imports: the Electron
// wiring is in ./install.ts, so this logic is unit-tested on plain Node.
import { isCommandName } from '../../shared/contracts/ipc';
import type { CommandName, ErrorCode, Result } from '../../shared/contracts/ipc';
import { commandSchemas } from '../../shared/contracts/schemas';
import type { CommandInput, CommandOutput } from '../../shared/contracts/schemas';
import type { Logger } from '../platform/logger';
import { CommandError } from './command-error';
import type { SenderVerdict } from './sender';

export type CommandHandlers = {
  readonly [C in CommandName]: (
    input: CommandInput<C>,
  ) => CommandOutput<C> | Promise<CommandOutput<C>>;
};

export interface IpcRouterOptions<Event> {
  readonly handlers: CommandHandlers;
  readonly verifySender: (event: Event) => SenderVerdict;
  readonly logger: Logger;
}

export type IpcRoute<Event> = (
  event: Event,
  command: unknown,
  input: unknown,
) => Promise<Result<unknown>>;

function failure(code: ErrorCode): Result<never> {
  return { ok: false, code };
}

export function createIpcRouter<Event>({
  handlers,
  verifySender,
  logger,
}: IpcRouterOptions<Event>): IpcRoute<Event> {
  return async (event, command, input) => {
    let verdict: SenderVerdict;
    try {
      verdict = verifySender(event);
    } catch {
      logger.warn('ipc.senderCheckFailed');
      return failure('forbidden');
    }
    if (!verdict.trusted) {
      // Nothing about the command runs for an untrusted sender, not even the name check.
      logger.warn('ipc.forbidden', { reason: verdict.reason });
      return failure('forbidden');
    }

    if (!isCommandName(command)) {
      logger.warn('ipc.unknownCommand');
      return failure('unknown_command');
    }

    const schema = commandSchemas[command];
    const parsedInput = schema.input.safeParse(input);
    if (!parsedInput.success) {
      return failure('invalid_input');
    }

    try {
      // The schema lookup and the handler lookup use the same key; TypeScript can't correlate them.
      const handler = handlers[command] as (input: unknown) => unknown;
      const parsedOutput = schema.output.safeParse(await handler(parsedInput.data));
      if (!parsedOutput.success) {
        logger.error('ipc.invalidOutput', { command });
        return failure('internal');
      }
      return { ok: true, value: parsedOutput.data };
    } catch (error) {
      if (error instanceof CommandError) {
        return failure(error.code);
      }
      logger.error('ipc.handlerFailed', {
        command,
        error: error instanceof Error ? error.name : typeof error,
      });
      return failure('internal');
    }
  };
}
