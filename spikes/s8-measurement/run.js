'use strict';
// Runs the S8 measurement N times in fresh Electron processes and summarizes run-to-run variance.
// Usage from /spikes: node s8-measurement/run.js [runs]

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const RUNS = Number(process.argv[2] ?? 5);
const electron = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const resultsDir = path.join(__dirname, 'results');

// ELECTRON_RUN_AS_NODE must be *absent*: Electron treats the variable as set even when it is empty.
const baseEnv = { ...process.env };
delete baseEnv.ELECTRON_RUN_AS_NODE;

for (let i = 1; i <= RUNS; i++) {
  console.log(`run ${i}/${RUNS}`);
  execFileSync(electron, [path.join(__dirname, 'main.js')], {
    env: { ...baseEnv, S8_RUN_ID: String(i) },
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: 280_000,
  });
}

const runs = Array.from({ length: RUNS }, (_, i) => JSON.parse(fs.readFileSync(path.join(resultsDir, `s8-run-${i + 1}.json`), 'utf8')));

function describe(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
  return { median, min: sorted[0], max: sorted[sorted.length - 1], cvPct: Math.round((sd / mean) * 1000) / 10 };
}

const metric = (phase, source, key) => describe(runs.map((r) => r[phase][source][key]));
const summary = {
  generatedAt: new Date().toISOString(),
  runs: RUNS,
  tabs: runs[0].tabs,
  electron: runs[0].electron,
  privateMB: {
    empty: { appMetrics: metric('empty', 'electron', 'privateMB'), windowsTree: metric('empty', 'windows', 'privateMB') },
    allLive: { appMetrics: metric('allLive', 'electron', 'privateMB'), windowsTree: metric('allLive', 'windows', 'privateMB') },
    discarded: { appMetrics: metric('discarded', 'electron', 'privateMB'), windowsTree: metric('discarded', 'windows', 'privateMB') },
  },
  workingSetMB: {
    allLive: { appMetrics: metric('allLive', 'electron', 'workingSetMB'), windowsTree: metric('allLive', 'windows', 'workingSetMB') },
    discarded: { appMetrics: metric('discarded', 'electron', 'workingSetMB'), windowsTree: metric('discarded', 'windows', 'workingSetMB') },
  },
  samePidAgreementMB: runs.map((r) => ({ electron: r.allLive.samePids.electronPrivateMB, windows: r.allLive.samePids.windowsPrivateMB })),
  missingFromAppMetrics: runs.map((r) => r.allLive.missingFromAppMetrics),
  freedByDiscardMB: describe(runs.map((r) => r.allLive.electron.privateMB - r.discarded.electron.privateMB)),
};
fs.writeFileSync(path.join(resultsDir, 's8-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
