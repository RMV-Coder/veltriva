// Checks what `npm run package:dir` put in release/win-unpacked (ADR-0007 item 2, spike S5):
//   - the only file outside app.asar is better-sqlite3's win32-x64 binary, and it is the pinned one;
//   - app.asar holds the data worker and better-sqlite3's JavaScript and license;
//   - none of better-sqlite3's build inputs, other platforms' binaries or node-addon-api shipped;
//   - Veltriva.exe's fuses are the ones ADR-0007 item 3 sets, read back from the binary (M6.1);
//   - the licenses ship: the app's, the third-party notices, Electron's and Chromium's (M6.1).
// It reads the asar header directly (a Chromium Pickle, then JSON), so it needs no dependency.
//
//   node scripts/check-packaged-app.mjs [output folder]    release by default, as package:dir
//   writes it; another folder when electron-builder was pointed elsewhere
//   (--config.directories.output=<folder>), for instance while Windows holds release/ open.
import console from 'node:console';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import process from 'node:process';

import { readFuseWire } from './fuse-wire.mjs';
import { SQLITE_BINARY, SQLITE_BINARY_SHA256 } from './sqlite-pin.mjs';

const OUTPUT = process.argv[2] ?? 'release';
const RESOURCES = join(OUTPUT, 'win-unpacked', 'resources');
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

// 3. The fuses, as the binary has them (assessment §6.2, ADR-0007 item 3).
const EXPECTED_FUSES = {
  RunAsNode: 'off',
  EnableCookieEncryption: 'on',
  EnableNodeOptionsEnvironmentVariable: 'off',
  EnableNodeCliInspectArguments: 'off',
  EnableEmbeddedAsarIntegrityValidation: 'on',
  OnlyLoadAppFromAsar: 'on',
  LoadBrowserProcessSpecificV8Snapshot: 'off',
  GrantFileProtocolExtraPrivileges: 'off',
  WasmTrapHandlers: 'on',
};
const wire = await readFuseWire(join(OUTPUT, 'win-unpacked', 'Veltriva.exe'));
for (const [name, expected] of Object.entries(EXPECTED_FUSES)) {
  if (wire.fuses[name] !== expected) {
    problems.push(`the fuse ${name} is ${wire.fuses[name] ?? 'missing'}, not ${expected}`);
  }
}
for (const name of Object.keys(wire.fuses)) {
  if (!(name in EXPECTED_FUSES)) {
    problems.push(`the binary has a fuse this check doesn't know (${name}): decide its setting`);
  }
}

// 4. The licenses (M6.1).
for (const path of [
  join(RESOURCES, 'LICENSE.txt'),
  join(RESOURCES, 'THIRD_PARTY_NOTICES.txt'),
  join(OUTPUT, 'win-unpacked', 'LICENSE.electron.txt'),
  join(OUTPUT, 'win-unpacked', 'LICENSES.chromium.html'),
]) {
  if (!existsSync(path)) {
    problems.push(`${path} is missing`);
  }
}

if (problems.length > 0) {
  console.error(`The packaged app is wrong:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `${OUTPUT}/win-unpacked: only ${binary} is unpacked, and it matches the pin; better-sqlite3's ` +
    `JavaScript in app.asar is ${String(Math.round(moduleBytes / 1024))} KiB. The fuses are as ` +
    `set, and the licenses ship.`,
);
