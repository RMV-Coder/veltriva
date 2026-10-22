import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  ARCHIVE_OVERSCAN,
  ARCHIVE_ROW_HEIGHT,
  ARCHIVE_VIEWPORT_ROWS,
  ARCHIVE_WINDOW,
  MAX_KEPT_WINDOWS,
  alignedOffset,
  listHeight,
  neededOffsets,
  nextRowIndex,
  pageRows,
  scrollToReveal,
  viewportHeight,
  visibleRange,
  windowsToDrop,
} from './virtual-window';

const ROW = 40;

describe('listHeight and viewportHeight', () => {
  it('makes the scroll height every row, drawn or not', () => {
    expect(listHeight(10_000, ARCHIVE_ROW_HEIGHT)).toBe(10_000 * ARCHIVE_ROW_HEIGHT);
    expect(listHeight(0, ROW)).toBe(0);
    expect(listHeight(-3, ROW)).toBe(0);
  });

  it('shows all of a short list and a fixed number of rows of a long one', () => {
    expect(viewportHeight(3, ROW, ARCHIVE_VIEWPORT_ROWS)).toBe(120);
    expect(viewportHeight(8, ROW, ARCHIVE_VIEWPORT_ROWS)).toBe(320);
    expect(viewportHeight(10_000, ROW, ARCHIVE_VIEWPORT_ROWS)).toBe(320);
    expect(viewportHeight(0, ROW, ARCHIVE_VIEWPORT_ROWS)).toBe(0);
  });
});

describe('visibleRange', () => {
  const view = (scrollTop: number, total = 10_000, overscan = 0) => ({
    scrollTop,
    viewportHeight: 320, // eight rows
    rowHeight: ROW,
    total,
    overscan,
  });

  it('is the rows that touch the viewport', () => {
    expect(visibleRange(view(0))).toEqual({ start: 0, end: 8 });
    expect(visibleRange(view(400))).toEqual({ start: 10, end: 18 });
  });

  it('includes a row that is only partly in view, at either edge', () => {
    // Scrolled half a row: rows 0 to 8 are touched (the ninth by its first half).
    expect(visibleRange(view(20))).toEqual({ start: 0, end: 9 });
  });

  it('adds the overscan on both sides, inside the list', () => {
    expect(visibleRange(view(400, 10_000, 6))).toEqual({ start: 4, end: 24 });
    expect(visibleRange(view(0, 10_000, 6))).toEqual({ start: 0, end: 14 });
  });

  it('stops at the end of the list', () => {
    const atEnd = (10_000 - 8) * ROW;
    expect(visibleRange(view(atEnd, 10_000, 6))).toEqual({ start: 9_986, end: 10_000 });
    // A scroll position past the end (the list shrank) counts as the end.
    expect(visibleRange(view(atEnd * 2, 10_000, 0))).toEqual({ start: 9_992, end: 10_000 });
  });

  it('draws all of a list that fits', () => {
    expect(visibleRange({ ...view(0, 3, 6), viewportHeight: 120 })).toEqual({ start: 0, end: 3 });
  });

  it('draws nothing for an empty list', () => {
    expect(visibleRange(view(0, 0, 6))).toEqual({ start: 0, end: 0 });
    expect(visibleRange({ ...view(0), rowHeight: 0 })).toEqual({ start: 0, end: 0 });
  });

  it('ignores a scroll position that is not a number or is negative', () => {
    expect(visibleRange(view(Number.NaN))).toEqual({ start: 0, end: 8 });
    expect(visibleRange(view(-500))).toEqual({ start: 0, end: 8 });
  });

  it('draws few rows however long the list is: the real settings stay far under 60 rows', () => {
    const rows = (top: number): number => {
      const range = visibleRange({
        scrollTop: top,
        viewportHeight: viewportHeight(10_000, ARCHIVE_ROW_HEIGHT, ARCHIVE_VIEWPORT_ROWS),
        rowHeight: ARCHIVE_ROW_HEIGHT,
        total: 10_000,
        overscan: ARCHIVE_OVERSCAN,
      });
      return range.end - range.start;
    };
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000 * ARCHIVE_ROW_HEIGHT }), (top) => {
        expect(rows(top)).toBeLessThanOrEqual(ARCHIVE_VIEWPORT_ROWS + 1 + 2 * ARCHIVE_OVERSCAN);
        expect(rows(top)).toBeLessThan(60);
      }),
    );
  });

  it('always includes every row in the viewport, wherever it is scrolled', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5_000 }),
        fc.integer({ min: 0, max: 5_000 * ROW }),
        (total, top) => {
          const height = viewportHeight(total, ROW, 8);
          const range = visibleRange({
            scrollTop: top,
            viewportHeight: height,
            rowHeight: ROW,
            total,
            overscan: 0,
          });
          const maxScroll = Math.max(0, listHeight(total, ROW) - height);
          const clamped = Math.min(top, maxScroll);
          const firstInView = Math.floor(clamped / ROW);
          const lastInView = Math.min(total - 1, Math.ceil((clamped + height) / ROW) - 1);
          expect(range.start).toBeLessThanOrEqual(firstInView);
          expect(range.end).toBeGreaterThanOrEqual(lastInView + 1);
          expect(range.start).toBeGreaterThanOrEqual(0);
          expect(range.end).toBeLessThanOrEqual(total);
        },
      ),
    );
  });
});

describe('alignedOffset', () => {
  it('is the start of the window that holds the row', () => {
    expect(alignedOffset(0, ARCHIVE_WINDOW)).toBe(0);
    expect(alignedOffset(99, ARCHIVE_WINDOW)).toBe(0);
    expect(alignedOffset(100, ARCHIVE_WINDOW)).toBe(100);
    expect(alignedOffset(9_999, ARCHIVE_WINDOW)).toBe(9_900);
    expect(alignedOffset(-4, ARCHIVE_WINDOW)).toBe(0);
  });
});

describe('neededOffsets', () => {
  it('lists the windows that hold the rows to draw', () => {
    expect(neededOffsets({ start: 250, end: 270 }, 0, 10_000, 100)).toEqual([200]);
    expect(neededOffsets({ start: 290, end: 310 }, 0, 10_000, 100)).toEqual([200, 300]);
    expect(neededOffsets({ start: 90, end: 410 }, 0, 10_000, 100)).toEqual([0, 100, 200, 300, 400]);
  });

  it('skips the rows the snapshot already holds', () => {
    // The newest 200 come with the snapshot: only rows from 200 on are fetched.
    expect(neededOffsets({ start: 0, end: 14 }, 200, 10_000, 100)).toEqual([]);
    expect(neededOffsets({ start: 190, end: 210 }, 200, 10_000, 100)).toEqual([200]);
    expect(neededOffsets({ start: 150, end: 450 }, 200, 10_000, 100)).toEqual([200, 300, 400]);
  });

  it('never goes past the end of the list', () => {
    expect(neededOffsets({ start: 9_990, end: 10_020 }, 0, 10_000, 100)).toEqual([9_900]);
    expect(neededOffsets({ start: 0, end: 40 }, 0, 40, 100)).toEqual([0]);
  });

  it('is empty for no rows', () => {
    expect(neededOffsets({ start: 0, end: 0 }, 0, 0, 100)).toEqual([]);
    expect(neededOffsets({ start: 500, end: 400 }, 0, 10_000, 100)).toEqual([]);
  });
});

describe('scrollToReveal', () => {
  const base = { scrollTop: 400, viewportHeight: 320, rowHeight: ROW, total: 1000 };

  it('stays where it is when the row is fully in view', () => {
    expect(scrollToReveal({ ...base, index: 10 })).toBe(400); // top edge exactly
    expect(scrollToReveal({ ...base, index: 14 })).toBe(400);
    expect(scrollToReveal({ ...base, index: 17 })).toBe(400); // bottom edge exactly
  });

  it('scrolls up just far enough to show a row above the view', () => {
    expect(scrollToReveal({ ...base, index: 9 })).toBe(360);
    expect(scrollToReveal({ ...base, index: 0 })).toBe(0);
  });

  it('scrolls down just far enough to show a row below the view', () => {
    expect(scrollToReveal({ ...base, index: 18 })).toBe(440);
    expect(scrollToReveal({ ...base, index: 999 })).toBe(1000 * ROW - 320);
  });

  it('shows a partly hidden row whole', () => {
    expect(scrollToReveal({ ...base, scrollTop: 420, index: 10 })).toBe(400);
    expect(scrollToReveal({ ...base, scrollTop: 420, index: 18 })).toBe(440);
  });
});

describe('windowsToDrop', () => {
  it('keeps everything while there is room', () => {
    expect(windowsToDrop([0, 100, 200], 50, 100, 12, 200)).toEqual([]);
  });

  it('drops the windows farthest from the view', () => {
    const held = [200, 300, 400, 500, 9_800];
    // Looking at row 350: the far end of the list goes first.
    expect(windowsToDrop(held, 350, 100, 4, 400)).toEqual([9_800]);
    expect(windowsToDrop(held, 350, 100, 3, 400)).toEqual([500, 9_800]);
  });

  it('never drops the window that just arrived, however far it is', () => {
    expect(windowsToDrop([0, 100, 5_000], 0, 100, 2, 5_000)).toEqual([100]);
    expect(windowsToDrop([0, 100, 5_000], 0, 100, 1, 5_000)).toEqual([0, 100]);
  });

  it('keeps at most MAX_KEPT_WINDOWS', () => {
    const held = Array.from({ length: 40 }, (_, index) => index * 100);
    const dropped = windowsToDrop(held, 0, 100, MAX_KEPT_WINDOWS, 0);
    expect(held.length - dropped.length).toBe(MAX_KEPT_WINDOWS);
  });
});

describe('pageRows and nextRowIndex', () => {
  it('moves a screenful less one', () => {
    expect(pageRows(8)).toBe(7);
    expect(pageRows(1)).toBe(1);
    expect(pageRows(0)).toBe(1);
  });

  it('goes to the next and previous row, wrapping around', () => {
    expect(nextRowIndex(100, 5, 'ArrowDown', 7)).toBe(6);
    expect(nextRowIndex(100, 5, 'ArrowUp', 7)).toBe(4);
    expect(nextRowIndex(100, 99, 'ArrowDown', 7)).toBe(0);
    expect(nextRowIndex(100, 0, 'ArrowUp', 7)).toBe(99);
  });

  it('goes to the first and last row on Home and End', () => {
    expect(nextRowIndex(10_000, 4_321, 'Home', 7)).toBe(0);
    expect(nextRowIndex(10_000, 4_321, 'End', 7)).toBe(9_999);
  });

  it('pages by the page size and stops at the ends', () => {
    expect(nextRowIndex(100, 10, 'PageDown', 7)).toBe(17);
    expect(nextRowIndex(100, 10, 'PageUp', 7)).toBe(3);
    expect(nextRowIndex(100, 97, 'PageDown', 7)).toBe(99);
    expect(nextRowIndex(100, 2, 'PageUp', 7)).toBe(0);
  });

  it('starts at the first row when none has focus', () => {
    expect(nextRowIndex(100, -1, 'ArrowDown', 7)).toBe(0);
    expect(nextRowIndex(100, -1, 'ArrowUp', 7)).toBe(99);
  });

  it('has nowhere to go without rows', () => {
    expect(nextRowIndex(0, -1, 'ArrowDown', 7)).toBeNull();
    expect(nextRowIndex(0, 0, 'End', 7)).toBeNull();
  });
});
