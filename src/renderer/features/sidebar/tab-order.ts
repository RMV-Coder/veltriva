// Where a tab goes when it is moved by keyboard or by dragging, in whole-strip indexes. Pure, so
// Vitest covers it. The strip is pinned tabs first, then the rest; main clamps a move into the
// tab's own section, and these functions never ask for more.

export interface StripTab {
  readonly id: string;
  readonly pinned: boolean;
}

interface Section {
  /** Strip index of the section's first tab. */
  readonly start: number;
  /** Strip index just past the section's last tab. */
  readonly end: number;
  /** Strip index of the tab itself. */
  readonly index: number;
}

/** The section (pinned or not) a tab sits in, and the tab's own index. Undefined if it isn't there. */
function sectionOf(tabs: readonly StripTab[], tabId: string): Section | undefined {
  const index = tabs.findIndex((tab) => tab.id === tabId);
  const tab = tabs[index];
  if (tab === undefined) {
    return undefined;
  }
  let start = index;
  while (start > 0 && tabs[start - 1]?.pinned === tab.pinned) {
    start -= 1;
  }
  let end = index + 1;
  while (end < tabs.length && tabs[end]?.pinned === tab.pinned) {
    end += 1;
  }
  return { start, end, index };
}

/**
 * The drop slot for a pointer at `pointerY`: how many rows have their midpoint above it. Slot `s`
 * means "before the section's s-th row", so 0 is the top and the row count is after the last one.
 * `midpoints` are the section's row midpoints, top to bottom, in the same coordinate space.
 */
export function dropSlot(midpoints: readonly number[], pointerY: number): number {
  let slot = 0;
  for (const midpoint of midpoints) {
    if (pointerY > midpoint) {
      slot += 1;
    }
  }
  return slot;
}

/**
 * The strip index to pass to `tabs.move` for dropping `tabId` into `slot` of its own section.
 * Moving takes the tab out first, so a slot below the tab lands one index earlier. Returns null
 * when the drop leaves the tab where it is, or the tab isn't in the strip.
 */
export function dropTargetIndex(
  tabs: readonly StripTab[],
  tabId: string,
  slot: number,
): number | null {
  const section = sectionOf(tabs, tabId);
  if (section === undefined) {
    return null;
  }
  const length = section.end - section.start;
  const from = section.index - section.start;
  const clamped = Math.min(Math.max(Math.trunc(slot), 0), length);
  const insertion = clamped > from ? clamped - 1 : clamped;
  return insertion === from ? null : section.start + insertion;
}

/** The strip index one place up (-1) or down (+1) within the tab's section, or null at its edge. */
export function keyboardMoveTarget(
  tabs: readonly StripTab[],
  tabId: string,
  direction: -1 | 1,
): number | null {
  const section = sectionOf(tabs, tabId);
  if (section === undefined) {
    return null;
  }
  const target = section.index + direction;
  return target >= section.start && target < section.end ? target : null;
}

export type FocusKey = 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';

/** Which tab gets focus for a navigation key. Arrow keys wrap around. Null when there are no tabs. */
export function nextFocusIndex(count: number, current: number, key: FocusKey): number | null {
  if (count <= 0) {
    return null;
  }
  switch (key) {
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    case 'ArrowDown':
      return current < 0 ? 0 : (current + 1) % count;
    case 'ArrowUp':
      return current <= 0 ? count - 1 : current - 1;
  }
}
