'use strict';
// Harness smoke test: run with `npx electron shared/smoke.js` from /spikes.
const { app } = require('electron');
const path = require('node:path');
const h = require('./harness');
const { startFixtureServer } = require('./fixture-server');

h.prepareApp(__dirname);
h.failSafe(60_000, 'smoke');

app.whenReady().then(async () => {
  const rows = [];
  const fixture = await startFixtureServer();
  const win = h.createWindow({ width: 900, height: 600 });

  const view = h.createTabView(win);
  await view.webContents.loadURL(fixture.url('/timers.html', 'a.test'));
  h.record(rows, 'fixture loads through *.test host mapping', view.webContents.getTitle(), view.webContents.getTitle() === 'timers');

  await view.webContents.loadURL(fixture.url('/iframe-parent.html', 'a.test'));
  await h.sleep(1500);
  const frames = view.webContents.mainFrame.framesInSubtree.map((f) => ({ url: f.url, processId: f.processId }));
  const distinctProcesses = new Set(frames.map((f) => f.processId)).size;
  h.record(rows, 'cross-site iframe runs in its own renderer process', { frames, distinctProcesses }, distinctProcesses === 2);

  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec("CREATE VIRTUAL TABLE t USING fts5(x); INSERT INTO t VALUES ('veltriva spike');");
  const hit = db.prepare("SELECT x FROM t WHERE t MATCH 'velt*'").get();
  h.record(rows, 'better-sqlite3 loads in Electron main with FTS5', { sqlite: db.prepare('select sqlite_version() v').get().v, hit }, Boolean(hit));
  db.close();

  h.writeResults(__dirname, 'smoke', { rows });
  h.destroyView(win, view);
  await fixture.close();
  app.exit(rows.every((r) => r.pass !== false) ? 0 : 1);
});
