// The shell ⇄ main IPC contract, schema part (ADR-0005). Main validates every command input and
// output and every event payload against these. The preload and the renderer only import their
// types, so Zod never ships in the shell bundle (its JIT would also trip the shell's CSP).
import { z } from 'zod';

import { UUID_V7_PATTERN } from '../../core/id/uuidv7';
import { LIFECYCLE_RULES } from '../../core/lifecycle/policy';
import { PROTECTION_REASONS } from '../../core/lifecycle/protections';
import { activityEntrySchema, MAX_ACTIVITY_ENTRIES } from './activity';
import { PROMPTED_PERMISSIONS } from '../../core/permissions/permission-policy';
import { INTERNAL_PAGES } from '../../core/url/internal-pages';
import type { CommandName, EventName } from './ipc';
import {
  DEFAULT_PRESSURE_PERCENT,
  NUMERIC_OVERRIDES,
  settingsChangeSchema,
  strictSettingsSchema,
} from './settings';

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

/** One preset's values (core/lifecycle/policy.ts), for the settings page to describe (M5.1). */
const presetValues = z.strictObject({
  discardAfterMs: z.number().int().nonnegative(),
  stripCap: z.number().int().nonnegative(),
  shelveAfterEngagedMs: z.number().int().nonnegative(),
  archiveAfterActiveDays: z.number().int().nonnegative(),
  interactionGuardMs: z.number().int().nonnegative(),
  discardPinned: z.boolean(),
});
const range = z.strictObject({ min: z.number().int(), max: z.number().int() });
/** At most this many site rules (main/privacy/site-rules.ts MAX_SITE_RULES). */
export const MAX_LISTED_SITE_RULES = 1000;

/**
 * What the settings page shows (M5.1): the document as main keeps it, and what the page needs to
 * describe and check it (the presets, each number's range, the named search engines). The page
 * never writes the document: it sends a change, and shows the view main answers with.
 */
export const settingsViewSchema = z.strictObject({
  settings: strictSettingsSchema,
  /** Preview mode is on now (§4.13): the first active days, unless the user started early. */
  previewActive: z.boolean(),
  siteRules: z
    .array(
      z.strictObject({
        site: z.string().min(1).max(253),
        protect: z.boolean(),
        excludeMemory: z.boolean(),
      }),
    )
    .max(MAX_LISTED_SITE_RULES),
  presets: z.strictObject({
    gentle: presetValues,
    balanced: presetValues,
    aggressive: presetValues,
  }),
  limits: z.record(z.enum(NUMERIC_OVERRIDES), range),
  pressureDefaults: z.strictObject({
    moderate: z.literal(DEFAULT_PRESSURE_PERCENT.moderate),
    critical: z.literal(DEFAULT_PRESSURE_PERCENT.critical),
  }),
  searchEngines: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(32),
        name: z.string().min(1).max(64),
        template: z.string().min(1).max(2048),
      }),
    )
    .max(20),
});
export type SettingsView = z.infer<typeof settingsViewSchema>;

/** Clearing data's time ranges (M5.2, §5.7): the last hour, day or week, or everything. */
export const CLEAR_RANGES = ['hour', 'day', 'week', 'all'] as const;
export type ClearRange = (typeof CLEAR_RANGES)[number];
/** What a clear removed from the memory: the settings page and the palette say it. */
const clearResult = z.strictObject({
  pages: z.number().int().nonnegative(),
  visits: z.number().int().nonnegative(),
  tabs: z.number().int().nonnegative(),
});
/** An origin as the stores key it: scheme://host[:port]. */
const permissionOrigin = z.string().min(1).max(2048);
/** At most this many stored answers are listed (the stores keep fewer). */
export const MAX_LISTED_PERMISSIONS = 10_000;
/** The user's stored answers to sites (M5.2), for the settings page. */
export const permissionsViewSchema = z.strictObject({
  decisions: z
    .array(
      z.strictObject({
        origin: permissionOrigin,
        permission: z.enum(PROMPTED_PERMISSIONS),
        decision: z.enum(['allow', 'block']),
      }),
    )
    .max(MAX_LISTED_PERMISSIONS),
  protocols: z
    .array(z.strictObject({ origin: permissionOrigin, scheme: z.string().min(1).max(64) }))
    .max(MAX_LISTED_PERMISSIONS),
  clientHints: z
    .array(
      z.strictObject({
        origin: permissionOrigin,
        hints: z.array(z.string().min(1).max(64)).max(32),
      }),
    )
    .max(MAX_LISTED_PERMISSIONS),
});
export type PermissionsView = z.infer<typeof permissionsViewSchema>;

/** How many of each automatic action (M5.3, the diagnostics page). */
const activityCounts = z.strictObject({
  discard: z.number().int().nonnegative(),
  freeze: z.number().int().nonnegative(),
  shelve: z.number().int().nonnegative(),
  archive: z.number().int().nonnegative(),
  undo: z.number().int().nonnegative(),
});

/** The palette's filters (M4.2, §7.3): Tab steps through them. */
export const MEMORY_SCOPES = ['all', 'open', 'sleeping', 'archived', 'today', 'week'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];
/** What a memory search may carry: the data worker reads at most 256 characters of it. */
export const MAX_MEMORY_QUERY = 1024;
/** Results per memory search: a palette page, or the address bar's few. */
export const MAX_MEMORY_RESULTS = 50;
/** Rows per Archive list window (M4.2). */
export const MAX_ARCHIVE_WINDOW = 200;
/** A site as the memory stores it: a host name or registrable domain, lower case. */
const memorySite = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9.\-[\]:]+$/);
const memoryPageId = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const overlayName = z.enum(['palette', 'suggestions']);
const memoryScore = z.number().min(-1e9).max(1e9);
/** One memory search result (M4.2): what the palette and the address bar show. */
const memoryResult = z.strictObject({
  pageId: memoryPageId,
  title: z.string().max(1024),
  /** The page's address, as the display rules show it (core/url/display.ts). */
  address: z.string().max(4096),
  site: z.string().max(253),
  lastVisitAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  visitCount: z.number().int().nonnegative(),
  /** The tab showing the page, unless it's closed: in the strip (Tabs), Sleeping or the Archive. */
  tab: z.strictObject({ tabId, placement: z.enum(['strip', 'shelf', 'archive']) }).nullable(),
  /** Where the words start words of the title: [start, end) in UTF-16 units, sorted, disjoint. */
  titleRanges: z
    .array(z.tuple([z.number().int().min(0).max(1024), z.number().int().min(0).max(1024)]))
    .max(32),
  score: memoryScore,
  /** Each weighted term of the score (core/search/ranking.ts), for the debug view. */
  breakdown: z.strictObject({
    text: memoryScore,
    frecency: memoryScore,
    titleExact: memoryScore,
    siteMatch: memoryScore,
    state: memoryScore,
  }),
});

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
/** A release's version, as the update check reads it from the feed (M6.3). */
const releaseVersion = z.string().regex(/^\d{1,6}\.\d{1,6}\.\d{1,6}$/);
/** Where the update check stands (M6.3, src/main/updates/update-checker.ts). */
const updateView = z.strictObject({
  enabled: z.boolean(),
  feedUrl: z.string().max(2048),
  currentVersion: z.string().max(64),
  lastCheckedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  lastStatus: z.enum(['up-to-date', 'available', 'failed']).nullable(),
  available: z
    .strictObject({ version: releaseVersion, url: z.url({ protocol: /^https$/ }).max(2048) })
    .nullable(),
  checking: z.boolean(),
});
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
  /** For a tab memory pressure unloaded, how low memory was (M3.4); null otherwise. */
  unloadPressure: z.enum(['moderate', 'critical']).nullable(),
  /** The user protected the tab from automation (M3.3). */
  userProtected: z.boolean(),
  /**
   * Why automation keeps the tab as it is, as observed now (M3.4, §4.10): "Kept awake: playing
   * audio". In the order the sidebar names them; empty when nothing keeps it.
   */
  keptAwake: z.array(z.enum(PROTECTION_REASONS)).max(PROTECTION_REASONS.length),
  /** What automation would do to the tab if preview were over (M3.4, §4.13); null for nothing. */
  previewMove: z.enum(['shelve', 'archive']).nullable(),
  /** For a Sleeping tab, who moved it there in this run; null otherwise or unknown (M3.4). */
  movedBy: z.enum(['automation', 'user']).nullable(),
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
export const archivedTabSnapshot = z.strictObject({
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
  /** The activity log's newest entry id (0 for none): the open log view refreshes when it moves. */
  activityVersion: z.number().int().nonnegative(),
  /**
   * What automation is doing (M3.4): paused by the user; previewing its moves for the first
   * active days (`previewUntilDay` is the last of them, `activeDay` today's); and the memory
   * pressure it sees.
   */
  automation: z.strictObject({
    paused: z.boolean(),
    preview: z.boolean(),
    previewUntilDay: z.number().int().nonnegative(),
    activeDay: z.number().int().nonnegative(),
    pressure: z.enum(['none', 'moderate', 'critical']),
  }),
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
        /** M6.3: the update check found a newer version (its page stays in main). */
        z.strictObject({
          id: noticeId,
          kind: z.literal('update-available'),
          version: releaseVersion,
        }),
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
        v8: z.string(),
      }),
    }),
  },
  /**
   * About (M6.3): Veltriva's license and THIRD_PARTY_NOTICES.txt, as shipped in the app's
   * resources. Plain text the page shows as text.
   */
  'app.licenses': {
    input: nothing,
    output: z.strictObject({ license: z.string().max(20_000), notices: z.string().max(2_000_000) }),
  },
  /** Selects the About tab, or opens one (`veltriva://about`). */
  'app.openAbout': { input: nothing, output: nothing },
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
  /** "Pause automation" (§4.12, M3.4): nothing is planned while paused. Saved in the settings. */
  'lifecycle.setPaused': { input: z.strictObject({ paused: z.boolean() }), output: nothing },
  /** Ends preview mode early (§4.13): automation carries its moves out from now on. */
  'lifecycle.endPreview': { input: nothing, output: nothing },
  /**
   * Protects the site of a tab's page, or stops protecting it (§4.10 "Protected site"): every tab
   * on the site is then left alone. `not_found` for a tab without a site (not an http(s) page).
   */
  'tabs.setSiteProtected': {
    input: z.strictObject({ tabId, protected: z.boolean() }),
    output: z.strictObject({ site: z.string().min(1).max(253) }),
  },
  /** The local diagnostics page (§4.13): the regret metric and what automation sees. */
  'lifecycle.diagnostics': {
    input: nothing,
    output: z.strictObject({
      regret: z.strictObject({
        since: z.number().int().nonnegative(),
        moves: z.number().int().nonnegative(),
        moveRegrets: z.number().int().nonnegative(),
        unloads: z.number().int().nonnegative(),
        unloadRegrets: z.number().int().nonnegative(),
        events: z
          .array(
            z.strictObject({
              at: z.number().int().nonnegative(),
              how: z.enum(['restore', 'undo', 'reload']),
              action: z.enum(['shelve', 'archive', 'discard']),
              rule: z.enum(LIFECYCLE_RULES),
              afterEngagedMs: z.number().int().nonnegative(),
            }),
          )
          .max(200),
      }),
      engagement: z.strictObject({
        activeDay: z.number().int().nonnegative(),
        engagedMs: z.number().nonnegative(),
      }),
      settings: z.strictObject({
        preset: z.string().max(32),
        paused: z.boolean(),
        preview: z.boolean(),
        protectedSites: z.array(z.string().max(253)).max(1000),
      }),
      pressure: z.enum(['none', 'moderate', 'critical']),
      memory: z.strictObject({
        totalMb: z.number().nonnegative(),
        availableMb: z.number().nonnegative(),
      }),
      // M5.3: what each tab costs, what automation did, pressure, the database, the log.
      /** Per tab in Tabs and Sleeping: its renderer's private memory (null when unloaded). */
      tabs: z
        .array(
          z.strictObject({
            tabId,
            title: z.string().max(1024),
            placement: z.enum(['strip', 'shelf']),
            runtime: z.enum(['unloaded', 'creating', 'live', 'frozen', 'discarding', 'crashed']),
            privateKb: z.number().int().nonnegative().nullable(),
            /** Other tabs sharing that renderer (Chromium groups a site's tabs). */
            sharedWith: z.number().int().nonnegative(),
          }),
        )
        .max(5000),
      /** Veltriva's own processes, in kB: the browser process, the GPU, and the rest. */
      processes: z.strictObject({
        browserKb: z.number().int().nonnegative(),
        gpuKb: z.number().int().nonnegative(),
        otherKb: z.number().int().nonnegative(),
      }),
      /** What automation did, from the activity log: the last 24 hours, and all it keeps. */
      automation: z.strictObject({
        lastDay: activityCounts,
        kept: activityCounts,
      }),
      /** Each change of the pressure level this run, newest first. */
      pressureHistory: z
        .array(
          z.strictObject({
            at: z.number().int().nonnegative(),
            level: z.enum(['none', 'moderate', 'critical']),
          }),
        )
        .max(50),
      /** Null without a database. */
      database: z
        .strictObject({
          sizeBytes: z.number().int().nonnegative(),
          walBytes: z.number().int().nonnegative(),
          lastBackupAt: z.number().int().nonnegative().nullable(),
          lastCheckAt: z.number().int().nonnegative().nullable(),
          lastCheckOk: z.boolean().nullable(),
        })
        .nullable(),
      /** Diagnostic logging (§6.6): whether addresses are logged, and where the log is. */
      logging: z.strictObject({ enabled: z.boolean(), file: z.string().min(1).max(4096) }),
    }),
  },
  /**
   * Saves a JSON document of what the diagnostics page shows (M5.3), through the save dialog. It
   * holds no page address unless `includeAddresses`, and never a title. `saved` is false when the
   * user cancelled.
   */
  'diagnostics.export': {
    input: z.strictObject({ includeAddresses: z.boolean() }),
    output: z.strictObject({ saved: z.boolean() }),
  },
  /** Shows the log file's folder in Explorer (M5.3). */
  'diagnostics.openLogFolder': { input: nothing, output: nothing },
  /** F6 from the sidebar (M6.2): the selected tab's page gets the keyboard, as F6 from it left. */
  'focus.page': { input: nothing, output: nothing },
  /**
   * Searches the memory (M4.2, assessment §5.4, §7.3): the palette and the address bar. The words
   * go to the data worker as typed; main reads a `site:<domain>` word out of them, which, like
   * `site`, keeps the results on that site. `scope` is the palette's filter:
   *   - `open`, `sleeping`, `archived`: only pages a tab there shows;
   *   - `today`, `week`: visited since local midnight, or in the last 7 days.
   * Results come ranked, each with the tab showing it (if any), title marks and its score terms.
   */
  'memory.search': {
    input: z.strictObject({
      query: z.string().max(MAX_MEMORY_QUERY),
      scope: z.enum(MEMORY_SCOPES),
      site: memorySite.optional(),
      limit: z.number().int().min(1).max(MAX_MEMORY_RESULTS),
    }),
    output: z.strictObject({
      mode: z.enum(['text', 'recent']),
      /** The site the results are kept to, from `site` or a `site:` word; null for none. */
      site: memorySite.nullable(),
      results: z.array(memoryResult).max(MAX_MEMORY_RESULTS),
    }),
  },
  /**
   * Opens a search result (M4.2). `switch`: its tab, brought back from Sleeping or the Archive if
   * need be, or a new tab when no tab shows it (any more). `newTab`: always a new tab, the page's
   * address. `current`: the selected tab goes there (the address bar's suggestion). Returns the
   * tab now showing it, selected, with the page's keyboard focus.
   */
  'memory.open': {
    input: z.strictObject({
      pageId: memoryPageId,
      tabId: tabId.optional(),
      target: z.enum(['switch', 'newTab', 'current']),
    }),
    output: tabRef,
  },
  /**
   * The shell has painted an overlay on a transparent page (ADR-0006 A′): main raises the shell
   * above the tab and gives it the keyboard. One handshake per overlay; the shell stays raised
   * while any overlay (or the fullscreen notice) wants it.
   */
  'overlay.show': { input: z.strictObject({ overlay: overlayName }), output: nothing },
  /** The overlay closed: main lowers the shell once nothing wants it, and may focus the page. */
  'overlay.hide': {
    input: z.strictObject({ overlay: overlayName, focusPage: z.boolean() }),
    output: nothing,
  },
  /**
   * A window of the Archive list (M4.2), newest first, from the database: any of the archived
   * tabs, not only the newest 200 the snapshot carries. `total` is how many there are now.
   */
  // M5.1: the settings page. Main validates every change and keeps the document; see
  // shared/contracts/settings.ts.
  'settings.get': { input: nothing, output: settingsViewSchema },
  /**
   * Applies a change. `invalid_input` when the change fails its strict schema or would make an
   * invalid document (critical pressure at or above moderate); nothing is changed then.
   */
  'settings.update': { input: settingsChangeSchema, output: settingsViewSchema },
  /**
   * Sets a site's rules: protect it from automation, exclude it from the memory. `site` is what
   * the user typed (a site, a host or an address); main reads the site from it. A field left
   * out keeps its value. `invalid_input` when it names no site, or the list is full.
   */
  'settings.setSiteRule': {
    input: z.strictObject({
      site: z.string().min(1).max(2048),
      protect: z.boolean().optional(),
      excludeMemory: z.boolean().optional(),
    }),
    output: settingsViewSchema,
  },
  /** Shows Settings: selects its tab if one is open, else opens one. */
  'settings.open': { input: nothing, output: nothing },
  /** M6.3: where the update check stands. Asks nobody. */
  'updates.status': { input: nothing, output: updateView },
  /** "Check now": asks the release feed, only if the user turned checks on. */
  'updates.check': { input: nothing, output: updateView },
  /** "Skip this version": its notice won't come back. */
  'updates.skip': { input: z.strictObject({ version: releaseVersion }), output: nothing },
  /** "View release": main opens the release page the check found, in a new tab. */
  'updates.openRelease': { input: nothing, output: nothing },
  // M5.2: clearing data and managing stored answers.
  /**
   * Clears what was recorded in a time range: the visits (`memory`), the tabs archived or closed
   * then (`tabs`); and Chromium's cookies and site data, and its cache, which Electron can only
   * clear for all time. `invalid_input` when nothing is chosen.
   */
  'privacy.clear': {
    input: z.strictObject({
      range: z.enum(CLEAR_RANGES),
      memory: z.boolean(),
      tabs: z.boolean(),
      siteData: z.boolean(),
      cache: z.boolean(),
    }),
    output: clearResult,
  },
  /**
   * Forgets a site: every page and visit of it, its archived and closed tabs; with `siteData` its
   * cookies, storage and cached files; with `permissions` its stored answers. `site` is what the
   * user typed; main reads the site from it (`invalid_input` when it names none).
   */
  'privacy.forgetSite': {
    input: z.strictObject({
      site: z.string().min(1).max(2048),
      siteData: z.boolean(),
      permissions: z.boolean(),
    }),
    output: clearResult.extend({ site: z.string().min(1).max(253) }),
  },
  /**
   * One entry of the memory (the palette's Shift+Delete): the page and its visits, and the
   * archived tab showing it when that is the entry. An open or Sleeping tab is never removed.
   */
  'memory.remove': {
    input: z.strictObject({ pageId: memoryPageId, tabId: tabId.optional() }),
    output: clearResult,
  },
  'permissions.list': { input: nothing, output: permissionsViewSchema },
  /**
   * Changes or revokes a stored answer: a permission decision (Allow, Block, or null to revoke),
   * an app's "always open", or the browser details a site asked for. `not_found` when there was
   * nothing to revoke.
   */
  'permissions.change': {
    input: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('decision'),
        origin: permissionOrigin,
        permission: z.enum(PROMPTED_PERMISSIONS),
        decision: z.enum(['allow', 'block']).nullable(),
      }),
      z.strictObject({
        kind: z.literal('protocol'),
        origin: permissionOrigin,
        scheme: z.string().min(1).max(64),
      }),
      z.strictObject({ kind: z.literal('clientHints'), origin: permissionOrigin }),
    ]),
    output: permissionsViewSchema,
  },
  'archive.list': {
    input: z.strictObject({
      offset: z.number().int().min(0).max(10_000_000),
      limit: z.number().int().min(1).max(MAX_ARCHIVE_WINDOW),
    }),
    output: z.strictObject({
      total: z.number().int().nonnegative(),
      tabs: z.array(archivedTabSnapshot).max(MAX_ARCHIVE_WINDOW),
    }),
  },
} as const satisfies Record<CommandName, CommandSchema>;

export const eventSchemas = {
  'app.themeChanged': z.strictObject({ dark: z.boolean() }),
  'workspace.changed': workspaceSnapshot,
  'ui.focusAddressBar': nothing,
  'ui.focusFind': nothing,
  'ui.openPalette': nothing,
  'ui.cycleFocus': nothing,
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
