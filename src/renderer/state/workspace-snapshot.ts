// Pure helpers over the workspace snapshot main sends. No DOM and no store, so they run in Vitest.

interface Versioned {
  readonly version: number;
}

/**
 * Whether `incoming` should replace `held`. Snapshots carry an increasing version, and the shell
 * gets them from two places (the `workspace.changed` event and `workspace.getSnapshot()`) that can
 * deliver in either order. Only a strictly newer one wins, so a late old snapshot never rolls the
 * UI back and a repeat is ignored.
 */
export function isNewerSnapshot(held: Versioned | null, incoming: Versioned): boolean {
  return held === null || incoming.version > held.version;
}

interface SelectableSnapshot<Tab extends { readonly id: string }> {
  readonly selectedTabId: string | null;
  readonly tabs: readonly Tab[];
}

/** The selected tab, or undefined before the first snapshot or if the id matches no tab. */
export function findSelectedTab<Tab extends { readonly id: string }>(
  snapshot: SelectableSnapshot<Tab> | null,
): Tab | undefined {
  return snapshot?.tabs.find((tab) => tab.id === snapshot.selectedTabId);
}
