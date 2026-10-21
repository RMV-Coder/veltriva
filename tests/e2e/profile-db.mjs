// Runs SQL on a profile's database file, in a process of its own (see ./profile-db.ts, its only
// caller). The specs never load SQLite themselves (ESLint bans it in tests/**/*.ts: only the data
// worker opens the database, ADR-0004), so a spec that has to look at the file after the app has
// quit, or put a row in it before the app starts, asks this script.
//
//   node --no-warnings profile-db.mjs <database file>      (the request is JSON on stdin)
//   request:  { "statements": [{ "sql": "...", "params": [...] }] }
//   response: { "results": [ [row, ...], ... ] }, one list of rows per statement (empty for one
//             that is not a query); a BLOB comes back as { "base64": "..." }.
//
// `node:sqlite` is Node's own SQLite, a different build from the one the app uses
// (better-sqlite3), so it is also an independent reader of what the app wrote.
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';

const [file] = process.argv.slice(2);
if (file === undefined) {
  throw new Error('usage: profile-db.mjs <database file>');
}
const { statements } = JSON.parse(readFileSync(0, 'utf8'));

function plain(value) {
  if (value instanceof Uint8Array) {
    return { base64: Buffer.from(value).toString('base64') };
  }
  return value;
}

const db = new DatabaseSync(file);
try {
  const results = [];
  for (const { sql, params = [] } of statements) {
    const statement = db.prepare(sql);
    if (statement.columns().length > 0) {
      results.push(
        statement
          .all(...params)
          .map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, plain(v)]))),
      );
    } else {
      statement.run(...params);
      results.push([]);
    }
  }
  process.stdout.write(JSON.stringify({ results }));
} finally {
  db.close();
}
