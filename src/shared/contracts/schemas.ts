// The shell ⇄ main IPC contract, schema part (ADR-0005). Main validates every command input and
// output and every event payload against these. The preload and the renderer only import their
// types, so Zod never ships in the shell bundle (its JIT would also trip the shell's CSP).
import { z } from 'zod';

import type { CommandName, EventName } from './ipc';

interface CommandSchema {
  readonly input: z.ZodType;
  readonly output: z.ZodType;
}

/** Inputs are strict objects: unknown keys are rejected, never stripped. */
export const commandSchemas = {
  'app.getInfo': {
    input: z.strictObject({}),
    output: z.strictObject({
      productName: z.string(),
      version: z.string(),
      versions: z.strictObject({
        electron: z.string(),
        chrome: z.string(),
        node: z.string(),
      }),
    }),
  },
} as const satisfies Record<CommandName, CommandSchema>;

export const eventSchemas = {
  'app.themeChanged': z.strictObject({ dark: z.boolean() }),
} as const satisfies Record<EventName, z.ZodType>;

export type CommandInput<C extends CommandName> = z.input<(typeof commandSchemas)[C]['input']>;
/** True when a command's input schema has no keys at all, so callers may omit the input. */
export type CommandTakesNoInput<C extends CommandName> =
  (typeof commandSchemas)[C]['input'] extends z.ZodObject<infer Shape>
    ? keyof Shape extends never
      ? true
      : false
    : false;
export type CommandOutput<C extends CommandName> = z.output<(typeof commandSchemas)[C]['output']>;
export type EventPayload<E extends EventName> = z.output<(typeof eventSchemas)[E]>;
