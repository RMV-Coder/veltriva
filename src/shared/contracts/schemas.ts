// The shell ⇄ main IPC contract, schema part (ADR-0005). Main validates every command input and
// output and every event payload against these. The preload and the renderer only import their
// types, so Zod never ships in the shell bundle (its JIT would also trip the shell's CSP).
import { z } from 'zod';

import { UUID_V7_PATTERN } from '../../core/id/uuidv7';
import { INTERNAL_PAGES } from '../../core/url/internal-pages';
import type { CommandName, EventName } from './ipc';

interface CommandSchema {
  readonly input: z.ZodType;
  readonly output: z.ZodType;
}

const nothing = z.strictObject({});
const tabId = z.string().regex(UUID_V7_PATTERN);
const tabRef = z.strictObject({ tabId });
/** Generous bounds: a CSS measurement of the shell's chrome, in DIPs. */
// Zod 4 numbers are finite by default.
const inset = z.number().min(0).max(10_000);

/** A favicon is always a validated raster image that main encoded itself (threat T5). */
const faviconDataUrl = z
  .string()
  .max(90_000)
  .regex(/^data:image\/(?:png|x-icon|gif|jpeg|webp|bmp);base64,[A-Za-z0-9+/]+={0,2}$/);

const tabSnapshot = z.strictObject({
  id: tabId,
  pinned: z.boolean(),
  /** Page-controlled. Shown in the sidebar, never in the address bar. */
  title: z.string().max(1024),
  /** What the address bar shows, rebuilt by main from the parsed URL (src/core/url/display.ts). */
  address: z.strictObject({
    text: z.string().max(4096),
    security: z.enum(['secure', 'not-secure', 'local', 'internal', 'neutral']),
    hadCredentials: z.boolean(),
  }),
  favicon: faviconDataUrl.nullable(),
  loading: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  /** ADR-0003's runtime dimension. Placement is always the strip until Phase 3. */
  runtime: z.enum(['unloaded', 'creating', 'live', 'crashed']),
  page: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('web') }),
    z.strictObject({
      kind: z.literal('internal'),
      name: z.enum(INTERNAL_PAGES),
      /** For error pages: Chromium's error code and name, or the crash reason. */
      error: z.strictObject({ code: z.number().int(), name: z.string().max(200) }).optional(),
    }),
  ]),
});

const workspaceSnapshot = z.strictObject({
  /** Increases with every snapshot; the shell ignores anything older than what it has. */
  version: z.number().int().nonnegative(),
  selectedTabId: tabId.nullable(),
  /** Strip order: pinned tabs first. */
  tabs: z.array(tabSnapshot).max(10_000),
});

/** Inputs are strict objects: unknown keys are rejected, never stripped. */
export const commandSchemas = {
  'app.getInfo': {
    input: nothing,
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
  'workspace.getSnapshot': { input: nothing, output: workspaceSnapshot },
  'tabs.create': { input: nothing, output: tabRef },
  'tabs.close': { input: tabRef, output: nothing },
  'tabs.select': { input: tabRef, output: nothing },
  'tabs.move': {
    input: z.strictObject({ tabId, toIndex: z.number().int().min(0).max(100_000) }),
    output: nothing,
  },
  'tabs.setPinned': { input: z.strictObject({ tabId, pinned: z.boolean() }), output: nothing },
  'tabs.duplicate': { input: tabRef, output: tabRef },
  'navigation.submit': {
    // What the user typed. Main classifies it (src/core/url/omnibox.ts); the shell never does.
    input: z.strictObject({ tabId, text: z.string().max(16_384) }),
    output: z.strictObject({ action: z.enum(['navigate', 'search', 'internal', 'none']) }),
  },
  'navigation.back': { input: tabRef, output: nothing },
  'navigation.forward': { input: tabRef, output: nothing },
  'navigation.reload': { input: tabRef, output: nothing },
  'navigation.stop': { input: tabRef, output: nothing },
  'layout.setInsets': {
    input: z.strictObject({ top: inset, right: inset, bottom: inset, left: inset }),
    output: nothing,
  },
} as const satisfies Record<CommandName, CommandSchema>;

export const eventSchemas = {
  'app.themeChanged': z.strictObject({ dark: z.boolean() }),
  'workspace.changed': workspaceSnapshot,
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

export type WorkspaceSnapshot = z.output<typeof workspaceSnapshot>;
export type TabSnapshot = z.output<typeof tabSnapshot>;
