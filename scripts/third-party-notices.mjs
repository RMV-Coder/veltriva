// THIRD_PARTY_NOTICES.txt (M6.1, the license audit; ADR-0007 item 6). It lists every piece of
// third-party code the packaged app ships, with its license text:
// - the packages each bundle holds, as the build recorded them (out/third-party/*.json, written by
//   scripts/bundled-packages.mjs), so run a build first;
// - the packages the shell's styles import (`@import '<package>'` in src/renderer);
// - the runtime dependencies electron-builder copies (better-sqlite3), and what its prebuilt
//   binary has compiled in (node-addon-api's headers, SQLite);
// - Electron itself. Chromium's and Node's licenses are in LICENSES.chromium.html, which
//   electron-builder puts next to Veltriva.exe.
// Every license must be on the allow-list below (permissive, compatible with shipping an MIT app),
// or this fails.
//
//   node scripts/third-party-notices.mjs           writes THIRD_PARTY_NOTICES.txt
//   node scripts/third-party-notices.mjs --check   fails if the file is out of date (CI, package:dir)
import console from 'node:console';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const OUTPUT = 'THIRD_PARTY_NOTICES.txt';
const TARGETS = { main: 'the main process', preload: 'the shell preload', renderer: 'the shell' };
const ALLOWED = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD']);
const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt))?$/i;
/** Where a license file also holds the licenses of things the package's shipped code doesn't use. */
const TEXT_UNTIL = { vite: '# Licenses of bundled dependencies' };
/** Code a bundler writes into every bundle, which no module id names. */
const BUNDLER_CODE = [
  { name: 'rolldown', why: 'its runtime helpers, in the bundles' },
  { name: 'vite', why: 'its module-preload helper, in the shell' },
];

function manifestOf(name) {
  const file = join('node_modules', name, 'package.json');
  if (!existsSync(file)) {
    throw new Error(`${name} is not installed (run npm run setup)`);
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

function licenseOf(manifest) {
  if (typeof manifest.license === 'string') {
    return manifest.license;
  }
  throw new Error(`${manifest.name} has no SPDX license in its package.json`);
}

function repositoryOf(manifest) {
  const url =
    typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  if (url === undefined) {
    return manifest.homepage ?? '';
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) {
    return `https://github.com/${url}`;
  }
  return url
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/\.git$/, '');
}

function licenseText(name) {
  const folder = join('node_modules', name);
  const files = readdirSync(folder)
    .filter((file) => LICENSE_FILE.test(file) && statSync(join(folder, file)).isFile())
    .sort();
  if (files.length === 0) {
    throw new Error(`${name} ships no license file`);
  }
  return files
    .map((file) => {
      let text = readFileSync(join(folder, file), 'utf8').replace(/\r\n/g, '\n');
      const until = TEXT_UNTIL[name];
      if (until !== undefined && text.includes(until)) {
        text = text.slice(0, text.indexOf(until));
      }
      return text.trim();
    })
    .join('\n\n');
}

/** The bare package names the shell's style sheets import (`@import 'tailwindcss' …`). */
function stylePackages() {
  const names = new Set();
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.endsWith('.css')) {
        for (const match of readFileSync(path, 'utf8').matchAll(
          /@import\s+['"]([^'"./][^'"]*)['"]/g,
        )) {
          const parts = match[1].split('/');
          names.add(parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]);
        }
      }
    }
  };
  walk(join('src', 'renderer'));
  return [...names];
}

function collect() {
  /** name → { version, uses: Set } */
  const packages = new Map();
  const add = (name, version, use) => {
    const known = packages.get(name);
    if (known !== undefined && known.version !== version) {
      throw new Error(`${name} is shipped at two versions: ${known.version} and ${version}`);
    }
    const entry = known ?? { version, uses: new Set() };
    entry.uses.add(use);
    packages.set(name, entry);
  };

  for (const [target, label] of Object.entries(TARGETS)) {
    const file = join('out', 'third-party', `${target}.json`);
    if (!existsSync(file)) {
      throw new Error(`${file} is missing: run npm run build first`);
    }
    for (const { name, version } of JSON.parse(readFileSync(file, 'utf8'))) {
      const installed = manifestOf(name).version;
      if (installed !== version) {
        throw new Error(`${name}: the build used ${version}, but ${installed} is installed`);
      }
      add(name, version, `bundled into ${label}`);
    }
  }
  for (const name of stylePackages()) {
    add(name, manifestOf(name).version, "in the shell's styles");
  }
  for (const { name, why } of BUNDLER_CODE) {
    add(name, manifestOf(name).version, why);
  }
  const app = JSON.parse(readFileSync('package.json', 'utf8'));
  for (const name of Object.keys(app.dependencies ?? {})) {
    const manifest = manifestOf(name);
    add(name, manifest.version, 'a runtime dependency (its JavaScript and prebuilt binary)');
    for (const inner of Object.keys(manifest.dependencies ?? {})) {
      add(inner, manifestOf(inner).version, `compiled into ${name}'s prebuilt binary`);
    }
  }
  const electron = manifestOf('electron');
  add('electron', electron.version, 'the runtime Veltriva runs on');
  return packages;
}

function render(packages) {
  const rule = '-'.repeat(78);
  const sections = [...packages.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, { version, uses }]) => {
      const manifest = manifestOf(name);
      const license = licenseOf(manifest);
      if (!ALLOWED.has(license)) {
        throw new Error(`${name}@${version} is ${license}, which is not on the allow-list`);
      }
      return [
        rule,
        `${name} ${version}`,
        `License: ${license}`,
        `Source: ${repositoryOf(manifest)}`,
        `Shipped as: ${[...uses].sort().join('; ')}`,
        '',
        licenseText(name),
        '',
      ].join('\n');
    });
  return [
    'THIRD-PARTY SOFTWARE NOTICES',
    '',
    'Veltriva Browser is MIT-licensed (see LICENSE). It includes the third-party software',
    'listed below, each under its own license, which is reproduced in full.',
    '',
    'Not listed here, because they ship in files of their own next to Veltriva.exe:',
    '- Chromium, Node.js and the libraries they include: LICENSES.chromium.html.',
    '- Electron: LICENSE.electron.txt (also reproduced below).',
    '',
    'SQLite, which better-sqlite3 compiles into its binary, is in the public domain',
    '(https://sqlite.org/copyright.html) and needs no notice.',
    '',
    ...sections,
    rule,
    '',
  ].join('\n');
}

const text = render(collect());
if (process.argv.includes('--check')) {
  const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8').replace(/\r\n/g, '\n') : '';
  if (current !== text) {
    console.error(
      `${OUTPUT} is out of date: run node scripts/third-party-notices.mjs and commit it.`,
    );
    process.exit(1);
  }
  console.log(`${OUTPUT} is up to date (${String(text.split('\n').length)} lines).`);
} else {
  writeFileSync(OUTPUT, text);
  console.log(`Wrote ${OUTPUT}.`);
}
