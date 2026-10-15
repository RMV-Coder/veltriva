'use strict';
// The §5.4 retrieval query, the FTS MATCH builder, the benchmark query set, and the
// "recent & frequent" (empty query) variants. Shared by the worker and the Electron scripts.

/** §5.4 verbatim. */
const SEARCH_SQL = `
SELECT p.id, p.url, p.title, p.site, p.favicon_id, p.last_visit_at, p.visit_count,
       p.frecency, p.frecency_at, t.id AS tab_id, t.placement,
       bm25(pages_fts, 10.0, 3.0, 5.0)           AS text_rank,
       highlight(pages_fts, 0, char(1), char(2)) AS title_marked
FROM pages_fts
JOIN pages p     ON p.id = pages_fts.rowid
LEFT JOIN tabs t ON t.page_id = p.id AND t.placement <> 'closed'
WHERE pages_fts MATCH :q
ORDER BY text_rank
LIMIT 200`;

/** Cheap counter for "how many rows match" (reporting only; not part of the latency numbers). */
const COUNT_SQL = 'SELECT count(*) AS n FROM pages_fts WHERE pages_fts MATCH :q';

/**
 * Builds the MATCH string from user words: each token double-quoted and prefix-starred
 * ("postgre"* "index"*), implicit AND, FTS5 operator syntax neutralized. Embedded quotes are doubled.
 */
function buildMatch(input) {
  const tokens = input.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
}

// ~30 representative palette queries (lower-case as a user would type). Group = what we report on.
const QUERY_GROUPS = {
  oneToken: ['postgres', 'react', 'docker', 'kubernetes', 'rust', 'tailwind', 'wikipedia', 'youtube', 'election', 'typescript'],
  shortPrefix: ['po', 're', 'do', 'ku', 'pos', 'typ'],
  twoTokens: ['postgres index', 'react hooks', 'docker compose', 'python asyncio', 'rust ownership', 'css grid', 'git rebase', 'post ind'],
  threeTokens: ['how to install', 'react server components', 'postgres index performance', 'docker compose volumes', 'kubernetes ingress tls', 'rust async await'],
};
// Deliberately nasty: match (nearly) every row. Reported separately, not in the headline percentiles.
const STRESS_QUERIES = ['h', 'https', 'com', 'the'];
// Keystroke ladders: what the palette sees while a phrase is typed one character at a time.
const LADDER_PHRASES = ['kubernetes ingress', 'postgres index'];

function ladder(phrase) {
  const steps = [];
  for (let i = 1; i <= phrase.length; i += 1) {
    const prefix = phrase.slice(0, i);
    if (prefix.endsWith(' ')) continue; // a trailing space yields the same MATCH string
    steps.push(prefix);
  }
  return steps;
}

const headline = Object.entries(QUERY_GROUPS).flatMap(([group, qs]) => qs.map((q) => ({ group, q })));

// ---- empty query: "recent & frequent" listing --------------------------------------------------
const HALF_LIFE_MS = 30 * 86_400_000;
const RECENT_COLUMNS = `p.id, p.url, p.title, p.site, p.favicon_id, p.last_visit_at, p.visit_count,
       p.frecency, p.frecency_at, t.id AS tab_id, t.placement`;

const RECENT_VARIANTS = {
  // A: decay at query time with pow(); full scan + sort of every page.
  pow: `SELECT ${RECENT_COLUMNS},
       p.frecency * pow(2.0, -((:now - p.frecency_at) * 1.0 / ${HALF_LIFE_MS})) AS frecency_now
FROM pages p LEFT JOIN tabs t ON t.page_id = p.id AND t.placement <> 'closed'
ORDER BY frecency_now DESC LIMIT 200`,
  // B: same with exp()/ln(2).
  exp: `SELECT ${RECENT_COLUMNS},
       p.frecency * exp(-0.6931471805599453 * (:now - p.frecency_at) / ${HALF_LIFE_MS}.0) AS frecency_now
FROM pages p LEFT JOIN tabs t ON t.page_id = p.id AND t.placement <> 'closed'
ORDER BY frecency_now DESC LIMIT 200`,
  // C: restrict candidates with the last_visit_at index first (last 60 days), then rank by decayed frecency.
  windowed: `SELECT ${RECENT_COLUMNS},
       p.frecency * pow(2.0, -((:now - p.frecency_at) * 1.0 / ${HALF_LIFE_MS})) AS frecency_now
FROM pages p LEFT JOIN tabs t ON t.page_id = p.id AND t.placement <> 'closed'
WHERE p.last_visit_at >= :now - 60 * 86400000
ORDER BY frecency_now DESC LIMIT 200`,
  // D: index-friendly ordering. For one half-life H the decayed value f*2^(-(now-at)/H) orders exactly like
  // log2(f) + at/H (the now/H term is common to every row), so an expression index serves ORDER BY ... LIMIT.
  exprIndex: `SELECT ${RECENT_COLUMNS},
       p.frecency * pow(2.0, -((:now - p.frecency_at) * 1.0 / ${HALF_LIFE_MS})) AS frecency_now
FROM pages p LEFT JOIN tabs t ON t.page_id = p.id AND t.placement <> 'closed'
ORDER BY (log2(p.frecency) + p.frecency_at / ${HALF_LIFE_MS}.0) DESC LIMIT 200`,
};
const RECENT_EXPR_INDEX_SQL = `CREATE INDEX IF NOT EXISTS pages_frecency_key_idx
  ON pages((log2(frecency) + frecency_at / ${HALF_LIFE_MS}.0))`;

// ---- experiment: where does the search time go? Variants of §5.4 (all LIMIT 200) -----------------------------
const BM25 = 'bm25(pages_fts, 10.0, 3.0, 5.0)';
const ROW_COLUMNS = `p.id, p.url, p.title, p.site, p.favicon_id, p.last_visit_at, p.visit_count,
       p.frecency, p.frecency_at, t.id AS tab_id, t.placement`;
const SEARCH_VARIANTS = {
  spec: SEARCH_SQL,
  noHighlight: `SELECT ${ROW_COLUMNS}, ${BM25} AS text_rank
FROM pages_fts JOIN pages p ON p.id = pages_fts.rowid LEFT JOIN tabs t ON t.page_id = p.id AND t.placement <> 'closed'
WHERE pages_fts MATCH :q ORDER BY text_rank LIMIT 200`,
  rankOnly: `SELECT rowid AS id, ${BM25} AS text_rank FROM pages_fts WHERE pages_fts MATCH :q ORDER BY text_rank LIMIT 200`,
  rankThenJoin: `WITH top AS (SELECT rowid AS id, ${BM25} AS text_rank FROM pages_fts WHERE pages_fts MATCH :q ORDER BY text_rank LIMIT 200)
SELECT ${ROW_COLUMNS}, top.text_rank FROM top JOIN pages p ON p.id = top.id
LEFT JOIN tabs t ON t.page_id = p.id AND t.placement <> 'closed' ORDER BY top.text_rank`,
};

/** Approximation of highlight() done in JS on the final 200 rows (marks words that start with a query token). */
function markTitles(rows, input) {
  const tokens = input.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const r of rows) {
    r.title_marked = r.title.replace(/[\p{L}\p{N}]+/gu, (w) => (tokens.some((t) => w.toLowerCase().startsWith(t)) ? '\u0001' + w + '\u0002' : w));
  }
  return rows;
}

module.exports = {
  SEARCH_VARIANTS, markTitles,
  SEARCH_SQL, COUNT_SQL, buildMatch, QUERY_GROUPS, STRESS_QUERIES, LADDER_PHRASES, ladder, headline,
  RECENT_VARIANTS, RECENT_EXPR_INDEX_SQL, HALF_LIFE_MS,
};
