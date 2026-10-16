// Popups refused for lack of a gesture, per tab (assessment §3.7). The toolbar shows "Pop-up
// blocked" with a way to open the latest one anyway; a new document clears it, as in Chrome.
// No Electron here, so the rules are unit-tested.
import type { TabId } from '../tabs/tab-manager';

export interface BlockedPopupsState {
  readonly count: number;
  /** The latest blocked URL; it already passed the scheme checks of ./window-open-route.ts. */
  readonly latestUrl: string;
}

export class BlockedPopups {
  readonly #byTab = new Map<TabId, BlockedPopupsState>();
  readonly #onChange: () => void;

  constructor(options: { readonly onChange: () => void }) {
    this.#onChange = options.onChange;
  }

  record(tabId: TabId, url: string): void {
    const count = (this.#byTab.get(tabId)?.count ?? 0) + 1;
    this.#byTab.set(tabId, { count, latestUrl: url });
    this.#onChange();
  }

  get(tabId: TabId): BlockedPopupsState | null {
    return this.#byTab.get(tabId) ?? null;
  }

  /** The user chose to open the latest one: it is no longer blocked, and the indicator goes. */
  take(tabId: TabId): string | null {
    const state = this.#byTab.get(tabId);
    if (state === undefined) {
      return null;
    }
    this.clear(tabId);
    return state.latestUrl;
  }

  clear(tabId: TabId): void {
    if (this.#byTab.delete(tabId)) {
      this.#onChange();
    }
  }
}
