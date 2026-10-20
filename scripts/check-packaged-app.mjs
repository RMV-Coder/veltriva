// Checks what `npm run package:dir` put in release/win-unpacked (ADR-0007 item 2, spike S5):
//   - the only file outside app.asar is better-sqlite3's win32-x64 binary, and it is the pinned one;
//   - app.asar holds the data worker and better-sqlite3's JavaScript and license;
//   - none of better-sqlite3's build inputs, other platforms' binaries or node-addon-api shipped.
// It reads the asar header directly (a Chromium Pickle, then JSON), so it needs no dependency.
import console from 'node:console';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import process from 'node:process';

import { SQLITE_BINARY, SQLITE_BINARY_SHA256 } from './sqlite-pin.mjs';

const RESOURCES = join('release', 'win-unpacked', 'resources');
const MODULE = 'node_modules/better-sqlite3';

const problems = [];

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else {
      yield path;
    }
  }
}

// 1. Outside the archive: exactly the binary, byte for byte the pinned one.
const unpackedDir = join(RESOURCES, 'app.asar.unpacked');
const unpacked = [];
for await (const path of walk(unpackedDir)) {
  unpacked.push(relative(unpackedDir, path).split(sep).join('/'));
}
const binary = `${MODULE}/${SQLITE_BINARY}`;
if (unpacked.length !== 1 || unpacked[0] !== binary) {
  problems.push(`app.asar.unpacked should hold only ${binary}; it holds: ${unpacked.join(', ')}`);
}
if (unpacked.includes(binary)) {
  const sha256 = createHash('sha256')
    .update(await readFile(join(unpackedDir, ...binary.split('/'))))
    .digest('hex');
  if (sha256 !== SQLITE_BINARY_SHA256) {
    problems.push(`the packaged ${binary} has SHA-256 ${sha256}, not ${SQLITE_BINARY_SHA256}`);
  }
}

// 2. Inside the archive. Header: four UInt32LE (pickle size, header size, pickle payload size,
// JSON length), then the JSON. Files are `{ files: { name: { files | size, unpacked } } }`.
const asar = await readFile(join(RESOURCES, 'app.asar'));
const jsonLength = asar.readUInt32LE(12);
const header = JSON.parse(asar.subarray(16, 16 + jsonLength).toString('utf8'));
const inArchive = new Map();
(function list(node, prefix) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = prefix === '' ? name : `${prefix}/${name}`;
    if (entry.files !== undefined) {
      list(entry, path);
    } else {
      inArchive.set(path, entry);
    }
  }
})(header, '');

for (const path of [
  'out/main/index.js',
  'out/main/data-worker.js',
  `${MODULE}/package.json`,
  `${MODULE}/LICENSE`,
  `${MODULE}/lib/win32-x64.js`,
  `${MODULE}/lib/database.js`,
]) {
  if (!inArchive.has(path)) {
    problems.push(`app.asar is missing ${path}`);
  }
}
if (inArchive.get(binary)?.unpacked !== true) {
  problems.push(`app.asar doesn't mark ${binary} as unpacked`);
}
let moduleBytes = 0;
for (const [path, entry] of inArchive) {
  if (path.startsWith(`${MODULE}/`) && entry.unpacked !== true) {
    moduleBytes += entry.size ?? 0;
  }
  if (
    path.startsWith('node_modules/node-addon-api/') ||
    path.startsWith(`${MODULE}/deps/`) ||
    path.startsWith(`${MODULE}/src/`) ||
    (path.startsWith(`${MODULE}/prebuilds/`) && path !== binary)
  ) {
    problems.push(`app.asar ships ${path}, which the app never loads`);
  }
}

if (problems.length > 0) {
  console.error(`The packaged app's data stack is wrong:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `release/win-unpacked: only ${binary} is unpacked, and it matches the pin; better-sqlite3's ` +
    `JavaScript in app.asar is ${String(Math.round(moduleBytes / 1024))} KiB.`,
);
