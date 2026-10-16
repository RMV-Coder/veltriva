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

interface FullscreenSnapshot {
  readonly fullscreen: {
    readonly tabId: string;
    readonly origin: string;
    /** The shell must draw the fullscreen notice now. */
    readonly notice: boolean;
  } | null;
}

/**
 * The fullscreen notice the shell must draw right now, or null. While a tab is in HTML fullscreen
 * but its notice is over, the shell draws its normal UI, which sits underneath the page.
 */
export function fullscreenNotice(
  snapshot: FullscreenSnapshot | null,
): { readonly tabId: string; readonly origin: string } | null {
  const fullscreen = snapshot?.fullscreen;
  if (fullscreen?.notice !== true) {
    return null;
  }
  return { tabId: fullscreen.tabId, origin: fullscreen.origin };
}
