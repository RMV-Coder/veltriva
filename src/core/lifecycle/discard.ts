// The discard as TabManager runs it (assessment §4.9, §4.11): who asks, what comes back, and the
// deadlines. The procedure itself is in src/main/tabs/tab-manager.ts; its parts that need no tab
// are here so they are unit-tested on their own.

import type { ProtectionReason } from './protections';

/** Who asked. Automation and pressure are the scheduler (M3.2); `user` is an explicit request. */
export type DiscardOrigin = 'automation' | 'pressure' | 'user';

export interface DiscardRequest {
  readonly origin: DiscardOrigin;
  /**
   * The runtime epoch the decision saw. If the tab's runtime changed since, the decision is stale
   * and nothing happens (invariant I5). Omitted for an explicit request.
   */
  readonly epoch?: number;
  /** Critical memory pressure: soft protections don't block (§4.7 rule 4). */
  readonly overrideSoft?: boolean;
}

/** Why a discard didn't run: nothing to do, or the decision no longer holds. */
export type DiscardSkip =
  /** The tab is gone. */
  | 'closed'
  /** Not live or frozen: already unloaded, still creating, crashed, or being discarded. */
  | 'not-live'
  /** The tab shows an internal page (an error page), not a web page. */
  | 'not-web'
  /** It is the selected tab (I5). */
  | 'selected'
  /** A navigation is in progress (§4.10: deferred to a later evaluation). */
  | 'loading'
  /** Its runtime changed after the decision (I5). */
  | 'stale'
  /** The user picked the tab, or it changed, while the discard was under way. */
  | 'cancelled'
  /** Chromium reported no navigation entry worth keeping. */
  | 'no-history';

/** What kept the tab: a protection, or a probe that didn't answer in time ("keep the tab"). */
export type DiscardBlock = ProtectionReason | 'probe-unanswered';

export type DiscardOutcome =
  | { readonly outcome: 'discarded' }
  | { readonly outcome: 'skipped'; readonly why: DiscardSkip }
  | { readonly outcome: 'blocked'; readonly reason: DiscardBlock };

/**
 * How long a close may take before it counts as blocked (§4.9 step 5): `will-prevent-unload`
 * comes within milliseconds, `destroyed` within about 20 (S3), so this is a backstop for a page
 * stuck in its handler.
 */
export const CLOSE_TIMEOUT_MS = 5000;

/**
 * How long a protection the procedure learned keeps automation from asking the page again. It is
 * forgotten sooner when the tab's document changes; an explicit request always asks again.
 */
export const LEARNED_RECHECK_MS = 30 * 60 * 1000;

/** How long freezing may take (experimental, §4.3) before the tab counts as not frozen. */
export const FREEZE_TIMEOUT_MS = 1000;

/** Timers, injected so tests decide when deadlines pass. */
export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * `promise`'s value, or `timedOut` if it takes longer than `ms`. A rejection counts as a value of
 * its own (`failed`). The promise itself goes on; whatever it settles to later is ignored.
 */
export function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  timers: Timers,
): Promise<
  { readonly kind: 'value'; readonly value: T } | { readonly kind: 'timedOut' | 'failed' }
> {
  return new Promise((resolve) => {
    const handle = timers.setTimeout(() => {
      resolve({ kind: 'timedOut' });
    }, ms);
    promise.then(
      (value) => {
        timers.clearTimeout(handle);
        resolve({ kind: 'value', value });
      },
      () => {
        timers.clearTimeout(handle);
        resolve({ kind: 'failed' });
      },
    );
  });
}
