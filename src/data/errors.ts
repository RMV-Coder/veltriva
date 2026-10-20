// Errors the data worker reports. Only the code and a short detail ever cross to main, and the
// detail is a SQLite error code or a schema version: never SQL text or row data.
import type { DataErrorCode, DataErrorInfo } from '../shared/contracts/data-rpc';

export class DataError extends Error {
  readonly code: DataErrorCode;
  readonly detail: string | undefined;

  constructor(code: DataErrorCode, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'DataError';
    this.code = code;
    this.detail = detail;
  }
}

/** SQLite's extended result code (`SQLITE_CONSTRAINT_CHECK`), if `error` carries one. */
export function sqliteCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error;
    if (typeof code === 'string' && /^SQLITE_[A-Z_]{1,60}$/.test(code)) {
      return code;
    }
  }
  return undefined;
}

/** What a thrown error becomes on the wire. */
export function toErrorInfo(error: unknown): DataErrorInfo {
  if (error instanceof DataError) {
    return error.detail === undefined
      ? { code: error.code }
      : { code: error.code, detail: error.detail };
  }
  const code = sqliteCode(error);
  if (code === undefined) {
    return { code: 'internal' };
  }
  // A CHECK, NOT NULL, UNIQUE or foreign-key refusal means the caller sent a row the schema
  // doesn't allow, the same as a Zod refusal.
  return { code: code.startsWith('SQLITE_CONSTRAINT') ? 'invalid_input' : 'sqlite', detail: code };
}
