// Crash-loop detection (assessment §5.9): if Veltriva crashed twice in a row, each time within a
// minute of starting, something in the restored session may be what crashes it. The next start
// is then in safe mode: the workspace comes back, but no tab loads until the user picks one.

export interface RunSummary {
  readonly startedAt: number;
  /** For a crash: its last heartbeat (the data worker closes unended runs that way). */
  readonly endedAt: number | null;
  readonly exitKind: 'clean' | 'crash' | null;
}

export const CRASH_LOOP_RUNS = 2;
export const CRASH_LOOP_WINDOW_MS = 60_000;

/**
 * `previous` is the runs before this one, newest first. A crash before the first heartbeat (one
 * minute in) ends at its start, so "within 60 s" holds exactly for those.
 */
export function isCrashLoop(previous: readonly RunSummary[]): boolean {
  if (previous.length < CRASH_LOOP_RUNS) {
    return false;
  }
  return previous
    .slice(0, CRASH_LOOP_RUNS)
    .every(
      (run) =>
        run.exitKind === 'crash' &&
        run.endedAt !== null &&
        run.endedAt - run.startedAt < CRASH_LOOP_WINDOW_MS,
    );
}
