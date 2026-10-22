// What the sidebar's Sleeping and Archive sections say, derived from the workspace snapshot's
// `counts`, `sleeping` and `archived`. Pure, so Vitest covers it; the components only render what
// this returns.
import type { WorkspaceSnapshot } from '../../../shared/contracts/schemas';

export type PlacementCounts = WorkspaceSnapshot['counts'];
export type ArchivedTab = WorkspaceSnapshot['archived'][number];

/**
 * A list shows this many rows, then a "Show more" button. A user can have a thousand Sleeping
 * tabs, and a few hundred rows is as many as the sidebar draws at once without a virtual list.
 */
export const ROWS_PER_PAGE = 200;

// ── Counts (assessment §4.13: "Sleeping 12 · Archived today 3") ─────────────────────────────────

/** The line under the sections, visible whether they are open or not. */
export function countsLine(counts: Pick<PlacementCounts, 'sleeping' | 'archivedToday'>): string {
  return `Sleeping ${String(counts.sleeping)} · Archived today ${String(counts.archivedToday)}`;
}

/** The first line of the open Archive section: today's number and the total. */
export function archiveSummary(
  counts: Pick<PlacementCounts, 'archived' | 'archivedToday'>,
): string {
  return `Archived today ${String(counts.archivedToday)} · ${String(counts.archived)} in total`;
}

/**
 * Said under "Recently archived" when the list holds fewer tabs than the Archive does (main lists
 * only the newest), so the number in the header is not mistaken for the number of rows. Null when
 * every archived tab is listed.
 */
export function archiveListNote(listed: number, total: number): string | null {
  return listed < total ? `Showing the newest ${String(listed)} of ${String(total)}` : null;
}

/** "1 tab", "12 tabs". */
export function tabCount(count: number): string {
  return count === 1 ? '1 tab' : `${String(count)} tabs`;
}

/** What a screen reader hears after the Archive section's name. */
export function archiveCountText(
  counts: Pick<PlacementCounts, 'archived' | 'archivedToday'>,
): string {
  return `${tabCount(counts.archived)} in total, ${String(counts.archivedToday)} archived today`;
}

// ── Open and closed ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether a section is open. `choice` is what the user chose, or null before they did, and then
 * `fallback` decides: Sleeping opens while something sleeps, the Archive stays closed.
 */
export function isSectionExpanded(choice: boolean | null, fallback: boolean): boolean {
  return choice ?? fallback;
}

// ── Long lists ──────────────────────────────────────────────────────────────────────────────────

export interface RowWindow {
  /** The rows to draw: the first `shown` of the list. */
  readonly shown: number;
  /** The rows behind the "Show more" button. */
  readonly remaining: number;
  /** How many one press of "Show more" adds. */
  readonly step: number;
}

/** The part of a list of `total` rows to draw while the user has asked for `limit`. */
export function rowWindow(total: number, limit: number): RowWindow {
  const shown = Math.max(0, Math.min(total, limit));
  const remaining = total - shown;
  return { shown, remaining, step: Math.min(ROWS_PER_PAGE, remaining) };
}

// ── When ────────────────────────────────────────────────────────────────────────────────────────

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "min" or "minute(s)", for the short and the long form of a time. */
const UNITS = {
  minute: { short: 'min', long: ['minute', 'minutes'] },
  hour: { short: 'h', long: ['hour', 'hours'] },
  day: { short: 'd', long: ['day', 'days'] },
  month: { short: 'mo', long: ['month', 'months'] },
  year: { short: 'y', long: ['year', 'years'] },
} as const;

function ago(count: number, unit: keyof typeof UNITS, style: 'short' | 'long'): string {
  const names = UNITS[unit];
  if (style === 'short') {
    return `${String(count)} ${names.short} ago`;
  }
  return `${String(count)} ${count === 1 ? names.long[0] : names.long[1]} ago`;
}

/**
 * How long ago `at` was, at `now` (both Unix milliseconds): "just now", "5 min ago", "2 h ago",
 * "3 d ago", "2 mo ago", "1 y ago". `long` spells the units out for a screen reader. A time in the
 * future (the clock was set back) reads as "just now". Whole units, rounded down.
 */
export function relativeTime(at: number, now: number, style: 'short' | 'long' = 'short'): string {
  const elapsed = now - at;
  if (!Number.isFinite(elapsed) || elapsed < MINUTE) {
    return 'just now';
  }
  if (elapsed < HOUR) {
    return ago(Math.floor(elapsed / MINUTE), 'minute', style);
  }
  if (elapsed < DAY) {
    return ago(Math.floor(elapsed / HOUR), 'hour', style);
  }
  const days = Math.floor(elapsed / DAY);
  if (days < 30) {
    return ago(days, 'day', style);
  }
  if (days < 365) {
    return ago(Math.floor(days / 30), 'month', style);
  }
  return ago(Math.floor(days / 365), 'year', style);
}

/** Who archived the tab, in the secondary line of an archived row. */
const ARCHIVED_BY: Readonly<Record<ArchivedTab['reason'], string>> = {
  auto: 'by automation',
  manual: 'by you',
};

/** The secondary line of an archived row: "2 h ago · by automation". */
export function archivedMeta(tab: Pick<ArchivedTab, 'archivedAt' | 'reason'>, now: number): string {
  return `${relativeTime(tab.archivedAt, now)} · ${ARCHIVED_BY[tab.reason]}`;
}

/** The same in words, for a screen reader: "Archived 2 hours ago by automation". */
export function archivedDescription(
  tab: Pick<ArchivedTab, 'archivedAt' | 'reason'>,
  now: number,
): string {
  const when = relativeTime(tab.archivedAt, now, 'long');
  // "just now" reads "Archived just now by you"; the others "Archived 2 hours ago by you".
  return `Archived ${when} ${ARCHIVED_BY[tab.reason]}`;
}

/** What clicking a Sleeping or archived row does. */
export const RESTORE_HINT = 'click to bring it back to Tabs';

/** An archived tab's label: its title, else its address, else "Untitled" (as a tab row's is). */
export function archivedLabel(
  tab: Pick<ArchivedTab, 'title'> & { address: { text: string } },
): string {
  const title = tab.title.trim();
  if (title !== '') {
    return title;
  }
  const address = tab.address.text.trim();
  return address === '' ? 'Untitled' : address;
}

export interface ArchivedRowText {
  readonly label: string;
  /** "2 h ago · by automation". */
  readonly meta: string;
  /** The row's tooltip: the label, then when, who and what a click does. */
  readonly tooltip: string;
  /** What a screen reader hears after the label. */
  readonly description: string;
}

/** The words of an archived row at `now`. */
export function archivedRowText(
  tab: Pick<ArchivedTab, 'title' | 'archivedAt' | 'reason'> & { address: { text: string } },
  now: number,
): ArchivedRowText {
  const label = archivedLabel(tab);
  const description = archivedDescription(tab, now);
  return {
    label,
    meta: archivedMeta(tab, now),
    // The label is a page's text: its line breaks are folded, so it cannot fake a line of ours.
    tooltip: `${label.replace(LINE_BREAKS, ' ')}\n${description} — ${RESTORE_HINT}`,
    description: `${description}. Click to bring it back to Tabs`,
  };
}

/** Line breaks in all their forms, and the other controls (a tab stop) that have no place in a line. */
const LINE_BREAKS = /[\p{Cc}\p{Zl}\p{Zp}]+/gu;
