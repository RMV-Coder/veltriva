// A tab's back/forward stack as Veltriva keeps it between runs (assessment §5.3 `restore_state`,
// §5.7, ADR-0003 item 6, spike S2): URLs and titles only, at most 50 entries, and nothing a
// restore could misuse. Chromium's page state (scroll, form values) is never persisted.
//
// What gets through, in order:
//   - only addresses a tab may show by itself: http:, https: and file: (the address bar opens
//     local drive paths); everything else is dropped, so a restore can never load veltriva:,
//     javascript:, data: or another app's link;
//   - fragments that carry tokens are cut, as in `#access_token=…` after an OAuth sign-in;
//   - titles are plain strings of at most 1,024 characters, and never carry what the address
//     lost (`keptTitle`);
//   - at most 50 entries, kept around the active one.
/** The data contract's limits (src/shared/contracts/data-rpc.ts), which a test keeps in step. */
export const MAX_HISTORY_URL = 65_536;
export const MAX_HISTORY_TITLE = 1024;

export interface HistoryEntry {
  readonly url: string;
  readonly title: string;
}

export interface TabHistory {
  readonly index: number;
  readonly entries: readonly HistoryEntry[];
}

/** `restore_state` holds at most this many entries (assessment §5.3). */
export const MAX_HISTORY_ENTRIES = 50;

const RESTORABLE_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'file:']);

/**
 * A fragment parameter that carries a credential: OAuth's implicit flow puts the token there
 * (`#access_token=…&token_type=…`), and so do some sign-in links (`#code=…`, `#id_token=…`).
 */
const TOKEN_FRAGMENT =
  /(?:^|[&;?#])(?:access_token|id_token|refresh_token|token|code|auth|authorization|session|sessionid|sid|secret|password|api_key|apikey|key|sig|signature)=/i;

/**
 * The URL without a fragment that carries a token, or the URL itself. `tabs.url` and every
 * history entry go through this (§5.7: "minus token-bearing fragments"). Unparseable input comes
 * back unchanged; `restorableUrl` refuses it.
 */
export function stripTokenFragment(raw: string): string {
  const hash = raw.indexOf('#');
  if (hash === -1) {
    return raw;
  }
  const fragment = raw.slice(hash + 1);
  let decoded = fragment;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {
    // A malformed escape: test the raw text.
  }
  return TOKEN_FRAGMENT.test(fragment) || TOKEN_FRAGMENT.test(decoded) ? raw.slice(0, hash) : raw;
}

/**
 * The title a session may keep for an address it cleaned from `rawUrl` to `cleanUrl`, or ''.
 *
 * Chromium gives an entry with no title of its own (a page without one, or one still loading) its
 * address as the title, fragment and all. Measured on Electron 45: `navigationHistory` reports
 * `127.0.0.1:…/untitled?case=a#/cb?code=…&state=…`. A save in that moment wrote the code into the
 * file, which a hard kill then kept in the write-ahead log. So the title goes when cleaning the
 * address cut something, or when the title itself holds a token-bearing fragment (one saved before
 * this rule, read back from the database).
 */
export function keptTitle(title: string, rawUrl: string, cleanUrl: string): string {
  if (cleanUrl !== rawUrl || stripTokenFragment(title) !== title) {
    return '';
  }
  return title.slice(0, MAX_HISTORY_TITLE);
}

/** The URL a restore may load, cleaned; null if a tab must not restore it. */
export function restorableUrl(raw: string): string | null {
  if (raw.length === 0 || raw.length > MAX_HISTORY_URL) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!RESTORABLE_PROTOCOLS.has(url.protocol)) {
    return null;
  }
  // Credentials typed into an address are never kept (the address bar removes them too).
  let clean = raw;
  if (url.username !== '' || url.password !== '') {
    url.username = '';
    url.password = '';
    clean = url.href;
  }
  clean = stripTokenFragment(clean);
  // Normalizing (removing credentials re-serializes the URL) can make it longer.
  return clean.length > MAX_HISTORY_URL ? null : clean;
}

/**
 * A history that is safe to persist and to restore, or null when nothing in it is. Entries that
 * fail are dropped; if the active one goes, the nearest earlier entry (else the next later one)
 * becomes active. A title that could carry what its address lost goes (`keptTitle`). Unknown
 * input shapes are refused, never trusted: this also runs on what the database returns.
 */
export function sanitizeHistory(
  raw: { readonly index: number; readonly entries: readonly unknown[] } | null,
): TabHistory | null {
  return sanitizeEntries(raw, (entry) => entry);
}

/**
 * `sanitizeHistory`, with a hook that builds each kept entry: it gets the clean entry (its title
 * already through `keptTitle`), the raw one, and whether the URL came through unchanged. The in-memory discard snapshot uses it to keep
 * an entry's page state only when its URL is exactly the one Chromium stored (core/lifecycle).
 */
export function sanitizeEntries<E extends HistoryEntry>(
  raw: { readonly index: number; readonly entries: readonly unknown[] } | null,
  build: (entry: HistoryEntry, raw: Readonly<Record<string, unknown>>, unchanged: boolean) => E,
): { readonly index: number; readonly entries: readonly E[] } | null {
  if (raw === null || !Number.isInteger(raw.index)) {
    return null;
  }
  const kept: { entry: E; from: number }[] = [];
  raw.entries.forEach((candidate, from) => {
    if (typeof candidate !== 'object' || candidate === null) {
      return;
    }
    const record = candidate as Readonly<Record<string, unknown>>;
    const { url, title } = record;
    if (typeof url !== 'string') {
      return;
    }
    const clean = restorableUrl(url);
    if (clean !== null) {
      const text = typeof title === 'string' ? keptTitle(title, url, clean) : '';
      kept.push({ entry: build({ url: clean, title: text }, record, clean === url), from });
    }
  });
  if (kept.length === 0) {
    return null;
  }
  const atOrBefore = kept.findLastIndex(({ from }) => from <= raw.index);
  let index = atOrBefore === -1 ? 0 : atOrBefore;
  let entries = kept.map(({ entry }) => entry);
  if (entries.length > MAX_HISTORY_ENTRIES) {
    // Keep the active entry, most of what is behind it, and some of what is ahead.
    const start = Math.min(
      Math.max(index - (MAX_HISTORY_ENTRIES - 10), 0),
      entries.length - MAX_HISTORY_ENTRIES,
    );
    entries = entries.slice(start, start + MAX_HISTORY_ENTRIES);
    index -= start;
  }
  return { index, entries };
}

/** The history a tab with only an address restores: one entry. */
export function singleEntryHistory(url: string, title: string): TabHistory | null {
  return sanitizeHistory({ index: 0, entries: [{ url, title }] });
}
