// TabManager (ADR-0005 §1, assessment §3.2): the only writer of tab state. The shell sends intents;
// this class decides. It has no Electron imports: each tab's web contents sits behind the
// TabRuntime port (./tab-runtime.ts in the app, fakes in tests).
//
// Invariants, checked by the unit tests after every operation:
//   1. Order is pinned tabs first, then the rest; ids are unique.
//   2. A non-empty strip has exactly one selected tab; an empty strip has none.
//   3. At most one runtime is shown: the selected tab's, and only while it shows web content.
//   4. A closed tab's runtime is destroyed; nothing refers to it afterwards (ADR-0002 §2).
//
// The tab model is shaped for ADR-0003: placement is always 'strip' until Phase 3, and runtime
// is a subset of its states (unloaded, creating, live, crashed).
//
// M1.3b adds what the browser does to a page: find in page, zoom, HTML fullscreen (at most one
// tab, always the selected one), DevTools, and reopening closed tabs.
//
// M2.2a adds the session (ADR-0003 items 6 and 8, spike S2). A restored tab starts unloaded, with
// its sanitized back/forward stack, and is restored into a brand-new runtime only when selected:
// at startup that is the selected tab alone. A closed tab keeps its stack for Ctrl+Shift+T, and
// the session store (src/main/session) persists both lists.
import { nextZoomFactor, zoomPercent } from '../../core/layout/zoom';
import { restorableUrl, sanitizeHistory, singleEntryHistory } from '../../core/session/history';
import type { TabHistory } from '../../core/session/history';
import { errorPageFor } from '../../core/net/error-pages';
import type { ZoomDirection } from '../../core/layout/zoom';
import type { VisitTransition } from '../../core/search/frecency';
import type { InternalPage } from '../../core/url/internal-pages';

export type TabId = string;

export type TabRuntimeState = 'unloaded' | 'creating' | 'live' | 'crashed';

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
  readonly placement: 'strip';
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
  /** Detaches the view. Idempotent. */
  hide(): void;
  /** Gives the page keyboard focus. */
  focus(): void;
  /** Detaches and closes the web contents. The runtime is unusable afterwards. */
  destroy(): void;
  /**
   * Rebuilds a back/forward stack in this runtime, which must never have loaded anything (S2).
   * TabManager attaches the view first. A failure to create it arrives as `restoreFailed`; a
   * page that fails to load arrives as `loadFailed`, with the stack intact.
   */
  restore(history: TabHistory): void;
  /** The current back/forward stack (URLs and titles), unsanitized; null before any load. */
  history(): TabHistory | null;
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
  /** A main-frame navigation committed. `sameDocument` for fragment and history-API changes. */
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
}

export type TabRuntimeFactory = (tabId: TabId, events: TabRuntimeEvents) => TabRuntime;

export interface TabManagerOptions {
  readonly createRuntime: TabRuntimeFactory;
  readonly newId: () => TabId;
  /** Called after every change; the projector coalesces these into snapshots. */
  readonly onChange: () => void;
  /** Called when a tab enters HTML fullscreen (its id) or the window leaves it (null). */
  readonly onFullscreenChange?: (tabId: TabId | null) => void;
  /**
   * The page a tab showed is gone: a new document committed, it failed or crashed, an internal
   * page replaced it, or the tab closed. Its permission prompts and blocked popups no longer apply.
   */
  readonly onPageGone?: (tabId: TabId) => void;
  /** What the memory records (main/history/history-recorder.ts). Each is called after the change. */
  readonly history?: TabHistoryObserver;
  /** Wall-clock time, for the session's timestamps. */
  readonly now?: () => number;
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

/**
 * How many closed tabs Ctrl+Shift+T can bring back in a run. The database keeps every closed tab
 * for 7 days (ADR-0003 item 8); the session store loads the newest of them at startup.
 */
export const MAX_CLOSED_TABS = 100;

/** How a new-tab page is stored in the session: its typeable address (internal-pages.ts). */
export const SESSION_NEW_TAB_URL = 'veltriva://newtab';

/** A tab as the session stores it and restores it. */
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
}

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

interface TabRecord {
  state: TabState;
  runtime: TabRuntime | undefined;
  /** Identifies the current runtime, so events from a replaced one are ignored. */
  runtimeToken: symbol | undefined;
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
  lastUsedAt: number;
}

const NEW_TAB_PAGE: TabPage = { kind: 'internal', name: 'new-tab' };

export class TabManager {
  readonly #options: TabManagerOptions;
  readonly #order: TabId[] = [];
  readonly #records = new Map<TabId, TabRecord>();
  readonly #closed: ClosedTab[] = [];
  #selected: TabId | null = null;
  /** The tab in HTML fullscreen, if any. Only the selected tab can be. */
  #fullscreen: TabId | null = null;

  constructor(options: TabManagerOptions) {
    this.#options = options;
  }

  /** Every tab in strip order: pinned first. */
  tabs(): readonly TabState[] {
    return this.#order.map((id) => this.#record(id).state);
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

  /** Opens a new-tab page at the end of the strip (or right after `afterTabId`). */
  create(options: { readonly select?: boolean; readonly afterTabId?: TabId } = {}): TabId {
    const after = options.afterTabId === undefined ? undefined : this.#record(options.afterTabId);
    const id = this.#options.newId();
    const now = this.#now();
    this.#records.set(
      id,
      this.#newRecord({
        id,
        pinned: after?.state.pinned ?? false,
        createdAt: now,
        lastUsedAt: now,
      }),
    );
    if (after === undefined) {
      this.#order.push(id);
    } else {
      this.#order.splice(this.#order.indexOf(after.state.id) + 1, 0, id);
    }
    if (options.select !== false || this.#selected === null) {
      this.#setSelected(id, true);
    }
    this.#changed();
    return id;
  }

  /**
   * Closes a tab and destroys its runtime. Selection moves to the tab that took its place (the
   * next one), or the previous one at the end of the strip. Closing the last tab opens a new one:
   * the window always has something to show. `focus: false` keeps keyboard focus where it is
   * (the sidebar) instead of giving it to the newly selected page.
   */
  close(tabId: TabId, options: { readonly focus?: boolean } = {}): void {
    const record = this.#record(tabId);
    const index = this.#order.indexOf(tabId);
    if (record.state.url !== '') {
      // Its stack is read before the runtime goes (Recently closed keeps it for 7 days).
      this.#closed.push({ ...this.#sessionTab(record), closedAt: this.#now(), index });
      if (this.#closed.length > MAX_CLOSED_TABS) {
        this.#closed.shift();
      }
    }
    this.#order.splice(index, 1);
    this.#records.delete(tabId);
    if (this.#fullscreen === tabId) {
      this.#setFullscreen(null);
    }
    record.runtime?.destroy();
    record.runtime = undefined;
    this.#options.onPageGone?.(tabId);
    this.#options.history?.closed(tabId);

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
    this.#records.set(id, this.#newRecord({ ...closed, id, lastUsedAt: this.#now() }));
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

  /** Every tab in strip order, as the session stores it. */
  sessionTabs(): readonly SessionTab[] {
    return this.#order.map((id) => this.#sessionTab(this.#record(id)));
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
      this.#records.set(tab.id, this.#newRecord(checkedSessionTab(tab)));
      this.#order.push(tab.id);
    }
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
    if (session.loadSelected) {
      this.#ensureLive(selected);
    }
    this.#syncVisibility();
    this.#changed();
  }

  /** Closes every tab without opening a new one. For shutdown only. */
  closeAll(): void {
    for (const [tabId, record] of this.#records) {
      record.runtime?.destroy();
      record.runtime = undefined;
      this.#options.onPageGone?.(tabId);
    }
    this.#records.clear();
    this.#order.length = 0;
    this.#selected = null;
    this.#fullscreen = null;
    this.#changed();
  }

  /**
   * Selects a tab. Its page gets keyboard focus unless `focus` is false (keyboard use of the
   * sidebar keeps focus in the sidebar). A tab in HTML fullscreen leaves it first.
   */
  select(tabId: TabId, options: { readonly focus?: boolean } = {}): void {
    this.#record(tabId);
    if (this.#selected === tabId) {
      // Safe mode leaves the selected tab unloaded: picking it again loads it.
      this.#ensureLive(tabId);
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
    this.#order.splice(this.#order.indexOf(tabId), 1);
    const target = this.#pinnedCount();
    this.#order.splice(target, 0, tabId);
    record.state = { ...record.state, pinned };
    this.#changed();
  }

  /** A new tab right after the source, loading the same URL. History isn't copied (M3.1 can). */
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
    if (record.runtime === undefined) {
      const token = Symbol(tabId);
      record.runtimeToken = token;
      record.runtime = this.#options.createRuntime(tabId, this.#eventsFor(tabId, token));
    }
    record.pendingHistory = null;
    record.nextTransition = options.transition ?? 'link';
    record.focusOnCommit = options.focus ?? true;
    record.credentialsRemovedOnCommit = options.credentialsRemoved ?? false;
    record.state = {
      ...record.state,
      runtime: record.state.runtime === 'live' ? 'live' : 'creating',
      loading: true,
    };
    record.runtime.load(url);
    this.#changed();
  }

  /** Shows an internal page in a tab. Its web contents (if any) is closed: back can't reach it. */
  showInternal(tabId: TabId, name: InternalPage): void {
    const record = this.#record(tabId);
    if (this.#fullscreen === tabId) {
      this.#setFullscreen(null);
    }
    record.runtime?.destroy();
    record.runtime = undefined;
    record.runtimeToken = undefined;
    record.credentialsRemovedOnCommit = false;
    record.pendingHistory = null;
    this.#options.onPageGone?.(tabId);
    record.findRequestId = undefined;
    record.state = {
      ...record.state,
      runtime: 'unloaded',
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
    if (record.state.canGoBack && record.runtime !== undefined) {
      record.nextTransition = 'back_forward';
      record.runtime.goBack();
    }
  }

  goForward(tabId: TabId): void {
    const record = this.#record(tabId);
    if (record.state.canGoForward && record.runtime !== undefined) {
      record.nextTransition = 'back_forward';
      record.runtime.goForward();
    }
  }

  /** Reloads; for an error page this retries, and for a crashed tab it starts a new renderer. */
  reload(tabId: TabId, options: { readonly ignoreCache?: boolean } = {}): void {
    const record = this.#record(tabId);
    if (record.runtime === undefined) {
      // An unloaded tab (safe mode leaves the selected one so): Reload loads it.
      this.#ensureLive(tabId);
      return;
    }
    if (record.state.runtime === 'crashed') {
      record.state = { ...record.state, runtime: 'creating' };
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

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  /** A record for a tab that has no runtime: a new-tab page, or an unloaded restored page. */
  #newRecord(tab: {
    readonly id: TabId;
    readonly pinned: boolean;
    readonly createdAt: number;
    readonly lastUsedAt: number;
    readonly url?: string;
    readonly title?: string;
    readonly history?: TabHistory | null;
  }): TabRecord {
    const web = tab.url !== undefined && tab.url !== '';
    return {
      state: {
        id: tab.id,
        pinned: tab.pinned,
        placement: 'strip',
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
      focusOnCommit: false,
      credentialsRemovedOnCommit: false,
      findRequestId: undefined,
      lastFindText: '',
      pendingHistory: web ? (tab.history ?? null) : null,
      nextTransition: null,
      createdAt: tab.createdAt,
      lastUsedAt: tab.lastUsedAt,
    };
  }

  /**
   * Brings an unloaded web tab to life: a new runtime, attached, then `restore()` with its stack
   * (S2: a brand-new web contents, attached before restoring). A tab with only an address
   * restores a one-entry stack; one whose address can't be restored becomes a new-tab page.
   */
  #ensureLive(tabId: TabId): void {
    const record = this.#record(tabId);
    if (record.runtime !== undefined || record.state.page.kind !== 'web') {
      return;
    }
    const history =
      record.pendingHistory ?? singleEntryHistory(record.state.url, record.state.title);
    // Kept until the first commit: a flush before then must not replace the saved stack.
    record.pendingHistory = history;
    if (history === null) {
      this.showInternal(tabId, 'new-tab');
      return;
    }
    const token = Symbol(tabId);
    record.runtimeToken = token;
    record.runtime = this.#options.createRuntime(tabId, this.#eventsFor(tabId, token));
    record.state = { ...record.state, runtime: 'creating', loading: true };
    record.nextTransition = 'restore';
    this.#syncVisibility();
    record.runtime.restore(history);
    this.#changed();
  }

  /** What the session stores for a tab: a live tab's current stack, else its pending one. */
  #sessionTab(record: TabRecord): SessionTab {
    const { state } = record;
    const base = {
      id: state.id,
      pinned: state.pinned,
      createdAt: record.createdAt,
      lastUsedAt: record.lastUsedAt,
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
    this.#selected = tabId;
    const record = this.#record(tabId);
    record.lastUsedAt = this.#now();
    // An unloaded tab (restored at startup, or reopened) is restored when it is selected.
    this.#ensureLive(tabId);
    this.#syncVisibility();
    if (focus && record.state.page.kind === 'web') {
      record.runtime?.focus();
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

  /** Invariant 3: only the selected tab's runtime is shown, and only for web content. */
  #syncVisibility(): void {
    for (const [id, record] of this.#records) {
      if (record.runtime === undefined) {
        continue;
      }
      const visible =
        id === this.#selected &&
        record.state.page.kind === 'web' &&
        record.state.runtime !== 'crashed';
      if (visible) {
        record.runtime.show();
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

    return {
      committed: ({ url, sameDocument, canGoBack, canGoForward }) => {
        const record = current();
        if (record === undefined) {
          return;
        }
        // The runtime has a stack of its own now.
        record.pendingHistory = null;
        const transition = record.nextTransition ?? 'link';
        record.nextTransition = null;
        const leavingInternalPage = record.state.page.kind !== 'web';
        if (!sameDocument) {
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
        update(
          sameDocument
            ? { url, canGoBack, canGoForward, runtime: 'live' }
            : // A new document: the old site's favicon no longer applies.
              {
                url,
                credentialsRemoved: takeCredentialsRemoved(record),
                canGoBack,
                canGoForward,
                runtime: 'live',
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
        this.#options.history?.committed(tabId, { url, sameDocument, transition });
      },
      titleChanged: (title) => {
        const record = current();
        update({ title: sanitizeTitle(title) });
        if (record?.state.page.kind === 'web') {
          this.#options.history?.titleChanged(tabId, record.state.title);
        }
      },
      faviconChanged: (favicon) => {
        const record = current();
        update({ favicon });
        if (favicon !== null && record?.state.page.kind === 'web') {
          this.#options.history?.faviconChanged(tabId, favicon);
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
      },
      loadFailed: ({ code, name, url, canGoBack, canGoForward }) => {
        const record = current();
        if (record === undefined) {
          return;
        }
        record.findRequestId = undefined;
        record.nextTransition = null;
        if (this.#fullscreen === tabId) {
          this.#setFullscreen(null);
        }
        this.#options.onPageGone?.(tabId);
        update(
          {
            // A certificate or client-certificate failure gets its own page, with no way past it.
            page: { kind: 'internal', name: errorPageFor(code), error: { code, name } },
            url,
            credentialsRemoved: takeCredentialsRemoved(record),
            // The previous page's title and icon belong to a page that is no longer shown.
            title: '',
            favicon: null,
            runtime: 'live',
            loading: false,
            find: null,
            ...(canGoBack === undefined ? {} : { canGoBack }),
            ...(canGoForward === undefined ? {} : { canGoForward }),
          },
          { visibility: true },
        );
      },
      crashed: ({ code, name }) => {
        const record = current();
        if (record === undefined) {
          return;
        }
        record.findRequestId = undefined;
        if (this.#fullscreen === tabId) {
          this.#setFullscreen(null);
        }
        this.#options.onPageGone?.(tabId);
        update(
          {
            page: { kind: 'internal', name: 'crashed', error: { code, name } },
            runtime: 'crashed',
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
        this.navigate(tabId, record.state.url, {
          focus: this.#selected === tabId,
          transition: 'restore',
        });
        // The replacement is attached now: its commit attaches nothing, the page being 'web'.
        this.#syncVisibility();
      },
    };
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
