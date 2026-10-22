// What the activity log view says (assessment §4.12: "every automatic action is logged locally
// with the rule that triggered it"), derived from the entries main keeps. Pure, so Vitest covers
// it; the component only renders what this returns.
//
// A tab's title and address in an entry are a page's text, so they are treated as the prompt strip
// treats a site (./prompts/prompt-display.ts): controls and invisible formatting (bidi overrides
// included) are removed here, the text is cut at its END (an address starts with its host), and
// the component renders both in `<bdi dir="ltr">`.
import type { ActivityEntry } from '../../../shared/contracts/activity';
import { cleanText, truncateEnd } from '../prompts/prompt-display';

/** A title is shown with at most this many characters, ellipsis included. */
export const MAX_TITLE_CHARS = 80;
/** An address is shown with at most this many characters, ellipsis included. */
export const MAX_ADDRESS_CHARS = 100;

/** The words for what happened, and why. `rule` is null for the user's undo. */
export function activitySentence(
  entry: Pick<ActivityEntry, 'action' | 'rule' | 'pressure'>,
): string {
  switch (entry.action) {
    case 'discard':
      if (entry.rule === 'pressure-discard') {
        // Plainly memory pressure, as the tab's tooltip says (§4.13).
        return entry.pressure === 'critical'
          ? 'Unloaded because memory was very low'
          : 'Unloaded because memory was low';
      }
      return entry.rule === 'discard-hidden' ? 'Unloaded — not used for a while' : 'Unloaded';
    case 'freeze':
      return 'Paused in the background';
    case 'shelve':
      return entry.rule === 'shelve-beyond-cap'
        ? 'Moved to Sleeping — too many open tabs'
        : 'Moved to Sleeping';
    case 'archive':
      return entry.rule === 'archive-dormant' ? 'Archived — not used for days' : 'Archived';
    case 'undo':
      return 'You undid this';
  }
}

/** Short month names, for a date in the user's words ("21 Oct"). */
export const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * When it happened, in the user's local time, as short as the day allows: "14:32" today,
 * "Yesterday 14:32", "21 Oct 14:32" this year, "21 Oct 2025 14:32" before. Empty for a time that
 * is not a date.
 */
export function activityTimeText(at: number, now: number): string {
  const date = new Date(at);
  const today = new Date(now);
  if (Number.isNaN(date.getTime()) || Number.isNaN(today.getTime())) {
    return '';
  }
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (sameDay(date, today)) {
    return time;
  }
  if (sameDay(date, new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1))) {
    return `Yesterday ${time}`;
  }
  const day = `${String(date.getDate())} ${MONTHS[date.getMonth()] ?? ''}`;
  return date.getFullYear() === today.getFullYear()
    ? `${day} ${time}`
    : `${day} ${String(date.getFullYear())} ${time}`;
}

/** One run of untrusted text: what to draw, and the whole of it when it was cut. */
export interface UntrustedText {
  readonly text: string;
  /** The tooltip: the whole text, when `text` is a shortened form of it. */
  readonly full: string | undefined;
}

function shown(raw: string, maxChars: number): UntrustedText {
  const full = cleanText(raw);
  const text = truncateEnd(full, maxChars);
  return { text, full: text === full ? undefined : full };
}

export interface ActivityRowView {
  readonly id: number;
  /** "Unloaded — not used for a while". */
  readonly sentence: string;
  /** "14:32". */
  readonly time: string;
  /** The tab's title; its address when it had none; "Untitled" when it had neither. */
  readonly title: UntrustedText;
  /** The tab's address, or null when the title already is the address (or there is none). */
  readonly address: UntrustedText | null;
}

/** An entry as the view draws it. */
export function activityRowView(entry: ActivityEntry, now: number): ActivityRowView {
  const title = shown(entry.title, MAX_TITLE_CHARS);
  const address = shown(entry.address, MAX_ADDRESS_CHARS);
  const untitled = title.text === '';
  return {
    id: entry.id,
    sentence: activitySentence(entry),
    time: activityTimeText(entry.at, now),
    title: untitled
      ? address.text === ''
        ? { text: 'Untitled', full: undefined }
        : address
      : title,
    address: untitled || address.text === '' ? null : address,
  };
}

/**
 * A string that changes whenever the log has grown: main's `activityVersion` (the newest entry's
 * id) changes with every entry. The open view fetches the log again when it changes.
 */
export function activityRefreshKey(source: { readonly activityVersion: number } | null): string {
  return source === null ? '' : String(source.activityVersion);
}
