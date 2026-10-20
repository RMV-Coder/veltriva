// Types for the part of better-sqlite3 13 that the data worker uses. The package ships no types,
// and these are kept narrow on purpose: anything not declared here is not used. The data worker
// loads the `win32-x64` entry point, which requires that one prebuilt N-API binary directly
// (ADR-0004; scripts/verify-sqlite-binary.mjs pins its hash). Only src/data may import it
// (eslint.config.mjs), because a statement blocks the thread that runs it (S5).
declare module 'better-sqlite3/win32-x64' {
  /**
   * One value per `?`, an array of them, or an object for `@name` parameters: a number, bigint,
   * string, Buffer or null each.
   */
  type BindParameters = unknown;

  interface RunResult {
    readonly changes: number;
    readonly lastInsertRowid: number | bigint;
  }

  interface Statement {
    run(...params: BindParameters[]): RunResult;
    get(...params: BindParameters[]): unknown;
    all(...params: BindParameters[]): unknown[];
    /** Rows become their first column's value. */
    pluck(toggle?: boolean): this;
  }

  interface Options {
    readonly readonly?: boolean;
    readonly fileMustExist?: boolean;
    /** busy_timeout, in ms. */
    readonly timeout?: number;
  }

  interface BackupProgress {
    readonly totalPages: number;
    readonly remainingPages: number;
  }

  interface Database {
    readonly open: boolean;
    readonly inTransaction: boolean;
    readonly name: string;
    prepare(sql: string): Statement;
    exec(sql: string): this;
    /** With `simple`, the first column of the first row. */
    pragma(source: string, options: { readonly simple: true }): unknown;
    pragma(source: string): unknown[];
    transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R;
    /** SQLite's online backup API, stepped with setImmediate. */
    backup(destination: string): Promise<BackupProgress>;
    close(): this;
  }

  type DatabaseConstructor = new (filename: string, options?: Options) => Database;

  /** Thrown by SQLite itself, with an extended result code such as `SQLITE_CONSTRAINT_CHECK`. */
  interface SqliteErrorInstance extends Error {
    readonly code: string;
  }

  const Database: DatabaseConstructor & {
    readonly SqliteError: new (message: string, code: string) => SqliteErrorInstance;
  };
  export default Database;
  export type { Database as DatabaseConnection, Statement, RunResult, SqliteErrorInstance };
}
