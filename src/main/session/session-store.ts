// Keeps the `tabs` table the live session (assessment §5.3, §5.5): TabManager reports changes;
// this writes them in batches, at most 1 s later, or 250 ms for a structural change (a tab opened,
// closed, moved, pinned or selected). Each flush is one `session.save`, one transaction, holding
// only rows that changed since the last flush. A hard kill loses at most that last second.
//
// Shutdown: the window's `closed` handler freezes the store before TabManager closes every tab
// (otherwise that would look like the user closing them all), and DataLifecycle's flush writes
// the frozen state within the 3 s cap.
import { restorableUrl } from '../../core/session/history';
import type { SavedWindow } from '../../core/layout/window-bounds';
import type { DataInput, TabRow } from '../../shared/contracts/data-rpc';
import { MAX_BATCH } from '../../shared/contracts/data-rpc';
import type { DataClient } from '../persistence/data-client';
import type { Logger } from '../platform/logger';
import { SESSION_NEW_TAB_URL } from '../tabs/tab-manager';
import type { ArchivedTab, ClosedTab, SessionTab, TabId } from '../tabs/tab-manager';

export const FLUSH_DELAY_MS = 1000;
export const STRUCTURAL_FLUSH_DELAY_MS = 250;
export const SESSION_DOCUMENT = 'session';
export const WINDOW_DOCUMENT = 'window';

/** What the store reads: TabManager in the app, a fake in tests. */
export interface SessionSource {
  /** The strip, cheaply: ids and pins, for telling a structural change from any other. */
  tabs(): readonly { readonly id: TabId; readonly pinned: boolean }[];
  sessionTabs(): readonly SessionTab[];
  closedTabs(): readonly ClosedTab[];
  selectedTabId(): TabId | null;
  /** Sleeping, most recently moved there first (M3.3). */
  shelfSessionTabs?(): readonly SessionTab[];
  /**
   * The archived tabs in memory, newest first (M3.3). An archived tab that leaves this list is
   * still archived: its row stays.
   */
  archivedTabs?(): readonly ArchivedTab[];
}

/** The session document in app_state. */
export interface SessionDocument {
  readonly selectedTabId: TabId | null;
}

export interface SessionStoreOptions {
  readonly source: SessionSource;
  readonly data: Pick<DataClient, 'call'>;
  readonly workspaceId: string;
  readonly logger: Logger;
  /** The rows the database already holds (from loading), so the first flush skips them. */
  readonly loaded?: readonly TabRow[];
}

type Documents = DataInput<'session.save'>['documents'];

export class SessionStore {
  readonly #source: SessionSource;
  readonly #data: Pick<DataClient, 'call'>;
  readonly #workspaceId: string;
  readonly #logger: Logger;
  /** Each row as last written, by id, as JSON. */
  readonly #written = new Map<string, string>();
  /** The placement each row was last written with: an archived row is never deleted for leaving. */
  readonly #writtenPlacement = new Map<string, TabRow['placement']>();
  readonly #writtenDocuments = new Map<string, string>();
  #structure = '';
  #window: SavedWindow | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #timerDue = 0;
  #frozen: { rows: TabRow[]; documents: Documents } | null = null;
  #flushing: Promise<void> | null = null;
  /** Set when freezing failed: nothing more is written. */
  #stopped = false;

  constructor(options: SessionStoreOptions) {
    this.#source = options.source;
    this.#data = options.data;
    this.#workspaceId = options.workspaceId;
    this.#logger = options.logger;
    for (const row of options.loaded ?? []) {
      // The worker links each row to its page (M4.1); main always sends none, so a loaded row is
      // compared as main would write it, or every row would look changed at the first flush.
      this.#written.set(row.id, JSON.stringify({ ...row, pageId: null }));
      this.#writtenPlacement.set(row.id, row.placement);
    }
    this.#structure = this.#structureOf();
  }

  /** TabManager changed something; a flush follows, sooner if the strip's shape changed. */
  changed(): void {
    if (this.#frozen !== null) {
      return;
    }
    let structural = true;
    try {
      const structure = this.#structureOf();
      structural = structure !== this.#structure;
      this.#structure = structure;
    } catch {
      // Unreadable now: flush soon anyway, which logs if it still is (`session.readFailed`).
    }
    this.#schedule(structural ? STRUCTURAL_FLUSH_DELAY_MS : FLUSH_DELAY_MS);
  }

  /** The window moved, resized, maximized or restored. */
  windowChanged(window: SavedWindow): void {
    if (this.#frozen !== null) {
      return;
    }
    this.#window = window;
    this.#schedule(FLUSH_DELAY_MS);
  }

  /**
   * Captures the session as it is now and ignores every later change. Called when the window
   * closes, before its tabs are torn down; `flush()` then writes what was captured.
   */
  freeze(): void {
    if (this.#frozen !== null) {
      return;
    }
    try {
      this.#frozen = { rows: this.#rows(), documents: this.#documents() };
    } catch {
      // Nothing more is written this run: tearing the tabs down must never be saved as the user
      // closing them all. What the last flush wrote is what the next start restores.
      this.#logger.error('session.readFailed');
      this.#frozen = { rows: [], documents: [] };
      this.#stopped = true;
    }
  }

  /** Writes what changed, now. Never rejects: a failed write is logged and tried again later. */
  async flush(): Promise<void> {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    // One flush at a time, in order: a second waits for the first, then writes what's left.
    while (this.#flushing !== null) {
      await this.#flushing;
    }
    const flushing = this.#write().finally(() => {
      this.#flushing = null;
    });
    this.#flushing = flushing;
    await flushing;
  }

  #schedule(delayMs: number): void {
    const due = Date.now() + delayMs;
    if (this.#timer !== undefined && this.#timerDue <= due) {
      return; // Already due sooner.
    }
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
    }
    this.#timerDue = due;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.flush();
    }, delayMs);
  }

  async #write(): Promise<void> {
    if (this.#stopped) {
      return;
    }
    let rows: TabRow[];
    let documents: Documents;
    try {
      rows = this.#frozen?.rows ?? this.#rows();
      documents = this.#frozen?.documents ?? this.#documents();
    } catch {
      // A bug in reading the session must not become an unhandled rejection in main.
      this.#logger.error('session.readFailed');
      return;
    }
    const json = new Map(rows.map((row) => [row.id, JSON.stringify(row)]));
    const changed = rows.filter((row) => this.#written.get(row.id) !== json.get(row.id));
    // An archived tab that left the in-memory list (MAX_ARCHIVED_IN_MEMORY) is still archived:
    // its row is forgotten here, not deleted.
    for (const id of [...this.#written.keys()]) {
      if (!json.has(id) && this.#writtenPlacement.get(id) === 'archive') {
        this.#written.delete(id);
        this.#writtenPlacement.delete(id);
      }
    }
    const gone = [...this.#written.keys()].filter((id) => !json.has(id));
    const newDocuments = documents.filter(
      ({ key, value }) => this.#writtenDocuments.get(key) !== JSON.stringify(value),
    );
    if (changed.length === 0 && gone.length === 0 && newDocuments.length === 0) {
      return;
    }
    try {
      // Almost always one call. A bigger change (over 1,000 rows) is split, and only then could
      // a kill land between its parts.
      for (let start = 0; ; start += MAX_BATCH) {
        const tabs = changed.slice(start, start + MAX_BATCH);
        const deleteIds = gone.slice(start, start + MAX_BATCH);
        const last = start + MAX_BATCH >= Math.max(changed.length, gone.length);
        await this.#data.call('session.save', {
          tabs,
          deleteIds,
          documents: last ? newDocuments : [],
        });
        for (const row of tabs) {
          this.#written.set(row.id, json.get(row.id) ?? '');
          this.#writtenPlacement.set(row.id, row.placement);
        }
        for (const id of deleteIds) {
          this.#written.delete(id);
          this.#writtenPlacement.delete(id);
        }
        if (last) {
          for (const { key, value } of newDocuments) {
            this.#writtenDocuments.set(key, JSON.stringify(value));
          }
          break;
        }
      }
    } catch (error) {
      this.#logger.warn('session.saveFailed', {
        code: error instanceof Error && 'code' in error ? String(error.code) : 'internal',
      });
      if (this.#frozen === null) {
        this.#schedule(FLUSH_DELAY_MS);
      }
    }
  }

  #documents(): Documents {
    const session: SessionDocument = { selectedTabId: this.#source.selectedTabId() };
    const documents: Documents = [{ key: SESSION_DOCUMENT, value: { ...session } }];
    if (this.#window !== null) {
      documents.push({ key: WINDOW_DOCUMENT, value: { ...this.#window } });
    }
    return documents;
  }

  /** A change in the strip's order, pins, membership or selection: flushed sooner. */
  #structureOf(): string {
    // Ids and pins only: this runs on every change, and reading stacks would cost a URL parse
    // per history entry of every tab.
    const tabs = this.#source.tabs().map((tab) => `${tab.id}${tab.pinned ? '*' : ''}`);
    // Sleeping and Archive moves are structural too (M3.3): their counts tell them apart.
    const shelf = this.#source.shelfSessionTabs?.().length ?? 0;
    const archived = this.#source.archivedTabs?.()[0]?.id ?? '';
    return `${tabs.join(',')}|${String(this.#source.selectedTabId())}|${String(this.#source.closedTabs().length)}|${String(shelf)}|${archived}`;
  }

  #rows(): TabRow[] {
    const rows: TabRow[] = [];
    this.#source.sessionTabs().forEach((tab, position) => {
      rows.push(this.#row(tab, { placement: 'strip', position, closedAt: null }));
    });
    this.#source.shelfSessionTabs?.().forEach((tab, position) => {
      rows.push(this.#row(tab, { placement: 'shelf', position, closedAt: null }));
    });
    for (const tab of this.#source.archivedTabs?.() ?? []) {
      rows.push(
        this.#row(tab, {
          placement: 'archive',
          position: 0,
          closedAt: null,
          archivedAt: tab.archivedAt,
          archiveReason: tab.reason,
        }),
      );
    }
    for (const tab of this.#source.closedTabs()) {
      // For a closed tab, `position` is where it was in the strip: Ctrl+Shift+T puts it back there.
      rows.push(
        this.#row(tab, {
          placement: 'closed',
          position: Math.min(Math.max(tab.index, 0), 1_000_000),
          closedAt: tab.closedAt,
        }),
      );
    }
    return rows;
  }

  #row(
    tab: SessionTab,
    where: {
      readonly placement: TabRow['placement'];
      readonly position: number;
      readonly closedAt: number | null;
      readonly archivedAt?: number;
      readonly archiveReason?: 'auto' | 'manual';
    },
  ): TabRow {
    // The exact address, minus credentials and token-bearing fragments (§5.7). A tab whose
    // address can't be restored keeps it as is; restoring it then opens a new-tab page.
    // An address a tab may not restore (about:blank, a chrome: page) is saved as a new-tab
    // page: restoring it would open one anyway, and nothing unsafe reaches the file.
    const url = restorableUrl(tab.url);
    const restorable = url !== null;
    return {
      id: tab.id,
      workspaceId: this.#workspaceId,
      placement: where.placement,
      position: where.position,
      // The schema allows a pin only in the strip; a closed tab reopens unpinned after a restart.
      pinned: where.placement === 'strip' && tab.pinned,
      userProtected: tab.userProtected ?? false,
      pageId: null,
      url: url ?? SESSION_NEW_TAB_URL,
      title: restorable ? tab.title : '',
      faviconId: null,
      restoreState:
        !restorable || tab.history === null
          ? null
          : { v: 1, ...tab.history, entries: [...tab.history.entries] },
      openerTabId: null,
      createdAt: tab.createdAt,
      // Whole, non-negative numbers, as the row's schema wants them: one fraction would make the
      // whole save fail (found by E2E in M3.4).
      lastUsedAt: wholeMs(tab.lastUsedAt),
      lastUsedEngaged: wholeMs(tab.lastUsedEngaged ?? 0),
      lastUsedActiveDay: Math.max(0, Math.floor(tab.lastUsedActiveDay ?? 0)),
      placementChangedAt:
        where.closedAt ?? where.archivedAt ?? tab.placementChangedAt ?? tab.createdAt,
      archivedAt: where.archivedAt ?? null,
      archiveReason: where.archiveReason ?? null,
      closedAt: where.closedAt,
    };
  }
}

/** A time as the tab rows store it: a whole, non-negative number of milliseconds. */
function wholeMs(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
