// The object the shell preload exposes as `window.veltriva`, derived from the IPC contract
// (ADR-0005). It never exposes `ipcRenderer`, IPC event objects or a generic send: every method
// is one allow-listed command, and `on` only accepts allow-listed event names.
import type { CommandName, EventName, Result } from './contracts/ipc';
import type {
  CommandInput,
  CommandOutput,
  CommandTakesNoInput,
  EventPayload,
} from './contracts/schemas';

export const SHELL_API_KEY = 'veltriva';

type Namespace<N extends string> = N extends `${infer NS}.${string}` ? NS : never;
type Method<N extends string, NS extends string> = N extends `${NS}.${infer M}` ? M : never;

/** Commands whose input schema has no keys can be called without an argument. */
type CommandMethod<C extends CommandName> =
  CommandTakesNoInput<C> extends true
    ? (input?: CommandInput<C>) => Promise<Result<CommandOutput<C>>>
    : (input: CommandInput<C>) => Promise<Result<CommandOutput<C>>>;

export type ShellCommands = {
  readonly [NS in Namespace<CommandName>]: {
    readonly [M in Method<CommandName, NS>]: CommandMethod<Extract<`${NS}.${M}`, CommandName>>;
  };
};

export type ShellEventListener<E extends EventName> = (payload: EventPayload<E>) => void;

export type ShellApi = ShellCommands & {
  /** Subscribes to a main-process event. Returns a function that unsubscribes. */
  readonly on: <E extends EventName>(event: E, listener: ShellEventListener<E>) => () => void;
};
