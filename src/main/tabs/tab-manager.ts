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
// tab, always the selected one), DevTools, and reopening closed tabs (in memory until Phase 2).
import { nextZoomFactor, zoomPercent } from '../../core/layout/zoom';
import type { ZoomDirection } from '../../core/layout/zoom';
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
  loadFailed(error: TabPageError & { url: string }): void;
  crashed(error: TabPageError): void;
  /** Results of the find request with this id; several arrive for one request. */
  foundInPage(result: { requestId: number; activeMatch: number; matches: number }): void;
  /** The user zoomed with Ctrl+wheel or a pinch. */
  zoomRequested(direction: 'in' | 'out'): void;
  /** The page entered or left HTML fullscreen. */
  fullscreenChanged(fullscreen: boolean): void;
}

export type TabRuntimeFactory = (tabId: TabId, events: TabRuntimeEvents) => TabRuntime;

export interface TabManagerOptions {
  readonly createRuntime: TabRuntimeFactory;
  readonly newId: () => TabId;
  /** Called after every change; the projector coalesces these into snapshots. */
  readonly onChange: () => void;
  /** Called when a tab enters HTML fullscreen (its id) or the window leaves it (null). */
  readonly onFullscreenChange?: (tabId: TabId | null) => void;
}

/** How many closed tabs Ctrl+Shift+T can bring back. */
const MAX_CLOSED_TABS = 25;

interface ClosedTab {
  readonly url: string;
  readonly pinned: boolean;
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
    const record: TabRecord = {
      state: {
        id,
        pinned: after?.state.pinned ?? false,
        placement: 'strip',
        runtime: 'unloaded',
        page: NEW_TAB_PAGE,
        url: '',
        credentialsRemoved: false,
        title: '',
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
    };
    this.#records.set(id, record);
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
      this.#closed.push({ url: record.state.url, pinned: record.state.pinned, index });
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

  /**
   * Reopens the most recently closed tab where it was and loads its last address (Ctrl+Shift+T).
   * In memory only, and without its history: Phase 2 brings session restore.
   */
  reopenClosed(): TabId | null {
    const closed = this.#closed.pop();
    if (closed === undefined) {
      return null;
    }
    const id = this.create();
    if (closed.pinned) {
      this.setPinned(id, true);
    }
    this.move(id, closed.index);
    this.navigate(id, closed.url);
    return id;
  }

  /** Closes every tab without opening a new one. For shutdown only. */
  closeAll(): void {
    for (const record of this.#records.values()) {
      record.runtime?.destroy();
      record.runtime = undefined;
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
    options: { readonly focus?: boolean; readonly credentialsRemoved?: boolean } = {},
  ): void {
    const record = this.#record(tabId);
    if (record.runtime === undefined) {
      const token = Symbol(tabId);
      record.runtimeToken = token;
      record.runtime = this.#options.createRuntime(tabId, this.#eventsFor(tabId, token));
    }
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
    if (record.state.canGoBack) {
      record.runtime?.goBack();
    }
  }

  goForward(tabId: TabId): void {
    const record = this.#record(tabId);
    if (record.state.canGoForward) {
      record.runtime?.goForward();
    }
  }

  /** Reloads; for an error page this retries, and for a crashed tab it starts a new renderer. */
  reload(tabId: TabId, options: { readonly ignoreCache?: boolean } = {}): void {
    const record = this.#record(tabId);
    if (record.runtime === undefined) {
      return;
    }
    if (record.state.runtime === 'crashed') {
      record.state = { ...record.state, runtime: 'creating' };
      this.#changed();
    }
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
    this.#syncVisibility();
    const record = this.#record(tabId);
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
        const leavingInternalPage = record.state.page.kind !== 'web';
        if (!sameDocument) {
          // The old document's matches are gone; the find bar stays open with its text.
          record.findRequestId = undefined;
        }
        const find = record.state.find;
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
                find: find === null ? null : { text: find.text, activeMatch: 0, matches: 0 },
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
      },
      titleChanged: (title) => {
        update({ title: sanitizeTitle(title) });
      },
      faviconChanged: (favicon) => {
        update({ favicon });
      },
      loadingChanged: (loading) => {
        update({ loading });
      },
      loadFailed: ({ code, name, url }) => {
        const record = current();
        if (record === undefined) {
          return;
        }
        record.findRequestId = undefined;
        if (this.#fullscreen === tabId) {
          this.#setFullscreen(null);
        }
        update(
          {
            page: { kind: 'internal', name: 'network-error', error: { code, name } },
            url,
            credentialsRemoved: takeCredentialsRemoved(record),
            // The previous page's title and icon belong to a page that is no longer shown.
            title: '',
            favicon: null,
            runtime: 'live',
            loading: false,
            find: null,
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
    };
  }
}

export class TabNotFoundError extends Error {
  constructor(tabId: TabId) {
    super(`No tab ${tabId}`);
    this.name = 'TabNotFoundError';
  }
}
