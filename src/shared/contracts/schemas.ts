// The shell ⇄ main IPC contract, schema part (ADR-0005). Main validates every command input and
// output and every event payload against these. The preload and the renderer only import their
// types, so Zod never ships in the shell bundle (its JIT would also trip the shell's CSP).
import { z } from 'zod';

import { UUID_V7_PATTERN } from '../../core/id/uuidv7';
import { activityEntrySchema, MAX_ACTIVITY_ENTRIES } from './activity';
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
/** A download's id: main's own handle, never a path (src/main/downloads). */
/** A UUIDv7: the key of the download's row (M2.2b). */
const downloadId = z.string().regex(UUID_V7_PATTERN);
const downloadRef = z.strictObject({ downloadId });

/**
 * A batch of moves the user can undo (src/main/lifecycle/undo.ts): an evaluation's (`batch-`) or
 * one the user made (`manual-`).
 */
const batchId = z.string().regex(/^(?:batch|manual)-[0-9]{1,15}$/);

/** The archived tabs main keeps in memory and the shell lists ("Recently archived"). */
export const MAX_LISTED_ARCHIVED = 200;

/** What a tab's address shows: rebuilt by main from the parsed URL (src/core/url/display.ts). */
const addressSnapshot = z.strictObject({
  text: z.string().max(4096),
  security: z.enum(['secure', 'not-secure', 'local', 'internal', 'neutral']),
  hadCredentials: z.boolean(),
});

/** A toolbar question's id (src/main/prompts/prompt-manager.ts). */
const promptId = z.string().regex(/^prompt-[0-9]{1,15}$/);

/** A notice about Veltriva itself: main's own handle (src/main/notices/app-notices.ts). */
const noticeId = z.string().regex(/^notice-[0-9]{1,15}$/);
/**
 * A file's name, never a path: no separators, none of the characters Windows forbids in a name,
 * and no control characters. Main cleans the name before it gets here (`projectNotice`).
 */
const noticeFileName = z
  .string()
  .min(1)
  .max(260)
  .regex(/^[^\\/:*?"<>|\p{Cc}]+$/u);

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
  address: addressSnapshot,
  favicon: faviconDataUrl.nullable(),
  loading: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  /**
   * ADR-0003's runtime dimension (core/lifecycle/runtime-machine.ts). `frozen` is an experiment,
   * off by default; `discarding` lasts while a discard probes and closes the page (M3.1).
   */
  runtime: z.enum(['unloaded', 'creating', 'live', 'frozen', 'discarding', 'crashed']),
  /** Who unloaded the page, while it stays unloaded after a discard (§4.13); null otherwise. */
  unloadedBy: z.enum(['automation', 'pressure', 'user']).nullable(),
  /** The user protected the tab from automation (M3.3). */
  userProtected: z.boolean(),
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
      z.strictObject({
        id: promptId,
        kind: z.literal('http-auth'),
        site: z.string().max(300),
        /** The server's own text, cleaned by main. */
        realm: z.string().max(100),
        secure: z.boolean(),
      }),
      /** The page objected to the user closing its tab (M3.3): "Leave page?". */
      z.strictObject({
        id: promptId,
        kind: z.literal('leave-page'),
        site: z.string().max(300),
      }),
    ])
    .nullable(),
  /** Popups blocked for lack of a gesture: how many, and the latest one's address text. */
  blockedPopups: z
    .strictObject({ count: z.number().int().min(1), latest: z.string().max(4096) })
    .nullable(),
});

/** An archived tab: data only, never a page (I3). Restoring it brings it back next to the current tab. */
const archivedTabSnapshot = z.strictObject({
  id: tabId,
  title: z.string().max(1024),
  address: addressSnapshot,
  favicon: faviconDataUrl.nullable(),
  /** When it was archived: Unix milliseconds. */
  archivedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  /** Automation archived it, or the user did. */
  reason: z.enum(['auto', 'manual']),
});

const workspaceSnapshot = z.strictObject({
  /** Increases with every snapshot; the shell ignores anything older than what it has. */
  version: z.number().int().nonnegative(),
  selectedTabId: tabId.nullable(),
  /** Strip order: pinned tabs first. */
  tabs: z.array(tabSnapshot).max(10_000),
  /** Sleeping (§4.4), most recently moved there first. Never pinned, never selected. */
  sleeping: z.array(tabSnapshot).max(10_000),
  /** The newest archived tabs, newest first ("Recently archived"). */
  archived: z.array(archivedTabSnapshot).max(MAX_LISTED_ARCHIVED),
  /** The sidebar's counts (§4.13): "Sleeping 12 · Archived today 3". `archived` is all of them. */
  counts: z.strictObject({
    sleeping: z.number().int().nonnegative(),
    archived: z.number().int().nonnegative(),
    archivedToday: z.number().int().nonnegative(),
  }),
  /**
   * The moves the user can undo for now (§4.12): the latest automated batch, or the user's own
   * last move. Null when there is nothing to undo.
   */
  undo: z
    .strictObject({
      batchId,
      automated: z.boolean(),
      shelved: z.number().int().nonnegative(),
      archived: z.number().int().nonnegative(),
    })
    .nullable(),
  /**
   * A tab in HTML fullscreen (threat T6). While `notice` is true the shell draws only the notice,
   * naming `origin`, because main raises it above the page (ADR-0006 A′).
   */
  fullscreen: z
    .strictObject({ tabId, origin: z.string().max(2048), notice: z.boolean() })
    .nullable(),
  /** Newest first (src/main/downloads/download-manager.ts). No paths: the shell never has one. */
  downloads: z
    .array(
      z.strictObject({
        id: downloadId,
        fileName: z.string().max(200),
        state: z.enum(['progressing', 'paused', 'completed', 'cancelled', 'interrupted']),
        receivedBytes: z.number().int().nonnegative(),
        totalBytes: z.number().int().nonnegative(),
        dangerous: z.boolean(),
        confirmed: z.boolean(),
        canResume: z.boolean(),
        site: z.string().max(300),
      }),
    )
    .max(100),
  /**
   * What Veltriva has to tell the user about itself, oldest first, until each is dismissed
   * (src/main/notices/app-notices.ts). Not about any tab: the shell shows them under the toolbar
   * whichever tab is selected. `corruptFile` is a file name main kept a damaged file under, shown
   * as untrusted text.
   */
  notices: z
    .array(
      z.discriminatedUnion('kind', [
        z.strictObject({
          id: noticeId,
          kind: z.literal('database-restored'),
          /** When the backup it was restored from was taken: Unix milliseconds. */
          backupAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
          corruptFile: noticeFileName,
        }),
        z.strictObject({
          id: noticeId,
          kind: z.literal('database-reset'),
          corruptFile: noticeFileName,
        }),
        z.strictObject({ id: noticeId, kind: z.literal('session-recovered') }),
        z.strictObject({ id: noticeId, kind: z.literal('safe-mode') }),
      ]),
    )
    .max(3),
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
      /** A keyboard answer: the shell puts focus back itself. Otherwise the page gets it. */
      keepFocus: z.boolean().optional(),
    }),
    output: nothing,
  },
  /**
   * The user signed in to a server's HTTP authentication prompt. The credentials go to Chromium
   * once and are never stored. Cancel is `prompts.respond` with `block` or `dismiss`.
   */
  'prompts.signIn': {
    input: z.strictObject({
      tabId,
      promptId,
      username: z.string().max(1024),
      password: z.string().max(1024),
      keepFocus: z.boolean().optional(),
    }),
    output: nothing,
  },
  /** Opens the tab's latest blocked popup in a new tab after it, and clears the indicator. */
  'popups.openBlocked': { input: tabRef, output: nothing },
  /** Clears the tab's "Pop-up blocked" indicator. */
  'popups.dismissBlocked': { input: tabFocusRef, output: nothing },
  // Downloads, by main's id. Open and Show in folder act on main's own record of the path.
  'downloads.pause': { input: downloadRef, output: nothing },
  'downloads.resume': { input: downloadRef, output: nothing },
  'downloads.cancel': { input: downloadRef, output: nothing },
  'downloads.open': { input: downloadRef, output: nothing },
  'downloads.showInFolder': { input: downloadRef, output: nothing },
  /** A finished dangerous file: keep it (it gets its real name) or discard it (deleted). */
  'downloads.keep': { input: downloadRef, output: nothing },
  'downloads.discard': { input: downloadRef, output: nothing },
  /** Removes a finished download from the list; the file stays. */
  'downloads.clear': { input: downloadRef, output: nothing },
  /** Removes a notice from the strip. An id main no longer shows (already dismissed) is `not_found`. */
  'notices.dismiss': { input: z.strictObject({ noticeId }), output: nothing },
  /** Moves a strip tab to Sleeping (M3.3). A pinned tab stays. Offers Undo. */
  'tabs.shelve': { input: tabRef, output: z.strictObject({ moved: z.boolean() }) },
  /**
   * Archives a tab from the strip or Sleeping (M3.3): a loaded page is unloaded first, and a page
   * that objects (unsaved changes) keeps the tab where it is: `moved` is false. Offers Undo.
   */
  'tabs.archive': { input: tabRef, output: z.strictObject({ moved: z.boolean() }) },
  /**
   * Brings a tab back from Sleeping or the Archive to the strip, next to the current tab, and
   * selects it (§4.4). An archived tab may come back under a new id.
   */
  'tabs.restore': { input: tabFocusRef, output: tabRef },
  'tabs.setProtected': {
    input: z.strictObject({ tabId, protected: z.boolean() }),
    output: nothing,
  },
  /** Undoes a batch of moves, if it is still the one offered. */
  'lifecycle.undo': {
    input: z.strictObject({ batchId }),
    output: z.strictObject({ undone: z.number().int().nonnegative() }),
  },
  'lifecycle.dismissUndo': { input: z.strictObject({ batchId }), output: nothing },
  /** The activity log (§4.12): what automation did and why, newest first. */
  'lifecycle.activity': {
    input: nothing,
    output: z.strictObject({ entries: z.array(activityEntrySchema).max(MAX_ACTIVITY_ENTRIES) }),
  },
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
export type NoticeSnapshot = WorkspaceSnapshot['notices'][number];
