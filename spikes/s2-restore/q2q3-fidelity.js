'use strict';
// Q2: restore with FULL entries (url, title, pageState).  Q3: restore with persisted-style entries (url, title).
// Q2b: where the view is attached relative to restore() (found while running Q2, see report).
// Each configuration runs `reps` times; checks are reported as k/n.

const L = require('./lib');
const S = require('./scenario');
const h = require('../shared/harness');

/**
 * layout: formMiddle = A -> form -> C, formActive = A -> C -> form (see scenario.js)
 * mode:   full-settled   = wait until the active entry's pageState reflects the last edit, then snapshot
 *         full-flushed   = force a pageState update with history.replaceState from an isolated world, snapshot ~50 ms later
 *         full-immediate = snapshot right after the edit (the "Archive now" case)
 *         persisted      = {url, title} only
 * attach: when the view is attached to the window relative to restore()
 * hideSource: the source tab is detached (hidden) while the last page is edited
 */
const CONFIGS = [
  { group: 'q2', id: 'Q2 formMiddle full-settled', layout: 'formMiddle', mode: 'full-settled', attach: 'before' },
  { group: 'q2', id: 'Q2 formActive full-settled', layout: 'formActive', mode: 'full-settled', attach: 'before' },
  { group: 'q2', id: 'Q2 formMiddle full-flushed (replaceState)', layout: 'formMiddle', mode: 'full-flushed', attach: 'before' },
  { group: 'q2', id: 'Q2 formActive full-flushed (replaceState)', layout: 'formActive', mode: 'full-flushed', attach: 'before' },
  { group: 'q2', id: 'Q2 formMiddle full-flushed, source view HIDDEN (detached) while edited', layout: 'formMiddle', mode: 'full-flushed', attach: 'before', hideSource: true },
  { group: 'q2', id: 'Q2 formActive full-flushed, source view HIDDEN (detached) while edited', layout: 'formActive', mode: 'full-flushed', attach: 'before', hideSource: true },
  { group: 'q2', id: 'Q2 formMiddle full-immediate', layout: 'formMiddle', mode: 'full-immediate', attach: 'before' },
  { group: 'q2', id: 'Q2 formActive full-immediate', layout: 'formActive', mode: 'full-immediate', attach: 'before' },
  { group: 'q3', id: 'Q3 formMiddle persisted', layout: 'formMiddle', mode: 'persisted', attach: 'before' },
  { group: 'q3', id: 'Q3 formActive persisted', layout: 'formActive', mode: 'persisted', attach: 'before' },
  { group: 'q2b', id: 'Q2b formMiddle full-settled, restore into DETACHED view (attach after)', layout: 'formMiddle', mode: 'full-settled', attach: 'after' },
  { group: 'q2b', id: 'Q2b formActive full-settled, restore into DETACHED view (attach after)', layout: 'formActive', mode: 'full-settled', attach: 'after' },
  { group: 'q2b', id: 'Q2b formMiddle full-settled, restore into attached-but-hidden view', layout: 'formMiddle', mode: 'full-settled', attach: 'before-hidden' },
  { group: 'q2b', id: 'Q2b formActive full-settled, restore into attached-but-hidden view', layout: 'formActive', mode: 'full-settled', attach: 'before-hidden' },
];

async function run(ctx, rows, { reps = 3, group } = {}) {
  const out = { group, reps, displayScaleFactor: require('electron').screen.getPrimaryDisplay().scaleFactor, configs: {} };
  for (const cfg of CONFIGS.filter((c) => c.group === group)) {
    const runs = [];
    for (let i = 0; i < reps; i++) {
      try {
        runs.push(await S.runFidelity(ctx, cfg));
      } catch (error) {
        console.error(`${cfg.id} run ${i} failed:`, error);
        runs.push({ outcome: { status: 'error', error: String(error?.message ?? error) }, build: {}, flat: {} });
      }
    }
    const summary = S.summarizeRuns(runs);
    out.configs[cfg.id] = { ...cfg, summary, firstRunDetail: runs[0], lastRunDetail: runs[runs.length - 1] };
    h.record(rows, cfg.id, { outcomes: summary.outcomes, checks: summary.checks, timings: summary.timings }, null);
  }
  return out;
}

module.exports = { run, CONFIGS };
