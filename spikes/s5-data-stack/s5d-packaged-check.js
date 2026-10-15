'use strict';
// S5.4 / S5.5 — inspect and run the electron-builder `--dir` outputs of s5-data-stack/app, and record dependency hygiene.
// Prerequisite: package.sh has produced dist/win-unpacked ("default") and dist/slim/win-unpacked ("slim-fuses").
// No installer is ever run; the unpacked exe is started directly and writes its report to os.tmpdir().
// Run (from /spikes):  timeout 300 ./node_modules/.bin/electron s5-data-stack/s5d-packaged-check.js

const { app } = require('electron');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const realFs = require('original-fs'); // Electron's patched fs treats *.asar as a directory (size 0)
const os = require('node:os');
const path = require('node:path');
const asar = require('@electron/asar');
const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses');
const h = require('../shared/harness');

h.prepareApp(__dirname);
h.failSafe(280_000, 's5d');

const VARIANTS = [
  { name: 'default', dir: path.join(__dirname, 'dist', 'win-unpacked'), log: path.join(__dirname, 'pack.log') },
  { name: 'slim-fuses', dir: path.join(__dirname, 'dist', 'slim', 'win-unpacked'), log: path.join(__dirname, 'pack-slim.log') },
];
const RESULT = path.join(os.tmpdir(), 's5-packaged-probe-result.json');

const dirSize = (dir) => {
  let total = 0;
  for (const e of realFs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : realFs.statSync(p).size;
  }
  return total;
};
const walk = (dir, base = dir) => realFs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p, base) : [path.relative(base, p).replaceAll('\\', '/')];
});

function runExe(exe, env = {}) {
  return new Promise((resolve) => {
    fs.rmSync(RESULT, { force: true });
    const t0 = performance.now();
    const child = spawn(exe, [], { env: { ...process.env, ...env }, stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => child.kill(), 40_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      let report = null;
      try { report = JSON.parse(fs.readFileSync(RESULT, 'utf8')); } catch { /* leave null */ }
      resolve({ exitCode: code, wallMs: Math.round(performance.now() - t0), report });
    });
  });
}

function parseLog(file) {
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  return {
    lineCount: lines.length,
    warnings: lines.filter((l) => /warn|deprecat|missed|error/i.test(l)),
    rebuildRelated: lines.filter((l) => /rebuild|node-gyp|msvs|visual studio|python|compil/i.test(l)),
    downloads: lines.filter((l) => /download|cache/i.test(l)),
    steps: lines.filter((l) => /^\s*•/.test(l)).map((l) => l.trim()),
  };
}

async function checkVariant(v, rows) {
  const out = { name: v.name };
  out.packLog = parseLog(v.log);
  const exe = realFs.readdirSync(v.dir).find((f) => f.endsWith('.exe'));
  const resources = path.join(v.dir, 'resources');
  const asarFile = path.join(resources, 'app.asar');
  const unpackedDir = path.join(resources, 'app.asar.unpacked');
  const inAsar = asar.listPackage(asarFile, { isPack: false }).map((p) => p.replaceAll('\\', '/').replace(/^\//, ''));
  const unpackedFiles = realFs.existsSync(unpackedDir) ? walk(unpackedDir) : [];
  out.layout = {
    exe,
    exeMiB: Math.round(realFs.statSync(path.join(v.dir, exe)).size / 1048576),
    winUnpackedMiB: Math.round(dirSize(v.dir) / 1048576),
    appAsarKiB: Math.round(realFs.statSync(asarFile).size / 1024),
    appAsarUnpackedKiB: unpackedFiles.length ? Math.round(dirSize(unpackedDir) / 1024) : 0,
    asarEntryCount: inAsar.length,
    workerInAsar: inAsar.includes('worker.js'),
    mainInAsar: inAsar.includes('main.js'),
    betterSqlite3FilesInAsarIndex: inAsar.filter((p) => p.startsWith('node_modules/better-sqlite3/')).length,
    unpackedFileCount: unpackedFiles.length,
    unpackedNodeFiles: unpackedFiles.filter((f) => f.endsWith('.node')),
    unpackedTopFolders: [...new Set(unpackedFiles.map((f) => f.split('/').slice(0, 3).join('/')))].sort(),
    unpackedFolderCounts: unpackedFiles.reduce((acc, f) => { const k = f.split('/')[2] === 'better-sqlite3' ? f.split('/')[3] : f.split('/')[1]; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {}),
    nodeAddonApiPresent: inAsar.some((p) => p.startsWith('node_modules/node-addon-api/')),
  };
  const wire = await getCurrentFuseWire(path.join(v.dir, exe));
  const fuseState = (code) => ({ 48: 'disabled', 49: 'enabled', 114: 'removed', 144: 'inherit' })[code] ?? code;
  out.fuses = Object.fromEntries(Object.entries(FuseV1Options).filter(([k]) => Number.isNaN(Number(k))).map(([name, idx]) => [name, fuseState(wire[idx])]));

  h.record(rows, `[${v.name}] app.asar contains main.js + worker.js; native .node files unpacked`, {
    workerInAsar: out.layout.workerInAsar, asarKiB: out.layout.appAsarKiB, unpackedKiB: out.layout.appAsarUnpackedKiB, nodeFiles: out.layout.unpackedNodeFiles,
  }, out.layout.workerInAsar && out.layout.unpackedNodeFiles.some((f) => f.endsWith('win32-x64.node')));

  const runs = [];
  for (let i = 0; i < 3; i += 1) runs.push(await runExe(path.join(v.dir, exe)));
  const first = runs[0];
  const w = first.report?.worker;
  out.runs = runs.map((r) => ({ exitCode: r.exitCode, wallMs: r.wallMs, ok: r.report?.ok }));
  out.report = {
    workerPath: first.report?.workerPath, isPackaged: first.report?.isPackaged, appPath: first.report?.appPath,
    electron: first.report?.electron, node: first.report?.node, worker: w,
  };
  const loaded = w?.info?.loadedNative ?? [];
  h.record(rows, `[${v.name}] (a) worker script loads from inside app.asar and runs`, {
    workerPath: first.report?.workerPath, workerFilename: w?.info?.filename, exitCodes: out.runs.map((r) => r.exitCode), error: first.report?.error ?? w?.error?.split('\n')[0],
  }, runs.every((r) => r.exitCode === 0) && /app\.asar/.test(w?.info?.filename ?? ''));
  h.record(rows, `[${v.name}] (b) better-sqlite3 .node mapped from app.asar.unpacked`, { requireResolved: w?.info?.betterSqlite3Resolved, mappedByWorker: loaded },
    loaded.some((p) => /app\.asar\.unpacked/.test(p) && /\.node$/.test(p)));
  h.record(rows, `[${v.name}] (c) FTS5 query works in the packaged worker`, { sqlite: w?.info?.sqlite, journalMode: w?.info?.journalMode, autoVacuum: w?.info?.autoVacuum, ftsRows: w?.info?.ftsRows },
    Boolean(w?.ok) && w.info.ftsRows > 0);
  h.record(rows, `[${v.name}] wall time of exe run (start -> report -> exit), 3 runs; first is cold`, out.runs.map((r) => r.wallMs), null);
  h.record(rows, `[${v.name}] Electron fuses in the exe`, out.fuses, null);

  if (v.name === 'default') {
    const r = await runExe(path.join(v.dir, exe), { S5_WORKER_MODE: 'appPath' });
    out.alternativeWorkerPath = { mode: 'app.getAppPath()', exitCode: r.exitCode, ok: r.report?.ok, workerPath: r.report?.workerPath };
    h.record(rows, `[${v.name}] worker path via app.getAppPath() also works`, out.alternativeWorkerPath, null);
  }
  return out;
}

app.whenReady().then(async () => {
  const rows = [];
  const results = { rows, variants: {} };

  for (const v of VARIANTS) {
    if (!fs.existsSync(v.dir)) {
      h.record(rows, `[${v.name}] build output missing`, v.dir, false, 'run package.sh first');
      continue;
    }
    results.variants[v.name] = await checkVariant(v, rows);
  }

  // ---- optional: electron-builder with the native rebuild left ON (package.sh, S5_REBUILD_PROBE=1) ---------------------
  const probeApp = path.join(__dirname, 'dist', 'rebuild-probe', 'app', 'node_modules', 'better-sqlite3');
  if (fs.existsSync(path.join(__dirname, 'pack-rebuild-probe.log')) && realFs.existsSync(probeApp)) {
    const buildDir = path.join(probeApp, 'build');
    const built = realFs.existsSync(buildDir) ? walk(buildDir) : [];
    results.rebuildEnabledProbe = {
      packLog: parseLog(path.join(__dirname, 'pack-rebuild-probe.log')),
      buildDirCreated: realFs.existsSync(buildDir),
      generatedProjectFiles: built.filter((f) => /\.(vcxproj|sln|gypi)$/.test(f)),
      compiledNodeFiles: built.filter((f) => f.endsWith('.node')),
      electronHeadersCache: fs.existsSync(path.join(os.homedir(), '.electron-gyp')) ? 'present' : 'absent (removed after the probe)',
    };
    h.record(rows, 'electron-builder with npmRebuild left ON (throw-away copy)', results.rebuildEnabledProbe, null);
  }

  // ---- S5.5 dependency hygiene -----------------------------------------------------------------------------------
  const spikesDir = path.join(__dirname, '..');
  let ls;
  try {
    ls = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ls', 'rimraf', 'glob', 'boolean', '--all'], { cwd: spikesDir, encoding: 'utf8', shell: true });
  } catch (e) {
    ls = e.stdout?.toString() ?? String(e);
  }
  results.dependencyHygiene = ls.split(/\r?\n/).filter(Boolean);
  h.record(rows, 'npm ls rimraf glob boolean (run in spikes/)', results.dependencyHygiene, null);

  h.writeResults(__dirname, 's5d-packaged-build', results);
  app.exit(rows.every((r) => r.pass !== false) ? 0 : 1);
}).catch((e) => {
  console.error('s5d failed:', e);
  app.exit(2);
});
