// The activity log (M3.3, assessment §4.13): every automatic action that changed a tab (a discard,
// a freeze, a move to Sleeping or the Archive) with the rule that decided it, and the user's
// undos. It stays on this machine: the `activity` document in app_state, the newest
// MAX_ACTIVITY_ENTRIES, written at most every ACTIVITY_WRITE_DELAY_MS and when the app quits.
// An ephemeral tab's entries are kept in memory only (I6).
import { z } from 'zod';

import type { Timers } from '../../core/lifecycle/discard';
import { keptTitle, restorableUrl, stripTokenFragment } from '../../core/session/history';
import { displayUrl } from '../../core/url/display';
import {
  activityEntrySchema,
  MAX_ACTIVITY_ADDRESS,
  MAX_ACTIVITY_ENTRIES,
  MAX_ACTIVITY_TITLE,
} from '../../shared/contracts/activity';
import type { ActivityEntry } from '../../shared/contracts/activity';
import type { DataClient } from '../persistence/data-client';
import type { Logger } from '../platform/logger';

export const ACTIVITY_DOCUMENT = 'activity';
/** Entries come in bursts (one evaluation): one write covers a burst. */
export const ACTIVITY_WRITE_DELAY_MS = 10_000;
/** Reading the log at startup must not hold the window back. */
const ACTIVITY_READ_TIMEOUT_MS = 2000;

// Read leniently: a field a later version adds (beside the entries, or in one) is ignored rather
// than costing the log. Each entry is still checked field by field.
const storedSchema = z.object({ entries: z.array(z.unknown()) });
const storedEntrySchema = z.object(activityEntrySchema.shape);

/**
 * What the log keeps of a tab: its address as the session keeps it, without credentials or a
 * token-bearing fragment (§5.7), and its title unless that could carry what the address lost
 * (`keptTitle`). An address a tab may not restore (`veltriva:`) is shown as it is, minus such a
 * fragment.
 */
export function loggedTab(
  url: string,
  title: string,
): { readonly title: string; readonly address: string } {
  if (url === '') {
    return { title: keptTitle(title, url, url), address: '' };
  }
  const clean = restorableUrl(url) ?? stripTokenFragment(url);
  return { title: keptTitle(title, url, clean), address: displayUrl(clean).text };
}

/** What an entry says before it has an id. */
export type NewActivityEntry = Omit<ActivityEntry, 'id'>;

export interface ActivityLogOptions {
  /** The stored entries, oldest first (parseActivity), or empty. */
  readonly stored: readonly ActivityEntry[];
  readonly persist: (entries: readonly ActivityEntry[]) => Promise<void>;
  readonly timers: Timers;
  readonly logger: Logger;
  /** An entry was added. */
  readonly onChange?: () => void;
}

interface Kept {
  readonly entry: ActivityEntry;
  /** False for an ephemeral tab's entry: never written (I6). */
  readonly persist: boolean;
}

export class ActivityLog {
  readonly #options: ActivityLogOptions;
  /** Oldest first. */
  readonly #entries: Kept[];
  #nextId: number;
  #timer: unknown;
  #dirty = false;
  #writing: Promise<void> = Promise.resolve();

  constructor(options: ActivityLogOptions) {
    this.#options = options;
    this.#entries = options.stored
      .slice(-MAX_ACTIVITY_ENTRIES)
      .map((entry) => ({ entry, persist: true }));
    this.#nextId = Math.max(0, ...options.stored.map((entry) => entry.id)) + 1;
  }

  /** Adds an entry. `ephemeral`: the tab is never persisted, so neither is this. */
  add(entry: NewActivityEntry, options: { readonly ephemeral?: boolean } = {}): ActivityEntry {
    const kept: ActivityEntry = {
      ...entry,
      id: this.#nextId,
      title: entry.title.slice(0, MAX_ACTIVITY_TITLE),
      address: entry.address.slice(0, MAX_ACTIVITY_ADDRESS),
    };
    this.#nextId += 1;
    const persist = options.ephemeral !== true;
    this.#entries.push({ entry: kept, persist });
    if (this.#entries.length > MAX_ACTIVITY_ENTRIES) {
      this.#entries.shift();
    }
    if (persist) {
      this.#dirty = true;
      this.#schedule();
    }
    this.#options.onChange?.();
    return kept;
  }

  /** The newest entry's id, or 0 when there is none yet: changes with every entry. */
  version(): number {
    return this.#nextId - 1;
  }

  /** The entries, newest first, at most `limit`. */
  entries(limit = MAX_ACTIVITY_ENTRIES): ActivityEntry[] {
    // Not `slice(-limit)`: `slice(-0)` is everything (found by tests).
    return this.#entries
      .slice(Math.max(0, this.#entries.length - Math.max(0, limit)))
      .reverse()
      .map((kept) => kept.entry);
  }

  /** Writes what changed now (the app is quitting). Never rejects. */
  flush(): Promise<void> {
    this.#cancelTimer();
    if (!this.#dirty) {
      return this.#writing;
    }
    this.#dirty = false;
    const entries = this.#entries.filter((kept) => kept.persist).map((kept) => kept.entry);
    // One write at a time, in order: a later write always carries the newer list.
    this.#writing = this.#writing
      .then(() => this.#options.persist(entries))
      .catch(() => {
        this.#options.logger.warn('activity.writeFailed');
      });
    return this.#writing;
  }

  /** Stops the timer; what is unwritten waits for flush(). */
  stop(): void {
    this.#cancelTimer();
  }

  #schedule(): void {
    if (this.#timer !== undefined) {
      return;
    }
    this.#timer = this.#options.timers.setTimeout(() => {
      this.#timer = undefined;
      void this.flush();
    }, ACTIVITY_WRITE_DELAY_MS);
  }

  #cancelTimer(): void {
    if (this.#timer !== undefined) {
      this.#options.timers.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }
}

/**
 * The stored entries, oldest first. Entries that don't check are dropped one by one, so a damaged
 * entry never costs the rest; anything else unreadable is an empty log. Only the last
 * 2 × MAX_ACTIVITY_ENTRIES stored are looked at (the log is written oldest first).
 */
export function parseActivity(raw: unknown): ActivityEntry[] {
  const stored = storedSchema.safeParse(raw);
  if (!stored.success) {
    return [];
  }
  const entries: ActivityEntry[] = [];
  for (const candidate of stored.data.entries.slice(-2 * MAX_ACTIVITY_ENTRIES)) {
    const entry = storedEntrySchema.safeParse(candidate);
    if (entry.success) {
      entries.push(entry.data);
    }
  }
  return entries.sort((a, b) => a.id - b.id).slice(-MAX_ACTIVITY_ENTRIES);
}

export async function readStoredActivity(
  data: Pick<DataClient, 'call'>,
  logger: Logger,
): Promise<ActivityEntry[]> {
  try {
    const { value } = await data.call(
      'appState.get',
      { key: ACTIVITY_DOCUMENT },
      { timeoutMs: ACTIVITY_READ_TIMEOUT_MS },
    );
    return value === null ? [] : parseActivity(value);
  } catch {
    logger.warn('activity.readFailed');
    return [];
  }
}

/** Writes the log as the `activity` document. */
export function activityWriter(
  data: Pick<DataClient, 'call'>,
): (entries: readonly ActivityEntry[]) => Promise<void> {
  return async (entries) => {
    await data.call('appState.set', {
      key: ACTIVITY_DOCUMENT,
      value: { entries: entries.map((entry) => ({ ...entry })) },
    });
  };
}
