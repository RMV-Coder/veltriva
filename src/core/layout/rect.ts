// Pure layout geometry, in device-independent pixels (DIPs). Main uses it to size the shell view
// (the whole window) and the selected tab's view (the content area inside the shell's chrome).

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The rectangle that fills a content area of `size`, anchored at the origin.
 * Electron needs whole, non-negative DIPs, so fractions are floored and invalid sizes
 * (negative, NaN, infinite) collapse to 0.
 */
export function fillRect(size: Size): Rect {
  return { x: 0, y: 0, width: toWholeDips(size.width), height: toWholeDips(size.height) };
}

/** How far the shell's chrome (toolbar, sidebar) reaches into the window from each edge. */
export interface Insets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * The content area: the window minus the shell's chrome. The shell measures its chrome in CSS
 * pixels, which can be fractional, so the edges round inward: the tab view never covers chrome.
 * Invalid insets count as 0, and a window too small for its chrome gives an empty rectangle.
 */
export function insetRect(size: Size, insets: Insets): Rect {
  const width = toWholeDips(size.width);
  const height = toWholeDips(size.height);
  const left = Math.min(Math.ceil(toNonNegative(insets.left)), width);
  const top = Math.min(Math.ceil(toNonNegative(insets.top)), height);
  const right = Math.max(left, width - Math.ceil(toNonNegative(insets.right)));
  const bottom = Math.max(top, height - Math.ceil(toNonNegative(insets.bottom)));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function toWholeDips(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function toNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
