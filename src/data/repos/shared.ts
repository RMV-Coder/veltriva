// Small helpers the repositories share.
import type { DataOutput } from '../../shared/contracts/data-rpc';

/** SQLite has no boolean type and better-sqlite3 refuses to bind one: columns hold 0 or 1. */
export function bit(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

/** A JSON document as `app_state` and `settings` hold it. */
export type JsonValue = DataOutput<'appState.get'>['value'];

/** The `json` columns are CHECKed with json_valid(), so this never sees malformed text. */
export function parseDocument(text: string): JsonValue {
  return JSON.parse(text) as JsonValue;
}
