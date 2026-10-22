// TabManager (ADR-0005 §1, assessment §3.2): the only writer of tab state. The shell sends intents;
// this class decides. It has no Electron imports: each tab's web contents sits behind the
// TabRuntime port (./tab-runtime.ts in the app, fakes in tests).
//
// Invariants (assessment §4.5), checked by the unit tests after every operation and by the
// model-based tests after every step (tab-manager-model.test.ts):
//   I1. A non-empty strip has exactly one selected tab, in the strip; an empty strip has none.
//   I2. The selected tab is creating, live or crashed: selecting wakes it. It is unloaded only
//       while it shows an internal page, or in safe mode until the user picks it.
//   I3. A closed tab holds no web contents.
//   I4. A tab has a web contents if and only if its runtime isn't unloaded. No leaks, no zombies.
//   I5. Automation never acts on the selected tab, on a protected tab, or on a decision made
//       before the tab's runtime last changed (its epoch).
//   I6. An ephemeral tab never reaches persistence or the memory.
//   I7. A tab has at most one lifecycle operation in flight (its serial queue).
//   I8. A pinned tab is in the strip.
// Also: pinned tabs come first and ids are unique; at most one runtime is shown, the selected
// tab's, and only while it shows web content; a closed tab's runtime is destroyed and nothing
// refers to it afterwards (ADR-0002 §2).
//
// M1.3b adds what the browser does to a page: find in page, zoom, HTML fullscreen (at most one
// tab, always the selected one), DevTools, and reopening closed tabs.
//
// M2.2a adds the session (ADR-0003 items 6 and 8, spike S2). A restored tab starts unloaded, with
// its sanitized back/forward stack, and is restored into a brand-new runtime only when selected:
// at startup that is the selected tab alone. A closed tab keeps its stack for Ctrl+Shift+T, and
// the session store (src/main/session) persists both lists.
//
// M3.1 adds the runtime state machine of §4.3 (core/lifecycle/runtime-machine.ts), with the
// discard of §4.9 and an experimental freeze. Every lifecycle operation runs on its tab's serial
// queue, every runtime transition bumps the tab's epoch, and each operation re-validates before
// its irreversible step (§4.11). A discarded tab keeps its stack with Chromium's page state in
// memory, so selecting it brings back the page, its scroll position and plain form values.
//
// M3.3 adds the placement dimension of §4.4 (core/lifecycle/placement.ts): Tabs (the strip),
// Sleeping (the shelf: still in memory, possibly live) and Archive (data only, like Recently
// closed, and never holding a web contents: I3). Restoring a tab puts it next to the current one.
// A user close asks "Leave page?" when the page objects (§4.9 Close).
import { nextZoomFactor, zoomPercent } from '../../core/layout/zoom';
import {
  CLOSE_TIMEOUT_MS,
  FREEZE_TIMEOUT_MS,
  LEARNED_RECHECK_MS,
  withDeadline,
} from '../../core/lifecycle/discard';
import type {
  DiscardBlock,
  DiscardOutcome,
  DiscardRequest,
  DiscardSkip,
  Timers,
} from '../../core/lifecycle/discard';
import {
  judgeProbe,
  parseProbeReading,
  PING_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
} from '../../core/lifecycle/probe';
import type { CloseMode } from '../../core/lifecycle/probe';
import { blockingProtection, protectionFor } from '../../core/lifecycle/protections';
import type { Protection, ProtectionReason } from '../../core/lifecycle/protections';
import { nextRuntime } from '../../core/lifecycle/runtime-machine';
import type { RuntimeEvent, RuntimeState } from '../../core/lifecycle/runtime-machine';
import { SerialQueue } from '../../core/lifecycle/serial-queue';
import { restorableSnapshot, sameStack, withoutPageState } from '../../core/lifecycle/snapshot';
import type { NavigationSnapshot } from '../../core/lifecycle/snapshot';
import type { LifecycleClock, TabFacts } from '../../core/lifecycle/policy';
import type {
  ArchiveReason,
  MoveOutcome,
  MoveRequest,
  MoveSkip,
  PlacementMove,
} from '../../core/lifecycle/placement';
import { restorableUrl, sanitizeHistory, singleEntryHistory } from '../../core/session/history';
import type { TabHistory } from '../../core/session/history';
import { errorPageFor } from '../../core/net/error-pages';
import type { ZoomDirection } from '../../core/layout/zoom';
import type { VisitTransition } from '../../core/search/frecency';
import type { InternalPage } from '../../core/url/internal-pages';
import { SYSTEM_TIMERS } from '../platform/timers';

export type TabId = string;

/** ADR-0003's runtime dimension (core/lifecycle/runtime-machine.ts). */
export type TabRuntimeState = RuntimeState;

export interface TabPageError {
  /** A Chromium net error code (did-fail-load), or a process exit code (crashed). */
  readonly code: number;
  /** For example `ERR_NAME_NOT_RESOLVED`, or a crash reason such as `oom`. */
  readonly name: string;
}

export type TabPage =
  | { readonly kind: 'web' }
  | { readonly kind: 'internal'; readonly name: InternalPage; readonly error?: TabPageError };

export interface TabState {
  readonly id: TabId;
  readonly pinned: boolean;
  /** Tabs or Sleeping (§4.4). An archived tab isn't a live record (see `archivedTabs`). */
  readonly placement: 'strip' | 'shelf';
  /** The user protected the tab: automation leaves it alone (a hard protection, §4.10). */
  readonly userProtected: boolean;
  /**
   * Never persisted or recorded in the memory (invariant I6). Nothing opens one yet: the option
   * exists so private windows can slot in later (ADR-0009 item 4).
   */
  readonly ephemeral: boolean;
  readonly runtime: TabRuntimeState;
  readonly page: TabPage;
  /**
   * The URL of the document on display: the last commit, or the load that failed. A load in
   * progress doesn't change it, so a stopped or aborted load leaves it as it was (ADR-0002 §7).
   * Empty for a new tab.
   */
  readonly url: string;
  /**
   * Main removed a username or password from the typed address before loading it, as in a pasted
   * `https://paypal.com@evil.example`. The address bar warns, as it does for a committed URL that
   * carries credentials (threat T7).
   */
  readonly credentialsRemoved: boolean;
  /** Page-controlled, sanitized. Empty until the page sets one. */
  readonly title: string;
  /** A validated `data:image/...` URL (threat T5), or null. */
  readonly favicon: string | null;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  /** The page's zoom as a whole percentage. Chromium keeps zoom per host: tabs on one host share it. */
  readonly zoomPercent: number;
  /** The find bar of this tab, or null while it is closed. */
  readonly find: FindState | null;
}

export interface FindState {
  readonly text: string;
  /** The highlighted match, from 1; 0 when there is none (yet). */
  readonly activeMatch: number;
  readonly matches: number;
}

/** How a discard's close ended (§4.9 step 5). */
export type CloseResult = 'closed' | 'prevented';

/** One tab's web contents. Implemented over a WebContentsView by ./tab-runtime.ts. */
export interface TabRuntime {
  load(url: string): void;
  goBack(): void;
  goForward(): void;
  /** `ignoreCache` bypasses the HTTP cache (Ctrl+Shift+R). */
  reload(options?: { readonly ignoreCache?: boolean }): void;
  stop(): void;
  /**
   * Searches the page; returns the request's id, which its `foundInPage` results carry.
   * `newSearch` starts over (the text changed); otherwise it moves to the next or previous match.
   */
  find(text: string, options: { readonly forward: boolean; readonly newSearch: boolean }): number;
  stopFind(action: 'clearSelection' | 'keepSelection'): void;
  zoomFactor(): number;
  setZoomFactor(factor: number): void;
  /** Opens the page's DevTools in their own window, or closes them. */
  toggleDevTools(): void;
  /** Makes the page leave HTML fullscreen, whatever the page's own script does. */
  exitFullscreen(): void;
  /** Attaches the view in the content area. Idempotent. */
  show(): void;
  /**
   * Attaches the view where it can't be seen, for a restore while the tab isn't selected: a
   * restore into a detached view puts the scroll position off by the display's scale (S2).
   */
  showHidden(): void;
  /** Detaches the view. Idempotent. */
  hide(): void;
  /** Gives the page keyboard focus. */
  focus(): void;
  /** Detaches and closes the web contents. The runtime is unusable afterwards. */
  destroy(): void;
  /**
   * Rebuilds a back/forward stack in this runtime, which must never have loaded anything (S2).
   * Entries may carry Chromium's page state, kept in memory since a discard. TabManager attaches
   * the view first. A failure to create it arrives as `restoreFailed`; a page that fails to load
   * arrives as `loadFailed`, with the stack intact.
   */
  restore(history: NavigationSnapshot): void;
  /** The current back/forward stack (URLs and titles), unsanitized; null before any load. */
  history(): TabHistory | null;
  /**
   * Wakes the page for the probe: the probe's dry run in our isolated world, without the flush.
   * It may take long on a busy or just-hidden page; TabManager enforces the deadline, and ignores
   * the answer.
   */
  ping(): Promise<unknown>;
  /**
   * Runs the discard probe in our isolated world: unsaved input, `hasBeenActive`, and the page
   * state flush (§4.9 step 3). Its answer comes from a renderer and is untrusted; a busy page may
   * take long to answer, so TabManager enforces the budget.
   */
  probe(): Promise<unknown>;
  /** Chromium's navigation entries with their page state, and the active index; null before any load. */
  snapshot(): { readonly index: number; readonly entries: readonly unknown[] } | null;
  /**
   * Detaches and closes the web contents for a discard (§4.9 step 5). `beforeunload` lets the
   * page object, which settles as `prevented` and leaves it alive; `plain` doesn't. Settles as
   * `closed` once the web contents is destroyed. It may never settle (a page stuck in its
   * handler): TabManager stops waiting after CLOSE_TIMEOUT_MS.
   */
  closeForDiscard(mode: CloseMode): Promise<CloseResult>;
  /** Experimental (§4.3): freezes the page; rejects if it can't. */
  freeze(): Promise<void>;
  /** Lets a frozen page run again. Idempotent. */
  thaw(): void;
}

/**
 * What a runtime reports about its web contents. Calls after `destroy()` are ignored.
 *
 * There is deliberately no "navigation started" event. Electron emits `did-start-navigation`
 * before the guard's `will-frame-navigate`, even for navigations the guard then cancels (checked
 * on Electron 44). A URL taken from it would let a page put any address, `app://shell`
 * included, into the address bar. The address only changes on a commit or a reported failure.
 */
export interface TabRuntimeEvents {
  /**
   * A main-frame navigation committed. `sameDocument` for fragment and history-API changes. The
   * probe's own page-state flush is not one: the runtime drops the commit it causes (S2).
   */
  committed(state: {
    url: string;
    sameDocument: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
  }): void;
  titleChanged(title: string): void;
  faviconChanged(favicon: string | null): void;
  loadingChanged(loading: boolean): void;
  /** The main frame failed to load (not for aborted loads). No page commits in this case. */
  loadFailed(
    error: TabPageError & { url: string; canGoBack?: boolean; canGoForward?: boolean },
  ): void;
  crashed(error: TabPageError): void;
  /** Results of the find request with this id; several arrive for one request. */
  foundInPage(result: { requestId: number; activeMatch: number; matches: number }): void;
  /** The user zoomed with Ctrl+wheel or a pinch. */
  zoomRequested(direction: 'in' | 'out'): void;
  /** The page entered or left HTML fullscreen. */
  fullscreenChanged(fullscreen: boolean): void;
  /**
   * `restore()` threw, or rejected without a failed load: the runtime is unusable (S2's
   * "creation failure"). TabManager replaces it and loads the active entry instead.
   */
  restoreFailed(): void;
  /**
   * The web contents was destroyed without `destroy()`: by a discard's close (reported to it as
   * well), by a close that finished after TabManager stopped waiting, or by something else.
   */
  gone(): void;
  /** A frozen page runs again without TabManager asking (its debugger detached). */
  thawed(): void;
  /**
   * The user gave the page input (any kind: keys, clicks, wheel, mouse moves). The runtime
   * reports it at most once a second; it feeds the recent-interaction guard (§4.10).
   */
  interacted?(): void;
  /**
   * The user activated the page (a click, a key press): what Chromium calls user activation, as
   * main sees it, including a click into a cross-site frame (S3). A user close of a page activated
   * since it loaded gives the page its `beforeunload` (§4.9 Close).
   */
  activated?(): void;
}

export type TabRuntimeFactory = (tabId: TabId, events: TabRuntimeEvents) => TabRuntime;

/** A runtime transition, as `onTransition` reports it. */
export interface RuntimeTransition {
  readonly tabId: TabId;
  readonly from: TabRuntimeState;
  readonly to: TabRuntimeState;
  readonly event: RuntimeEvent;
  /** The tab's epoch after the transition. */
  readonly epoch: number;
}

export interface TabManagerOptions {
  readonly createRuntime: TabRuntimeFactory;
  readonly newId: () => TabId;
  /** Called after every change; the projector coalesces these into snapshots. */
  readonly onChange: () => void;
  /** Called when a tab enters HTML fullscreen (its id) or the window leaves it (null). */
  readonly onFullscreenChange?: (tabId: TabId | null) => void;
  /**
   * The page a tab showed is gone: a new document committed, it failed or crashed, an internal
   * page replaced it, it was discarded, or the tab closed. Its permission prompts and blocked
   * popups no longer apply.
   */
  readonly onPageGone?: (tabId: TabId) => void;
  /** What the memory records (main/history/history-recorder.ts). Each is called after the change. */
  readonly history?: TabHistoryObserver;
  /** Wall-clock time, for the session's timestamps and learned protections. */
  readonly now?: () => number;
  /** The discard's and freeze's deadlines run on these (tests drive them). */
  readonly timers?: Timers;
  /** Protections from outside TabManager (the protection monitor, M3.4). */
  readonly protections?: (tabId: TabId) => Iterable<Protection>;
  /** Every runtime transition, after it happened. */
  readonly onTransition?: (transition: RuntimeTransition) => void;
  /**
   * The engagement clock (§4.6) with the wall clock, for each tab's last use. Without it, last
   * use is wall-clock only (engaged 0, active day 1).
   */
  readonly activityClock?: () => LifecycleClock;
  /**
   * The user closed a tab whose page objected to unloading (`beforeunload`): ask "Leave page?"
   * and resolve true to leave. The tab is selected by then. Without it, the tab stays.
   */
  readonly confirmLeave?: (tabId: TabId) => Promise<boolean>;
}

/** A tab's page changes, as the memory needs them. Never called for internal pages. */
export interface TabHistoryObserver {
  /** A main-frame commit, and how the user got there. */
  committed(
    tabId: TabId,
    commit: {
      readonly url: string;
      readonly sameDocument: boolean;
      readonly transition: VisitTransition;
    },
  ): void;
  /** The page's title, sanitized. */
  titleChanged(tabId: TabId, title: string): void;
  /** The page's icon, as the favicon service validated it (a `data:` URL). */
  faviconChanged(tabId: TabId, favicon: string): void;
  /** The tab closed: nothing more arrives for it. */
  closed(tabId: TabId): void;
}

export type FreezeOutcome =
  | { readonly outcome: 'frozen' }
  | { readonly outcome: 'skipped'; readonly why: DiscardSkip }
  | { readonly outcome: 'blocked'; readonly reason: DiscardBlock }
  | { readonly outcome: 'failed' };

/** What the lifecycle knows about a tab beyond its state: for the scheduler and the tests. */
export interface LifecycleFacts {
  /** Bumped by every runtime transition (§4.11). */
  readonly epoch: number;
  /** Lifecycle operations queued or running on the tab. */
  readonly queued: number;
  /** Lifecycle operations running right now: never more than one (I7). */
  readonly running: number;
  /** Protections a discard learned, still fresh, newest first. */
  readonly learned: readonly ProtectionReason[];
  /** Safe mode left the selected tab unloaded until the user picks it. */
  readonly heldUnloaded: boolean;
  /** A discard's page state waits in memory for the tab's next restore. */
  readonly pageStateInMemory: boolean;
}

/**
 * How many closed tabs Ctrl+Shift+T can bring back in a run. The database keeps every closed tab
 * for 7 days (ADR-0003 item 8); the session store loads the newest of them at startup.
 */
export const MAX_CLOSED_TABS = 100;

/** How a new-tab page is stored in the session: its typeable address (internal-pages.ts). */
export const SESSION_NEW_TAB_URL = 'veltriva://newtab';

/** A tab as the session stores it and restores it. Only non-ephemeral tabs become one (I6). */
export interface SessionTab {
  readonly id: TabId;
  readonly pinned: boolean;
  /** The address on display, or SESSION_NEW_TAB_URL for a new-tab page. */
  readonly url: string;
  readonly title: string;
  /** Sanitized (core/session/history.ts); null for a new-tab page. */
  readonly history: TabHistory | null;
  readonly createdAt: number;
  readonly lastUsedAt: number;
  /** The engagement clock at its last use (§4.6); absent from older rows, then "now". */
  readonly lastUsedEngaged?: number;
  /** The active day of its last use (§4.6); absent from older rows, then "today". */
  readonly lastUsedActiveDay?: number;
  /** The user protected it (`tabs.user_protected`). */
  readonly userProtected?: boolean;
  /** When it last moved between Tabs, Sleeping and Archive (`tabs.placement_changed_at`). */
  readonly placementChangedAt?: number;
}

/** An archived tab: data only, never a web contents (I3). */
export interface ArchivedTab extends SessionTab {
  readonly archivedAt: number;
  readonly reason: ArchiveReason;
  /** Its icon when it was archived, for the sidebar; memory only (not in its row). */
  readonly favicon?: string | null;
}

/**
 * Archived tabs kept in memory: the newest, for the sidebar and Undo. The database keeps them
 * all; Phase 4's Archive list and search read it.
 */
export const MAX_ARCHIVED_IN_MEMORY = 200;

export interface ClosedTab extends SessionTab {
  readonly closedAt: number;
  /** Where it was in the strip, for reopening it there. */
  readonly index: number;
}

const MAX_TITLE_LENGTH = 1024;
// Controls, bidi overrides and isolates: a page title must not reorder or hide sidebar text.
const TITLE_UNSAFE =
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point.
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

export function sanitizeTitle(title: string): string {
  return title.replace(TITLE_UNSAFE, '').trim().slice(0, MAX_TITLE_LENGTH);
}

/** A discard under way (§4.9). */
interface DiscardProgress {
  /** The close was sent: from here, the page decides (it closes, or objects). */
  closing: boolean;
  /** The tab was selected while closing: it comes back as soon as the close settles. */
  revive: boolean;
  /** What the user did to the tab while it was closing, done once the close settles. */
  readonly deferred: (() => void)[];
  /** Set when something other than the procedure ended it (the renderer died, the contents went). */
  result: DiscardOutcome | null;
}

interface TabRecord {
  state: TabState;
  runtime: TabRuntime | undefined;
  /** Identifies the current runtime, so events from a replaced one are ignored. */
  runtimeToken: symbol | undefined;
  /** Bumped by every runtime transition; a decision made before the last one is stale (§4.11). */
  epoch: number;
  /** The tab's lifecycle operations, one at a time (I7). */
  readonly queue: SerialQueue;
  /** The discard in progress, if any. */
  discard: DiscardProgress | null;
  /**
   * The last discard's snapshot with Chromium's page state, kept in memory for this run only, and
   * used by the next restore if the tab's stack is still the one it holds.
   */
  memorySnapshot: NavigationSnapshot | null;
  /** The snapshot of a close that timed out, in case it finishes after all. Until the next commit. */
  lateCloseSnapshot: NavigationSnapshot | null;
  /** The runtime's last reported stack, for a web contents that vanishes before it can be read. */
  lastHistory: TabHistory | null;
  /** Protections a discard learned, with when; forgotten with the document (§4.10). */
  readonly learned: Map<ProtectionReason, number>;
  /** Safe mode: the selected tab stays unloaded until the user picks it. */
  heldUnloaded: boolean;
  /** Restored while not selected: attached invisibly until its page has loaded (S2). */
  restoringHidden: boolean;
  /** Focus the page when the next navigation commits (it came from the address bar). */
  focusOnCommit: boolean;
  /** `credentialsRemoved` for whatever the next navigation commits or fails with. */
  credentialsRemovedOnCommit: boolean;
  /** The latest find request; results for older ones are stale. */
  findRequestId: number | undefined;
  /** What the find bar searched for last, offered again when it reopens. */
  lastFindText: string;
  /** An unloaded tab's stack, restored when it is next selected (or reloaded). */
  pendingHistory: TabHistory | null;
  /**
   * How the navigation main started last got there, for the commit it leads to. A commit with
   * none (a link, a form, a page's own script) is a `link`.
   */
  nextTransition: VisitTransition | null;
  readonly createdAt: number;
  /** Its last use: when it was last selected, or left (§4.2's activity). */
  lastUsedAt: number;
  lastUsedEngaged: number;
  lastUsedActiveDay: number;
  /** Wall-clock time it stopped being shown; null while it is the selected tab. */
  hiddenSince: number | null;
  /** Wall-clock time of the user's last input in its page. */
  lastInteractionAt: number | null;
  /** The user activated the page since it loaded (as main sees input). */
  activated: boolean;
  /** A user close is asking the page whether it may unload. */
  userClosing: boolean;
  /** The page objected to a user close and "Leave page?" waits for the user's answer. */
  askingToLeave: boolean;
  placementChangedAt: number;
}

const NEW_TAB_PAGE: TabPage = { kind: 'internal', name: 'new-tab' };

const skipped = (why: DiscardSkip): DiscardOutcome => ({ outcome: 'skipped', why });
const blocked = (reason: DiscardBlock): DiscardOutcome => ({ outcome: 'blocked', reason });
const DISCARDED: DiscardOutcome = { outcome: 'discarded' };
const skippedMove = (why: MoveSkip): MoveOutcome => ({ outcome: 'skipped', why });

export class TabManager {
  readonly #options: TabManagerOptions;
  readonly #timers: Timers;
  readonly #order: TabId[] = [];
  readonly #records = new Map<TabId, TabRecord>();
  readonly #closed: ClosedTab[] = [];
  /** Sleeping, most recently moved there first. */
  readonly #shelf: TabId[] = [];
  /** Archived tabs in memory, oldest first (MAX_ARCHIVED_IN_MEMORY). */
  readonly #archived: ArchivedTab[] = [];
  /** Archived tabs only the database holds (beyond those in memory). */
  #archivedElsewhere = 0;
  #selected: TabId | null = null;
  /** The tab in HTML fullscreen, if any. Only the selected tab can be. */
  #fullscreen: TabId | null = null;

  constructor(options: TabManagerOptions) {
    this.#options = options;
    this.#timers = options.timers ?? SYSTEM_TIMERS;
  }

  /** Every tab in strip order: pinned first. */
  tabs(): readonly TabState[] {
    return this.#order.map((id) => this.#record(id).state);
  }

  /** Sleeping (§4.4), most recently moved there first. */
  sleepingTabs(): readonly TabState[] {
    return this.#shelf.map((id) => this.#record(id).state);
  }

  /** Archived tabs in memory, newest first. */
  archivedTabs(): readonly ArchivedTab[] {
    return [...this.#archived].reverse();
  }

  /** How many tabs are archived in all: those in memory and those only in the database. */
  archivedCount(): number {
    return this.#archivedElsewhere + this.#archived.length;
  }

  /** Sleeping as the session stores it (I6: never an ephemeral tab). */
  shelfSessionTabs(): readonly SessionTab[] {
    return this.#shelf
      .map((id) => this.#record(id))
      .filter((record) => !record.state.ephemeral)
      .map((record) => this.#sessionTab(record));
  }

  selectedTabId(): TabId | null {
    return this.#selected;
  }

  has(tabId: TabId): boolean {
    return this.#records.has(tabId);
  }

  get(tabId: TabId): TabState {
    return this.#record(tabId).state;
  }

  fullscreenTabId(): TabId | null {
    return this.#fullscreen;
  }

  /** What the lifecycle knows about a tab beyond its state. */
  lifecycleFacts(tabId: TabId): LifecycleFacts {
    const record = this.#record(tabId);
    return {
      epoch: record.epoch,
      queued: record.queue.pending,
      running: record.queue.running,
      learned: this.#freshLearned(record).map((protection) => protection.reason),
      heldUnloaded: record.heldUnloaded,
      pageStateInMemory: record.memorySnapshot !== null,
    };
  }

  /**
   * What the policy (core/lifecycle/policy.ts) needs about every tab, in strip order: activity,
   * runtime, and its protections (the monitor's and what discards learned).
   */
  lifecycleTabs(): TabFacts[] {
    const clock = this.#clock();
    return [...this.#order, ...this.#shelf].map((id) => {
      const record = this.#record(id);
      const { state } = record;
      const selected = this.#selected === id;
      return {
        id,
        placement: state.placement,
        runtime: state.runtime,
        pinned: state.pinned,
        selected,
        webPage: state.page.kind === 'web',
        loading: state.loading,
        busy: record.queue.pending > 0 || record.discard !== null,
        epoch: record.epoch,
        hiddenSince: selected ? null : record.hiddenSince,
        lastUsedAt: selected ? clock.wallNow : record.lastUsedAt,
        lastUsedEngaged: selected ? clock.engagedNow : record.lastUsedEngaged,
        lastUsedActiveDay: selected ? clock.activeDay : record.lastUsedActiveDay,
        lastInteractionAt: record.lastInteractionAt,
        protections: this.#protectionsOf(record),
      };
    });
  }

  /**
   * Opens a new-tab page at the end of the strip (or right after `afterTabId`). An `ephemeral`
   * tab is never persisted or recorded (I6).
   */
  create(
    options: {
      readonly select?: boolean;
      readonly afterTabId?: TabId;
      readonly ephemeral?: boolean;
    } = {},
  ): TabId {
    const after = options.afterTabId === undefined ? undefined : this.#record(options.afterTabId);
    const id = this.#options.newId();
    const now = this.#now();
    this.#records.set(
      id,
      this.#newRecord({
        id,
        pinned: after?.state.pinned ?? false,
        ephemeral: options.ephemeral ?? after?.state.ephemeral ?? false,
        createdAt: now,
        lastUsedAt: now,
      }),
    );
    const afterIndex = after === undefined ? -1 : this.#order.indexOf(after.state.id);
    if (afterIndex === -1) {
      this.#order.push(id); // After nothing, or after a Sleeping tab: at the end of the strip.
    } else {
      this.#order.splice(afterIndex + 1, 0, id);
    }
    if (options.select !== false || this.#selected === null) {
      this.#setSelected(id, true);
    }
    this.#changed();
    return id;
  }

  /**
   * Closes a tab and destroys its runtime, whatever lifecycle operation it has under way.
   * Selection moves to the tab that took its place (the next one), or the previous one at the
   * end of the strip. Closing the last tab opens a new one: the window always has something to
   * show. `focus: false` keeps keyboard focus where it is (the sidebar) instead of giving it to
   * the newly selected page.
   */
  close(tabId: TabId, options: { readonly focus?: boolean } = {}): void {
    this.#closeRecord(this.#record(tabId), options, null);
  }

  /**
   * A close the user asked for (§4.9 Close). A page the user activated may object to unloading
   * (`beforeunload`): then the tab is selected and `confirmLeave` asks "Leave page?", where only
   * the user can override. Other pages close at once, without the round trip that would let an
   * untouched page object (S3). `onClosed` runs once the tab is closed, if it is.
   */
  requestClose(
    tabId: TabId,
    options: { readonly focus?: boolean; readonly onClosed?: () => void } = {},
  ): void {
    const record = this.#record(tabId);
    const runtime = record.runtime;
    if (record.userClosing) {
      return; // Already asking the page.
    }
    if (record.askingToLeave) {
      // Closing again while "Leave page?" waits: the question is the answer; show it.
      if (this.#selected !== tabId) {
        this.select(tabId, options);
      }
      return;
    }
    const asks =
      runtime !== undefined &&
      record.activated &&
      record.state.page.kind === 'web' &&
      (record.state.runtime === 'live' || record.state.runtime === 'frozen');
    if (!asks) {
      this.close(tabId, options);
      options.onClosed?.();
      return;
    }
    record.userClosing = true;
    // The stack is read now: the close may destroy the web contents.
    const captured = record.state.ephemeral ? null : this.#sessionTab(record);
    void record.queue.run(async () => {
      if (this.#records.get(tabId) !== record) {
        return;
      }
      if (record.state.runtime === 'frozen') {
        this.#thaw(record);
      }
      const closed = await withDeadline(
        Promise.resolve().then(() => runtime.closeForDiscard('beforeunload')),
        CLOSE_TIMEOUT_MS,
        this.#timers,
      );
      if (this.#records.get(tabId) !== record) {
        return;
      }
      record.userClosing = false;
      if (closed.kind === 'value' && closed.value === 'closed') {
        this.#closeRecord(record, options, captured);
        options.onClosed?.();
        return;
      }
      // The page objects, or is stuck in its handler: the user decides. The close detached its
      // view; it is shown again with the tab selected.
      if (this.#selected === tabId) {
        this.#syncVisibility();
      } else {
        this.#setSelected(tabId, true);
      }
      this.#changed();
      this.#askToLeave(record, options);
    });
  }

  #askToLeave(
    record: TabRecord,
    options: { readonly focus?: boolean; readonly onClosed?: () => void },
  ): void {
    const confirm = this.#options.confirmLeave;
    if (confirm === undefined) {
      return;
    }
    const tabId = record.state.id;
    record.askingToLeave = true;
    const answered = (leave: boolean): void => {
      if (this.#records.get(tabId) !== record) {
        return; // Closed meanwhile.
      }
      record.askingToLeave = false;
      if (leave) {
        // The user overrides the page: a plain close, which runs no handler.
        this.#closeRecord(record, options, null);
        options.onClosed?.();
      }
    };
    confirm(tabId).then(answered, () => {
      answered(false);
    });
  }

  #closeRecord(
    record: TabRecord,
    options: { readonly focus?: boolean },
    captured: SessionTab | null,
  ): void {
    const tabId = record.state.id;
    const sleeping = record.state.placement === 'shelf';
    // A Sleeping tab reopens at the end of the strip.
    const index = sleeping ? this.#order.length : this.#order.indexOf(tabId);
    if (record.state.url !== '' && !record.state.ephemeral) {
      // Its stack is read before the runtime goes (Recently closed keeps it for 7 days).
      this.#closed.push({
        ...(captured ?? this.#sessionTab(record)),
        closedAt: this.#now(),
        index,
      });
      if (this.#closed.length > MAX_CLOSED_TABS) {
        this.#closed.shift();
      }
    }
    if (sleeping) {
      this.#shelf.splice(this.#shelf.indexOf(tabId), 1);
    } else {
      this.#order.splice(index, 1);
    }
    this.#records.delete(tabId);
    if (this.#fullscreen === tabId) {
      this.#setFullscreen(null);
    }
    record.discard = null;
    record.memorySnapshot = null;
    record.runtime?.destroy();
    record.runtime = undefined;
    record.runtimeToken = undefined;
    this.#options.onPageGone?.(tabId);
    if (!record.state.ephemeral) {
      this.#options.history?.closed(tabId);
    }

    if (this.#order.length === 0) {
      this.#selected = null;
      this.create();
      return;
    }
    if (this.#selected === tabId) {
      const next = this.#order[Math.min(index, this.#order.length - 1)];
      this.#selected = null;
      if (next !== undefined) {
        this.#setSelected(next, options.focus ?? true);
      }
    }
    this.#changed();
  }

  /** Whether Ctrl+Shift+T has a closed tab to bring back. */
  canReopenClosed(): boolean {
    return this.#closed.length > 0;
  }

  /**
   * Reopens the most recently closed tab where it was, with its back/forward stack and its own id
   * (Ctrl+Shift+T), and selects it, which restores it.
   */
  reopenClosed(): TabId | null {
    const closed = this.#closed.pop();
    if (closed === undefined) {
      return null;
    }
    const id = this.#records.has(closed.id) ? this.#options.newId() : closed.id;
    this.#records.set(
      id,
      this.#newRecord({ ...closed, id, ephemeral: false, lastUsedAt: this.#now() }),
    );
    // Pinned or not, it goes back inside its own section.
    const pinnedCount = this.#pinnedCount();
    const [first, last] = closed.pinned ? [0, pinnedCount] : [pinnedCount, this.#order.length];
    this.#order.splice(Math.min(Math.max(closed.index, first), last), 0, id);
    this.#setSelected(id, true);
    this.#changed();
    return id;
  }

  /** Recently closed, newest first: what the session stores. */
  closedTabs(): readonly ClosedTab[] {
    return [...this.#closed].reverse();
  }

  /** Every persistable tab in strip order, as the session stores it. Ephemeral tabs never are (I6). */
  sessionTabs(): readonly SessionTab[] {
    const tabs: SessionTab[] = [];
    for (const id of this.#order) {
      const record = this.#record(id);
      if (!record.state.ephemeral) {
        tabs.push(this.#sessionTab(record));
      }
    }
    return tabs;
  }

  /**
   * Puts back a saved session into an empty TabManager (startup, assessment §5.9): every tab
   * unloaded, pinned ones first, the saved one selected. Only the selected tab is restored, and
   * only if `loadSelected` (safe mode leaves it unloaded until the user picks a tab). With no
   * tabs it opens a new-tab page. `closed` is newest first.
   */
  restoreSession(session: {
    readonly tabs: readonly SessionTab[];
    readonly selectedTabId: TabId | null;
    readonly closed: readonly ClosedTab[];
    readonly loadSelected: boolean;
    /** Sleeping, most recently moved there first (M3.3). */
    readonly shelf?: readonly SessionTab[];
    /** Archived tabs, newest first, as many as are kept in memory (M3.3). */
    readonly archived?: readonly ArchivedTab[];
    /** How many tabs are archived in all (M3.3). */
    readonly archivedCount?: number;
  }): void {
    if (this.#records.size > 0) {
      throw new Error('restoreSession needs an empty TabManager.');
    }
    const sorted = [
      ...session.tabs.filter((tab) => tab.pinned),
      ...session.tabs.filter((tab) => !tab.pinned),
    ];
    for (const tab of sorted) {
      if (this.#records.has(tab.id)) {
        continue; // A duplicate id: keep the first.
      }
      this.#records.set(tab.id, this.#newRecord({ ...checkedSessionTab(tab), ephemeral: false }));
      this.#order.push(tab.id);
    }
    for (const tab of session.shelf ?? []) {
      if (this.#records.has(tab.id)) {
        continue;
      }
      // I8: a pinned tab is in the strip, so a Sleeping one never is.
      this.#records.set(
        tab.id,
        this.#newRecord({
          ...checkedSessionTab(tab),
          pinned: false,
          ephemeral: false,
          placement: 'shelf',
        }),
      );
      this.#shelf.push(tab.id);
    }
    this.#archived.length = 0;
    for (const archived of [...(session.archived ?? [])].reverse().slice(-MAX_ARCHIVED_IN_MEMORY)) {
      const checked = checkedSessionTab(archived);
      if (!this.#records.has(archived.id) && checked.url !== '') {
        this.#archived.push({ ...archived, ...checked, pinned: false });
      }
    }
    this.#archivedElsewhere = Math.max(0, (session.archivedCount ?? 0) - this.#archived.length);
    this.#closed.length = 0;
    for (const closed of [...session.closed].reverse().slice(-MAX_CLOSED_TABS)) {
      const checked = checkedSessionTab(closed);
      // A closed new-tab page has nothing to reopen.
      if (!this.#records.has(closed.id) && checked.url !== '') {
        this.#closed.push({ ...closed, ...checked });
      }
    }
    const selected =
      session.selectedTabId !== null && this.#records.has(session.selectedTabId)
        ? session.selectedTabId
        : this.#order[0];
    if (selected === undefined) {
      this.create();
      return;
    }
    this.#selected = selected;
    const record = this.#record(selected);
    if (session.loadSelected) {
      this.#ensureLive(record);
    } else if (record.state.page.kind === 'web') {
      record.heldUnloaded = true;
    }
    this.#syncVisibility();
    this.#changed();
  }

  /** Closes every tab without opening a new one. For shutdown only. */
  closeAll(): void {
    for (const [tabId, record] of this.#records) {
      record.discard = null;
      record.runtime?.destroy();
      record.runtime = undefined;
      record.runtimeToken = undefined;
      this.#options.onPageGone?.(tabId);
    }
    this.#records.clear();
    this.#order.length = 0;
    this.#shelf.length = 0;
    this.#selected = null;
    this.#fullscreen = null;
    this.#changed();
  }

  /**
   * Selects a tab. Its page gets keyboard focus unless `focus` is false (keyboard use of the
   * sidebar keeps focus in the sidebar). A tab in HTML fullscreen leaves it first.
   */
  select(tabId: TabId, options: { readonly focus?: boolean } = {}): void {
    const record = this.#record(tabId);
    if (record.state.placement === 'shelf') {
      // I1: the selected tab is in the strip. Picking a Sleeping tab brings it back.
      this.restoreToStrip(tabId, { select: true, focus: options.focus ?? true });
      return;
    }
    if (this.#selected === tabId) {
      // Safe mode leaves the selected tab unloaded: picking it again loads it.
      const epoch = record.epoch;
      this.#wake(record);
      if (record.epoch !== epoch) {
        this.#syncVisibility();
        this.#changed();
      }
      return;
    }
    this.#setSelected(tabId, options.focus ?? true);
    this.#changed();
  }

  /** Selects the tab `delta` places away in strip order, wrapping around (Ctrl+Tab). */
  selectRelative(delta: number, options: { readonly focus?: boolean } = {}): void {
    const count = this.#order.length;
    if (this.#selected === null || count === 0) {
      return;
    }
    const index = this.#order.indexOf(this.#selected);
    const next = this.#order[(((index + delta) % count) + count) % count];
    if (next !== undefined) {
      this.select(next, options);
    }
  }

  /** Selects the tab at `index` in strip order, if there is one (Ctrl+1 to Ctrl+8). */
  selectIndex(index: number, options: { readonly focus?: boolean } = {}): void {
    const tabId = this.#order[index];
    if (tabId !== undefined) {
      this.select(tabId, options);
    }
  }

  /** Selects the last tab in strip order (Ctrl+9). */
  selectLast(options: { readonly focus?: boolean } = {}): void {
    const tabId = this.#order.at(-1);
    if (tabId !== undefined) {
      this.select(tabId, options);
    }
  }

  /** Gives the tab's page keyboard focus. False if the tab shows no web page. */
  focusPage(tabId: TabId): boolean {
    const record = this.#record(tabId);
    if (record.runtime === undefined || record.state.page.kind !== 'web') {
      return false;
    }
    record.runtime.focus();
    return true;
  }

  /** Moves a tab within its section: pinned tabs stay before the others. */
  move(tabId: TabId, toIndex: number): void {
    const record = this.#record(tabId);
    const from = this.#order.indexOf(tabId);
    this.#order.splice(from, 1);
    const pinnedCount = this.#pinnedCount();
    const [first, last] = record.state.pinned
      ? [0, pinnedCount]
      : [pinnedCount, this.#order.length];
    const target = Math.min(Math.max(Math.trunc(toIndex), first), last);
    this.#order.splice(target, 0, tabId);
    if (target !== from) {
      this.#changed();
    }
  }

  /** Pinning moves a tab to the end of the pinned section; unpinning, to the start of the rest. */
  setPinned(tabId: TabId, pinned: boolean): void {
    const record = this.#record(tabId);
    if (record.state.pinned === pinned) {
      return;
    }
    if (record.state.placement === 'shelf') {
      // I8: a pinned tab is in the strip.
      this.restoreToStrip(tabId, { select: false });
    }
    this.#order.splice(this.#order.indexOf(tabId), 1);
    const target = this.#pinnedCount();
    this.#order.splice(target, 0, tabId);
    record.state = { ...record.state, pinned };
    this.#changed();
  }

  /** A new tab right after the source, loading the same URL. History isn't copied. */
  duplicate(tabId: TabId): TabId {
    const source = this.#record(tabId).state;
    const id = this.create({ afterTabId: tabId });
    if (source.page.kind === 'web' && source.url !== '') {
      this.navigate(id, source.url, { focus: false });
    } else if (
      source.page.kind === 'internal' &&
      source.page.name !== 'new-tab' &&
      source.url !== ''
    ) {
      // An error or crashed page: try the URL again in the copy.
      this.navigate(id, source.url, { focus: false });
    }
    return id;
  }

  /**
   * Loads a web URL in a tab, creating its runtime if it has none. The tab's URL and page change
   * only when the load commits or fails: until then it keeps showing what it showed (a new-tab or
   * error page stays up, and the address stays that of the document on display).
   */
  navigate(
    tabId: TabId,
    url: string,
    options: {
      readonly focus?: boolean;
      readonly credentialsRemoved?: boolean;
      /** For the memory: `typed` from the address bar, `generated` for its searches. */
      readonly transition?: VisitTransition;
    } = {},
  ): void {
    const record = this.#record(tabId);
    if (
      !this.#readyForUse(record, () => {
        this.navigate(tabId, url, options);
      })
    ) {
      return;
    }
    if (record.runtime === undefined) {
      this.#attachRuntime(record);
    }
    record.pendingHistory = null;
    record.memorySnapshot = null;
    record.heldUnloaded = false;
    record.nextTransition = options.transition ?? 'link';
    record.focusOnCommit = options.focus ?? true;
    record.credentialsRemovedOnCommit = options.credentialsRemoved ?? false;
    if (record.state.runtime === 'unloaded' || record.state.runtime === 'crashed') {
      this.#transition(record, 'load');
    }
    record.state = { ...record.state, loading: true };
    record.runtime?.load(url);
    this.#syncVisibility();
    this.#changed();
  }

  /** Shows an internal page in a tab. Its web contents (if any) is closed: back can't reach it. */
  showInternal(tabId: TabId, name: InternalPage): void {
    const record = this.#record(tabId);
    if (
      !this.#readyForUse(record, () => {
        this.showInternal(tabId, name);
      })
    ) {
      return;
    }
    if (this.#fullscreen === tabId) {
      this.#setFullscreen(null);
    }
    record.runtime?.destroy();
    record.runtime = undefined;
    record.runtimeToken = undefined;
    record.credentialsRemovedOnCommit = false;
    record.pendingHistory = null;
    record.memorySnapshot = null;
    record.lastHistory = null;
    record.heldUnloaded = false;
    record.restoringHidden = false;
    this.#options.onPageGone?.(tabId);
    record.findRequestId = undefined;
    this.#transition(record, 'internalPage');
    record.state = {
      ...record.state,
      page: { kind: 'internal', name },
      url: '',
      credentialsRemoved: false,
      title: '',
      favicon: null,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      zoomPercent: 100,
      find: null,
    };
    this.#syncVisibility();
    this.#changed();
  }

  goBack(tabId: TabId): void {
    const record = this.#record(tabId);
    if (
      !this.#readyForUse(record, () => {
        this.goBack(tabId);
      })
    ) {
      return;
    }
    if (record.state.canGoBack && record.runtime !== undefined) {
      record.nextTransition = 'back_forward';
      record.runtime.goBack();
    }
  }

  goForward(tabId: TabId): void {
    const record = this.#record(tabId);
    if (
      !this.#readyForUse(record, () => {
        this.goForward(tabId);
      })
    ) {
      return;
    }
    if (record.state.canGoForward && record.runtime !== undefined) {
      record.nextTransition = 'back_forward';
      record.runtime.goForward();
    }
  }

  /**
   * Reloads; for an error page this retries, for a crashed tab it starts a new renderer, and an
   * unloaded tab is restored.
   */
  reload(tabId: TabId, options: { readonly ignoreCache?: boolean } = {}): void {
    const record = this.#record(tabId);
    if (
      !this.#readyForUse(record, () => {
        this.reload(tabId, options);
      })
    ) {
      return;
    }
    if (record.runtime === undefined) {
      // An unloaded tab (safe mode leaves the selected one so, a discard others): Reload loads it.
      this.#ensureLive(record);
      this.#syncVisibility();
      this.#changed();
      return;
    }
    if (record.state.runtime === 'crashed') {
      this.#transition(record, 'load');
      this.#changed();
    }
    record.nextTransition = 'reload';
    record.runtime.reload({ ignoreCache: options.ignoreCache ?? false });
  }

  stop(tabId: TabId): void {
    this.#record(tabId).runtime?.stop();
  }

  /**
   * Opens the find bar of a tab that shows a web page, with the text it searched for last (and
   * searches for it again). False if the tab has no page to search.
   */
  openFind(tabId: TabId): boolean {
    const record = this.#record(tabId);
    if (record.runtime === undefined || record.state.page.kind !== 'web') {
      return false;
    }
    if (record.state.find === null) {
      const text = record.lastFindText;
      record.state = { ...record.state, find: { text, activeMatch: 0, matches: 0 } };
      record.findRequestId =
        text === '' ? undefined : record.runtime.find(text, { forward: true, newSearch: true });
      this.#changed();
    }
    return true;
  }

  /** The find bar's text changed: search again from the top, or clear an empty search. */
  updateFind(tabId: TabId, text: string): void {
    const record = this.#record(tabId);
    if (record.state.find === null || record.runtime === undefined) {
      return;
    }
    record.lastFindText = text;
    record.state = { ...record.state, find: { text, activeMatch: 0, matches: 0 } };
    if (text === '') {
      record.findRequestId = undefined;
      record.runtime.stopFind('clearSelection');
    } else {
      record.findRequestId = record.runtime.find(text, { forward: true, newSearch: true });
    }
    this.#changed();
  }

  /** Moves to the next (or previous) match of the find bar's text. */
  findNext(tabId: TabId, forward: boolean): void {
    const record = this.#record(tabId);
    const find = record.state.find;
    if (find === null || find.text === '' || record.runtime === undefined) {
      return;
    }
    record.findRequestId = record.runtime.find(find.text, { forward, newSearch: false });
  }

  /** Closes the find bar. The page keeps its selection on the last match, as in Chrome. */
  closeFind(tabId: TabId): void {
    const record = this.#record(tabId);
    if (record.state.find === null) {
      return;
    }
    record.findRequestId = undefined;
    record.runtime?.stopFind('keepSelection');
    record.state = { ...record.state, find: null };
    this.#changed();
  }

  /** Zooms a tab's page one preset step, or back to 100%. */
  zoom(tabId: TabId, direction: ZoomDirection): void {
    const record = this.#record(tabId);
    if (record.runtime === undefined || record.state.page.kind !== 'web') {
      return;
    }
    record.runtime.setZoomFactor(nextZoomFactor(record.runtime.zoomFactor(), direction));
    this.#refreshZoom();
  }

  /** Opens or closes the DevTools of a tab's page, in their own window (F12). */
  toggleDevTools(tabId: TabId): void {
    const record = this.#record(tabId);
    if (record.runtime !== undefined && record.state.page.kind === 'web') {
      record.runtime.toggleDevTools();
    }
  }

  /** Makes the fullscreen tab leave fullscreen (F11, Esc in the shell, a tab switch). */
  exitFullscreen(): void {
    const tabId = this.#fullscreen;
    if (tabId === null) {
      return;
    }
    this.#records.get(tabId)?.runtime?.exitFullscreen();
    this.#setFullscreen(null);
  }

  /** Protects a tab from automation, or stops protecting it (a hard protection, §4.10). */
  setProtected(tabId: TabId, on: boolean): void {
    const record = this.#record(tabId);
    if (record.state.userProtected === on) {
      return;
    }
    record.state = { ...record.state, userProtected: on };
    this.#changed();
  }

  /**
   * Moves a strip tab to Sleeping (§4.4). Never a pinned tab (I8). The user may move the selected
   * tab: the one next to it is selected first. Automation re-validates its decision: not the
   * selected tab, not a busy one, the epoch it saw, and no protection that blocks shelving.
   */
  shelve(tabId: TabId, request: MoveRequest): MoveOutcome {
    const record = this.#records.get(tabId);
    if (record === undefined) {
      return skippedMove('closed');
    }
    if (record.state.placement !== 'strip') {
      return skippedMove('wrong-placement');
    }
    if (record.state.pinned) {
      return skippedMove('pinned');
    }
    if (request.origin === 'automation') {
      const refusal = this.#automationRefusal(record, request, 'shelve');
      if (refusal !== null) {
        return refusal;
      }
    }
    const index = this.#order.indexOf(tabId);
    this.#leaveSelection(record);
    this.#order.splice(this.#order.indexOf(tabId), 1);
    this.#shelf.unshift(tabId);
    record.state = { ...record.state, placement: 'shelf' };
    record.placementChangedAt = this.#clock().wallNow;
    this.#ensureStripNotEmpty();
    this.#syncVisibility();
    this.#changed();
    return { outcome: 'moved', move: { tabId, from: 'strip', to: 'shelf', index } };
  }

  /**
   * Brings a Sleeping tab back to the strip (§4.4): next to the selected tab, or at `index`
   * (Undo puts a tab back where it was). Selects it unless `select` is false.
   */
  restoreToStrip(
    tabId: TabId,
    options: { readonly select?: boolean; readonly index?: number; readonly focus?: boolean } = {},
  ): void {
    const record = this.#record(tabId);
    if (record.state.placement !== 'shelf') {
      return;
    }
    this.#shelf.splice(this.#shelf.indexOf(tabId), 1);
    this.#order.splice(this.#stripSlot(record.state.pinned, options.index), 0, tabId);
    record.state = { ...record.state, placement: 'strip' };
    record.placementChangedAt = this.#clock().wallNow;
    if (options.select !== false) {
      this.#setSelected(tabId, options.focus ?? true);
    } else {
      this.#syncVisibility();
    }
    this.#changed();
  }

  /**
   * Archives a strip or Sleeping tab (§4.4, §4.9 Archive). An archived tab holds no web contents
   * (I3), so a live one is discarded first, in the same operation, on the tab's queue; a discard
   * that is blocked leaves the tab where it was, with the reason. The tab then leaves the
   * workspace: its stack is kept (without page state) and `restoreArchived` brings it back.
   * The user may archive the selected or a pinned tab; automation re-validates its decision.
   */
  archive(tabId: TabId, request: MoveRequest): Promise<MoveOutcome> {
    const record = this.#records.get(tabId);
    if (record === undefined) {
      return Promise.resolve(skippedMove('closed'));
    }
    return record.queue.run(() => this.#runArchive(record, request));
  }

  /**
   * Brings an archived tab back (§4.4): to the strip next to the selected tab and selected, or,
   * for an Undo, to where it was (`to`, `index`) without selecting it. Null if it isn't in memory.
   */
  restoreArchived(
    tabId: TabId,
    options: {
      readonly select?: boolean;
      readonly to?: 'strip' | 'shelf';
      readonly index?: number;
      readonly focus?: boolean;
    } = {},
  ): TabId | null {
    const at = this.#archived.findIndex((entry) => entry.id === tabId);
    const entry = this.#archived[at];
    if (entry === undefined) {
      return null;
    }
    this.#archived.splice(at, 1);
    const id = this.#records.has(entry.id) ? this.#options.newId() : entry.id;
    const to = options.to ?? 'strip';
    const record = this.#newRecord({
      ...checkedSessionTab(entry),
      id,
      ephemeral: false,
      // An archived tab is never pinned (I8): it comes back in the unpinned section.
      pinned: false,
      placement: to,
      placementChangedAt: this.#clock().wallNow,
    });
    this.#records.set(id, record);
    if (to === 'shelf') {
      this.#shelf.splice(Math.min(Math.max(options.index ?? 0, 0), this.#shelf.length), 0, id);
    } else {
      this.#order.splice(this.#stripSlot(false, options.index), 0, id);
    }
    if (to === 'strip' && options.select !== false) {
      this.#setSelected(id, options.focus ?? true);
    }
    this.#changed();
    return id;
  }

  /**
   * Puts back what an automated batch moved (§4.13: every move has an Undo), newest first. A tab
   * that moved again since, or closed, is left as it is. Returns how many came back.
   */
  undoMoves(moves: readonly PlacementMove[]): number {
    let undone = 0;
    for (const move of [...moves].reverse()) {
      if (move.to === 'archive') {
        if (
          this.restoreArchived(move.tabId, { select: false, to: move.from, index: move.index }) !==
          null
        ) {
          undone += 1;
        }
        continue;
      }
      const record = this.#records.get(move.tabId);
      if (record?.state.placement === 'shelf') {
        this.restoreToStrip(move.tabId, { select: false, index: move.index });
        undone += 1;
      }
    }
    return undone;
  }

  /**
   * Discards a tab's page to free its renderer (assessment §4.9): LIVE or FROZEN → UNLOADED. The
   * tab keeps its back/forward stack, with Chromium's page state in memory for this run, and
   * selecting it restores the page. Runs on the tab's serial queue and never rejects:
   *   1. re-validate (not selected, not loading, unprotected, the decision's epoch);
   *   2. thaw a frozen page, since unload handlers need it running;
   *   3. wake the renderer (a no-op, within PING_TIMEOUT_MS), then probe for unsaved input and
   *      flush the page state, within PROBE_TIMEOUT_MS; no answer to either means "keep the tab";
   *   4. snapshot the navigation entries, then re-validate once more;
   *   5. close: with `beforeunload` only for a page the user activated, where an objection keeps
   *      the tab and teaches it a protection; a plain close otherwise (S3);
   *   6. once the web contents is gone, the tab is unloaded and the session persists its stack
   *      without page state.
   */
  discard(tabId: TabId, request: DiscardRequest): Promise<DiscardOutcome> {
    const record = this.#records.get(tabId);
    if (record === undefined) {
      return Promise.resolve(skipped('closed'));
    }
    return record.queue.run(() => this.#runDiscard(record, request));
  }

  /**
   * Freezes a hidden live tab (experimental, off by default; assessment §4.3): its page stops
   * running but keeps its memory. Selecting the tab, or discarding it, thaws it first.
   */
  freeze(tabId: TabId): Promise<FreezeOutcome> {
    const record = this.#records.get(tabId);
    if (record === undefined) {
      return Promise.resolve({ outcome: 'skipped', why: 'closed' });
    }
    return record.queue.run(() => this.#runFreeze(record));
  }

  async #runDiscard(record: TabRecord, request: DiscardRequest): Promise<DiscardOutcome> {
    const tabId = record.state.id;
    if (this.#records.get(tabId) !== record) {
      return skipped('closed');
    }
    const refusal =
      this.#refusal(record, request.epoch) ??
      this.#protected(record, 'discard', request, request.origin !== 'user');
    if (refusal !== null) {
      return refusal;
    }
    const runtime = record.runtime;
    if (runtime === undefined) {
      return skipped('not-live');
    }
    const progress: DiscardProgress = { closing: false, revive: false, deferred: [], result: null };
    record.discard = progress;
    if (record.state.runtime === 'frozen') {
      runtime.thaw(); // Unload handlers need a running page.
    }
    this.#transition(record, 'discard');
    const epoch = record.epoch;
    this.#changed();

    // 3. Wake the renderer: a just-hidden tab's first script call can take seconds to be
    // scheduled on a loaded machine, and the probe's budget is for the page, not for that.
    const awake = await withDeadline(
      Promise.resolve().then(() => runtime.ping()),
      PING_TIMEOUT_MS,
      this.#timers,
    );
    const asleep = this.#interrupted(record, progress, epoch);
    if (asleep !== null) {
      return asleep;
    }
    if (awake.kind !== 'value') {
      return this.#discardKept(record, progress, blocked('probe-unanswered'));
    }
    // Probe and flush. A probe that throws at once counts as one that never answered.
    const answer = await withDeadline(
      Promise.resolve().then(() => runtime.probe()),
      PROBE_TIMEOUT_MS,
      this.#timers,
    );
    const interrupted = this.#interrupted(record, progress, epoch);
    if (interrupted !== null) {
      return interrupted;
    }
    const verdict = judgeProbe(answer.kind === 'value' ? parseProbeReading(answer.value) : null, {
      overrideSoft: request.overrideSoft ?? false,
    });
    if (verdict.kind === 'keep') {
      if (verdict.reason !== 'probe-unanswered') {
        this.#learn(record, verdict.reason);
      }
      return this.#discardKept(record, progress, blocked(verdict.reason));
    }

    // 4. Snapshot, then the last checks before the irreversible step.
    const snapshot = readSnapshot(runtime);
    const lastCheck =
      this.#refusal(record, undefined, { discarding: true }) ??
      this.#protected(record, 'discard', request, false);
    if (lastCheck !== null) {
      return this.#discardKept(record, progress, lastCheck);
    }
    if (snapshot === null) {
      return this.#discardKept(record, progress, skipped('no-history'));
    }

    // 5. Close. From here the page decides.
    progress.closing = true;
    const closing = Promise.resolve().then(() => runtime.closeForDiscard(verdict.mode));
    const closed = await withDeadline(closing, CLOSE_TIMEOUT_MS, this.#timers);
    if (progress.result !== null) {
      return progress.result;
    }
    if (this.#records.get(tabId) !== record || record.discard !== progress) {
      return skipped('closed');
    }
    if (closed.kind === 'value' && closed.value === 'closed') {
      // 6. The web contents is gone.
      this.#completeDiscard(record, progress, snapshot);
      return DISCARDED;
    }
    // The page objected, or didn't close in time: it lives on, and is protected (S3).
    this.#learn(record, 'page-unsaved-changes');
    if (closed.kind === 'timedOut') {
      record.lateCloseSnapshot = snapshot;
    }
    return this.#discardKept(record, progress, blocked('page-unsaved-changes'));
  }

  async #runArchive(record: TabRecord, request: MoveRequest): Promise<MoveOutcome> {
    const tabId = record.state.id;
    if (this.#records.get(tabId) !== record) {
      return skippedMove('closed');
    }
    if (record.state.ephemeral) {
      return skippedMove('wrong-placement'); // I6: never stored, so never archived.
    }
    if (request.origin === 'automation') {
      if (record.state.pinned) {
        return skippedMove('pinned');
      }
      const refusal = this.#automationRefusal(record, request, 'archive');
      if (refusal !== null) {
        return refusal;
      }
    }
    if (record.state.loading) {
      return skippedMove('loading');
    }
    // The user's own archive of the tab in use: the one next to it is selected first.
    this.#leaveSelection(record);
    // I3: no web contents in the Archive. A live page is discarded first; a dead one let go.
    if (record.runtime !== undefined) {
      if (record.state.runtime === 'live' || record.state.runtime === 'frozen') {
        const discarded = await this.#runDiscard(record, {
          origin: request.origin === 'user' ? 'user' : 'automation',
        });
        if (discarded.outcome !== 'discarded') {
          return discarded;
        }
      } else if (record.state.runtime === 'crashed') {
        const runtime = record.runtime;
        record.runtime = undefined;
        record.runtimeToken = undefined;
        runtime.destroy();
        this.#transition(record, 'gone');
      } else {
        return skippedMove('not-live');
      }
    }
    if (this.#records.get(tabId) !== record) {
      return skippedMove('closed');
    }
    if (record.runtime !== undefined || this.#selected === tabId) {
      return skippedMove('cancelled'); // Picked again while its page was closing.
    }
    const from = record.state.placement;
    const list = from === 'strip' ? this.#order : this.#shelf;
    const index = list.indexOf(tabId);
    list.splice(index, 1);
    this.#records.delete(tabId);
    // §4.9 Archive: the stack is kept, in-memory page state is not.
    record.memorySnapshot = null;
    this.#archived.push({
      ...this.#sessionTab(record),
      pinned: false,
      archivedAt: this.#clock().wallNow,
      reason: request.origin === 'user' ? 'manual' : 'auto',
      favicon: record.state.favicon,
    });
    if (this.#archived.length > MAX_ARCHIVED_IN_MEMORY) {
      this.#archived.shift();
      this.#archivedElsewhere += 1; // Still archived, in the database only.
    }
    this.#options.onPageGone?.(tabId);
    this.#options.history?.closed(tabId);
    this.#ensureStripNotEmpty();
    this.#changed();
    return { outcome: 'moved', move: { tabId, from, to: 'archive', index } };
  }

  /** Why automation may not move this tab now (I5), or null. */
  #automationRefusal(
    record: TabRecord,
    request: MoveRequest,
    action: 'shelve' | 'archive',
  ): MoveOutcome | null {
    if (this.#selected === record.state.id) {
      return skippedMove('selected');
    }
    if (request.epoch !== undefined && request.epoch !== record.epoch) {
      return skippedMove('stale');
    }
    if (record.queue.running > 0 && action === 'shelve') {
      return skippedMove('cancelled');
    }
    const protection = blockingProtection(this.#protectionsOf(record), action);
    return protection === null ? null : { outcome: 'blocked', reason: protection.reason };
  }

  /** The protections of a tab: the monitor's, the user's, and what discards learned. */
  #protectionsOf(record: TabRecord): Protection[] {
    return [
      ...(this.#options.protections?.(record.state.id) ?? []),
      ...(record.state.userProtected ? [protectionFor('user-protected')] : []),
      ...this.#freshLearned(record),
    ];
  }

  /** If this tab is selected, selects the strip tab next to it (or a new tab if it is the last). */
  #leaveSelection(record: TabRecord): void {
    if (this.#selected !== record.state.id) {
      return;
    }
    const index = this.#order.indexOf(record.state.id);
    const others = this.#order.filter((id) => id !== record.state.id);
    const next = others[Math.min(index, others.length - 1)];
    if (next === undefined) {
      this.create(); // Selects the new tab.
    } else {
      this.#setSelected(next, true);
    }
  }

  /** The strip always has a tab once a session exists (I1): a new one if it emptied. */
  #ensureStripNotEmpty(): void {
    if (this.#order.length === 0) {
      this.#selected = null;
      this.create();
    }
  }

  /**
   * Where a tab joins the strip: at `index` (clamped to its section), else right after the
   * selected tab within its section, else at the end of its section.
   */
  #stripSlot(pinned: boolean, index: number | undefined): number {
    const pinnedCount = this.#pinnedCount();
    const [first, last] = pinned ? [0, pinnedCount] : [pinnedCount, this.#order.length];
    if (index !== undefined) {
      return Math.min(Math.max(Math.trunc(index), first), last);
    }
    const selected = this.#selected === null ? -1 : this.#order.indexOf(this.#selected);
    return selected >= first && selected < last ? selected + 1 : last;
  }

  async #runFreeze(record: TabRecord): Promise<FreezeOutcome> {
    const tabId = record.state.id;
    if (this.#records.get(tabId) !== record) {
      return { outcome: 'skipped', why: 'closed' };
    }
    if (record.state.runtime !== 'live') {
      return { outcome: 'skipped', why: 'not-live' };
    }
    const refusal =
      this.#refusal(record, undefined) ??
      this.#protected(record, 'freeze', { origin: 'automation' }, true);
    if (refusal !== null) {
      return refusal.outcome === 'blocked'
        ? { outcome: 'blocked', reason: refusal.reason }
        : { outcome: 'skipped', why: refusal.outcome === 'skipped' ? refusal.why : 'not-live' };
    }
    const runtime = record.runtime;
    if (runtime === undefined) {
      return { outcome: 'skipped', why: 'not-live' };
    }
    this.#transition(record, 'freeze');
    const epoch = record.epoch;
    this.#changed();
    const frozen = await withDeadline(
      Promise.resolve().then(() => runtime.freeze()),
      FREEZE_TIMEOUT_MS,
      this.#timers,
    );
    if (this.#records.get(tabId) !== record) {
      return { outcome: 'skipped', why: 'closed' };
    }
    if (record.epoch !== epoch) {
      return { outcome: 'skipped', why: 'cancelled' }; // Thawed, crashed or discarded meanwhile.
    }
    if (frozen.kind !== 'value') {
      this.#thaw(record);
      this.#changed();
      return { outcome: 'failed' };
    }
    return { outcome: 'frozen' };
  }

  /**
   * Why a lifecycle operation may not act on a tab now, or null. `epoch` is the decision's, if it
   * carries one (I5). While discarding, the tab is expected to be in the middle of it.
   */
  #refusal(
    record: TabRecord,
    epoch: number | undefined,
    options: { readonly discarding?: boolean } = {},
  ): DiscardOutcome | null {
    const { state } = record;
    if (this.#records.get(state.id) !== record) {
      return skipped('closed');
    }
    const expected = options.discarding === true ? ['discarding'] : ['live', 'frozen'];
    if (record.runtime === undefined || !expected.includes(state.runtime)) {
      return skipped('not-live');
    }
    if (state.page.kind !== 'web') {
      return skipped('not-web');
    }
    if (this.#selected === state.id) {
      return skipped('selected');
    }
    if (state.loading) {
      return skipped('loading');
    }
    if (epoch !== undefined && epoch !== record.epoch) {
      return skipped('stale');
    }
    return null;
  }

  /**
   * The protection that blocks `action` on this tab, as an outcome, or null: the monitor's, and
   * (for automation) what a discard learned recently. An explicit request asks the page again.
   */
  #protected(
    record: TabRecord,
    action: 'discard' | 'freeze',
    request: DiscardRequest,
    useLearned: boolean,
  ): DiscardOutcome | null {
    const protections: Protection[] = [
      ...(this.#options.protections?.(record.state.id) ?? []),
      ...(record.state.userProtected ? [protectionFor('user-protected')] : []),
    ];
    if (useLearned) {
      protections.push(...this.#freshLearned(record));
    }
    const protection = blockingProtection(protections, action, {
      overrideSoft: request.overrideSoft ?? false,
    });
    return protection === null ? null : blocked(protection.reason);
  }

  #freshLearned(record: TabRecord): Protection[] {
    // On the lifecycle's clock, like every other time automation compares (found by E2E).
    const now = this.#clock().wallNow;
    return [...record.learned]
      .filter(([, at]) => now - at < LEARNED_RECHECK_MS && now >= at)
      .sort(([, a], [, b]) => b - a)
      .map(([reason]) => protectionFor(reason));
  }

  #learn(record: TabRecord, reason: ProtectionReason): void {
    record.learned.set(reason, this.#clock().wallNow);
  }

  /**
   * After an await in a discard: the outcome if the discard can't go on — the renderer died or
   * the web contents went (it ended as a discard), the tab closed, or the user picked it.
   */
  #interrupted(record: TabRecord, progress: DiscardProgress, epoch: number): DiscardOutcome | null {
    if (progress.result !== null) {
      return progress.result;
    }
    if (this.#records.get(record.state.id) !== record) {
      return skipped('closed');
    }
    if (record.discard !== progress || record.epoch !== epoch) {
      return skipped('cancelled');
    }
    return null;
  }

  /** The discard stops and the page lives on. */
  #discardKept(
    record: TabRecord,
    progress: DiscardProgress,
    outcome: DiscardOutcome,
  ): DiscardOutcome {
    record.discard = null;
    progress.result = outcome;
    // A tab selected while it was closing is creating; it is live again now.
    this.#transition(record, progress.revive ? 'ready' : 'discardBlocked');
    if (progress.revive) {
      record.state = { ...record.state, loading: false };
    }
    this.#syncVisibility();
    this.#changed();
    this.#runDeferred(progress);
    return outcome;
  }

  /**
   * Ends a discard whose web contents is gone (closed, or its renderer died): the tab keeps the
   * snapshot and is unloaded — or, if it was selected while closing, restores right away.
   */
  #completeDiscard(
    record: TabRecord,
    progress: DiscardProgress,
    snapshot: NavigationSnapshot | null,
  ): void {
    const tabId = record.state.id;
    record.discard = null;
    progress.result = DISCARDED;
    const runtime = record.runtime;
    record.runtime = undefined;
    record.runtimeToken = undefined;
    runtime?.destroy();
    record.memorySnapshot = snapshot;
    record.pendingHistory =
      snapshot === null
        ? (sanitizeHistory(record.lastHistory) ??
          singleEntryHistory(record.state.url, record.state.title))
        : withoutPageState(snapshot);
    record.lastHistory = null;
    record.findRequestId = undefined;
    record.restoringHidden = false;
    this.#options.onPageGone?.(tabId);
    record.state = {
      ...record.state,
      loading: false,
      find: null,
      canGoBack: false,
      canGoForward: false,
    };
    if (progress.revive) {
      // Still creating: a new web contents takes over from the one that closed.
      this.#startRestore(record, 'load');
    } else {
      this.#transition(record, 'discarded');
    }
    this.#syncVisibility();
    this.#changed();
    this.#runDeferred(progress);
  }

  #runDeferred(progress: DiscardProgress): void {
    for (const action of progress.deferred.splice(0)) {
      action();
    }
  }

  /**
   * Readies a tab's runtime for something done to its page. A discard yields: before its close it
   * simply stops; during its close, `action` waits until the close settles (false is returned).
   * A frozen page is thawed.
   */
  #readyForUse(record: TabRecord, action: () => void): boolean {
    const progress = record.discard;
    if (progress !== null) {
      if (progress.closing) {
        const tabId = record.state.id;
        progress.deferred.push(() => {
          if (this.#records.get(tabId) === record) {
            action();
          }
        });
        return false;
      }
      this.#stopDiscard(record, progress);
    }
    if (record.state.runtime === 'frozen') {
      this.#thaw(record);
    }
    return true;
  }

  /** A discard that hasn't closed anything yet stops; its operation sees that and returns. */
  #stopDiscard(record: TabRecord, progress: DiscardProgress): void {
    record.discard = null;
    progress.result = skipped('cancelled');
    this.#transition(record, 'discardBlocked');
    this.#runDeferred(progress);
  }

  /**
   * I2: the selected tab is creating, live or crashed. A frozen page thaws; a discard stops, or,
   * if its close was sent, the tab comes back once it settles; an unloaded tab restores.
   */
  #wake(record: TabRecord): void {
    switch (record.state.runtime) {
      case 'frozen':
        this.#thaw(record);
        break;
      case 'discarding': {
        const progress = record.discard;
        if (progress === null) {
          throw new Error(`Tab ${record.state.id} is discarding with no discard under way.`);
        }
        if (!progress.closing) {
          this.#stopDiscard(record, progress);
        } else if (!progress.revive) {
          progress.revive = true;
          this.#transition(record, 'revive');
          record.state = { ...record.state, loading: true };
        }
        break;
      }
      case 'unloaded':
        this.#ensureLive(record);
        break;
      default:
        break;
    }
  }

  #thaw(record: TabRecord): void {
    record.runtime?.thaw();
    this.#transition(record, 'thaw');
  }

  /** Applies a runtime transition (core/lifecycle/runtime-machine.ts) and bumps the epoch. */
  #transition(record: TabRecord, event: RuntimeEvent): void {
    const from = record.state.runtime;
    const to = nextRuntime(from, event);
    record.epoch += 1;
    if (to !== from) {
      record.state = { ...record.state, runtime: to };
    }
    this.#options.onTransition?.({ tabId: record.state.id, from, to, event, epoch: record.epoch });
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  /** A record for a tab that has no runtime: a new-tab page, or an unloaded restored page. */
  #newRecord(tab: {
    readonly id: TabId;
    readonly pinned: boolean;
    readonly ephemeral: boolean;
    readonly createdAt: number;
    readonly lastUsedAt: number;
    readonly lastUsedEngaged?: number;
    readonly lastUsedActiveDay?: number;
    readonly url?: string;
    readonly title?: string;
    readonly history?: TabHistory | null;
    readonly userProtected?: boolean;
    readonly placement?: 'strip' | 'shelf';
    readonly placementChangedAt?: number;
  }): TabRecord {
    const web = tab.url !== undefined && tab.url !== '';
    const clock = this.#clock();
    return {
      state: {
        id: tab.id,
        pinned: tab.pinned,
        placement: tab.placement ?? 'strip',
        userProtected: tab.userProtected ?? false,
        ephemeral: tab.ephemeral,
        runtime: 'unloaded',
        page: web ? { kind: 'web' } : NEW_TAB_PAGE,
        url: web ? (tab.url ?? '') : '',
        credentialsRemoved: false,
        title: web ? (tab.title ?? '') : '',
        favicon: null,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        zoomPercent: 100,
        find: null,
      },
      runtime: undefined,
      runtimeToken: undefined,
      epoch: 0,
      queue: new SerialQueue(),
      discard: null,
      memorySnapshot: null,
      lateCloseSnapshot: null,
      lastHistory: null,
      learned: new Map(),
      heldUnloaded: false,
      restoringHidden: false,
      focusOnCommit: false,
      credentialsRemovedOnCommit: false,
      findRequestId: undefined,
      lastFindText: '',
      pendingHistory: web ? (tab.history ?? null) : null,
      nextTransition: null,
      createdAt: tab.createdAt,
      lastUsedAt: tab.lastUsedAt,
      // A stored value from the future (another clock, a damaged file) or none at all counts as
      // now: an upgraded profile must never look unused since the beginning of time.
      lastUsedEngaged: Math.min(tab.lastUsedEngaged ?? clock.engagedNow, clock.engagedNow),
      lastUsedActiveDay:
        tab.lastUsedActiveDay !== undefined && tab.lastUsedActiveDay >= 1
          ? Math.min(tab.lastUsedActiveDay, clock.activeDay)
          : clock.activeDay,
      hiddenSince: clock.wallNow,
      lastInteractionAt: null,
      activated: false,
      userClosing: false,
      askingToLeave: false,
      placementChangedAt: tab.placementChangedAt ?? tab.createdAt,
    };
  }

  /** The wall clock with the engagement clock (§4.6). */
  #clock(): LifecycleClock {
    return this.#options.activityClock?.() ?? { wallNow: this.#now(), engagedNow: 0, activeDay: 1 };
  }

  /** The tab is in use now: its last use is now, by every clock. */
  #stampUse(record: TabRecord): void {
    const clock = this.#clock();
    record.lastUsedAt = clock.wallNow;
    record.lastUsedEngaged = clock.engagedNow;
    record.lastUsedActiveDay = clock.activeDay;
  }

  /** A new runtime for a tab that has none. */
  #attachRuntime(record: TabRecord): TabRuntime {
    const tabId = record.state.id;
    const token = Symbol(tabId);
    record.runtimeToken = token;
    const runtime = this.#options.createRuntime(tabId, this.#eventsFor(tabId, token));
    record.runtime = runtime;
    return runtime;
  }

  /**
   * Brings an unloaded web tab to life: a new runtime, attached, then `restore()` with its stack
   * (S2: a brand-new web contents, attached before restoring). A tab with only an address
   * restores a one-entry stack; one whose address can't be restored becomes a new-tab page.
   */
  #ensureLive(record: TabRecord): void {
    if (record.runtime !== undefined || record.state.page.kind !== 'web') {
      return;
    }
    this.#startRestore(record, 'ensureLive');
  }

  #startRestore(record: TabRecord, event: 'ensureLive' | 'load'): void {
    const tabId = record.state.id;
    record.heldUnloaded = false;
    const history =
      record.pendingHistory ?? singleEntryHistory(record.state.url, record.state.title);
    // Kept until the first commit: a flush before then must not replace the saved stack.
    record.pendingHistory = history;
    // The discard's page state, if it belongs to this very stack. Used once.
    const memory = record.memorySnapshot;
    record.memorySnapshot = null;
    if (history === null) {
      this.showInternal(tabId, 'new-tab');
      return;
    }
    const restoring = memory !== null && sameStack(memory, history) ? memory : history;
    const runtime = this.#attachRuntime(record);
    this.#transition(record, event);
    record.state = { ...record.state, loading: true };
    record.nextTransition = 'restore';
    // Attached before restoring (S2): shown if selected, else invisibly until it has loaded.
    record.restoringHidden = this.#selected !== tabId;
    this.#syncVisibility();
    runtime.restore(restoring);
  }

  /** What the session stores for a tab: a live tab's current stack, else its pending one. */
  #sessionTab(record: TabRecord): SessionTab {
    const { state } = record;
    if (state.ephemeral) {
      throw new Error('I6: an ephemeral tab must never reach persistence.');
    }
    // As stamped when it was last selected or left: reading "now" for the selected tab would
    // rewrite its row on every flush.
    const base = {
      id: state.id,
      pinned: state.pinned,
      createdAt: record.createdAt,
      lastUsedAt: record.lastUsedAt,
      lastUsedEngaged: record.lastUsedEngaged,
      lastUsedActiveDay: record.lastUsedActiveDay,
      userProtected: state.userProtected,
      placementChangedAt: record.placementChangedAt,
    };
    if (state.url === '') {
      return { ...base, url: SESSION_NEW_TAB_URL, title: '', history: null };
    }
    const live = record.runtime === undefined ? null : sanitizeHistory(record.runtime.history());
    return {
      ...base,
      url: state.url,
      title: state.title,
      history: live ?? record.pendingHistory ?? singleEntryHistory(state.url, state.title),
    };
  }

  #record(tabId: TabId): TabRecord {
    const record = this.#records.get(tabId);
    if (record === undefined) {
      throw new TabNotFoundError(tabId);
    }
    return record;
  }

  #pinnedCount(): number {
    let count = 0;
    for (const id of this.#order) {
      if (this.#record(id).state.pinned) {
        count += 1;
      }
    }
    return count;
  }

  #setSelected(tabId: TabId, focus: boolean): void {
    // Only the selected tab can be fullscreen: switching away leaves it, as in Chrome.
    if (this.#fullscreen !== null && this.#fullscreen !== tabId) {
      this.exitFullscreen();
    }
    const previous = this.#selected === null ? undefined : this.#records.get(this.#selected);
    if (previous !== undefined && previous.state.id !== tabId) {
      // In use until now; hidden from now on.
      this.#stampUse(previous);
      previous.hiddenSince = this.#clock().wallNow;
    }
    this.#selected = tabId;
    const record = this.#record(tabId);
    this.#stampUse(record);
    record.hiddenSince = null;
    // I2: an unloaded tab (restored at startup, reopened, discarded) is restored when selected; a
    // frozen one thaws; a discard under way gives way.
    this.#wake(record);
    this.#syncVisibility();
    if (focus && record.state.page.kind === 'web') {
      if (record.discard?.closing === true) {
        // Its web contents is closing: the one that replaces it gets focus when it commits.
        record.focusOnCommit = true;
      } else {
        record.runtime?.focus();
      }
    }
  }

  #setFullscreen(tabId: TabId | null): void {
    if (this.#fullscreen === tabId) {
      return;
    }
    this.#fullscreen = tabId;
    this.#options.onFullscreenChange?.(tabId);
    this.#changed();
  }

  /** Chromium keeps zoom per host, so one tab's change can reach others: read each tab's again. */
  #refreshZoom(): void {
    let changed = false;
    for (const record of this.#records.values()) {
      if (record.runtime === undefined) {
        continue;
      }
      const percent = zoomPercent(record.runtime.zoomFactor());
      if (percent !== record.state.zoomPercent) {
        record.state = { ...record.state, zoomPercent: percent };
        changed = true;
      }
    }
    if (changed) {
      this.#changed();
    }
  }

  /**
   * Only the selected tab's runtime is shown, and only for web content. A web contents being
   * closed for a discard is never shown; one being restored in the background stays attached,
   * invisibly, until its page has loaded (S2).
   */
  #syncVisibility(): void {
    for (const [id, record] of this.#records) {
      if (record.runtime === undefined) {
        continue;
      }
      const visible =
        id === this.#selected &&
        record.state.page.kind === 'web' &&
        record.state.runtime !== 'crashed' &&
        record.discard?.closing !== true;
      if (visible) {
        record.restoringHidden = false;
        record.runtime.show();
      } else if (record.restoringHidden) {
        record.runtime.showHidden();
      } else {
        record.runtime.hide();
      }
    }
  }

  #changed(): void {
    this.#options.onChange();
  }

  /** Events from a runtime. Once its tab is closed (or its runtime replaced), they're ignored. */
  #eventsFor(tabId: TabId, token: symbol): TabRuntimeEvents {
    const current = (): TabRecord | undefined => {
      const record = this.#records.get(tabId);
      return record?.runtime !== undefined && record.runtimeToken === token ? record : undefined;
    };
    const update = (patch: Partial<TabState>, options: { visibility?: boolean } = {}): void => {
      const record = current();
      if (record === undefined) {
        return;
      }
      record.state = { ...record.state, ...patch };
      if (options.visibility === true) {
        this.#syncVisibility();
      }
      this.#changed();
    };
    /** The flag `navigate` set for this load. It applies once: to this commit or failure. */
    const takeCredentialsRemoved = (record: TabRecord): boolean => {
      const removed = record.credentialsRemovedOnCommit;
      record.credentialsRemovedOnCommit = false;
      return removed;
    };
    /** The page shows something now: a restore or load that was under way is done. */
    const pageReady = (record: TabRecord): void => {
      if (record.state.runtime === 'creating') {
        this.#transition(record, 'ready');
      } else if (record.state.runtime === 'frozen') {
        this.#thaw(record);
      }
    };
    /** A background restore's page has loaded (or failed): it can be detached now. */
    const restored = (record: TabRecord): void => {
      if (record.restoringHidden) {
        record.restoringHidden = false;
        this.#syncVisibility();
      }
    };
    const memory = this.#options.history;
    const remember = (record: TabRecord): TabHistoryObserver | undefined =>
      record.state.ephemeral ? undefined : memory;

    return {
      committed: ({ url, sameDocument, canGoBack, canGoForward }) => {
        const record = current();
        if (record === undefined) {
          return;
        }
        // The runtime has a stack of its own now.
        record.pendingHistory = null;
        record.memorySnapshot = null;
        record.lastHistory = record.runtime?.history() ?? null;
        const transition = record.nextTransition ?? 'link';
        record.nextTransition = null;
        const leavingInternalPage = record.state.page.kind !== 'web';
        if (!sameDocument) {
          // A new document: what a discard learned about the old one no longer applies, and the
          // page hasn't been activated yet.
          record.learned.clear();
          record.activated = false;
          record.lateCloseSnapshot = null;
          // A new document closes the find bar, as in Chrome; Ctrl+F reopens it with the same
          // text, searched on the new page. Stopping also resets Chromium's find state, which
          // otherwise carried over: the first search on a new page with 2 matches reported
          // 2 of 2 (found by E2E).
          record.findRequestId = undefined;
          if (record.state.find !== null) {
            record.runtime?.stopFind('clearSelection');
          }
          this.#options.onPageGone?.(tabId);
        }
        pageReady(record);
        update(
          sameDocument
            ? { url, canGoBack, canGoForward }
            : // A new document: the old site's favicon no longer applies.
              {
                url,
                credentialsRemoved: takeCredentialsRemoved(record),
                canGoBack,
                canGoForward,
                page: { kind: 'web' },
                favicon: null,
                find: null,
              },
          { visibility: !sameDocument && leavingInternalPage },
        );
        if (!sameDocument) {
          // A new host may have its own zoom level.
          this.#refreshZoom();
        }
        if (record.focusOnCommit && this.#selected === tabId && record.state.page.kind === 'web') {
          record.focusOnCommit = false;
          record.runtime?.focus();
        }
        remember(record)?.committed(tabId, { url, sameDocument, transition });
      },
      titleChanged: (title) => {
        const record = current();
        update({ title: sanitizeTitle(title) });
        if (record?.state.page.kind === 'web') {
          remember(record)?.titleChanged(tabId, record.state.title);
        }
      },
      faviconChanged: (favicon) => {
        const record = current();
        update({ favicon });
        if (favicon !== null && record?.state.page.kind === 'web') {
          remember(record)?.faviconChanged(tabId, favicon);
        }
      },
      loadingChanged: (loading) => {
        const record = current();
        if (!loading && record !== undefined) {
          // A load that ends without a commit (it became a download, or was stopped) leaves no
          // transition behind for the next commit, which would be a link (found by E2E).
          record.nextTransition = null;
        }
        update({ loading });
        if (!loading && record !== undefined) {
          restored(record);
        }
      },
      loadFailed: ({ code, name, url, canGoBack, canGoForward }) => {
        const record = current();
        if (record === undefined) {
          return;
        }
        record.findRequestId = undefined;
        record.nextTransition = null;
        record.lastHistory = record.runtime?.history() ?? null;
        if (this.#fullscreen === tabId) {
          this.#setFullscreen(null);
        }
        this.#options.onPageGone?.(tabId);
        pageReady(record);
        update(
          {
            // A certificate or client-certificate failure gets its own page, with no way past it.
            page: { kind: 'internal', name: errorPageFor(code), error: { code, name } },
            url,
            credentialsRemoved: takeCredentialsRemoved(record),
            // The previous page's title and icon belong to a page that is no longer shown.
            title: '',
            favicon: null,
            loading: false,
            find: null,
            ...(canGoBack === undefined ? {} : { canGoBack }),
            ...(canGoForward === undefined ? {} : { canGoForward }),
          },
          { visibility: true },
        );
        restored(record);
      },
      crashed: ({ code, name }) => {
        const record = current();
        if (record === undefined) {
          return;
        }
        if (record.discard !== null) {
          // §4.11: a renderer that dies mid-discard counts as discarded, with the entries
          // Chromium still has (the browser side keeps them), else the last ones reported.
          const snapshot = record.runtime === undefined ? null : readSnapshot(record.runtime);
          this.#completeDiscard(record, record.discard, snapshot);
          return;
        }
        record.findRequestId = undefined;
        record.restoringHidden = false;
        if (this.#fullscreen === tabId) {
          this.#setFullscreen(null);
        }
        this.#options.onPageGone?.(tabId);
        if (record.state.runtime === 'frozen') {
          // The freeze belonged to the dead page: release it, so the next page isn't frozen
          // (found by the model-based tests).
          record.runtime?.thaw();
        }
        if (record.state.runtime !== 'crashed') {
          this.#transition(record, 'rendererGone');
        }
        update(
          {
            page: { kind: 'internal', name: 'crashed', error: { code, name } },
            loading: false,
            find: null,
          },
          { visibility: true },
        );
      },
      foundInPage: ({ requestId, activeMatch, matches }) => {
        const record = current();
        const find = record?.state.find;
        // Results of an older request (the text has changed since) are stale.
        if (record === undefined || find == null || requestId !== record.findRequestId) {
          return;
        }
        update({ find: { text: find.text, activeMatch, matches } });
      },
      zoomRequested: (direction) => {
        if (current() !== undefined) {
          this.zoom(tabId, direction);
        }
      },
      fullscreenChanged: (fullscreen) => {
        const record = current();
        if (record === undefined) {
          return;
        }
        if (!fullscreen) {
          if (this.#fullscreen === tabId) {
            this.#setFullscreen(null);
          }
          return;
        }
        // Fullscreen needs a user gesture, which only the selected tab can get; refuse it anyway.
        if (this.#selected !== tabId) {
          record.runtime?.exitFullscreen();
          return;
        }
        this.#setFullscreen(tabId);
      },
      restoreFailed: () => {
        const record = current();
        if (record === undefined) {
          return;
        }
        // S2: the web contents is unusable for another restore. A new one loads the address
        // alone; the stack is lost, the page is not.
        record.runtime?.destroy();
        record.runtime = undefined;
        record.runtimeToken = undefined;
        record.restoringHidden = false;
        if (record.state.runtime === 'creating') {
          this.#transition(record, 'creationFailed');
        }
        this.navigate(tabId, record.state.url, {
          focus: this.#selected === tabId,
          transition: 'restore',
        });
      },
      gone: () => {
        const record = current();
        if (record === undefined || record.userClosing) {
          return; // A user close that went through: requestClose finishes it.
        }
        const progress = record.discard;
        if (progress !== null) {
          if (!progress.closing) {
            // Gone mid-probe: it ends as a discard, with the last stack reported.
            this.#completeDiscard(record, progress, null);
          }
          // A discard's own close: the discard sees the result and finishes it.
          return;
        }
        // A close that finished after the discard stopped waiting, or something else closed it:
        // the tab keeps what is known of its stack and is unloaded, like a discarded tab.
        record.runtime = undefined;
        record.runtimeToken = undefined;
        record.restoringHidden = false;
        record.memorySnapshot = record.lateCloseSnapshot;
        record.lateCloseSnapshot = null;
        record.pendingHistory =
          record.memorySnapshot === null
            ? (sanitizeHistory(record.lastHistory) ??
              record.pendingHistory ??
              singleEntryHistory(record.state.url, record.state.title))
            : withoutPageState(record.memorySnapshot);
        record.lastHistory = null;
        record.findRequestId = undefined;
        if (this.#fullscreen === tabId) {
          this.#setFullscreen(null);
        }
        this.#options.onPageGone?.(tabId);
        // A tab showing an internal page (an error page) goes back to a plain web page.
        this.#transition(record, 'gone');
        record.state = {
          ...record.state,
          page: record.state.url === '' ? NEW_TAB_PAGE : { kind: 'web' },
          loading: false,
          find: null,
          canGoBack: false,
          canGoForward: false,
        };
        if (this.#selected === tabId) {
          this.#ensureLive(record); // I2.
        }
        this.#syncVisibility();
        this.#changed();
      },
      thawed: () => {
        const record = current();
        if (record?.state.runtime === 'frozen') {
          this.#transition(record, 'thaw');
          this.#changed();
        }
      },
      interacted: () => {
        const record = current();
        if (record !== undefined) {
          // A stamp only: no change any view shows.
          record.lastInteractionAt = this.#clock().wallNow;
        }
      },
      activated: () => {
        const record = current();
        if (record !== undefined) {
          record.activated = true;
        }
      },
    };
  }
}

/** A runtime's navigation entries, checked; null if it has none or can't tell. */
function readSnapshot(runtime: TabRuntime): NavigationSnapshot | null {
  try {
    return restorableSnapshot(runtime.snapshot());
  } catch {
    return null;
  }
}

/**
 * A saved tab's address and title, checked like any input: the database file is not trusted.
 * An address a tab may not load falls back to its stack's active entry (itself checked), else
 * the tab is a new-tab page (address '', no title, no stack).
 */
function checkedSessionTab<T extends SessionTab>(tab: T): T {
  const history = tab.history === null ? null : sanitizeHistory(tab.history);
  const url =
    tab.url === SESSION_NEW_TAB_URL
      ? null
      : (restorableUrl(tab.url) ?? history?.entries[history.index]?.url ?? null);
  return url === null
    ? { ...tab, url: '', title: '', history: null }
    : { ...tab, url, title: sanitizeTitle(tab.title), history };
}

export class TabNotFoundError extends Error {
  constructor(tabId: TabId) {
    super(`No tab ${tabId}`);
    this.name = 'TabNotFoundError';
  }
}
