'use strict';
// S5.2 follow-up — where does the §5.4 query spend its time, and what does the design gain by restructuring it?
// Variants (all LIMIT 200, better-sqlite3, in-worker timings, 30 headline queries, fresh DB per repetition):
//   spec          the query exactly as written in §5.4
//   noHighlight   same, without the highlight() column
//   rankOnly      MATCH + bm25 + ORDER BY + LIMIT, no joins
//   rankThenJoin  rank in a CTE (LIMIT 200), then join pages/tabs for only those 200 rows
//   rankThenJoin+jsHighlight  as above, plus title marking done in JavaScript on the 200 rows
// Run (from /spikes):  timeout 900 ./node_modules/.bin/electron s5-data-stack/s5e-query-variants.js

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../shared/harness');
const { DbClient } = require('./lib/db-client');
const Q = require('./lib/queries');
const { summarize, medianAcross, medianOf, round, median } = require('./lib/stats');

h.prepareApp(__dirname);
h.failSafe(Number(process.env.S5_FAILSAFE_MS ?? 900_000), 's5e');

const SCALES = (process.env.S5_SCALES ?? '10000,50000').split(',').map(Number);
const REPS = Number(process.env.S5_REPS ?? 3);
const queries = Q.headline.map((x) => x.q);
const rmDb = (file) => ['', '-wal', '-shm'].forEach((s) => fs.rmSync(file + s, { force: true }));

const VARIANTS = {
  spec: Q.SEARCH_VARIANTS.spec,
  noHighlight: Q.SEARCH_VARIANTS.noHighlight,
  rankOnly: Q.SEARCH_VARIANTS.rankOnly,
  rankThenJoin: Q.SEARCH_VARIANTS.rankThenJoin,
  'rankThenJoin+jsHighlight': { sql: Q.SEARCH_VARIANTS.rankThenJoin, post: 'jsHighlight' },
};

app.whenReady().then(async () => {
  const rows = [];
  const results = { reps: REPS, scales: SCALES, passes: 15, perScale: {} };
  for (const scale of SCALES) {
    const file = path.join(__dirname, `variants-${scale}.db`);
    const perRep = [];
    let matches = null;
    for (let rep = 1; rep <= REPS; rep += 1) {
      rmDb(file);
      let w = new DbClient();
      await w.ready;
      await w.call('open', { file });
      await w.call('load', { pages: scale, seed: 20261016, tabs: 300, batchSize: 1000 });
      await w.call('sizes', { breakdown: false });
      await w.close();
      w = new DbClient();
      await w.ready;
      await w.call('open', { file });
      if (!matches) matches = Object.fromEntries((await w.call('bench', { queries, passes: 1, warmupPasses: 0 })).map((i) => [i.q, i.matches]));
      const res = await w.call('benchSql', { variants: VARIANTS, queries, passes: 15, warmupPasses: 2 });
      await w.close();
      perRep.push(res);
      console.log(`  scale=${scale} rep=${rep}: ${Object.entries(res).map(([n, items]) => `${n} p50=${summarize(items.flatMap((i) => i.samples)).p50}`).join('  ')}`);
    }
    const agg = {};
    for (const name of Object.keys(VARIANTS)) {
      agg[name] = medianAcross(perRep.map((r) => summarize(r[name].flatMap((i) => i.samples))));
    }
    // Per-query p50 for the §5.4 query against match count: gives the cost per matching row.
    const perQuery = queries.map((q, i) => {
      const spec = round(median(perRep.map((r) => summarize(r.spec[i].samples).p50)));
      const rtj = round(median(perRep.map((r) => summarize(r.rankThenJoin[i].samples).p50)));
      return { q, matches: matches[q], specP50: spec, rankThenJoinP50: rtj };
    });
    const bigOnes = perQuery.filter((p) => p.matches >= 1000);
    const usPerMatch = bigOnes.length ? round(median(bigOnes.map((p) => (p.specP50 * 1000) / p.matches)), 2) : null;
    results.perScale[scale] = { variants: agg, perQuery: perQuery.sort((a, b) => b.matches - a.matches), microsecondsPerMatchSpec: usPerMatch };
    h.record(rows, `§5.4 variants @ ${scale} pages (pooled over 30 queries; medians of ${REPS} runs)`,
      Object.fromEntries(Object.entries(agg).map(([n, a]) => [n, [a.p50.median, a.p95.median, a.p99.median]])), null, 'values are [p50, p95, p99] ms in-worker');
  }
  h.writeResults(__dirname, 's5e-query-variants', results);
  app.exit(0);
}).catch((e) => {
  console.error('s5e failed:', e);
  app.exit(2);
});
