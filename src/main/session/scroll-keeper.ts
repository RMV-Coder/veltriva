// Scroll position across restarts (§7.2 "Should", M5.3): a restored tab comes back where you had
// scrolled, unless its page is sensitive.
//   - Read from the page's isolated world (never its own; ADR-0002) when its tab is hidden, and for
//     the selected tab when Veltriva quits. A page with a password or payment field gives nothing.
//   - Never kept for an address the session would cut (a token in its fragment, credentials;
//     §5.7): the document holds the address as it is.
//   - Kept in the app_state document `scroll`: per tab, the address it was read on and x, y. Only
//     tabs that still exist are kept, at most MAX_SCROLL_TABS, written a few seconds after a change
//     and at quit.
//   - Put back once, after the first load of a restored tab, and only on that same address.
// Within a run, a discarded tab already comes back where it was (Chromium's page state, M3.1);
// this is for the restart, where that page state is not kept (ADR-0004 item 4).
import { restorableUrl } from '../../core/session/history';
import type { DataClient } from '../persistence/data-client';
import type { Logger } from '../platform/logger';
import type { TabId } from '../tabs/tab-manager';

export const SCROLL_DOCUMENT = 'scroll';
/** More tabs than anyone keeps open: a bound, so a damaged document can't grow without end. */
export const MAX_SCROLL_TABS = 500;
/** A change is written this long after it, and at quit. */
export const SCROLL_WRITE_DELAY_MS = 5000;
/** At quit, the selected tab gets this long to answer. */
export const SCROLL_READ_TIMEOUT_MS = 300;

/**
 * Run in the isolated world: where the page is scrolled, or null for a sensitive page (a password
 * or payment field) or one at the top. The isolated world sees the page's DOM, not its scripts.
 */
export const READ_SCROLL = `(() => {
  if (document.querySelector('input[type="password"], input[autocomplete^="cc-"]')) return null;
  const x = Math.round(window.scrollX), y = Math.round(window.scrollY);
  return x === 0 && y === 0 ? null : [x, y];
})()`;

/** Run in the isolated world: scrolls the page there. */
export const scrollTo = (x: number, y: number): string =>
  `window.scrollTo(${String(Math.trunc(x))}, ${String(Math.trunc(y))}); true`;

export interface ScrollPosition {
  readonly url: string;
  readonly x: number;
  readonly y: number;
}

/** What the keeper needs of a tab's web contents. */
export interface ScrollContents {
  getURL(): string;
  isDestroyed(): boolean;
  executeJavaScriptInIsolatedWorld(
    worldId: number,
    scripts: { code: string }[],
    userGesture?: boolean,
  ): Promise<unknown>;
}

export interface ScrollKeeperOptions {
  readonly data: Pick<DataClient, 'call'> | null;
  readonly logger: Logger;
  readonly worldId: number;
  /** The stored document, unchecked (null when there was none). */
  readonly stored: unknown;
  /** Tabs that still exist: the document keeps only theirs. */
  readonly liveTabIds: () => ReadonlySet<TabId>;
  readonly timers?: {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
}

/** The usable entries of a stored document: an address and two whole non-negative numbers. */
export function parseScrollDocument(stored: unknown): Map<TabId, ScrollPosition> {
  const positions = new Map<TabId, ScrollPosition>();
  if (typeof stored !== 'object' || stored === null || !('tabs' in stored)) {
    return positions;
  }
  const { tabs } = stored;
  if (typeof tabs !== 'object' || tabs === null || Array.isArray(tabs)) {
    return positions;
  }
  for (const [tabId, value] of Object.entries(tabs)) {
    if (positions.size >= MAX_SCROLL_TABS) {
      break;
    }
    if (typeof value !== 'object' || value === null) {
      continue;
    }
    const { url, x, y } = value as Record<string, unknown>;
    const whole = (n: unknown): n is number =>
      typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 10_000_000;
    if (typeof url === 'string' && restorableUrl(url) === url && whole(x) && whole(y)) {
      positions.set(tabId, { url, x, y });
    }
  }
  return positions;
}

export class ScrollKeeper {
  readonly #options: ScrollKeeperOptions;
  /** What was read last, per tab. */
  readonly #positions: Map<TabId, ScrollPosition>;
  /** Restored tabs still to be put back: once each, on their first load. */
  readonly #pending: Map<TabId, ScrollPosition>;
  #timer: unknown;
  #dirty = false;

  constructor(options: ScrollKeeperOptions) {
    this.#options = options;
    this.#positions = parseScrollDocument(options.stored);
    this.#pending = new Map(this.#positions);
  }

  /** Where a tab was, as kept. */
  position(tabId: TabId): ScrollPosition | undefined {
    return this.#positions.get(tabId);
  }

  /** Reads where the tab's page is scrolled, and keeps it (or forgets it: top, sensitive). */
  async capture(tabId: TabId, contents: ScrollContents | undefined): Promise<void> {
    if (contents === undefined || contents.isDestroyed()) {
      return;
    }
    const url = contents.getURL();
    if (!/^https?:/.test(url)) {
      return;
    }
    if (restorableUrl(url) !== url) {
      // The session cuts this address, so it is never written whole here either.
      if (this.#positions.delete(tabId)) {
        this.#changed();
      }
      return;
    }
    let reading: unknown;
    try {
      reading = await contents.executeJavaScriptInIsolatedWorld(
        this.#options.worldId,
        [{ code: READ_SCROLL }],
        false,
      );
    } catch {
      return; // The page went, or isn't scriptable: what was kept stays.
    }
    const before = this.#positions.get(tabId);
    if (
      Array.isArray(reading) &&
      reading.length === 2 &&
      reading.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)
    ) {
      const [x, y] = reading as [number, number];
      const next = { url, x: Math.round(x), y: Math.round(y) };
      if (before?.url !== next.url || before.x !== next.x || before.y !== next.y) {
        this.#positions.set(tabId, next);
        this.#changed();
      }
    } else if (before !== undefined) {
      this.#positions.delete(tabId);
      this.#changed();
    }
  }

  /**
   * A tab's page finished loading. The first time after a restore, on the address it was read on,
   * it goes back where it was.
   */
  loaded(tabId: TabId, contents: ScrollContents): void {
    const pending = this.#pending.get(tabId);
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(tabId);
    if (contents.isDestroyed() || contents.getURL() !== pending.url) {
      return;
    }
    contents
      .executeJavaScriptInIsolatedWorld(
        this.#options.worldId,
        [{ code: scrollTo(pending.x, pending.y) }],
        false,
      )
      .catch(() => {
        this.#options.logger.warn('scroll.restoreFailed');
      });
  }

  /** A tab closed: nothing of it is kept. */
  forget(tabId: TabId): void {
    this.#pending.delete(tabId);
    if (this.#positions.delete(tabId)) {
      this.#changed();
    }
  }

  /** At quit: reads the selected tab (bounded), then writes what is kept now. */
  async flush(selected?: {
    readonly tabId: TabId;
    readonly contents: ScrollContents | undefined;
  }): Promise<void> {
    if (selected !== undefined) {
      await Promise.race([
        this.capture(selected.tabId, selected.contents),
        new Promise<void>((resolve) => {
          (this.#options.timers ?? globalThis).setTimeout(resolve, SCROLL_READ_TIMEOUT_MS);
        }),
      ]);
    }
    if (this.#timer !== undefined) {
      (this.#options.timers ?? globalThis).clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    await this.#write();
  }

  /** The document as stored: only tabs that still exist, at most MAX_SCROLL_TABS. */
  document(): { tabs: Record<string, { url: string; x: number; y: number }> } {
    const live = this.#options.liveTabIds();
    const tabs: Record<string, { url: string; x: number; y: number }> = {};
    let count = 0;
    for (const [tabId, position] of this.#positions) {
      if (live.has(tabId) && count < MAX_SCROLL_TABS) {
        tabs[tabId] = { ...position };
        count += 1;
      }
    }
    return { tabs };
  }

  #changed(): void {
    this.#dirty = true;
    if (this.#timer !== undefined) {
      return;
    }
    const timers = this.#options.timers ?? globalThis;
    this.#timer = timers.setTimeout(() => {
      this.#timer = undefined;
      void this.#write();
    }, SCROLL_WRITE_DELAY_MS);
  }

  async #write(): Promise<void> {
    if (!this.#dirty || this.#options.data === null) {
      return;
    }
    this.#dirty = false;
    try {
      await this.#options.data.call('appState.set', {
        key: SCROLL_DOCUMENT,
        value: this.document(),
      });
    } catch {
      this.#options.logger.warn('scroll.writeFailed');
    }
  }
}
