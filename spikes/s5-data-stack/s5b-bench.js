'use strict';
// S5.2 / S5.3 — insert throughput, DB size, §5.4 search latency (in-worker and main round-trip), recent&frequent listing.
// One script for both drivers; configure with environment variables:
//   S5_DRIVER   better-sqlite3 (default) | node:sqlite
//   S5_SCALES   comma list of page counts   (default 1000,10000,50000)
//   S5_REPS     repetitions per scale       (default 3; each rep rebuilds the DB, uses fresh workers)
//   S5_CACHE_KB page-cache override in KiB  (default 0 = driver default)
//   S5_TAG      suffix for the results file (default none)
//   S5_EXTRAS   1 = also run the "load without FTS triggers + rebuild" experiment (better-sqlite3 only)
// Run (from /spikes):  S5_DRIVER=better-sqlite3 ./node_modules/.bin/electron s5-data-stack/s5b-bench.js

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../shared/harness');
const { DbClient } = require('./lib/db-client');
const Q = require('./lib/queries');
const { NOW } = require('./lib/datagen');
const { summarize, medianAcross, medianOf, round, median } = require('./lib/stats');

h.prepareApp(__dirname);
h.failSafe(Number(process.env.S5_FAILSAFE_MS ?? 1_500_000), 's5b');

const DRIVER = process.env.S5_DRIVER ?? 'better-sqlite3';
const SCALES = (process.env.S5_SCALES ?? '1000,10000,50000').split(',').map(Number);
const REPS = Number(process.env.S5_REPS ?? 3);
const CACHE_KB = Number(process.env.S5_CACHE_KB ?? 0);
const TAG = process.env.S5_TAG ? `-${process.env.S5_TAG}` : '';
const PASSES = 20;
const SEED = 20261016;
const slug = DRIVER.replace(':', '-');

const rmDb = (file) => ['', '-wal', '-shm'].forEach((s) => fs.rmSync(file + s, { force: true }));
const groupOf = new Map(Q.headline.map(({ group, q }) => [q, group]));
const pooled = (items) => items.flatMap((i) => i.samples);

async function fresh() {
  const c = new DbClient({ driver: DRIVER });
  await c.ready;
  return c;
}

/** Per-group + overall summaries from bench() output. */
function summarizeBench(items, { withGroups = true } = {}) {
  const out = { all: summarize(pooled(items)) };
  if (withGroups) {
    out.groups = {};
    for (const g of Object.keys(Q.QUERY_GROUPS)) out.groups[g] = summarize(pooled(items.filter((i) => groupOf.get(i.q) === g)));
  }
  out.perQueryP50 = Object.fromEntries(items.map((i) => [i.q, summarize(i.samples).p50]));
  return out;
}

async function oneRep(scale, rep) {
  const file = path.join(__dirname, `bench-${slug}${TAG}-${scale}.db`);
  rmDb(file);
  const record = { scale, rep };

  // --- build ---
  let w = await fresh();
  const open = await w.call('open', { file, cacheKB: CACHE_KB });
  record.open = { sqlite: open.sqliteVersion, pragmas: open.pragmas, compile: open.compile };
  const load = await w.call('load', { pages: scale, seed: SEED, tabs: 300, batchSize: 1000 });
  record.load = {
    generateMs: round(load.generateMs, 0), insertMs: round(load.insertMs, 0), pagesVisitsMs: round(load.pagesVisitsMs, 0), tabsMs: round(load.tabsMs, 1),
    pages: load.pages, visits: load.visits, tabs: load.tabs, visitsPerPage: round(load.visitsPerPage, 2), distinctSites: load.distinctSites,
    pagesPerSec: round(load.pagesPerSec, 0), totalRowsPerSec: round(load.totalRowsPerSec, 0), batchMsMedian: round(load.batchMsMedian, 1),
  };
  const sizes = await w.call('sizes', { breakdown: rep === 1 });
  record.size = { dbBytes: sizes.dbBytes, walBytes: sizes.walBytes, checkpointMs: round(sizes.checkpointMs, 1), bytesPerPage: round(sizes.dbBytes / scale, 0) };
  if (rep === 1) record.size.byGroup = sizes.byGroup;
  if (rep === 1) {
    const integ = await w.call('integrity');
    record.integrity = { quick: integ.quick[0], ftsOk: integ.ftsOk, ftsDocsize: integ.ftsDocsize };
  }
  await w.close();

  // --- query phase: fresh worker, existing file (cold connection, warm OS file cache) ---
  w = await fresh();
  await w.call('open', { file, cacheKB: CACHE_KB });
  const cold = await w.timed('search', { q: 'postgres' });
  record.coldFirstQuery = { rttMs: round(cold.rttMs), innerMs: round(cold.result.innerMs) };

  const headlineQs = Q.headline.map((x) => x.q);
  // in-worker
  const inWorker = await w.call('bench', { queries: headlineQs, passes: PASSES, warmupPasses: 2 });
  record.inWorker = summarizeBench(inWorker);
  if (rep === 1) record.matchCounts = Object.fromEntries(inWorker.map((i) => [i.q, i.matches]));
  const stress = await w.call('bench', { queries: Q.STRESS_QUERIES, passes: 10, warmupPasses: 1 });
  record.inWorkerStress = Object.fromEntries(stress.map((i) => [i.q, { matches: i.matches, ...summarize(i.samples) }]));
  const ladders = {};
  for (const phrase of Q.LADDER_PHRASES) {
    const steps = Q.ladder(phrase);
    const res = await w.call('bench', { queries: steps, passes: 10, warmupPasses: 1 });
    ladders[phrase] = res.map((r, i) => ({ chars: steps[i].length, p50: summarize(r.samples).p50, matches: r.matches }));
  }
  record.ladder = ladders;

  // round trip from main over postMessage (rows included, structured-cloned)
  for (let i = 0; i < 2; i += 1) for (const q of headlineQs) await w.call('search', { q });
  const rtt = Q.headline.map(({ q }) => ({ q, samples: [], inner: [] }));
  for (let pass = 0; pass < PASSES; pass += 1) {
    for (let i = 0; i < rtt.length; i += 1) {
      const t = await w.timed('search', { q: rtt[i].q });
      rtt[i].samples.push(t.rttMs);
      rtt[i].inner.push(t.result.innerMs);
    }
  }
  record.roundTrip = summarizeBench(rtt);
  record.roundTripInnerOnly = summarize(pooled(rtt.map((r) => ({ samples: r.inner }))));
  const stressRtt = {};
  for (const q of Q.STRESS_QUERIES) {
    const s = [];
    for (let i = 0; i < 10; i += 1) s.push((await w.timed('search', { q })).rttMs);
    stressRtt[q] = summarize(s);
  }
  record.roundTripStress = stressRtt;

  // empty-query recent & frequent
  const recent = {};
  for (const variant of ['pow', 'exp', 'windowed']) {
    const r = await w.call('recent', { variant, now: NOW, reps: 30, warmup: 3 });
    const rtts = [];
    for (let i = 0; i < 15; i += 1) rtts.push((await w.timed('recent', { variant, now: NOW, reps: 1, warmup: 0, returnRows: true })).rttMs);
    recent[variant] = { rows: r.rows, top: r.top, inWorker: summarize(r.samples), roundTrip: summarize(rtts), plan: rep === 1 ? r.plan : undefined };
  }
  record.recent = recent;

  // write path (before the extra index exists, then with it)
  const flush = await w.call('flushBench', { n: 200, now: NOW });
  record.flushTxn = summarize(flush.samples);
  const r = await w.call('recent', { variant: 'exprIndex', now: NOW, reps: 30, warmup: 3 });
  const rtts = [];
  for (let i = 0; i < 15; i += 1) rtts.push((await w.timed('recent', { variant: 'exprIndex', now: NOW, reps: 1, warmup: 0, returnRows: true })).rttMs);
  record.recent.exprIndex = {
    rows: r.rows, top: r.top, inWorker: summarize(r.samples), roundTrip: summarize(rtts), indexBuildMs: round(r.indexBuildMs, 1), plan: rep === 1 ? r.plan : undefined,
  };
  record.recent.compare = await w.call('recentCompare', { now: NOW });
  const flush2 = await w.call('flushBench', { n: 200, now: NOW + 86_400_000 });
  record.flushTxnWithExprIndex = summarize(flush2.samples);
  await w.close();
  return record;
}

function aggregate(scale, runs) {
  const med = (pick) => medianAcross(runs.map(pick));
  const group = (kind) => Object.fromEntries(Object.keys(Q.QUERY_GROUPS).map((g) => [g, med((r) => r[kind].groups[g])]));
  const perQuery = (kind) => {
    const qs = Object.keys(runs[0][kind].perQueryP50);
    return qs.map((q) => ({ q, p50: round(median(runs.map((r) => r[kind].perQueryP50[q]))) })).sort((a, b) => b.p50 - a.p50);
  };
  return {
    scale,
    reps: runs.length,
    insert: {
      pagesPerSec: medianOf(runs.map((r) => r.load.pagesPerSec), 0),
      totalRowsPerSec: medianOf(runs.map((r) => r.load.totalRowsPerSec), 0),
      insertMs: medianOf(runs.map((r) => r.load.insertMs), 0),
      generateMs: medianOf(runs.map((r) => r.load.generateMs), 0),
      rows: { pages: runs[0].load.pages, visits: runs[0].load.visits, tabs: runs[0].load.tabs, distinctSites: runs[0].load.distinctSites, visitsPerPage: runs[0].load.visitsPerPage },
    },
    size: {
      dbBytes: medianOf(runs.map((r) => r.size.dbBytes), 0),
      bytesPerPage: medianOf(runs.map((r) => r.size.bytesPerPage), 0),
      walBytesAfterTruncate: runs[0].size.walBytes,
      byGroup: runs[0].size.byGroup,
    },
    coldFirstQueryRttMs: medianOf(runs.map((r) => r.coldFirstQuery.rttMs)),
    inWorker: { all: med((r) => r.inWorker.all), groups: group('inWorker'), slowestQueriesP50: perQuery('inWorker').slice(0, 5) },
    roundTrip: { all: med((r) => r.roundTrip.all), groups: group('roundTrip'), slowestQueriesP50: perQuery('roundTrip').slice(0, 5) },
    messagingOverheadP50Ms: round(median(runs.map((r) => r.roundTrip.all.p50 - r.roundTripInnerOnly.p50))),
    stress: Object.fromEntries(Q.STRESS_QUERIES.map((q) => [q, {
      matches: runs[0].inWorkerStress[q].matches,
      inWorkerP50: medianOf(runs.map((r) => r.inWorkerStress[q].p50)),
      roundTripP50: medianOf(runs.map((r) => r.roundTripStress[q].p50)),
    }])),
    ladder: Object.fromEntries(Q.LADDER_PHRASES.map((ph) => [ph, runs[0].ladder[ph].map((s, i) => ({
      chars: s.chars, matches: s.matches, p50: round(median(runs.map((r) => r.ladder[ph][i].p50))),
    }))])),
    recent: Object.fromEntries(['pow', 'exp', 'windowed', 'exprIndex'].map((v) => [v, {
      rows: runs[0].recent[v].rows,
      inWorker: med((r) => r.recent[v].inWorker),
      roundTrip: med((r) => r.recent[v].roundTrip),
      plan: runs[0].recent[v].plan,
      ...(v === 'exprIndex' ? { indexBuildMs: medianOf(runs.map((r) => r.recent[v].indexBuildMs)), identicalOrderToPow: runs.every((r) => r.recent.compare.identicalOrder) } : {}),
    }])),
    flushTxn: { without: med((r) => r.flushTxn), withExprIndex: med((r) => r.flushTxnWithExprIndex) },
    matchCounts: runs[0].matchCounts,
    integrity: runs[0].integrity,
    perRep: runs.map((r) => ({
      pagesPerSec: r.load.pagesPerSec, dbBytes: r.size.dbBytes,
      inWorkerAll: r.inWorker.all, roundTripAll: r.roundTrip.all,
    })),
  };
}

/** Experiment: bulk load with the FTS triggers dropped, then rebuild the index in one go. */
async function noFtsExperiment(scale) {
  const file = path.join(__dirname, `bench-${slug}${TAG}-nofts-${scale}.db`);
  rmDb(file);
  const w = await fresh();
  await w.call('open', { file, cacheKB: CACHE_KB });
  await w.call('dropFtsTriggers');
  const load = await w.call('load', { pages: scale, seed: SEED, tabs: 300, batchSize: 1000 });
  const rebuild = await w.call('ftsRebuild');
  const sizes = await w.call('sizes', { breakdown: false });
  await w.close();
  return { scale, insertWithoutFtsMs: round(load.insertMs, 0), rebuildMs: round(rebuild.ms, 0), dbBytes: sizes.dbBytes };
}

app.whenReady().then(async () => {
  const rows = [];
  const results = { driver: DRIVER, scales: SCALES, reps: REPS, cacheKB: CACHE_KB || 'driver default', passes: PASSES, perScale: {} };
  console.log(`S5 bench: driver=${DRIVER} scales=${SCALES} reps=${REPS} cacheKB=${CACHE_KB || 'default'}`);
  for (const scale of SCALES) {
    const runs = [];
    for (let rep = 1; rep <= REPS; rep += 1) {
      const t0 = performance.now();
      const r = await oneRep(scale, rep);
      runs.push(r);
      console.log(`  scale=${scale} rep=${rep} done in ${Math.round(performance.now() - t0)} ms: insert ${r.load.pagesPerSec} pages/s, db ${(r.size.dbBytes / 1048576).toFixed(1)} MiB, in-worker p50/p95/p99 ${r.inWorker.all.p50}/${r.inWorker.all.p95}/${r.inWorker.all.p99} ms, rtt ${r.roundTrip.all.p50}/${r.roundTrip.all.p95}/${r.roundTrip.all.p99} ms`);
    }
    const agg = aggregate(scale, runs);
    results.perScale[scale] = agg;
    h.record(rows, `${DRIVER} @ ${scale} pages: search p50/p95/p99 (medians of ${REPS} runs)`,
      { inWorker: [agg.inWorker.all.p50.median, agg.inWorker.all.p95.median, agg.inWorker.all.p99.median], roundTrip: [agg.roundTrip.all.p50.median, agg.roundTrip.all.p95.median, agg.roundTrip.all.p99.median], dbMiB: round(agg.size.dbBytes.median / 1048576, 2), pagesPerSec: agg.insert.pagesPerSec.median },
      null);
  }
  if (process.env.S5_EXTRAS === '1') {
    results.noFtsExperiment = [];
    for (const scale of SCALES.filter((s) => s >= 10_000)) {
      const e = await noFtsExperiment(scale);
      results.noFtsExperiment.push(e);
      h.record(rows, `bulk load without FTS triggers + 'rebuild' @ ${scale}`, e, null, 'single run');
    }
  }
  h.writeResults(__dirname, `bench-${slug}${TAG}`, results);
  app.exit(0);
}).catch((e) => {
  console.error('s5b failed:', e);
  app.exit(2);
});
