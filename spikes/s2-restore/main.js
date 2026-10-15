'use strict';
// S2: restore fidelity of navigationHistory.restore().
//
//   cd spikes && ./node_modules/.bin/electron s2-restore/main.js --only=q1       (one group, < 170 s)
//   cd spikes && ./node_modules/.bin/electron s2-restore/main.js --only=q4,q5    (several groups)
//   cd spikes && bash s2-restore/run-all.sh                                      (every group, one process each; this produced the committed results)
//   (running main.js with no --only runs every group in one process; that mode was not used for the committed results)
//
// Groups: q1, q2, q3, q2b, q4, q4b, q5, q6.
// Options: --reps=N        repetitions for the fidelity groups (default 3)
//          --failsafe=MS   override the fail-safe timeout (default: 170 s for a subset, 15 min for everything)
//          --tag=NAME      suffix for the results file name (used for the --force-device-scale-factor runs)
// Results go to s2-restore/results/s2-restore-<groups>.json (or s2-restore.json when everything ran).

const { app } = require('electron');
const h = require('../shared/harness');
const L = require('./lib');

h.prepareApp(__dirname);

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const only = arg('only', '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const reps = Number(arg('reps', 3));
const tag = arg('tag', ''); // suffix for the results file, e.g. when running with --force-device-scale-factor
h.failSafe(Number(arg('failsafe', only.length ? 170_000 : 900_000)), 's2-restore');

/** group id -> module loader and options passed to its run(). */
const GROUPS = {
  q1: { load: () => require('./q1-entries') },
  q2: { load: () => require('./q2q3-fidelity'), options: { group: 'q2' } },
  q3: { load: () => require('./q2q3-fidelity'), options: { group: 'q3' } },
  q2b: { load: () => require('./q2q3-fidelity'), options: { group: 'q2b', reps: 2 } },
  q4: { load: () => require('./q4-freshness'), options: { part: 'freshness' } },
  q4b: { load: () => require('./q4-freshness'), options: { part: 'triggers' } },
  q5: { load: () => require('./q5-failure') },
  q6: { load: () => require('./q6-ordering') },
};

app.whenReady().then(async () => {
  const rows = [];
  const results = {};
  let exitCode = 0;
  try {
    const ctx = await L.setup();
    results.window = { alwaysOnTop: ctx.win.isAlwaysOnTop(), size: ctx.win.getSize() };
    for (const [id, group] of Object.entries(GROUPS)) {
      if (only.length && !only.includes(id)) continue;
      const t0 = Date.now();
      console.log(`\n=== ${id} ===`);
      try {
        results[id] = await group.load().run(ctx, rows, { reps, ...group.options });
        results[id].elapsedMs = Date.now() - t0;
        console.log(`(${id} took ${results[id].elapsedMs} ms)`);
      } catch (error) {
        console.error(`${id} failed:`, error);
        results[id] = { error: String(error?.stack ?? error) };
        exitCode = 1;
      }
    }
    results.guard = { blockedRequests: ctx.guard.blocked, permissionRequests: ctx.guard.permissionRequests };
    console.log('\nblocked non-local requests:', ctx.guard.blocked.length, ' permission requests (all denied):', ctx.guard.permissionRequests.length);
    await ctx.fx.close();
  } catch (error) {
    console.error('S2 aborted:', error);
    results.fatal = String(error?.stack ?? error);
    exitCode = 1;
  }
  h.writeResults(__dirname, `${only.length ? `s2-restore-${only.join('-')}` : 's2-restore'}${tag ? `-${tag}` : ''}`, { args: process.argv.slice(2), displayScaleFactor: require('electron').screen.getPrimaryDisplay().scaleFactor, results, rows });
  app.exit(exitCode);
});
