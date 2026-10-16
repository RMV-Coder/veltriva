// The user's permission decisions, per origin. In memory until Phase 2's `permission_decisions`
// table. A prompt dismissed three times for the same origin and permission counts as blocked for
// the rest of the session, as Chrome's embargo does, so a page can't keep re-asking.
import type { Decision, PromptedPermission } from './permission-policy';

/** Dismissals of the same prompt before it stops appearing. Chrome uses 3. */
export const DISMISSALS_BEFORE_EMBARGO = 3;

export class PermissionDecisions {
  readonly #decisions = new Map<string, Map<PromptedPermission, Decision>>();
  readonly #dismissals = new Map<string, Map<PromptedPermission, number>>();

  get(origin: string, permission: PromptedPermission): Decision | undefined {
    const decision = this.#decisions.get(origin)?.get(permission);
    if (decision !== undefined) {
      return decision;
    }
    const dismissals = this.#dismissals.get(origin)?.get(permission) ?? 0;
    return dismissals >= DISMISSALS_BEFORE_EMBARGO ? 'block' : undefined;
  }

  set(origin: string, permissions: readonly PromptedPermission[], decision: Decision): void {
    let byPermission = this.#decisions.get(origin);
    if (byPermission === undefined) {
      byPermission = new Map();
      this.#decisions.set(origin, byPermission);
    }
    for (const permission of permissions) {
      byPermission.set(permission, decision);
    }
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
