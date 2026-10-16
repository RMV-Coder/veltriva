// The shell ⇄ main IPC contract, schema part (ADR-0005). Main validates every command input and
// output and every event payload against these. The preload and the renderer only import their
// types, so Zod never ships in the shell bundle (its JIT would also trip the shell's CSP).
import { z } from 'zod';

import { UUID_V7_PATTERN } from '../../core/id/uuidv7';
import { PROMPTED_PERMISSIONS } from '../../core/permissions/permission-policy';
import { INTERNAL_PAGES } from '../../core/url/internal-pages';
import type { CommandName, EventName } from './ipc';

interface CommandSchema {
  readonly input: z.ZodType;
  readonly output: z.ZodType;
}

const nothing = z.strictObject({});
const tabId = z.string().regex(UUID_V7_PATTERN);
const tabRef = z.strictObject({ tabId });
/**
 * `keepFocus`: the shell's keyboard user stays in the sidebar. Otherwise the newly selected tab's
 * page gets keyboard focus, as after a click.
 */
const tabFocusRef = z.strictObject({ tabId, keepFocus: z.boolean().optional() });
/** The find bar's text. Longer searches are not useful, and the field stops there. */
export const MAX_FIND_TEXT = 1024;
/** Generous bounds: a CSS measurement of the shell's chrome, in DIPs. */
// Zod 4 numbers are finite by default.
const inset = z.number().min(0).max(10_000);

/** A favicon is always a validated raster image that main encoded itself (threat T5). */
/** A toolbar question's id (src/main/prompts/prompt-manager.ts). */
const promptId = z.string().regex(/^prompt-[0-9]{1,15}$/);

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
  /** The page's zoom, from 25% to 500% (src/core/layout/zoom.ts). */
  zoomPercent: z.number().int().min(25).max(500),
  /** The find bar of this tab, or null while it is closed. */
  find: z
    .strictObject({
      text: z.string().max(MAX_FIND_TEXT),
      /** The highlighted match, from 1; 0 when there is none. */
      activeMatch: z.number().int().nonnegative(),
      matches: z.number().int().nonnegative(),
    })
    .nullable(),
  /**
   * The question the toolbar asks about this tab's page, if any (ADR-0002 §4). `site` is main's
   * `originLabel` of the page's URL, never page text; null for a typed address.
   */
  prompt: z
    .discriminatedUnion('kind', [
      z.strictObject({
        id: promptId,
        kind: z.literal('permission'),
        site: z.string().max(300),
        permissions: z.array(z.enum(PROMPTED_PERMISSIONS)).min(1).max(PROMPTED_PERMISSIONS.length),
      }),
      z.strictObject({
        id: promptId,
        kind: z.literal('external-protocol'),
        site: z.string().max(300).nullable(),
        scheme: z.string().regex(/^[a-z][a-z0-9+.-]{0,63}$/),
        /** The app Windows would open, or '' when it's unknown. */
        appName: z.string().max(64),
        canRemember: z.boolean(),
      }),
    ])
    .nullable(),
  /** Popups blocked for lack of a gesture: how many, and the latest one's address text. */
  blockedPopups: z
    .strictObject({ count: z.number().int().min(1), latest: z.string().max(4096) })
    .nullable(),
});

const workspaceSnapshot = z.strictObject({
  /** Increases with every snapshot; the shell ignores anything older than what it has. */
  version: z.number().int().nonnegative(),
  selectedTabId: tabId.nullable(),
  /** Strip order: pinned tabs first. */
  tabs: z.array(tabSnapshot).max(10_000),
  /**
   * A tab in HTML fullscreen (threat T6). While `notice` is true the shell draws only the notice,
   * naming `origin`, because main raises it above the page (ADR-0006 A′).
   */
  fullscreen: z
    .strictObject({ tabId, origin: z.string().max(2048), notice: z.boolean() })
    .nullable(),
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
  'tabs.close': { input: tabFocusRef, output: nothing },
  'tabs.select': { input: tabFocusRef, output: nothing },
  'tabs.move': {
    input: z.strictObject({ tabId, toIndex: z.number().int().min(0).max(100_000) }),
    output: nothing,
  },
  'tabs.setPinned': { input: z.strictObject({ tabId, pinned: z.boolean() }), output: nothing },
  'tabs.duplicate': { input: tabRef, output: tabRef },
  'navigation.submit': {
    // What the user typed. Main classifies it (src/core/url/omnibox.ts); the shell never does.
    input: z.strictObject({ tabId, text: z.string().max(16_384) }),
    output: z.strictObject({
      action: z.enum(['navigate', 'search', 'internal', 'external', 'none']),
    }),
  },
  'navigation.back': { input: tabRef, output: nothing },
  'navigation.forward': { input: tabRef, output: nothing },
  'navigation.reload': { input: tabRef, output: nothing },
  'navigation.stop': { input: tabRef, output: nothing },
  'layout.setInsets': {
    input: z.strictObject({ top: inset, right: inset, bottom: inset, left: inset }),
    output: nothing,
  },
  /** One preset zoom step, or back to 100% (the shell's zoom indicator). */
  'tabs.zoom': {
    input: z.strictObject({ tabId, direction: z.enum(['in', 'out', 'reset']) }),
    output: nothing,
  },
  /**
   * The context menu of a tab in the sidebar (right-click, the Menu key, Shift+F10), at a point in
   * the shell's view, which is the window's. Main builds and shows the native menu.
   */
  'tabs.showMenu': {
    input: z.strictObject({
      tabId,
      x: z.number().min(0).max(100_000),
      y: z.number().min(0).max(100_000),
    }),
    output: nothing,
  },
  /** The find bar's text changed: search again from the top (an empty text clears the search). */
  'find.update': {
    input: z.strictObject({ tabId, text: z.string().max(MAX_FIND_TEXT) }),
    output: nothing,
  },
  'find.next': { input: z.strictObject({ tabId, forward: z.boolean() }), output: nothing },
  /** Closes the find bar; keyboard focus goes back to the page. */
  'find.close': { input: tabRef, output: nothing },
  /** The shell draws the fullscreen notice and nothing else: main may raise it over the page. */
  'fullscreen.noticeShown': { input: nothing, output: nothing },
  /** The user clicked the fullscreen notice: hide it now. */
  'fullscreen.dismissNotice': { input: nothing, output: nothing },
  /**
   * The user answered the toolbar's question about a tab. Only the question shown can be
   * answered: an old id is ignored. `remember` is the external-protocol prompt's "always allow".
   */
  'prompts.respond': {
    input: z.strictObject({
      tabId,
      promptId,
      decision: z.enum(['allow', 'block', 'dismiss']),
      remember: z.boolean(),
    }),
    output: nothing,
  },
  /** Opens the tab's latest blocked popup in a new tab after it, and clears the indicator. */
  'popups.openBlocked': { input: tabRef, output: nothing },
  /** Clears the tab's "Pop-up blocked" indicator. */
  'popups.dismissBlocked': { input: tabRef, output: nothing },
} as const satisfies Record<CommandName, CommandSchema>;

export const eventSchemas = {
  'app.themeChanged': z.strictObject({ dark: z.boolean() }),
  'workspace.changed': workspaceSnapshot,
  'ui.focusAddressBar': nothing,
  'ui.focusFind': nothing,
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
