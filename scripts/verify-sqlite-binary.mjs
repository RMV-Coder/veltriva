// Checks better-sqlite3's prebuilt Windows binary before anything loads it (ADR-0004, ADR-0007).
//
// better-sqlite3 13 has no install script: its N-API binaries ship inside the npm tarball, which
// npm checks against the lockfile's sha512, and nothing is downloaded or compiled. This script
// adds a second, narrower check: the one binary Veltriva loads must be the exact file reviewed
// for this version (./sqlite-pin.mjs). `npm run setup` runs it after `npm ci`, and
// `npm run package:dir` before packaging; scripts/check-packaged-app.mjs checks the packaged copy.
import console from 'node:console';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { SQLITE_BINARY, SQLITE_BINARY_SHA256, SQLITE_MODULE_VERSION } from './sqlite-pin.mjs';

const moduleDir = join('node_modules', 'better-sqlite3');

function fail(message) {
  console.error(`better-sqlite3 check failed: ${message}`);
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(await readFile(join(moduleDir, 'package.json'), 'utf8'));
} catch (error) {
  fail(`cannot read ${join(moduleDir, 'package.json')} (${error.code ?? error.message}).`);
}
if (manifest.version !== SQLITE_MODULE_VERSION) {
  fail(
    `found version ${manifest.version}, expected ${SQLITE_MODULE_VERSION} (scripts/sqlite-pin.mjs).`,
  );
}

const binaryPath = join(moduleDir, SQLITE_BINARY);
let binary;
try {
  binary = await readFile(binaryPath);
} catch (error) {
  fail(`cannot read ${binaryPath} (${error.code ?? error.message}).`);
}
const sha256 = createHash('sha256').update(binary).digest('hex');
if (sha256 !== SQLITE_BINARY_SHA256) {
  fail(`${binaryPath} has SHA-256 ${sha256}, expected ${SQLITE_BINARY_SHA256}.`);
}
console.log(`better-sqlite3 ${SQLITE_MODULE_VERSION}: ${SQLITE_BINARY} matches (${sha256}).`);
