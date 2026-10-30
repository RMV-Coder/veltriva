// Prepares a release locally (M6.3, assessment §9.4 "Releases", ADR-0007). Nothing leaves the
// machine: no push, no upload, no published release. Publishing stays the user's decision.
//
//   npm run release -- <version> [--assisted-by "<model>"] [--trailer "<line>"] [--skip-tests]
//                                [--notes-range <range>]
//
// In order, stopping at the first failure:
//   1. checks: a plain MAJOR.MINOR.PATCH version, a clean working tree, and a tag that is free;
//   2. bumps the version in package.json and package-lock.json and commits it with Veyra;
//   3. runs the unit tests under `veyra attest run`, so the release commit carries a test
//      attestation (skip with --skip-tests);
//   4. groups the changes by feature area (scripts/release-notes.mjs; since the last tag, or
//      --notes-range), and tags the commit with `veyra release prepare` (an annotated tag, local
//      only);
//   5. builds the installer (`npm run package:installer`, with every packaging check);
//   6. writes release/SHA256SUMS.txt for the installer;
//   7. drafts docs/releases/v<version>.md (the notes and the checksum) and commits it. A page
//      already drafted by hand keeps its text: only its status, download and change sections,
//      between <!-- release:… --> markers, are written.
// A failure leaves what was done in place; `veyra undo` reverses the commits and the tag.
import { createHash } from 'node:crypto';
import console from 'node:console';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

import { fillReleasePage, releaseNotes, releaseSection } from './release-notes.mjs';

const args = process.argv.slice(2);
const version = args[0];
const option = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const assistedBy = option('--assisted-by');
const trailer = option('--trailer');
const notesRange = option('--notes-range');
const skipTests = args.includes('--skip-tests');

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

/** Runs a command, streaming its output; returns its stdout when `capture` is set. */
function run(command, commandArgs, { capture = false, shell = false } = {}) {
  console.log(`\n> ${command} ${commandArgs.join(' ')}`);
  const result = spawnSync(command, commandArgs, {
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
    shell,
  });
  if (result.error !== undefined) {
    fail(`${command} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${command} ${commandArgs.join(' ')} exited with ${String(result.status)}`);
  }
  return capture ? result.stdout : '';
}

/** npm is a .cmd script on Windows, which Node starts only through a shell. */
const npm = (npmArgs) => run('npm', npmArgs, { shell: true });

function commit(message) {
  const lines = [message];
  if (trailer !== undefined) {
    lines.push('', trailer);
  }
  // A folder of its own (mkdtemp: a random name, for this user only), not a predictable name in
  // the shared temp folder, where another program could put a file first (CodeQL: insecure
  // temporary file).
  const dir = mkdtempSync(join(tmpdir(), 'veltriva-release-'));
  try {
    const file = join(dir, 'message.txt');
    writeFileSync(file, `${lines.join('\n')}\n`, { flag: 'wx', mode: 0o600 });
    run('veyra', [
      'commit',
      '-F',
      file,
      ...(assistedBy === undefined ? [] : ['--assisted-by', assistedBy]),
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 1. Checks.
if (version === undefined || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version)) {
  fail(
    'usage: npm run release -- <MAJOR.MINOR.PATCH> [--assisted-by "<model>"] [--trailer "<line>"]',
  );
}
const tag = `v${version}`;
if (run('git', ['status', '--porcelain'], { capture: true }).trim() !== '') {
  fail('the working tree has changes: commit them first');
}
if (spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]).status === 0) {
  fail(`${tag} already exists`);
}

// 2. The version.
const current = JSON.parse(readFileSync('package.json', 'utf8')).version;
if (current !== version) {
  npm(['version', version, '--no-git-tag-version', '--ignore-scripts']);
  run('veyra', ['add', 'package.json', 'package-lock.json']);
  commit(`Release ${tag}: the version`);
}

// 3. The tests, attested on the release commit.
if (!skipTests) {
  // Veyra joins the words after `--` with spaces and runs the line with `sh -c` (Git's bash on
  // Windows), so every word must survive the shell: `node` from PATH, not process.execPath,
  // whose "Program Files" and backslashes it splits and eats; and not npx, a .cmd script.
  run('veyra', [
    'attest',
    'run',
    '--',
    'node',
    'node_modules/vitest/vitest.mjs',
    'run',
    '--maxWorkers=2',
  ]);
}

// 4. The notes, grouped by feature area before the tag exists, and the tag.
let notes;
try {
  notes = releaseNotes({ range: notesRange, title: tag });
} catch (error) {
  fail(`the release notes: ${error instanceof Error ? error.message : String(error)}`);
}
run('veyra', ['release', 'prepare', tag]);

// 5. The installer, with every packaging check.
npm(['run', 'package:installer']);

// 6. The checksum.
const installer = `Veltriva-Browser-Setup-${version}.exe`;
const installerPath = join('release', installer);
if (!existsSync(installerPath)) {
  fail(`${installerPath} wasn't built`);
}
const sha256 = createHash('sha256').update(readFileSync(installerPath)).digest('hex');
writeFileSync(join('release', 'SHA256SUMS.txt'), `${sha256}  ${installer}\n`);
console.log(`\n${installer}: SHA-256 ${sha256}`);

// 7. The draft release page: the sections the script owns, written into a page drafted by hand
// when there is one, or into a new page.
const date = new Date().toISOString().slice(0, 10);
const sections = {
  status: `**Status:** draft, prepared locally on ${date} by \`scripts/release.mjs\`. Not published: the tag \`${tag}\` exists only in the local repository.`,
  download: `| File | SHA-256 |
|---|---|
| \`${installer}\` | \`${sha256}\` |

Check a download in PowerShell before running it:

\`\`\`powershell
(Get-FileHash .\\${installer} -Algorithm SHA256).Hash -eq '${sha256.toUpperCase()}'
\`\`\``,
  changes: notes.replace(/^## .*\n+/, '').trim(),
};
const newPage = `# Veltriva Browser ${tag} (draft)

${releaseSection('status', sections.status)}

## Download

${releaseSection('download', sections.download)}

The installer is **unsigned**, so Windows SmartScreen warns before it runs ("Windows protected your PC": **More info ▸ Run anyway**). Why, and what signing would change: [docs/distribution/signing.md](../distribution/signing.md).

## Install and remove

- Per user, no administrator rights: it installs into \`%LOCALAPPDATA%\\Programs\`, adds Start-menu and desktop shortcuts, and starts Veltriva.
- Your tabs, history and settings live in \`%APPDATA%\\Veltriva\`. Uninstalling asks whether to remove them too; installing a newer version keeps them.

## What's new

<!-- Write the highlights here before publishing. -->

## Known limitations

See the README's [Known limitations](../../README.md#known-limitations).

## All changes

${releaseSection('changes', sections.changes)}
`;
mkdirSync(join('docs', 'releases'), { recursive: true });
const pagePath = join('docs', 'releases', `${tag}.md`);
// Read it outright rather than check first, so nothing can change it in between (CodeQL: file
// system race); a page that isn't there is a new one.
let drafted;
try {
  drafted = readFileSync(pagePath, 'utf8');
} catch (error) {
  if (error?.code !== 'ENOENT') {
    fail(`${pagePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
let page = newPage;
if (drafted !== undefined) {
  try {
    page = fillReleasePage(drafted, sections);
  } catch (error) {
    fail(`${pagePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
writeFileSync(pagePath, page);
npm(['exec', '--', 'prettier', '--write', pagePath]);
run('veyra', ['add', pagePath]);
commit(`Release ${tag}: the draft release page and the installer's checksum`);

console.log(`
${tag} is prepared locally:
- the tag ${tag} (annotated, not pushed);
- release/${installer} and release/SHA256SUMS.txt;
- ${pagePath} (a draft: write its highlights before publishing).
Nothing was pushed or published.`);
