// The user's permission decisions, per origin. Main loads the stored ones at startup and writes
// each new one through (the `permission_decisions` table, M2.2b). A prompt dismissed three times
// for the same origin and permission counts as blocked for the rest of the session, as Chrome's
// embargo does, so a page can't keep re-asking; the embargo is never stored.
import { PROMPTED_PERMISSIONS } from './permission-policy';
import type { Decision, PromptedPermission } from './permission-policy';

const PROMPTED: ReadonlySet<string> = new Set(PROMPTED_PERMISSIONS);

/** A stored decision, as the database holds it; anything it doesn't recognize is skipped. */
export interface StoredDecision {
  readonly origin: string;
  readonly permission: string;
  readonly decision: Decision;
}

/** Dismissals of the same prompt before it stops appearing. Chrome uses 3. */
export const DISMISSALS_BEFORE_EMBARGO = 3;

export class PermissionDecisions {
  readonly #decisions = new Map<string, Map<PromptedPermission, Decision>>();
  readonly #dismissals = new Map<string, Map<PromptedPermission, number>>();
  readonly #onDecided:
    ((origin: string, permission: PromptedPermission, decision: Decision) => void) | undefined;

  constructor(
    options: {
      /** Stored decisions to start from. */
      readonly stored?: Iterable<StoredDecision>;
      /** Called for each decision the user makes, to store it. */
      readonly onDecided?: (
        origin: string,
        permission: PromptedPermission,
        decision: Decision,
      ) => void;
    } = {},
  ) {
    for (const { origin, permission, decision } of options.stored ?? []) {
      if (PROMPTED.has(permission)) {
        this.#put(origin, permission as PromptedPermission, decision);
      }
    }
    this.#onDecided = options.onDecided;
  }

  get(origin: string, permission: PromptedPermission): Decision | undefined {
    const decision = this.#decisions.get(origin)?.get(permission);
    if (decision !== undefined) {
      return decision;
    }
    const dismissals = this.#dismissals.get(origin)?.get(permission) ?? 0;
    return dismissals >= DISMISSALS_BEFORE_EMBARGO ? 'block' : undefined;
  }

  set(origin: string, permissions: readonly PromptedPermission[], decision: Decision): void {
    for (const permission of permissions) {
      this.#put(origin, permission, decision);
      this.#onDecided?.(origin, permission, decision);
    }
  }

  #put(origin: string, permission: PromptedPermission, decision: Decision): void {
    let byPermission = this.#decisions.get(origin);
    if (byPermission === undefined) {
      byPermission = new Map();
      this.#decisions.set(origin, byPermission);
    }
    byPermission.set(permission, decision);
  }

  /** Every stored decision, by origin, then permission (M5.2: the settings page lists them). */
  list(): { origin: string; permission: PromptedPermission; decision: Decision }[] {
    const decisions: { origin: string; permission: PromptedPermission; decision: Decision }[] = [];
    for (const [origin, byPermission] of [...this.#decisions].sort(([a], [b]) => compare(a, b))) {
      for (const [permission, decision] of [...byPermission].sort(([a], [b]) => compare(a, b))) {
        decisions.push({ origin, permission, decision });
      }
    }
    return decisions;
  }

  /**
   * Forgets a decision, or every decision for the origin (M5.2): the page asks again. The
   * dismissal embargo goes with it. True if there was one to forget.
   */
  forget(origin: string, permission?: PromptedPermission): boolean {
    this.#dismissals.delete(origin);
    const byPermission = this.#decisions.get(origin);
    if (byPermission === undefined) {
      return false;
    }
    if (permission === undefined) {
      this.#decisions.delete(origin);
      return true;
    }
    const had = byPermission.delete(permission);
    if (byPermission.size === 0) {
      this.#decisions.delete(origin);
    }
    return had;
  }

  /** The prompt was closed without an answer. */
  dismissed(origin: string, permissions: readonly PromptedPermission[]): void {
    let byPermission = this.#dismissals.get(origin);
    if (byPermission === undefined) {
      byPermission = new Map();
      this.#dismissals.set(origin, byPermission);
    }
    for (const permission of permissions) {
      byPermission.set(permission, (byPermission.get(permission) ?? 0) + 1);
    }
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
