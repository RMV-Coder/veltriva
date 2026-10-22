// The schema's history, newest last (assessment §5.6). Each file runs once, inside
// BEGIN IMMEDIATE … COMMIT, and moves PRAGMA user_version to its number. Released files are never
// edited: a change is a new file, plus a fixture database at the previous version for the
// migration tests (src/data/migrations/migrations.test.ts).
import init from './0001_init.sql?raw';
import faviconBytes from './0002_favicon_bytes.sql?raw';
import siteRules from './0003_site_rules.sql?raw';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: '0001_init', sql: init },
  { version: 2, name: '0002_favicon_bytes', sql: faviconBytes },
  { version: 3, name: '0003_site_rules', sql: siteRules },
];

/** The schema version this build writes. A database at a higher version is refused. */
export const LATEST_VERSION = MIGRATIONS.length;
