// What the memory palette and the address bar's suggestions say about a search result, derived from
// what `memory.search` returned. Pure, so Vitest covers it; the components only render what this
// returns. A result's title and address are a page's text: they are drawn as text nodes in `<bdi>`
// (marks.ts), and nothing here builds markup.
import type { CommandInput, CommandOutput } from '../../../shared/contracts/schemas';
import { relativeTime } from '../sidebar/placement-display';

// Not imported from state/commands.ts: that file reads `window`, and the unit tests that import
// this one are compiled without a DOM.
export type MemoryScope = CommandInput<'memory.search'>['scope'];
export type MemoryResult = CommandOutput<'memory.search'>['results'][number];
export type MemoryMode = CommandOutput<'memory.search'>['mode'];
export type MemoryTab = MemoryResult['tab'];

/** What a search may carry (the contract's limit; the input field stops there too). */
export const MAX_QUERY_CHARS = 1024;

// ── Filters ─────────────────────────────────────────────────────────────────────────────────────

/** The palette's filters in the order Tab steps through them (assessment §7.3). */
export const PALETTE_SCOPES: readonly { readonly scope: MemoryScope; readonly label: string }[] = [
  { scope: 'all', label: 'All' },
  { scope: 'open', label: 'Open' },
  { scope: 'sleeping', label: 'Sleeping' },
  { scope: 'archived', label: 'Archived' },
  { scope: 'today', label: 'Today' },
  { scope: 'week', label: 'This week' },
];

/** The filter after `scope` (1) or before it (-1), wrapping around at either end. */
export function stepScope(scope: MemoryScope, direction: 1 | -1): MemoryScope {
  const count = PALETTE_SCOPES.length;
  const index = PALETTE_SCOPES.findIndex((entry) => entry.scope === scope);
  const next = (Math.max(index, 0) + direction + count) % count;
  return PALETTE_SCOPES[next]?.scope ?? 'all';
}

// ── The site filter ─────────────────────────────────────────────────────────────────────────────

/** A `site:` word, as main reads it (src/core/search/site-filter.ts). */
const SITE_WORD = /(?:^|\s)site:\S*/giu;

/** The chip's text for the site main kept the results to. */
export function siteChipText(site: string): string {
  return `site: ${site}`;
}

/** The chip's accessible name: it is a button that removes the filter. */
export function siteChipLabel(site: string): string {
  return `Remove the site filter ${site}`;
}

/** The query without its `site:` words (what removing the chip does), with the spaces tidied. */
export function removeSiteWords(query: string): string {
  return query.replace(SITE_WORD, ' ').replace(/\s+/gu, ' ').trim();
}

// ── One result ──────────────────────────────────────────────────────────────────────────────────

export type StateBadge = 'Open' | 'Sleeping' | 'Archived';

/** The text of the badge for the tab showing a page, or null for a page with no tab. */
export function stateBadgeLabel(tab: MemoryTab): StateBadge | null {
  switch (tab?.placement) {
    case 'strip':
      return 'Open';
    case 'shelf':
      return 'Sleeping';
    case 'archive':
      return 'Archived';
    case undefined:
      return null;
  }
}

/** "visited 3 days ago"; null for a page with no visit time. */
export function visitedText(lastVisitAt: number, now: number): string | null {
  if (!Number.isFinite(lastVisitAt) || lastVisitAt <= 0) {
    return null;
  }
  return `visited ${relativeTime(lastVisitAt, now, 'long')}`;
}

/** Shown when a page has neither a title nor an address. */
const UNTITLED = 'Untitled';

/**
 * The line a result goes by: its title, with the title's marks, else its address (no marks: they
 * belong to the title), else "Untitled".
 */
export function displayTitle(result: Pick<MemoryResult, 'title' | 'address' | 'titleRanges'>): {
  readonly text: string;
  readonly ranges: MemoryResult['titleRanges'];
} {
  if (result.title.trim() !== '') {
    return { text: result.title, ranges: result.titleRanges };
  }
  return { text: result.address.trim() === '' ? UNTITLED : result.address, ranges: [] };
}

/** The label of the address bar suggestions' marker for a page that is open in a tab. */
export const SWITCH_TO_TAB_TEXT = 'Switch to tab';

/** Whether a result's tab is in the strip: the address bar then switches to it. */
export function isOpenInStrip(result: Pick<MemoryResult, 'tab'>): boolean {
  return result.tab?.placement === 'strip';
}

/** How `memory.open` is asked to open a suggestion. */
export type SuggestionOpen =
  | { readonly target: 'switch'; readonly tabId: string }
  | { readonly target: 'current'; readonly tabId?: undefined };

/** Enter on a suggestion: switch to the tab that shows the page if it is open, else go there. */
export function suggestionOpenFor(result: Pick<MemoryResult, 'tab'>): SuggestionOpen {
  return result.tab?.placement === 'strip'
    ? { target: 'switch', tabId: result.tab.tabId }
    : { target: 'current' };
}

// ── The score (the debug view, assessment §5.4) ─────────────────────────────────────────────────

/** A score term with two decimals. A tiny negative number is not shown as "-0.00". */
export function formatScore(value: number): string {
  if (!Number.isFinite(value)) {
    return '0.00';
  }
  const text = value.toFixed(2);
  return text === '-0.00' ? '0.00' : text;
}

export interface BreakdownRow {
  readonly key: keyof MemoryResult['breakdown'];
  readonly label: string;
  readonly value: string;
}

const BREAKDOWN_LABELS: readonly { readonly key: BreakdownRow['key']; readonly label: string }[] = [
  { key: 'text', label: 'Text match' },
  { key: 'frecency', label: 'Frecency' },
  { key: 'titleExact', label: 'Title words' },
  { key: 'siteMatch', label: 'Site' },
  { key: 'state', label: 'Tab state' },
];

/** The five weighted terms of a result's score, in the order they add up, and the score. */
export function scoreBreakdown(result: Pick<MemoryResult, 'breakdown' | 'score'>): {
  readonly rows: readonly BreakdownRow[];
  readonly total: string;
} {
  return {
    rows: BREAKDOWN_LABELS.map(({ key, label }) => ({
      key,
      label,
      value: formatScore(result.breakdown[key]),
    })),
    total: formatScore(result.score),
  };
}

// ── Empty states and announcements ──────────────────────────────────────────────────────────────

/** What the list says when there is nothing to list. */
export function emptyMessage(mode: MemoryMode): string {
  return mode === 'text' ? 'No pages match' : 'Nothing remembered yet';
}

/** The live region's text: how many results the list has now. */
export function resultsAnnouncement(count: number, mode: MemoryMode): string {
  if (count === 0) {
    return emptyMessage(mode);
  }
  return count === 1 ? '1 result' : `${String(count)} results`;
}
