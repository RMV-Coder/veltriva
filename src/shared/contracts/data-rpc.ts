// The main ⇄ data-worker RPC contract (ADR-0004, ADR-0005 §3). The data worker
// (src/data/worker.ts) owns the only SQLite connection; main reaches it through
// src/main/persistence/data-client.ts. Every request is parsed with its input schema in the worker,
// and every response with its output schema in main, so neither side trusts the other's shapes.
//
// Rules this contract encodes:
//   - every list is bounded (`limit`, batch caps): a SQLite statement can't be interrupted (S5);
//   - no method takes SQL, a table name or a column name;
//   - errors carry a code and an optional detail that never contains row data (a SQLite error
//     code such as SQLITE_CONSTRAINT_CHECK, or a schema version).
import { z } from 'zod';

import { UUID_V7_PATTERN } from '../../core/id/uuidv7';
import { MAX_FAVICON_BYTES, RASTER_TYPES } from '../../core/net/favicon-format';
import { VISIT_TRANSITIONS } from '../../core/search/frecency';

// ── Field schemas ───────────────────────────────────────────────────────────────────────────

/** Unix milliseconds (assessment §5.1). Zod 4 numbers are finite by default. */
const timestamp = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const uuid = z.string().regex(UUID_V7_PATTERN);
const rowId = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Chromium's own URL limit is 2 MiB; Veltriva stores at most this much of one. */
export const MAX_STORED_URL = 65_536;
/** The shell's sanitized titles are at most 1,024 characters (ADR-0005 item 8). */
export const MAX_STORED_TITLE = 1024;
const url = z.string().min(1).max(MAX_STORED_URL);
const title = z.string().max(MAX_STORED_TITLE);

/** A small JSON document (app_state, settings): at most this many characters once serialized. */
export const MAX_DOCUMENT_CHARS = 1_048_576;
const fitsDocument = (value: unknown): boolean =>
  JSON.stringify(value).length <= MAX_DOCUMENT_CHARS;
const jsonDocument = z.json().refine(fitsDocument, 'document too large');

export const PLACEMENTS = ['strip', 'shelf', 'archive', 'closed'] as const;
export type Placement = (typeof PLACEMENTS)[number];

/** A tab's back/forward stack (assessment §5.3 `restore_state`): URLs and titles only, ≤ 50. */
export const MAX_RESTORE_ENTRIES = 50;
export const restoreStateSchema = z
  .strictObject({
    v: z.literal(1),
    index: z.number().int().min(0),
    entries: z.array(z.strictObject({ url, title })).min(1).max(MAX_RESTORE_ENTRIES),
  })
  .refine((state) => state.index < state.entries.length, 'index outside entries');
export type RestoreState = z.infer<typeof restoreStateSchema>;

/** One `tabs` row. Column invariants (archived ⇒ archived_at, …) are CHECKs in 0001_init.sql. */
export const tabRowSchema = z.strictObject({
  id: uuid,
  workspaceId: uuid,
  placement: z.enum(PLACEMENTS),
  position: z.number().int().min(0).max(1_000_000),
  pinned: z.boolean(),
  userProtected: z.boolean(),
  pageId: rowId.nullable(),
  url,
  title,
  faviconId: rowId.nullable(),
  restoreState: restoreStateSchema.nullable(),
  openerTabId: uuid.nullable(),
  createdAt: timestamp,
  lastUsedAt: timestamp,
  lastUsedEngaged: timestamp,
  lastUsedActiveDay: z.number().int().min(0).max(1_000_000_000),
  placementChangedAt: timestamp,
  archivedAt: timestamp.nullable(),
  archiveReason: z.enum(['auto', 'manual']).nullable(),
  closedAt: timestamp.nullable(),
});
export type TabRow = z.infer<typeof tabRowSchema>;

export const appRunRowSchema = z.strictObject({
  id: rowId,
  startedAt: timestamp,
  lastHeartbeatAt: timestamp,
  endedAt: timestamp.nullable(),
  exitKind: z.enum(['clean', 'crash']).nullable(),
  appVersion: z.string().min(1).max(64),
});
export type AppRunRow = z.infer<typeof appRunRowSchema>;

/** `scheme://host[:port]`, as `URL.origin` gives it. */
const origin = z
  .string()
  .max(2048)
  .regex(/^[a-z][a-z0-9+.-]*:\/\/[^/?#\s]+$/);
/**
 * A prompted permission (`camera`, `clipboard-read`, …) or, amendment (b), an external
 * protocol's "always allow" as `protocol:<scheme>`.
 */
const permissionName = z
  .string()
  .max(80)
  .regex(/^(?:[a-z][a-z-]{0,62}|protocol:[a-z][a-z0-9+.-]{0,62})$/);
export const permissionRowSchema = z.strictObject({
  origin,
  permission: permissionName,
  decision: z.enum(['allow', 'block']),
  updatedAt: timestamp,
});
export type PermissionRow = z.infer<typeof permissionRowSchema>;

export const DOWNLOAD_STATES = [
  'progressing',
  'paused',
  'completed',
  'cancelled',
  'interrupted',
] as const;
/** One `downloads` row, amendment (c). */
export const downloadRowSchema = z.strictObject({
  id: uuid,
  fileName: z.string().min(1).max(1024),
  path: z.string().min(1).max(32_767),
  url,
  site: z.string().max(2048),
  state: z.enum(DOWNLOAD_STATES),
  dangerous: z.boolean(),
  confirmed: z.boolean(),
  receivedBytes: count,
  totalBytes: count,
  startedAt: timestamp,
  endedAt: timestamp.nullable(),
});
export type DownloadRow = z.infer<typeof downloadRowSchema>;

/** The data worker's own app_state document (backup and check times); no method may touch it. */
export const MAINTENANCE_STATE_KEY = 'maintenance';
/** A host name or registrable domain (DNS allows 253 characters). */
const hostName = z.string().min(1).max(253);
/**
 * A favicon as stored (migration 0002): the bytes the favicon service validated, as base64, never
 * decoded in main. At most MAX_FAVICON_BYTES, so at most this many base64 characters.
 */
export const MAX_FAVICON_BASE64 = Math.ceil(MAX_FAVICON_BYTES / 3) * 4;
const faviconBytes = z
  .string()
  .min(1)
  .max(MAX_FAVICON_BASE64)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/);
const faviconMime = z.enum(RASTER_TYPES);
/** Icons per `favicons.get`: at 64 KiB each, a reply stays under 10 MB. */
export const MAX_FAVICONS_PER_GET = 100;

/** One `pages` row: a distinct page in the memory (M2.2b, §5.3). */
export const pageRowSchema = z.strictObject({
  id: rowId,
  urlKey: url,
  url,
  host: hostName,
  site: hostName,
  title,
  faviconId: rowId.nullable(),
  firstVisitAt: timestamp,
  lastVisitAt: timestamp,
  visitCount: count,
  typedCount: count,
  frecency: z.number().min(0),
  frecencyAt: timestamp,
});
export type PageRow = z.infer<typeof pageRowSchema>;

/** An app_state key: `session`, `window`, `client_hints`, … */
const stateKey = z
  .string()
  .regex(/^[a-z][a-z0-9_.]{0,63}$/)
  .refine((key) => key !== MAINTENANCE_STATE_KEY, 'reserved key');
/** A file's name, never a path: what main may show the user about a kept file. */
const fileName = z
  .string()
  .min(1)
  .max(260)
  .regex(/^[^\\/:*?"<>|]+$/);

// ── Methods ─────────────────────────────────────────────────────────────────────────────────

/** Largest batch one write call may carry; one call is one transaction. */
export const MAX_BATCH = 1000;
const limit = (max: number) => z.number().int().min(1).max(max);
const nothing = z.strictObject({});
const changed = z.strictObject({ count });

export const DATA_METHODS = {
  /** What the worker opened: versions and the pragmas as read back. */
  'db.info': {
    input: nothing,
    output: z.strictObject({
      userVersion: z.number().int().min(0),
      latestVersion: z.number().int().min(1),
      sqliteVersion: z.string().max(32),
      journalMode: z.string().max(16),
      autoVacuum: z.number().int(),
      synchronous: z.number().int(),
      foreignKeys: z.number().int(),
      secureDelete: z.number().int(),
      busyTimeout: z.number().int(),
      tempStore: z.number().int(),
      cacheSize: z.number().int(),
      /** The worker's threadId: proof that SQLite runs off the main thread (0). */
      threadId: z.number().int(),
    }),
  },
  /** Closes the connection; the worker exits afterwards. */
  'db.close': { input: nothing, output: nothing },

  /** The default workspace's id, created with `candidateId` on first use. */
  'workspaces.ensureDefault': {
    input: z.strictObject({ candidateId: uuid, name: z.string().min(1).max(200), now: timestamp }),
    output: z.strictObject({ id: uuid, created: z.boolean() }),
  },

  /** A workspace's tabs in one placement, by position. */
  'tabs.list': {
    input: z.strictObject({
      workspaceId: uuid,
      placement: z.enum(PLACEMENTS),
      limit: limit(10_000),
    }),
    output: z.strictObject({ tabs: z.array(tabRowSchema).max(10_000) }),
  },
  /** Inserts or replaces whole rows, in one transaction. */
  'tabs.upsertMany': {
    input: z.strictObject({ tabs: z.array(tabRowSchema).min(1).max(MAX_BATCH) }),
    output: changed,
  },
  'tabs.deleteMany': {
    input: z.strictObject({ ids: z.array(uuid).min(1).max(MAX_BATCH) }),
    output: changed,
  },
  /**
   * One flush of the live session (M2.2a, §5.5): the changed tab rows, the rows that went, and
   * small app_state documents (`session`, `window`), all in one transaction, so a hard kill
   * leaves either this flush or the previous one, never half of it.
   */
  'session.save': {
    input: z.strictObject({
      tabs: z.array(tabRowSchema).max(MAX_BATCH),
      deleteIds: z.array(uuid).max(MAX_BATCH),
      documents: z
        .array(
          z.strictObject({
            key: stateKey,
            value: jsonDocument.refine((value) => value !== null, 'null document'),
          }),
        )
        .max(4),
    }),
    output: changed,
  },
  /** Recently closed (placement 'closed'), newest first (M2.2a). */
  'tabs.listClosed': {
    input: z.strictObject({ workspaceId: uuid, limit: limit(1000) }),
    output: z.strictObject({ tabs: z.array(tabRowSchema).max(1000) }),
  },
  /** Deletes closed tabs closed before `before`, at most `limit` of them (kept 7 days, §5.7). */
  'tabs.purgeClosed': {
    input: z.strictObject({ before: timestamp, limit: limit(MAX_BATCH) }),
    output: changed,
  },

  'appState.get': {
    input: z.strictObject({ key: stateKey }),
    output: z.strictObject({ value: jsonDocument.nullable() }),
  },
  /** `null` is refused: `appState.get` answers `null` for a key that isn't there. */
  'appState.set': {
    input: z.strictObject({
      key: stateKey,
      value: jsonDocument.refine((value) => value !== null, 'null document'),
    }),
    output: nothing,
  },
  'appState.delete': { input: z.strictObject({ key: stateKey }), output: changed },

  'appRuns.start': {
    input: z.strictObject({ startedAt: timestamp, appVersion: z.string().min(1).max(64) }),
    output: z.strictObject({ id: rowId }),
  },
  'appRuns.heartbeat': { input: z.strictObject({ id: rowId, at: timestamp }), output: changed },
  'appRuns.end': {
    input: z.strictObject({ id: rowId, at: timestamp, exitKind: z.enum(['clean', 'crash']) }),
    output: changed,
  },
  /** Newest first. */
  'appRuns.recent': {
    input: z.strictObject({ limit: limit(100) }),
    output: z.strictObject({ runs: z.array(appRunRowSchema).max(100) }),
  },

  /** The settings document, unparsed: its Zod schema arrives with M2.2b (assessment §5.3). */
  'settings.get': { input: nothing, output: z.strictObject({ value: jsonDocument.nullable() }) },
  'settings.set': {
    input: z.strictObject({
      value: z.record(z.string(), z.json()).refine(fitsDocument, 'document too large'),
    }),
    output: nothing,
  },

  'permissions.list': {
    input: z.strictObject({ limit: limit(10_000) }),
    output: z.strictObject({ decisions: z.array(permissionRowSchema).max(10_000) }),
  },
  'permissions.set': { input: permissionRowSchema, output: nothing },
  /** One decision, or every decision for the origin when `permission` is left out. */
  'permissions.delete': {
    input: z.strictObject({ origin, permission: permissionName.optional() }),
    output: changed,
  },

  /** Newest first. */
  'downloads.list': {
    input: z.strictObject({ limit: limit(1000) }),
    output: z.strictObject({ downloads: z.array(downloadRowSchema).max(1000) }),
  },
  'downloads.upsert': { input: downloadRowSchema, output: nothing },
  'downloads.delete': { input: z.strictObject({ id: uuid }), output: changed },
  'downloads.clear': { input: nothing, output: changed },

  /**
   * One visit (§5.5): the page is found by its key, or created, and its counts and frecency move;
   * the visit is added. Main has applied URL hygiene (core/url/hygiene.ts) already. A page on a
   * site excluded from the memory (site_rules) records nothing: `pageId` is null.
   */
  'history.recordVisit': {
    input: z.strictObject({
      page: z.strictObject({ urlKey: url, url, host: hostName, site: hostName, title }),
      transition: z.enum(VISIT_TRANSITIONS),
      visitedAt: timestamp,
      tabId: uuid.nullable(),
    }),
    output: z.strictObject({ pageId: rowId.nullable() }),
  },
  /** A page's title settled (debounced 2 s) or its icon arrived. */
  'history.updatePage': {
    input: z.strictObject({
      pageId: rowId,
      title: title.optional(),
      faviconId: rowId.optional(),
    }),
    output: changed,
  },
  /** The memory, most recently visited first. Search arrives in Phase 4. */
  'history.pages': {
    input: z.strictObject({ limit: limit(1000) }),
    output: z.strictObject({ pages: z.array(pageRowSchema).max(1000) }),
  },
  /** One page's visits, newest first. */
  'history.visits': {
    input: z.strictObject({ pageId: rowId, limit: limit(1000) }),
    output: z.strictObject({
      visits: z
        .array(
          z.strictObject({
            id: rowId,
            visitedAt: timestamp,
            transition: z.enum(VISIT_TRANSITIONS),
            tabId: uuid.nullable(),
          }),
        )
        .max(1000),
    }),
  },

  /**
   * Stores a favicon once, by the SHA-256 of its bytes (computed by the worker), and returns its
   * id. The worker sniffs the bytes again and refuses them unless they are a `mime` image.
   */
  'favicons.put': {
    input: z.strictObject({ bytes: faviconBytes, mime: faviconMime, at: timestamp }),
    output: z.strictObject({ id: rowId }),
  },
  'favicons.get': {
    input: z.strictObject({ ids: z.array(rowId).min(1).max(MAX_FAVICONS_PER_GET) }),
    output: z.strictObject({
      favicons: z
        .array(z.strictObject({ id: rowId, mime: faviconMime, bytes: faviconBytes }))
        .max(MAX_FAVICONS_PER_GET),
    }),
  },

  /**
   * Idle-time upkeep (assessment §5.6), which main calls only while the user is away: a full
   * integrity and FTS check if the last one is a week old, then a backup if the last one is a day
   * old and data changed since. The full check also runs before every backup, so a damaged
   * database never replaces a good backup. `now` is main's clock.
   */
  'maintenance.run': {
    input: z.strictObject({
      now: timestamp,
      /** Visits older than this go, and pages left with none (§5.7; the settings document's). */
      visitRetentionDays: z.number().int().min(1).max(36_500),
    }),
    output: z.strictObject({
      check: z.enum(['ok', 'failed', 'not_due']),
      backup: z.enum(['done', 'unchanged', 'not_due', 'failed', 'skipped']),
      /** The backup's file name, when one was written. */
      backupFile: fileName.nullable(),
      /** What the retention pass removed this time (bounded per pass). */
      pruned: z.strictObject({ visits: count, pages: count, closedTabs: count }),
    }),
  },
  'maintenance.status': {
    input: nothing,
    output: z.strictObject({
      lastBackupAt: timestamp.nullable(),
      changedSinceBackup: z.boolean(),
      lastCheckAt: timestamp.nullable(),
      lastCheckOk: z.boolean().nullable(),
    }),
  },
} as const satisfies Record<string, { readonly input: z.ZodType; readonly output: z.ZodType }>;

export type DataMethod = keyof typeof DATA_METHODS;
export type DataInput<M extends DataMethod> = z.input<(typeof DATA_METHODS)[M]['input']>;
export type DataOutput<M extends DataMethod> = z.output<(typeof DATA_METHODS)[M]['output']>;

export function isDataMethod(name: unknown): name is DataMethod {
  return typeof name === 'string' && Object.hasOwn(DATA_METHODS, name);
}

// ── Messages ────────────────────────────────────────────────────────────────────────────────

export const DATA_ERROR_CODES = [
  /** The request didn't match its input schema (or a CHECK/foreign key refused the row). */
  'invalid_input',
  /** A response didn't match its output schema: a bug, never shown to the user. */
  'invalid_output',
  'unknown_method',
  /** No response within the call's timeout. The statement may still be running (S5). */
  'timeout',
  /** Too many calls in flight. */
  'busy',
  /** The client or the connection was closed. */
  'closed',
  /** The worker thread exited or crashed. */
  'worker_gone',
  /** The database was written by a newer Veltriva (downgrade protection, §5.6). */
  'db_newer',
  /** The file is a SQLite database, but not Veltriva's. */
  'db_foreign',
  /** The file couldn't be opened, or a pragma didn't take. */
  'open_failed',
  'migration_failed',
  /** SQLite refused a write: a constraint, a full disk, a busy lock. */
  'sqlite',
  'internal',
] as const;
export type DataErrorCode = (typeof DATA_ERROR_CODES)[number];

const errorSchema = z.strictObject({
  code: z.enum(DATA_ERROR_CODES),
  /** A SQLite error code or a version, never row data. */
  detail: z.string().max(200).optional(),
});
export type DataErrorInfo = z.infer<typeof errorSchema>;

/** main → worker. */
export const dataRequestSchema = z.strictObject({
  kind: z.literal('request'),
  id: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  method: z.string().max(64),
  input: z.unknown(),
});
export type DataRequest = z.infer<typeof dataRequestSchema>;

/**
 * What opening had to do about a damaged database (§5.6). The damaged file is kept beside the new
 * one, renamed `corruptFile`, for manual recovery.
 */
export const recoverySchema = z.discriminatedUnion('kind', [
  /** Replaced by the newest backup that passed a check, taken at `backupAt`. */
  z.strictObject({ kind: z.literal('restored'), backupAt: timestamp, corruptFile: fileName }),
  /** No usable backup: an empty database. */
  z.strictObject({ kind: z.literal('reset'), corruptFile: fileName }),
]);
export type DataRecovery = z.infer<typeof recoverySchema>;

/** worker → main. A response's `value` is parsed separately, with the method's output schema. */
// A plain union: Zod's discriminatedUnion refuses two variants with the same `kind`.
export const dataMessageSchema = z.union([
  z.strictObject({
    kind: z.literal('response'),
    id: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    ok: z.literal(true),
    value: z.unknown(),
  }),
  z.strictObject({
    kind: z.literal('response'),
    id: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    ok: z.literal(false),
    error: errorSchema,
  }),
  /** The database is open and migrated, and this run is recorded; requests are served now. */
  z.strictObject({
    kind: z.literal('ready'),
    userVersion: z.number().int().min(1),
    /** This launch's `app_runs` row, for the heartbeat and the clean end. */
    runId: rowId,
    /** How the last launch ended: `crash` when its row was never closed (§5.9). */
    previousExit: z.enum(['none', 'clean', 'crash']),
    /** The check run on opening: quick after a crash, full after a check found damage. */
    checked: z.enum(['none', 'quick', 'full']),
    recovery: recoverySchema.nullable(),
  }),
  /** Opening failed; the worker exits after sending this. */
  z.strictObject({ kind: z.literal('fatal'), error: errorSchema }),
]);
export type DataMessage = z.infer<typeof dataMessageSchema>;

/** What main passes as `workerData`. */
export const dataWorkerOptionsSchema = z.strictObject({
  /** The database file, in userData. */
  file: z.string().min(1).max(32_767),
  /** Where pre-migration and daily backups go. */
  backupDir: z.string().min(1).max(32_767),
  /** Recorded with this launch's `app_runs` row. */
  appVersion: z.string().min(1).max(64),
});
export type DataWorkerOptions = z.infer<typeof dataWorkerOptionsSchema>;
