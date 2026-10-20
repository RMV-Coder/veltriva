// Test builds only (ADR-0008 §4): keeps the data worker's thread inside one SQLite statement for
// about `ms`, as a slow query would, so the lifecycle tests can check that quitting still ends
// within its cap (ADR-0004 item 5: a statement can't be interrupted). The worker calls it behind
// `import.meta.env.MODE === 'test'`, which production builds fold away, and
// scripts/check-production-build.mjs refuses a build that still contains it.
import type { DatabaseConnection } from 'better-sqlite3/win32-x64';

export const HOLD_MESSAGE_KIND = 'veltriva-test-hold';

export interface HoldMessage {
  readonly kind: typeof HOLD_MESSAGE_KIND;
  readonly ms: number;
}

export function isHoldMessage(message: unknown): message is HoldMessage {
  if (typeof message !== 'object' || message === null) {
    return false;
  }
  const { kind, ms } = message as { kind?: unknown; ms?: unknown };
  return kind === HOLD_MESSAGE_KIND && typeof ms === 'number' && ms > 0 && ms <= 60_000;
}

/** Counts up a recursive CTE; the length is calibrated so the one statement lasts about `ms`. */
export function holdThread(db: DatabaseConnection, ms: number): void {
  const count = db.prepare(
    'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?) SELECT count(*) FROM c',
  );
  const sample = 200_000;
  const started = performance.now();
  count.pluck().get([sample]);
  const perRow = Math.max(performance.now() - started, 1) / sample;
  count.pluck().get([Math.ceil(ms / perRow)]);
}
