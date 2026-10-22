// The window math of the Archive list: which of N fixed-height rows to draw for a scroll position,
// and which `archive.list` windows hold them. Pure, so Vitest covers it. The list can hold every
// archived tab (10,000 and more), so it draws only the rows in view plus a few more on each side,
// and the scroll height is `total × rowHeight`, as if all of them were there.

/** One row's height in CSS pixels: an archived row is a title and a line under it. */
export const ARCHIVE_ROW_HEIGHT = 44;
/** The list shows at most this many rows at once; a longer Archive scrolls. */
export const ARCHIVE_VIEWPORT_ROWS = 8;
/** Rows drawn above and below what is in view, so a scroll never shows an empty edge. */
export const ARCHIVE_OVERSCAN = 6;
/** Rows per `archive.list` call. Offsets are multiples of it, so a window is fetched once. */
export const ARCHIVE_WINDOW = 100;
/** The fetched windows kept: the ones nearest the view survive (a window is 100 small rows). */
export const MAX_KEPT_WINDOWS = 12;

/** The scroll height of the list: every row, drawn or not. */
export function listHeight(total: number, rowHeight: number): number {
  return Math.max(0, total) * rowHeight;
}

/** The height of the part of the list that is in view: all of a short list, else `maxRows` rows. */
export function viewportHeight(total: number, rowHeight: number, maxRows: number): number {
  return Math.min(Math.max(0, total), maxRows) * rowHeight;
}

export interface RowRange {
  /** The first row to draw. */
  readonly start: number;
  /** One past the last row to draw. */
  readonly end: number;
}

/**
 * The rows to draw for a scroll position: those that touch the viewport, and `overscan` more on
 * each side, kept inside the list. An empty range when there are no rows.
 */
export function visibleRange(view: {
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly rowHeight: number;
  readonly total: number;
  readonly overscan: number;
}): RowRange {
  const { rowHeight, total, overscan } = view;
  if (total <= 0 || rowHeight <= 0) {
    return { start: 0, end: 0 };
  }
  const maxScroll = Math.max(0, listHeight(total, rowHeight) - view.viewportHeight);
  const top = Math.min(
    Math.max(Number.isFinite(view.scrollTop) ? view.scrollTop : 0, 0),
    maxScroll,
  );
  const first = Math.floor(top / rowHeight);
  // The last row that touches the viewport's bottom edge.
  const last = Math.ceil((top + view.viewportHeight) / rowHeight) - 1;
  return {
    start: Math.min(Math.max(first - overscan, 0), total),
    end: Math.max(Math.min(last + 1 + overscan, total), 0),
  };
}

/** The offset of the `archive.list` window that holds row `index`. */
export function alignedOffset(index: number, windowSize: number): number {
  return Math.floor(Math.max(0, index) / windowSize) * windowSize;
}

/**
 * The offsets of the windows that hold the rows from `from` up to `end` (exclusive), in order.
 * Rows below `from` are not needed: the first rows come with the workspace snapshot, which main
 * keeps current, and only the rest are fetched.
 */
export function neededOffsets(
  range: RowRange,
  from: number,
  total: number,
  windowSize: number,
): number[] {
  const start = Math.max(range.start, from, 0);
  const end = Math.min(range.end, total);
  if (end <= start) {
    return [];
  }
  const offsets: number[] = [];
  for (let offset = alignedOffset(start, windowSize); offset < end; offset += windowSize) {
    offsets.push(offset);
  }
  return offsets;
}

/**
 * The scroll position that brings row `index` into view with the least movement: where it is now
 * if the row is already fully in view.
 */
export function scrollToReveal(view: {
  readonly index: number;
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly rowHeight: number;
  readonly total: number;
}): number {
  const { index, rowHeight } = view;
  const maxScroll = Math.max(0, listHeight(view.total, rowHeight) - view.viewportHeight);
  const rowTop = index * rowHeight;
  const rowBottom = rowTop + rowHeight;
  let target = view.scrollTop;
  if (rowTop < target) {
    target = rowTop;
  } else if (rowBottom > target + view.viewportHeight) {
    target = rowBottom - view.viewportHeight;
  }
  return Math.min(Math.max(target, 0), maxScroll);
}

/**
 * Which windows to keep after a new one arrived: the `keep` nearest to `center` (a row index),
 * and always `fresh`, the window that just arrived. Returns the offsets to drop.
 */
export function windowsToDrop(
  held: readonly number[],
  center: number,
  windowSize: number,
  keep: number,
  fresh: number,
): number[] {
  if (held.length <= keep) {
    return [];
  }
  const distance = (offset: number): number =>
    offset === fresh ? -1 : Math.abs(offset + windowSize / 2 - center);
  const ordered = [...held].sort((a, b) => distance(a) - distance(b) || a - b);
  return ordered.slice(keep);
}

/** How many rows a PageUp or PageDown moves: a screenful, less one so the last row stays in sight. */
export function pageRows(viewportRows: number): number {
  return Math.max(1, viewportRows - 1);
}

/** The row to focus for a navigation key, or null when there are no rows. Arrows wrap; pages stop. */
export function nextRowIndex(
  total: number,
  current: number,
  key: 'ArrowUp' | 'ArrowDown' | 'Home' | 'End' | 'PageUp' | 'PageDown',
  pageSize: number,
): number | null {
  if (total <= 0) {
    return null;
  }
  const from = Math.min(Math.max(current, 0), total - 1);
  switch (key) {
    case 'Home':
      return 0;
    case 'End':
      return total - 1;
    case 'ArrowDown':
      return current < 0 ? 0 : (from + 1) % total;
    case 'ArrowUp':
      return current <= 0 ? total - 1 : from - 1;
    case 'PageDown':
      return Math.min(from + pageSize, total - 1);
    case 'PageUp':
      return Math.max(from - pageSize, 0);
  }
}
