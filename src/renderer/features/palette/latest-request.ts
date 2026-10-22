// "Only the newest answer counts." The palette and the address bar's suggestions search at every
// keystroke, and an answer is not guaranteed to come back in the order its question went out:
// each search takes a ticket, and an answer is used only if its ticket is still the latest. Pure,
// so Vitest covers it.

export interface LatestRequest {
  /** Starts a request and returns its ticket. Every earlier ticket is stale from now on. */
  begin(): number;
  /** Whether the ticket is the latest one, and nothing has been cancelled since. */
  isLatest(ticket: number): boolean;
  /** Makes every ticket stale (the owner went away or stopped asking). */
  cancel(): void;
}

export function createLatestRequest(): LatestRequest {
  let latest = 0;
  return {
    begin: () => {
      latest += 1;
      return latest;
    },
    isLatest: (ticket) => ticket === latest,
    cancel: () => {
      latest += 1;
    },
  };
}
