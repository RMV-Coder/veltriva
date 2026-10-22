// The navigation snapshot a discard takes (assessment §4.9 step 4, spike S2): the back/forward
// stack with Chromium's page state (scroll position, form values) for each entry. Page state stays
// in memory for the run and is never persisted; what the session stores is `withoutPageState`.
//
// The snapshot passes the same checks as a persisted stack (core/session/history.ts): only http,
// https and file entries, no credentials, no token fragments, at most 50 entries. An entry keeps
// its page state only if its URL came through those checks unchanged, because the state belongs
// to that exact document. `restore()` rejects an empty page state, so one is dropped (S2).

import { sanitizeEntries } from '../session/history';
import type { HistoryEntry, TabHistory } from '../session/history';

export interface SnapshotEntry extends HistoryEntry {
  /** Chromium's serialized page state (base64), in memory only. */
  readonly pageState?: string;
}

export interface NavigationSnapshot {
  readonly index: number;
  readonly entries: readonly SnapshotEntry[];
}

/**
 * The page state a tab may keep in memory, in characters. S2: about 0.7–2 KB per entry, growing by
 * about 2 bytes per typed character. Above this, only the active entry keeps its state, if it fits.
 */
export const MAX_PAGE_STATE_PER_TAB = 256 * 1024;

function pageStateOf(raw: Readonly<Record<string, unknown>>): string | undefined {
  const { pageState } = raw;
  return typeof pageState === 'string' && pageState.length > 0 ? pageState : undefined;
}

/**
 * A snapshot that is safe to restore, or null when no entry is. `raw` is what Chromium reported
 * (`getAllEntries()` and `getActiveIndex()`), so it is checked like any input.
 */
export function restorableSnapshot(
  raw: { readonly index: number; readonly entries: readonly unknown[] } | null,
): NavigationSnapshot | null {
  const snapshot = sanitizeEntries<SnapshotEntry>(raw, (entry, original, unchanged) => {
    const pageState = unchanged ? pageStateOf(original) : undefined;
    return pageState === undefined ? entry : { ...entry, pageState };
  });
  if (snapshot === null) {
    return null;
  }
  let total = 0;
  for (const entry of snapshot.entries) {
    total += entry.pageState?.length ?? 0;
  }
  if (total <= MAX_PAGE_STATE_PER_TAB) {
    return snapshot;
  }
  // Too much typed text to keep around: the active entry's state matters most.
  return {
    index: snapshot.index,
    entries: snapshot.entries.map((entry, index) =>
      index === snapshot.index && (entry.pageState?.length ?? 0) <= MAX_PAGE_STATE_PER_TAB
        ? entry
        : { url: entry.url, title: entry.title },
    ),
  };
}

/** The stack as the session persists it: URLs and titles only. */
export function withoutPageState(snapshot: NavigationSnapshot): TabHistory {
  return {
    index: snapshot.index,
    entries: snapshot.entries.map(({ url, title }) => ({ url, title })),
  };
}

/** Whether a snapshot holds the same stack as a history: same entries, same active one. */
export function sameStack(snapshot: NavigationSnapshot, history: TabHistory): boolean {
  return (
    snapshot.index === history.index &&
    snapshot.entries.length === history.entries.length &&
    snapshot.entries.every((entry, index) => {
      const other = history.entries[index];
      return entry.url === other?.url && entry.title === other.title;
    })
  );
}
