// Crash consistency (ADR-0008 item 3): another process writes to the database inside a
// transaction and is killed before it can commit, as a crash or a power cut would end the app.
// The next start must find a database that passes its checks, holds every row that was committed,
// and holds nothing from the transaction that never was.
//
// The killed process is a real Node process running a small script from a temp folder, with the
// same better-sqlite3 binary and the same journal mode and sync level the worker uses. Its cache
// is made small so that the transaction's pages are already in the WAL, uncommitted, when it dies:
// that is the case recovery has to ignore.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startDatabase } from './startup';
import type { StartupResult } from './startup';

const T0 = Date.UTC(2026, 9, 21, 8, 0, 0);

/** The better-sqlite3 entry point the data worker loads, by absolute path. */
const DRIVER = join(
  import.meta.dirname,
  '..',
  '..',
  'node_modules',
  'better-sqlite3',
  'lib',
  'win32-x64.js',
);

const IN_TRANSACTION = 'IN_TRANSACTION';
const COMMITTED = 'COMMITTED';
/** How many rows the `commit-then-rollback` child commits before it starts the doomed transaction. */
const COMMITTED_ROWS = 100;
type ChildMode = 'rollback' | 'commit-then-rollback';

/**
 * What the killed process runs: `node child.cjs <driver> <database> <mode>`. It writes to
 * `app_state` and `pages` (so also to the search index, through the triggers), inside one
 * transaction that it never commits, and says so on stdout once the transaction holds enough to
 * have spilled into the WAL. In `commit-then-rollback` mode it first commits a transaction of its
 * own and says COMMITTED. It stops by itself after a while, so a test that dies leaves no runaway.
 */
const CHILD_SCRIPT = `'use strict';
const { writeSync } = require('node:fs');
const { EOL } = require('node:os');
const [driver, file, mode] = process.argv.slice(2);
const Database = require(driver);

const db = new Database(file, { timeout: 5000 });
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -256');

const pad = 'x'.repeat(400);
const addState = db.prepare('INSERT INTO app_state (key, json) VALUES (?, ?)');
const addPage = db.prepare(
  'INSERT INTO pages (url_key, url, host, site, title, first_visit_at, last_visit_at) VALUES (?, ?, ?, ?, ?, 1, 1)',
);
function add(prefix, n) {
  const name = prefix + '-' + n;
  addState.run(name, JSON.stringify({ pad }));
  addPage.run(name, 'https://example.com/' + name, 'example.com', 'example.com', 'Title ' + name);
}
function say(line) {
  writeSync(1, line + EOL);
}

if (mode === 'commit-then-rollback') {
  db.exec('BEGIN');
  for (let n = 0; n < ${String(COMMITTED_ROWS)}; n++) add('committed', n);
  db.exec('COMMIT');
  say('${COMMITTED}');
}

db.exec('BEGIN');
let n = 0;
for (; n < 2000; n++) add('partial', n);
say('${IN_TRANSACTION}');
const deadline = Date.now() + 20000;
for (; n < 100000 && Date.now() < deadline; n++) add('partial', n);
`;

/** Kills land at different points of the second phase: right away, and up to 200 ms later. */
const KILL_DELAYS_MS = [0, 40, 90, 150, 200];

/** The rows the database holds before any child touches it. */
const KNOWN_KEYS = Array.from({ length: 40 }, (_, n) => `known-${String(n).padStart(2, '0')}`);
const KNOWN_PAGES = Array.from({ length: 25 }, (_, n) => `known-${String(n).padStart(2, '0')}`);

let dir: string;
let file: string;
let backupDir: string;
let script: string;
const started: StartupResult[] = [];

async function start(now: number): Promise<StartupResult> {
  const result = await startDatabase({ file, backupDir, appVersion: '0.0.0', now: () => now });
  started.push(result);
  return result;
}

function close(result: StartupResult): void {
  if (result.opened.db.open) {
    result.opened.db.close();
  }
}

/**
 * Creates the database through the worker's own startup and fills it with known rows. Its run is
 * left open, as it is when an app is killed, so the next start sees a crash and quick-checks.
 */
async function seed(): Promise<void> {
  const first = await start(T0);
  const { db } = first.opened;
  for (const key of KNOWN_KEYS) {
    db.prepare('INSERT INTO app_state (key, json) VALUES (?, ?)').run([
      key,
      JSON.stringify({ key, pad: 'k'.repeat(300) }),
    ]);
  }
  for (const name of KNOWN_PAGES) {
    db.prepare(
      `INSERT INTO pages (url_key, url, host, site, title, first_visit_at, last_visit_at)
       VALUES (?, ?, 'example.com', 'example.com', ?, 1, 1)`,
    ).run([name, `https://example.com/${name}`, `Title ${name}`]);
  }
  close(first);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface Killed {
  /** What the child printed before it was killed. */
  readonly output: string;
  /** The size of the write-ahead log it left behind. */
  readonly walBytes: number;
}

/**
 * Runs the child until it says it is inside its transaction, lets `delayMs` more go by, and kills
 * it. Resolves once it is gone and the files are free.
 */
async function killInTransaction(mode: ChildMode, delayMs: number): Promise<Killed> {
  const child = spawn(process.execPath, [script, DRIVER, file, mode], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let output = '';
  let errors = '';
  child.stderr.on('data', (chunk: string) => {
    errors += chunk;
  });
  const closed = new Promise<NodeJS.Signals | null>((resolve) => {
    child.once('close', (_code, signal) => {
      resolve(signal);
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`the child never reported being in its transaction: ${errors}`));
      }, 30_000);
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
        if (output.includes(IN_TRANSACTION)) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`the child exited (${String(code)}) before it was killed: ${errors}`));
      });
    });
    await sleep(delayMs);
    expect(child.exitCode, 'the child should still be writing when it is killed').toBeNull();
    expect(child.kill()).toBe(true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(); // The test is failing: do not leave the child running.
    }
  }

  expect(await closed, 'the child should have died of the kill, not of its own accord').toBe(
    'SIGTERM',
  );
  return { output, walBytes: existsSync(`${file}-wal`) ? statSync(`${file}-wal`).size : 0 };
}

/** Everything a start after the crash has to find. */
function expectIntact(result: StartupResult, committed: readonly string[], label: string): void {
  const { db } = result.opened;
  expect(result.recovery, `${label}: nothing needed recovering`).toBeNull();
  expect(db.pragma('quick_check', { simple: true }), `${label}: quick_check`).toBe('ok');
  expect(db.pragma('integrity_check', { simple: true }), `${label}: integrity_check`).toBe('ok');
  expect(
    () => db.exec("INSERT INTO pages_fts(pages_fts, rank) VALUES ('integrity-check', 1)"),
    `${label}: the FTS5 integrity-check`,
  ).not.toThrow();
  expect(db.pragma('foreign_key_check'), `${label}: foreign_key_check`).toEqual([]);

  const expectedKeys = [...KNOWN_KEYS, ...committed].sort();
  expect(db.prepare('SELECT key FROM app_state ORDER BY key').pluck().all(), label).toEqual(
    expectedKeys,
  );
  expect(db.prepare('SELECT url_key FROM pages ORDER BY url_key').pluck().all(), label).toEqual(
    [...KNOWN_PAGES, ...committed].sort(),
  );
  // None of the transaction that never committed, in either table.
  expect(
    db.prepare("SELECT count(*) FROM app_state WHERE key LIKE 'partial-%'").pluck().get(),
    `${label}: no partial rows in app_state`,
  ).toBe(0);
  expect(
    db.prepare("SELECT count(*) FROM pages WHERE url_key LIKE 'partial-%'").pluck().get(),
    `${label}: no partial rows in pages`,
  ).toBe(0);
  // The known rows are as they were, not just present.
  expect(
    db.prepare('SELECT json FROM app_state WHERE key = ?').pluck().get([KNOWN_KEYS[7]]),
    label,
  ).toBe(JSON.stringify({ key: KNOWN_KEYS[7], pad: 'k'.repeat(300) }));
  // The search index finds the pages, which it can only do if its own pages were rolled back too.
  expect(
    db.prepare("SELECT count(*) FROM pages_fts WHERE pages_fts MATCH 'known*'").pluck().get(),
    `${label}: search`,
  ).toBe(KNOWN_PAGES.length);
  expect(
    db.prepare("SELECT count(*) FROM pages_fts WHERE pages_fts MATCH 'partial*'").pluck().get(),
    `${label}: search for the lost rows`,
  ).toBe(0);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'veltriva-crash-'));
  file = join(dir, 'veltriva.db');
  backupDir = join(dir, 'backups');
  script = join(dir, 'child.cjs');
  writeFileSync(script, CHILD_SCRIPT);
});

afterEach(() => {
  started.splice(0).forEach(close);
  rmSync(dir, { recursive: true, force: true });
});

describe('a process killed in the middle of a transaction', () => {
  it('leaves a database that starts, checks clean and holds only what was committed, five times over', async () => {
    await seed();

    for (const [index, delayMs] of KILL_DELAYS_MS.entries()) {
      const label = `kill ${String(index + 1)} (after ${String(delayMs)} ms)`;
      const killed = await killInTransaction('rollback', delayMs);
      expect(killed.output, label).not.toContain(COMMITTED);
      // The transaction's pages were already in the WAL, uncommitted: recovery had work to do.
      expect(killed.walBytes, `${label}: the WAL it left`).toBeGreaterThan(64 * 1024);

      const result = await start(T0 + (index + 1) * 60_000);
      expect(result, label).toMatchObject({ previousExit: 'crash', checked: 'quick' });
      expectIntact(result, [], label);
      // Closed without ending its run, as an app that is killed again would be.
      close(result);
    }
  }, 120_000);

  it('keeps the rows an earlier transaction committed, and loses only the one in progress', async () => {
    await seed();

    const killed = await killInTransaction('commit-then-rollback', 50);
    expect(killed.output.indexOf(COMMITTED)).toBeGreaterThanOrEqual(0);
    expect(killed.output.indexOf(IN_TRANSACTION)).toBeGreaterThan(killed.output.indexOf(COMMITTED));
    expect(killed.walBytes).toBeGreaterThan(64 * 1024);

    const result = await start(T0 + 60_000);
    expect(result).toMatchObject({ previousExit: 'crash', checked: 'quick' });
    const committed = Array.from({ length: COMMITTED_ROWS }, (_, n) => `committed-${String(n)}`);
    expectIntact(result, committed, 'after the commit');
  }, 60_000);

  it('can be written to as usual once it has been recovered', async () => {
    await seed();
    await killInTransaction('rollback', 20);

    const result = await start(T0 + 60_000);
    const { db } = result.opened;
    db.prepare("INSERT INTO app_state (key, json) VALUES ('after-crash', '{}')").run();
    db.prepare(
      `INSERT INTO pages (url_key, url, host, site, title, first_visit_at, last_visit_at)
       VALUES ('partial-0', 'https://example.com/partial-0', 'example.com', 'example.com', 'Reused', 1, 1)`,
    ).run();
    // The names the lost transaction used are free again.
    expect(db.prepare("SELECT title FROM pages WHERE url_key = 'partial-0'").pluck().get()).toBe(
      'Reused',
    );
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(
      db.prepare("SELECT count(*) FROM pages_fts WHERE pages_fts MATCH 'reused'").pluck().get(),
    ).toBe(1);
  }, 60_000);
});
