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
}

/** One tab's web contents. Implemented over a WebContentsView by ./tab-runtime.ts. */
export interface TabRuntime {
  load(url: string): void;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
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
}

export type TabRuntimeFactory = (tabId: TabId, events: TabRuntimeEvents) => TabRuntime;

export interface TabManagerOptions {
  readonly createRuntime: TabRuntimeFactory;
  readonly newId: () => TabId;
  /** Called after every change; the projector coalesces these into snapshots. */
  readonly onChange: () => void;
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
}

const NEW_TAB_PAGE: TabPage = { kind: 'internal', name: 'new-tab' };

export class TabManager {
  readonly #options: TabManagerOptions;
  readonly #order: TabId[] = [];
  readonly #records = new Map<TabId, TabRecord>();
  #selected: TabId | null = null;

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
      },
      runtime: undefined,
      runtimeToken: undefined,
      focusOnCommit: false,
      credentialsRemovedOnCommit: false,
    };
    this.#records.set(id, record);
    if (after === undefined) {
      this.#order.push(id);
    } else {
      this.#order.splice(this.#order.indexOf(after.state.id) + 1, 0, id);
    }
    if (options.select !== false || this.#selected === null) {
      this.#setSelected(id);
    }
    this.#changed();
    return id;
  }

  /**
   * Closes a tab and destroys its runtime. Selection moves to the tab that took its place (the
   * next one), or the previous one at the end of the strip. Closing the last tab opens a new one:
   * the window always has something to show.
   */
  close(tabId: TabId): void {
    const record = this.#record(tabId);
    const index = this.#order.indexOf(tabId);
    this.#order.splice(index, 1);
    this.#records.delete(tabId);
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
        this.#setSelected(next);
      }
    }
    this.#changed();
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
    this.#changed();
  }

  select(tabId: TabId): void {
    this.#record(tabId);
    if (this.#selected === tabId) {
      return;
    }
    this.#setSelected(tabId);
    this.#changed();
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
    record.runtime?.destroy();
    record.runtime = undefined;
    record.runtimeToken = undefined;
    record.credentialsRemovedOnCommit = false;
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
  reload(tabId: TabId): void {
    const record = this.#record(tabId);
    if (record.runtime === undefined) {
      return;
    }
    if (record.state.runtime === 'crashed') {
      record.state = { ...record.state, runtime: 'creating' };
      this.#changed();
    }
    record.runtime.reload();
  }

  stop(tabId: TabId): void {
    this.#record(tabId).runtime?.stop();
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

  #setSelected(tabId: TabId): void {
    this.#selected = tabId;
    this.#syncVisibility();
    const record = this.#record(tabId);
    if (record.state.page.kind === 'web') {
      record.runtime?.focus();
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
              },
          { visibility: !sameDocument && leavingInternalPage },
        );
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
          },
          { visibility: true },
        );
      },
      crashed: ({ code, name }) => {
        update(
          {
            page: { kind: 'internal', name: 'crashed', error: { code, name } },
            runtime: 'crashed',
            loading: false,
          },
          { visibility: true },
        );
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
