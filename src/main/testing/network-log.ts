// Test builds only (ADR-0008 item 4): every request Chromium is about to make, from every session
// the app has, so an E2E test can prove something made none. M4.2's case: typing in the address
// bar or the palette searches the local memory and must never reach the network.
//
// It listens to `webRequest.onBeforeRequest`, which the app itself never uses (its one listener
// per event and session is src/main/web/request-headers.ts, on other events), and lets every
// request through unchanged.
import type { Session } from 'electron';

export interface NetworkRequestEntry {
  readonly url: string;
  /** Which session asked: the browsing session, the shell's, or the default one. */
  readonly session: string;
  readonly resourceType: string;
  readonly at: number;
}

/** Enough for any one test; the oldest go first. */
const MAX_ENTRIES = 5000;
const entries: NetworkRequestEntry[] = [];

/** Starts recording `sessions`, each under its name. Call once. */
export function recordNetworkRequests(sessions: ReadonlyMap<string, Session>): void {
  for (const [name, session] of sessions) {
    session.webRequest.onBeforeRequest((details, callback) => {
      entries.push({
        url: details.url,
        session: name,
        resourceType: details.resourceType,
        at: Date.now(),
      });
      if (entries.length > MAX_ENTRIES) {
        entries.shift();
      }
      callback({});
    });
  }
}

export function recordedNetworkRequests(): NetworkRequestEntry[] {
  return [...entries];
}

export function clearNetworkRequests(): void {
  entries.length = 0;
}
