'use strict';
// Spike S3: unsaved-work detection.
//   A. webContents.close({ waitForBeforeUnload: true }) + will-prevent-unload
//   B. main-process input observation (input-event, before-input-event, before-mouse-event)
//   C. the isolated-world form probe (shared/probe.js)
//
// Run from /spikes in Git Bash:
//   timeout 180 ./node_modules/.bin/electron s3-unsaved-work/main.js            (all parts)
//   timeout 180 ./node_modules/.bin/electron s3-unsaved-work/main.js --part=a   (one part: a, b or c)

const { app } = require('electron');
const h = require('../shared/harness');
const { startFixtureServer } = require('../shared/fixture-server');
const L = require('./lib');

h.prepareApp(__dirname);
h.failSafe(Number(process.env.S3_FAILSAFE_MS ?? 175_000), 's3');

const PARTS = {
  a: { name: 'a-before-unload', module: () => require('./a-before-unload') },
  b: { name: 'b-input-events', module: () => require('./b-input-events') },
  c: { name: 'c-probe', module: () => require('./c-probe') },
};

const requested = process.argv.find((arg) => arg.startsWith('--part='))?.slice('--part='.length);
const selected = requested ? requested.split(',') : Object.keys(PARTS);

app.whenReady().then(async () => {
  const denied = L.lockDown();
  const fixture = await startFixtureServer();
  const win = h.createWindow({ width: 900, height: 600, title: 'S3 unsaved-work spike' });
  // Other spikes share this desktop: stay on top so the page is never occluded (occlusion hides the page) and
  // keep the window focused, because sendInputEvent is only delivered to a focused window.
  win.setAlwaysOnTop(true);
  const watcher = selected.includes('a') ? new L.WindowWatcher().start() : null;
  let exitCode = 0;

  try {
    for (const key of selected) {
      const part = PARTS[key];
      if (!part) throw new Error(`unknown part "${key}"`);
      console.log(`\n=== part ${key.toUpperCase()}: ${part.name} ===`);
      const rows = [];
      const data = await part.module().run({ win, fixture, rows, watcher, denied });
      h.writeResults(__dirname, part.name, { rows, ...data, deniedPermissionsAndNavigations: denied });
      const mismatches = rows.filter((r) => r.pass === false);
      console.log(`part ${key.toUpperCase()}: ${rows.length} rows, ${mismatches.length} expectation mismatches`);
      for (const row of mismatches) console.log(`  MISMATCH: ${row.name}`);
    }
  } catch (error) {
    console.error('spike crashed:', error);
    exitCode = 2;
  } finally {
    watcher?.stop();
    for (const view of win.contentView.children) {
      try {
        win.contentView.removeChildView(view);
        if (view.webContents && !view.webContents.isDestroyed()) view.webContents.close();
      } catch {
        /* ignore */
      }
    }
    await Promise.race([fixture.close().catch(() => {}), h.sleep(1000)]); // keep-alive sockets can stall close()
    app.exit(exitCode);
  }
});
