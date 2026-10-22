// Ranking v1 (assessment §5.4): the data worker retrieves at most 200 candidates by FTS5's bm25,
// and this re-scores them with what bm25 can't see. Pure and explainable: every result carries
// each term of its score, which the palette's debug view and the golden-set tests read.
//
//   score = 1.0 · text        (bm25 over the best candidate's: the best 1, half as good 0.5)
//         + 0.6 · log1p(frecencyNow)
//         + 0.4 · titleExact  (every word starts a word of the title)
//         + 0.3 · siteMatch   (a word equals the site's label: `github` for github.com)
//         + state boost       (open in Tabs +0.5 · Sleeping +0.3 · Archived +0.2)
import { decayedFrecency } from './frecency';
import { titleHasEveryWord, titleRanges } from './highlight';
import type { TextRange } from './highlight';

export const RANKING_WEIGHTS = {
  text: 1,
  frecency: 0.6,
  titleExact: 0.4,
  siteMatch: 0.3,
} as const;

/** Where a result's tab lives: the strip (Tabs), the shelf (Sleeping) or the archive. */
export const SEARCH_PLACEMENTS = ['strip', 'shelf', 'archive'] as const;
export type SearchPlacement = (typeof SEARCH_PLACEMENTS)[number];

export const STATE_BOOST: Readonly<Record<SearchPlacement, number>> = {
  strip: 0.5,
  shelf: 0.3,
  archive: 0.2,
};

/** One row the worker retrieved: a page, and the tab showing it, if any. */
export interface SearchCandidate {
  readonly pageId: number;
  readonly url: string;
  readonly title: string;
  readonly site: string;
  readonly faviconId: number | null;
  readonly lastVisitAt: number;
  readonly visitCount: number;
  readonly frecency: number;
  readonly frecencyAt: number;
  readonly tabId: string | null;
  readonly placement: SearchPlacement | null;
  /** FTS5's bm25 with §5.4's column weights, lower is better; null in the recent list. */
  readonly textRank: number | null;
}

/** Each weighted term of a score; they add up to it. */
export interface ScoreBreakdown {
  readonly text: number;
  readonly frecency: number;
  readonly titleExact: number;
  readonly siteMatch: number;
  readonly state: number;
  /** The raw inputs, for explaining a result. */
  readonly bm25: number | null;
  readonly frecencyNow: number;
}

export interface RankedResult extends SearchCandidate {
  readonly score: number;
  readonly breakdown: ScoreBreakdown;
  /** Where the words start words of the title (highlight.ts). */
  readonly titleRanges: readonly TextRange[];
}

/** The site's first label: `github` for github.com, `bbc` for bbc.co.uk (a site is eTLD+1). */
export function siteLabel(site: string): string {
  return site.split('.')[0] ?? '';
}

const PLACEMENT_ORDER: Readonly<Record<SearchPlacement, number>> = {
  strip: 0,
  shelf: 1,
  archive: 2,
};

/**
 * Scores and sorts the candidates for `words` (SearchQuery.words) at `now`, and returns the best
 * `limit` of them (all by default), titles marked. Ties go to the more recently visited page,
 * then the lower page id, then the tab nearer the strip, then the tab id, so the order never
 * depends on how SQLite returned the rows. Only the returned results are marked: marking is the
 * costly part, and the worker returns 50 of 200 (measured in M4.1: marking all 200 took
 * 17–35 ms at 10k pages on the reference laptop).
 */
export function rankCandidates(
  candidates: readonly SearchCandidate[],
  words: readonly string[],
  now: number,
  limit = Number.POSITIVE_INFINITY,
): RankedResult[] {
  // FTS5's bm25 is never positive: the more relevant, the more negative. Dividing by the best
  // keeps proportions, so two near-equal matches stay near-equal (stretching the candidates'
  // range to 0–1 would turn a rounding difference into a whole point).
  let best = 0;
  for (const { textRank } of candidates) {
    if (textRank !== null && Number.isFinite(textRank)) {
      best = Math.min(best, textRank);
    }
  }

  const scored = candidates.map((candidate): Omit<RankedResult, 'titleRanges'> => {
    const rank = candidate.textRank;
    const textScore =
      rank === null || !Number.isFinite(rank)
        ? 0
        : best === 0
          ? rank === 0
            ? 1
            : 0
          : Math.min(1, Math.max(0, rank / best));
    const frecencyNow = decayedFrecency(candidate.frecency, candidate.frecencyAt, now);
    const label = siteLabel(candidate.site).toLowerCase();
    const breakdown: ScoreBreakdown = {
      text: RANKING_WEIGHTS.text * textScore,
      frecency: RANKING_WEIGHTS.frecency * Math.log1p(frecencyNow),
      titleExact: titleHasEveryWord(candidate.title, words) ? RANKING_WEIGHTS.titleExact : 0,
      siteMatch: label.length > 0 && words.includes(label) ? RANKING_WEIGHTS.siteMatch : 0,
      state: candidate.placement === null ? 0 : STATE_BOOST[candidate.placement],
      bm25: rank,
      frecencyNow,
    };
    return {
      ...candidate,
      score:
        breakdown.text +
        breakdown.frecency +
        breakdown.titleExact +
        breakdown.siteMatch +
        breakdown.state,
      breakdown,
    };
  });

  return scored
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.lastVisitAt - a.lastVisitAt ||
        a.pageId - b.pageId ||
        (a.placement === null ? 3 : PLACEMENT_ORDER[a.placement]) -
          (b.placement === null ? 3 : PLACEMENT_ORDER[b.placement]) ||
        compareText(a.tabId ?? '', b.tabId ?? ''),
    )
    .slice(0, limit)
    .map((result) => ({ ...result, titleRanges: titleRanges(result.title, words) }));
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
