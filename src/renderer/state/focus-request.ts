// A request to focus a field that may not be on screen yet. Pure, so Vitest covers it.

/**
 * How long a request waits for its field to appear. Main opens the find bar, and the snapshot that
 * draws it follows within a frame; a request older than this is for a bar that never came, and
 * must not take the keyboard later, when something else opens it.
 */
export const FOCUS_REQUEST_MAX_AGE_MS = 5000;

/** Whether a request made at `requestedAt` should still be honored at `now` (both in ms). */
export function isFocusRequestFresh(requestedAt: number, now: number): boolean {
  const age = now - requestedAt;
  return age >= 0 && age <= FOCUS_REQUEST_MAX_AGE_MS;
}
