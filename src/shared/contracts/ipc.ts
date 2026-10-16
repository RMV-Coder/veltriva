// The shell ⇄ main IPC contract, transport part (ADR-0005). Plain TypeScript with no Zod, so the
// sandboxed preload can import it without bundling a schema library. Schemas are in ./schemas.ts.
//
// To add a command or an event: add its name here and its schemas in ./schemas.ts (the type
// checker rejects a name without a schema, and the reverse), then implement it in
// src/main/ipc/commands.ts or emit it with the ShellEvents emitter.

/** The single channel the shell invokes commands on. */
export const INVOKE_CHANNEL = 'veltriva:invoke';

/** Main → shell events. Only ever sent to the shell's web contents. */
export const EVENT_CHANNEL = 'veltriva:event';

/** Commands are named `<namespace>.<method>`; the preload exposes them as `veltriva.<ns>.<method>()`. */
export const COMMAND_NAMES = [
  'app.getInfo',
  'workspace.getSnapshot',
  'tabs.create',
  'tabs.close',
  'tabs.select',
  'tabs.move',
  'tabs.setPinned',
  'tabs.duplicate',
  'navigation.submit',
  'navigation.back',
  'navigation.forward',
  'navigation.reload',
  'navigation.stop',
  'layout.setInsets',
] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

/** `workspace.changed` carries a versioned, coalesced snapshot: at most one per ~16 ms. */
export const EVENT_NAMES = ['app.themeChanged', 'workspace.changed'] as const;
export type EventName = (typeof EVENT_NAMES)[number];

/**
 * Why a command failed. Stack traces and error messages never cross the process boundary.
 * - `forbidden`: the sender isn't the shell's main frame on an allowed origin. Nothing ran.
 * - `unknown_command`: the name isn't in the contract.
 * - `invalid_input`: the input failed its strict schema.
 * - `not_found`: the input named something that doesn't exist (a closed tab, say).
 * - `internal`: the handler failed; details are in main's log.
 */
export const ERROR_CODES = [
  'forbidden',
  'unknown_command',
  'invalid_input',
  'not_found',
  'internal',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export type Result<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: ErrorCode };

export function isCommandName(value: unknown): value is CommandName {
  return typeof value === 'string' && (COMMAND_NAMES as readonly string[]).includes(value);
}

export function isEventName(value: unknown): value is EventName {
  return typeof value === 'string' && (EVENT_NAMES as readonly string[]).includes(value);
}
