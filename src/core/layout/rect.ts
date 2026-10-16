// Pure layout geometry, in device-independent pixels (DIPs). The window code in main uses it
// to size views; the M1.3 LayoutManager adds its toolbar, sidebar and content rectangles here.

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

function toWholeDips(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
