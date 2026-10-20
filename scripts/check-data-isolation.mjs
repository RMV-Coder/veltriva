// Proves, on the built output, that SQLite is loaded only by the data worker (ADR-0004): no file
// in out/ but out/main/data-worker.js may reference better-sqlite3 or node:sqlite, and main must
// start that file as a worker rather than import it. ESLint enforces the same rule on the
// sources; this catches what a bundler could still pull in. Run after any build.
import console from 'node:console';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import process from 'node:process';

const OUT = 'out';
const WORKER = join(OUT, 'main', 'data-worker.js');
const MAIN = join(OUT, 'main', 'index.js');
const SQLITE = /better-sqlite3|node:sqlite/;

async function* files(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* files(path);
    } else if (/\.(js|mjs|cjs|html)$/.test(entry.name)) {
      yield path;
    }
  }
}

const problems = [];
let workerLoadsSqlite = false;
for await (const path of files(OUT)) {
  const text = await readFile(path, 'utf8');
  if (path === WORKER) {
    workerLoadsSqlite = text.includes('require("better-sqlite3/win32-x64")');
  } else if (SQLITE.test(text)) {
    problems.push(`${relative('.', path)} mentions SQLite; only ${relative('.', WORKER)} may.`);
  }
}
if (!workerLoadsSqlite) {
  problems.push(`${relative('.', WORKER)} doesn't require better-sqlite3/win32-x64.`);
}
const main = await readFile(MAIN, 'utf8').catch(() => '');
if (!main.includes('data-worker.js')) {
  problems.push(`${relative('.', MAIN)} doesn't start data-worker.js.`);
}

if (problems.length > 0) {
  console.error(`SQLite isn't isolated in the data worker:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('out/: only the data worker loads SQLite.');
