'use strict';
// Plain-Node smoke test of the data worker (no Electron): node s5-data-stack/smoke-node.js [driver] [pages]
const path = require('node:path');
const fs = require('node:fs');
const { DbClient } = require('./lib/db-client');

(async () => {
  const driver = process.argv[2] ?? 'better-sqlite3';
  const pages = Number(process.argv[3] ?? 1000);
  const file = path.join(__dirname, `smoke-${driver.replace(':', '-')}.db`);
  for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
  const c = new DbClient({ driver });
  await c.ready;
  console.log('open', JSON.stringify(await c.call('open', { file })));
  const load = await c.call('load', { pages, seed: 1 });
  console.log('load', JSON.stringify(load));
  console.log('sizes', JSON.stringify(await c.call('sizes')));
  for (const q of ['postgres', 'po', 'postgres index', 'h']) {
    const { result, rttMs } = await c.timed('search', { q });
    console.log(q, result.rows.length, 'inner', result.innerMs.toFixed(2), 'rtt', rttMs.toFixed(2), JSON.stringify(result.rows[0]));
  }
  console.log('integrity', JSON.stringify(await c.call('integrity')));
  await c.close();
  console.log('exit', c.exited);
})().catch((e) => { console.error(e); process.exit(1); });
