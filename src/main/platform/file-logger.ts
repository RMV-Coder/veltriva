// The log file (assessment §2.2, §6.6, M5.3): one JSON line per event in
// `<profile>/logs/veltriva.log`, rotated at 5 MB, keeping 5 files (veltriva.log, then .1 to .4,
// the oldest dropped). Logs name tab ids and error codes, never what the user browsed. Unless the
// user turned diagnostic logging on, for reporting a problem:
// - a field that holds an address (`url`, `address`, or a name ending in `Url`) is written as
//   "[hidden]";
// - every other string field has its address-like words hidden (M6.1, ./log-redaction.ts), since
//   an error message can name an address too.
// Writing never throws into the app: a log that can't be written is given up on for the run.
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { HIDDEN, scrubAddresses } from './log-redaction';
import type { LogFields, Logger } from './logger';

export { HIDDEN } from './log-redaction';

/** A file is rotated once it reaches this size. */
export const LOG_FILE_BYTES = 5 * 1024 * 1024;
/** Files kept: the current one and four older. */
export const LOG_FILES = 5;
export const LOG_FILE_NAME = 'veltriva.log';

/** Whether a field holds an address (and so is hidden unless diagnostic logging is on). */
export function isAddressField(name: string): boolean {
  return name === 'url' || name === 'address' || name.endsWith('Url');
}

/** A field's value as written while diagnostic logging is off. */
export function redactedValue(
  name: string,
  value: string | number | boolean,
): string | number | boolean {
  if (isAddressField(name)) {
    return HIDDEN;
  }
  return typeof value === 'string' ? scrubAddresses(value) : value;
}

export interface FileLoggerOptions {
  /** The folder the files go in: `<profile>/logs`. */
  readonly folder: string;
  /** Whether the user turned diagnostic logging on: addresses are written then. */
  readonly includeAddresses: () => boolean;
  readonly now?: () => number;
  /** Rotation size, for tests. */
  readonly maxBytes?: number;
}

export class FileLogger implements Logger {
  readonly #options: FileLoggerOptions;
  readonly #file: string;
  /** The current file's size, as far as this run wrote it; read once at the first write. */
  #size: number | null = null;
  #broken = false;

  constructor(options: FileLoggerOptions) {
    this.#options = options;
    this.#file = join(options.folder, LOG_FILE_NAME);
  }

  get file(): string {
    return this.#file;
  }

  warn(event: string, fields?: LogFields): void {
    this.#write('warn', event, fields);
  }

  error(event: string, fields?: LogFields): void {
    this.#write('error', event, fields);
  }

  #write(level: 'warn' | 'error', event: string, fields: LogFields | undefined): void {
    if (this.#broken) {
      return;
    }
    const addresses = this.#options.includeAddresses();
    const entry: Record<string, unknown> = {
      at: new Date((this.#options.now ?? Date.now)()).toISOString(),
      level,
      event,
    };
    for (const [name, value] of Object.entries(fields ?? {})) {
      if (value !== undefined && name !== 'at' && name !== 'level' && name !== 'event') {
        entry[name] = addresses ? value : redactedValue(name, value);
      }
    }
    const line = `${JSON.stringify(entry)}\n`;
    try {
      if (this.#size === null) {
        mkdirSync(this.#options.folder, { recursive: true });
        this.#size = existsSync(this.#file) ? statSync(this.#file).size : 0;
      }
      const bytes = Buffer.byteLength(line);
      if (this.#size > 0 && this.#size + bytes > (this.#options.maxBytes ?? LOG_FILE_BYTES)) {
        this.#rotate();
      }
      appendFileSync(this.#file, line);
      this.#size += bytes;
    } catch {
      this.#broken = true;
    }
  }

  /** veltriva.log becomes .1, .1 becomes .2, … and the oldest goes. */
  #rotate(): void {
    const name = (index: number): string =>
      index === 0 ? this.#file : join(this.#options.folder, `veltriva.${String(index)}.log`);
    rmSync(name(LOG_FILES - 1), { force: true });
    for (let index = LOG_FILES - 2; index >= 0; index -= 1) {
      if (existsSync(name(index))) {
        renameSync(name(index), name(index + 1));
      }
    }
    this.#size = 0;
  }
}

/** A logger that hides addresses, as the file does, unless addresses are wanted. */
export function redactAddresses(logger: Logger, includeAddresses: () => boolean): Logger {
  const redact = (fields: LogFields | undefined): LogFields | undefined => {
    if (fields === undefined || includeAddresses()) {
      return fields;
    }
    return Object.fromEntries(
      Object.entries(fields).map(([name, value]) => [
        name,
        value === undefined ? value : redactedValue(name, value),
      ]),
    );
  };
  return {
    warn(event, fields) {
      logger.warn(event, redact(fields));
    },
    error(event, fields) {
      logger.error(event, redact(fields));
    },
  };
}

/** Both loggers: the console for development, and the file. */
export function teeLogger(...loggers: readonly Logger[]): Logger {
  return {
    warn(event, fields) {
      for (const logger of loggers) {
        logger.warn(event, fields);
      }
    },
    error(event, fields) {
      for (const logger of loggers) {
        logger.error(event, fields);
      }
    },
  };
}
