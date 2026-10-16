import { describe, expect, it } from 'vitest';

import { dropSlot, dropTargetIndex, keyboardMoveTarget, nextFocusIndex } from './tab-order';
import type { StripTab } from './tab-order';

/** "P" is a pinned tab and "t" an unpinned one: "PPttt" is the strip P1 P2 t3 t4 t5. */
function strip(layout: string): StripTab[] {
  return Array.from(layout, (kind, position) => ({
    id: `${kind}${String(position + 1)}`,
    pinned: kind === 'P',
  }));
}

const tabs = strip('PPttt');

describe('dropSlot', () => {
  const midpoints = [10, 30, 50];

  it('counts the rows whose midpoint is above the pointer', () => {
    expect(dropSlot(midpoints, 0)).toBe(0);
    expect(dropSlot(midpoints, 20)).toBe(1);
    expect(dropSlot(midpoints, 40)).toBe(2);
    expect(dropSlot(midpoints, 100)).toBe(3);
  });

  it('puts the slot before a row until the pointer passes its midpoint', () => {
    expect(dropSlot(midpoints, 10)).toBe(0);
    expect(dropSlot(midpoints, 10.5)).toBe(1);
  });

  it('is 0 for an empty section', () => {
    expect(dropSlot([], 25)).toBe(0);
  });
});

describe('dropTargetIndex', () => {
  it('moves a tab down to a later slot, one index earlier than the slot', () => {
    // t3 is the first unpinned tab. Slot 2 is before the third unpinned tab (t5).
    expect(dropTargetIndex(tabs, 't3', 2)).toBe(3);
    expect(dropTargetIndex(tabs, 't3', 3)).toBe(4);
  });

  it('moves a tab up to an earlier slot', () => {
    expect(dropTargetIndex(tabs, 't5', 0)).toBe(2);
    expect(dropTargetIndex(tabs, 't5', 1)).toBe(3);
  });

  it('returns null when the drop leaves the tab in place', () => {
    // Slots at the tab's own top and bottom edge both mean "where it already is".
    expect(dropTargetIndex(tabs, 't4', 1)).toBeNull();
    expect(dropTargetIndex(tabs, 't4', 2)).toBeNull();
    expect(dropTargetIndex(tabs, 'P1', 0)).toBeNull();
    expect(dropTargetIndex(tabs, 'P1', 1)).toBeNull();
  });

  it('keeps a pinned tab among the pinned ones', () => {
    expect(dropTargetIndex(tabs, 'P1', 2)).toBe(1);
    expect(dropTargetIndex(tabs, 'P2', 0)).toBe(0);
  });

  it('clamps a slot outside the section into it', () => {
    expect(dropTargetIndex(tabs, 't3', 99)).toBe(4);
    expect(dropTargetIndex(tabs, 't5', -4)).toBe(2);
    expect(dropTargetIndex(tabs, 'P1', 99)).toBe(1);
  });

  it('truncates a fractional slot', () => {
    expect(dropTargetIndex(tabs, 't3', 2.9)).toBe(3);
  });

  it('works when every tab is in one section', () => {
    expect(dropTargetIndex(strip('ttt'), 't1', 3)).toBe(2);
    expect(dropTargetIndex(strip('PPP'), 'P3', 0)).toBe(0);
  });

  it('returns null for a tab that is not in the strip', () => {
    expect(dropTargetIndex(tabs, 'gone', 1)).toBeNull();
    expect(dropTargetIndex([], 't1', 0)).toBeNull();
  });
});

describe('keyboardMoveTarget', () => {
  it('moves one place within the section', () => {
    expect(keyboardMoveTarget(tabs, 't4', -1)).toBe(2);
    expect(keyboardMoveTarget(tabs, 't4', 1)).toBe(4);
    expect(keyboardMoveTarget(tabs, 'P2', -1)).toBe(0);
  });

  it('stops at the edge of the section', () => {
    expect(keyboardMoveTarget(tabs, 'P1', -1)).toBeNull();
    expect(keyboardMoveTarget(tabs, 'P2', 1)).toBeNull();
    expect(keyboardMoveTarget(tabs, 't3', -1)).toBeNull();
    expect(keyboardMoveTarget(tabs, 't5', 1)).toBeNull();
  });

  it('does nothing for a lone tab or an unknown one', () => {
    expect(keyboardMoveTarget(strip('t'), 't1', 1)).toBeNull();
    expect(keyboardMoveTarget(tabs, 'gone', 1)).toBeNull();
  });
});

describe('nextFocusIndex', () => {
  it('moves down and up one tab', () => {
    expect(nextFocusIndex(5, 1, 'ArrowDown')).toBe(2);
    expect(nextFocusIndex(5, 3, 'ArrowUp')).toBe(2);
  });

  it('wraps around at both ends', () => {
    expect(nextFocusIndex(5, 4, 'ArrowDown')).toBe(0);
    expect(nextFocusIndex(5, 0, 'ArrowUp')).toBe(4);
  });

  it('jumps to the first and last tab', () => {
    expect(nextFocusIndex(5, 2, 'Home')).toBe(0);
    expect(nextFocusIndex(5, 2, 'End')).toBe(4);
  });

  it('starts from the top or bottom when nothing is focused', () => {
    expect(nextFocusIndex(5, -1, 'ArrowDown')).toBe(0);
    expect(nextFocusIndex(5, -1, 'ArrowUp')).toBe(4);
  });

  it('has nowhere to go without tabs', () => {
    expect(nextFocusIndex(0, -1, 'ArrowDown')).toBeNull();
    expect(nextFocusIndex(0, 0, 'Home')).toBeNull();
  });
});
