// Refuses to package a build that contains E2E test hooks (ADR-0008 §4, threat T15).
// `npm run test:e2e` builds out/ in `--mode test`, which compiles the hooks in; a production
// build (`npm run build`) folds them away. Run after a production build, before packaging.
import console from 'node:console';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

const OUT = 'out';
const MARKERS = ['__veltrivaTest', 'installTestHooks', 'openTestTab'];

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

const found = [];
for await (const path of files(OUT)) {
  const text = await readFile(path, 'utf8');
  for (const marker of MARKERS) {
    if (text.includes(marker)) {
      found.push(`${path}: ${marker}`);
    }
  }
}

if (found.length > 0) {
  console.error(
    'out/ contains E2E test hooks, so it is not a production build:\n' +
      found.map((line) => `  ${line}`).join('\n') +
      '\nRun `npm run build` and try again.',
  );
  process.exit(1);
}
console.log('out/ is a production build: no test hooks found.');
