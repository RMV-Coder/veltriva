// A thin logger interface. The rotating JSONL sink from assessment §2.2 replaces the console
// backend later. Privacy rule: never log URLs, page titles or command inputs at these levels.

export type LogFields = Readonly<Record<string, string | number | boolean | undefined>>;

export interface Logger {
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export const consoleLogger: Logger = {
  warn(event, fields) {
    console.warn(`[veltriva] ${event}`, fields ?? {});
  },
  error(event, fields) {
    console.error(`[veltriva] ${event}`, fields ?? {});
  },
};
