// Test builds only (ADR-0008 §4): the runtime transitions TabManager reported, for E2E specs and
// lifecycle scenarios that check what happened to a tab (a discard, its revival, a freeze).
// src/main/index.ts passes `recordRuntimeTransition` to TabManager behind
// `import.meta.env.MODE === 'test'`; production builds fold it away.
import type { RuntimeTransition } from '../tabs/tab-manager';

/** The newest transitions are kept; a long spec doesn't grow main's memory without bound. */
const MAX_RECORDED = 2000;
const recorded: RuntimeTransition[] = [];

export function recordRuntimeTransition(transition: RuntimeTransition): void {
  recorded.push(transition);
  if (recorded.length > MAX_RECORDED) {
    recorded.shift();
  }
}

export function recordedRuntimeTransitions(): RuntimeTransition[] {
  return [...recorded];
}
