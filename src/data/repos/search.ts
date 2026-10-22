// Searching the memory (assessment §5.4). Retrieval ranks first, by FTS5's bm25 with the title,
// address and site weighted 10, 3 and 5, and keeps the best CANDIDATES; only those are joined to
// their pages and to the tabs showing them (closed tabs never are). Ranking v1
// (core/search/ranking.ts) then re-scores them and marks their titles, so main receives the
// results in order, each with its score's terms.
//
// Input shorter than a 2-character word gets the recent-and-frequent list instead: pages by
// decayed frecency (the expression index in 0001_init.sql), plus the pages open in the strip.
//
// The SQL never contains the user's text: the MATCH expression and every filter are bound
// parameters, and core/search/query.ts builds the expression so it can only mean "these words".
import type { DatabaseConnection, Statement } from 'better-sqlite3/win32-x64';

import { parseSearchInput } from '../../core/search/query';
import { rankCandidates } from '../../core/search/ranking';
import type { SearchCandidate, SearchPlacement } from '../../core/search/ranking';
import type { DataOutput } from '../../shared/contracts/data-rpc';
import type { HandlerInput, RepositoryHandlers } from '../handlers';

/** Retrieval's limit (§5.4, S5: ranking first and joining 200 took the 50k p95 from 25 to 11 ms). */
export const CANDIDATES = 200;

type Filter = NonNullable<HandlerInput<'search.query'>['filter']>;
type Mode = 'text' | 'recent';

/** The decayed-frecency order, exactly as pages_frecency_idx is written, so the index serves it. */
const BY_FRECENCY = 'log2(frecency) + frecency_at / 2592000000.0 DESC';

const COLUMNS = `p.id AS pageId, p.url, p.title, p.site, p.favicon_id AS faviconId,
  p.last_visit_at AS lastVisitAt, p.visit_count AS visitCount, p.frecency,
  p.frecency_at AS frecencyAt, t.id AS tabId, t.placement`;

/** The filters' SQL, all bound: which pages a candidate may be. */
function pageConditions(filter: Filter, column: string): string[] {
  const conditions: string[] = [];
  if (filter.placement !== undefined) {
    conditions.push(
      `${column} IN (SELECT page_id FROM tabs WHERE placement = @placement AND page_id IS NOT NULL)`,
    );
  }
  if (filter.site !== undefined) {
    conditions.push(`${column} IN (SELECT id FROM pages WHERE site = @site)`);
  }
  if (filter.visitedSince !== undefined) {
    conditions.push(`${column} IN (SELECT id FROM pages WHERE last_visit_at >= @visitedSince)`);
  }
  return conditions;
}

/** With a placement filter, only the tabs in it; otherwise any tab that isn't closed. */
function tabJoin(filter: Filter): string {
  return filter.placement === undefined
    ? "LEFT JOIN tabs t ON t.page_id = p.id AND t.placement <> 'closed'"
    : 'JOIN tabs t ON t.page_id = p.id AND t.placement = @placement';
}

function textSql(filter: Filter): string {
  const conditions = ['pages_fts MATCH @match', ...pageConditions(filter, 'rowid')];
  return `
    WITH ranked AS (
      SELECT rowid AS id, bm25(pages_fts, 10.0, 3.0, 5.0) AS textRank
      FROM pages_fts
      WHERE ${conditions.join(' AND ')}
      ORDER BY textRank
      LIMIT ${String(CANDIDATES)}
    )
    SELECT ${COLUMNS}, r.textRank
    FROM ranked r
    JOIN pages p ON p.id = r.id
    ${tabJoin(filter)}
    ORDER BY r.textRank`;
}

function recentSql(filter: Filter): string {
  const conditions = pageConditions(filter, 'id');
  const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
  // The strip's pages come too, unless a filter asks for something else: an open tab is always
  // worth offering. Their number is bounded by the strip.
  const strip =
    filter.placement === undefined && filter.site === undefined && filter.visitedSince === undefined
      ? `UNION SELECT page_id FROM tabs WHERE placement = 'strip' AND page_id IS NOT NULL`
      : '';
  return `
    WITH ranked AS (
      SELECT id FROM (
        SELECT id FROM pages ${where} ORDER BY ${BY_FRECENCY} LIMIT ${String(CANDIDATES)}
      )
      ${strip}
    )
    SELECT ${COLUMNS}, NULL AS textRank
    FROM ranked r
    JOIN pages p ON p.id = r.id
    ${tabJoin(filter)}`;
}

interface Row extends Omit<SearchCandidate, 'placement'> {
  readonly placement: string | null;
}

function isPlacement(value: string | null): value is SearchPlacement {
  return value === 'strip' || value === 'shelf' || value === 'archive';
}

type SearchResult = DataOutput<'search.query'>['results'][number];

export function searchHandlers(db: DatabaseConnection): Pick<RepositoryHandlers, 'search.query'> {
  // One prepared statement per mode and filter combination, prepared on first use.
  const statements = new Map<string, Statement>();
  const statementFor = (mode: Mode, filter: Filter): Statement => {
    const key = `${mode}:${filter.placement === undefined ? '' : 'p'}${filter.site === undefined ? '' : 's'}${filter.visitedSince === undefined ? '' : 't'}`;
    let statement = statements.get(key);
    if (statement === undefined) {
      statement = db.prepare(mode === 'text' ? textSql(filter) : recentSql(filter));
      statements.set(key, statement);
    }
    return statement;
  };

  return {
    'search.query': ({ query, now, limit, filter = {} }) => {
      const parsed = parseSearchInput(query);
      const mode: Mode = parsed.match === null ? 'recent' : 'text';
      const rows = statementFor(mode, filter).all({
        ...(parsed.match === null ? {} : { match: parsed.match }),
        ...(filter.placement === undefined ? {} : { placement: filter.placement }),
        ...(filter.site === undefined ? {} : { site: filter.site }),
        ...(filter.visitedSince === undefined ? {} : { visitedSince: filter.visitedSince }),
      }) as Row[];
      const candidates: SearchCandidate[] = rows.map((row) => ({
        ...row,
        placement: isPlacement(row.placement) ? row.placement : null,
        tabId: isPlacement(row.placement) ? row.tabId : null,
      }));
      const results = rankCandidates(candidates, parsed.words, now, limit).map(
        (result): SearchResult => ({
          pageId: result.pageId,
          url: result.url,
          title: result.title,
          site: result.site,
          faviconId: result.faviconId,
          lastVisitAt: result.lastVisitAt,
          visitCount: result.visitCount,
          tab:
            result.tabId === null || result.placement === null
              ? null
              : { id: result.tabId, placement: result.placement },
          score: result.score,
          breakdown: result.breakdown,
          titleRanges: result.titleRanges.map(([start, end]) => [start, end] as const),
        }),
      );
      return { mode, results };
    },
  };
}
