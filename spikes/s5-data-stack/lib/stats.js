'use strict';
// Percentile helpers (nearest-rank on a sorted copy) and "median across repetitions" aggregation.

const round = (x, digits = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** digits) / 10 ** digits : x);

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/** p50/p95/p99/max/mean over raw millisecond samples. */
function summarize(samples) {
  const sorted = Float64Array.from(samples).sort();
  const mean = sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1);
  return {
    n: sorted.length,
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted[sorted.length - 1]),
    mean: round(mean),
  };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** Given N summaries (one per repetition), returns {key: {median, min, max}} for numeric keys. */
function medianAcross(summaries, keys = ['p50', 'p95', 'p99', 'max', 'mean']) {
  const out = {};
  for (const k of keys) {
    const vals = summaries.map((s) => s[k]).filter((v) => Number.isFinite(v));
    out[k] = { median: round(median(vals)), min: round(Math.min(...vals)), max: round(Math.max(...vals)) };
  }
  return out;
}

/** Same for a flat list of plain numbers. */
function medianOf(values, digits = 2) {
  return { median: round(median(values), digits), min: round(Math.min(...values), digits), max: round(Math.max(...values), digits) };
}

/** Event-loop lag monitor: a 15 ms timer (just under Windows' 15.6 ms timer tick) whose drift measures how long the thread was unavailable. */
function lagMonitor(intervalMs = 15) {
  const lags = [];
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    lags.push(Math.max(0, now - last - intervalMs));
    last = now;
  }, intervalMs);
  return {
    stop() {
      clearInterval(timer);
      return { ticks: lags.length, ...summarize(lags.length ? lags : [0]) };
    },
  };
}

module.exports = { round, percentile, summarize, median, medianAcross, medianOf, lagMonitor };
