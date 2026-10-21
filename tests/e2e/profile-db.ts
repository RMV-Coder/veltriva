// Looking at a profile's database file, and putting a row in it, from outside the app. The specs
// can read the live database through the `dataCall` hook (./session-ui.ts `dataValue`), which is
// what main sees. This is for what the hook cannot do: the file as it is after the app quit or was
// killed, with its write-ahead log, and a row only a person with the file could add (a
// `site_rules` row: no method of the data contract writes one yet).
//
// SQLite itself is loaded by ./profile-db.mjs in a child process, because tests/**/*.ts may not
// import it (ESLint, ADR-0004). Nothing here may run while the app runs on the profile, except
// `copyOfProfileDb`, which only reads files.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, 'profile-db.mjs');

export interface Statement {
  readonly sql: string;
  readonly params?: readonly (string | number | null)[];
}

export type Row = Record<string, unknown>;

export function profileDbPath(userDataDir: string): string {
  return join(userDataDir, 'veltriva.db');
}

/** Runs `statements` on the database file at `file`, in order, and returns each one's rows. */
function run(file: string, statements: readonly Statement[]): Row[][] {
  const result = spawnSync(process.execPath, ['--no-warnings', SCRIPT, file], {
    input: JSON.stringify({ statements }),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`profile-db failed on ${file}: ${result.stderr || String(result.error)}`);
  }
  return (JSON.parse(result.stdout) as { results: Row[][] }).results;
}

/**
 * Runs `statements` on the profile's own database file. The app must not be running: this is how a
 * spec writes a row before a launch, and it folds any write-ahead log left by a kill into the file.
 */
export function writeProfileDb(userDataDir: string, statements: readonly Statement[]): void {
  run(profileDbPath(userDataDir), statements);
}

/** A copy of the database and its log in a folder of their own, which `dispose` removes. */
export interface DbCopy {
  readonly file: string;
  dispose(): void;
}

/**
 * Copies `veltriva.db` and `veltriva.db-wal` as they are now, so the original is never opened (and
 * so never checkpointed): what a killed app left behind is still there for the next launch to
 * recover.
 */
export function copyOfProfileDb(userDataDir: string): DbCopy {
  const folder = mkdtempSync(join(tmpdir(), 'veltriva-db-copy-'));
  const source = profileDbPath(userDataDir);
  const file = join(folder, 'copy.db');
  copyFileSync(source, file);
  if (existsSync(`${source}-wal`)) {
    copyFileSync(`${source}-wal`, `${file}-wal`);
  }
  return {
    file,
    dispose: () => {
      rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

/** Reads the profile's database as it is on disk, through a copy. Safe after a quit or a kill. */
export function readProfileDb(userDataDir: string, sql: string, params: Statement['params'] = []) {
  const copy = copyOfProfileDb(userDataDir);
  try {
    return run(copy.file, [{ sql, params }])[0] ?? [];
  } finally {
    copy.dispose();
  }
}

/** The bytes of the database file and its write-ahead log, as the scan of a secret sees them. */
export function profileDbBytes(userDataDir: string): Buffer {
  const file = profileDbPath(userDataDir);
  return Buffer.concat(
    [file, `${file}-wal`].map((path) => (existsSync(path) ? readFileSync(path) : Buffer.alloc(0))),
  );
}

/**
 * The database's bytes with the session removed: a copy with its `tabs` rows deleted and the
 * whole file rewritten (VACUUM), so no page still holds a tab's address.
 *
 * A tab keeps the exact address it shows, and every entry of its back/forward stack, so that it can
 * be restored (`tabs.url`, `tabs.restore_state`: only a token in the fragment and credentials are
 * cut, assessment §5.7). A query parameter such as `?token=...` is therefore in the file by design,
 * for as long as the tab, or its row in Recently closed, exists. What the memory must never hold is
 * a different question, and this is the file without the session.
 */
export function bytesWithoutSession(userDataDir: string): Buffer {
  const copy = copyOfProfileDb(userDataDir);
  try {
    run(copy.file, [
      { sql: 'PRAGMA journal_mode = DELETE' },
      { sql: 'PRAGMA secure_delete = ON' },
      { sql: 'DELETE FROM tabs' },
      { sql: "DELETE FROM app_state WHERE key = 'session'" },
      { sql: 'VACUUM' },
    ]);
    return readFileSync(copy.file);
  } finally {
    copy.dispose();
  }
}

/** Fails with the secret's name if any of `secrets` is in `bytes` (as UTF-8 text). */
export function foundSecrets(bytes: Buffer, secrets: readonly string[]): string[] {
  return secrets.filter((secret) => bytes.includes(secret));
}
