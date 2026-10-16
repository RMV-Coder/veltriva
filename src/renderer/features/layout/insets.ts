// How far the shell's chrome reaches into the window, measured from the content area's box.
// Pure, so Vitest covers it; the DOM measuring lives in use-content-insets.ts.

export interface Insets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/** The edges of an element's box in viewport coordinates, like a DOMRect's. */
export interface EdgeRect {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/** The `layout.setInsets` schema accepts 0 to 10000. */
const MAX_INSET = 10_000;

function clampInset(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.min(value, MAX_INSET);
}

/**
 * Insets from the content area's rect and the viewport size: the distance from each window edge to
 * the matching edge of the rect. Main puts the tab's view in what remains. Values are clamped to
 * what the command accepts, so a layout glitch can't make `setInsets` fail validation.
 */
export function computeInsets(rect: EdgeRect, viewport: Viewport): Insets {
  return {
    top: clampInset(rect.top),
    right: clampInset(viewport.width - rect.right),
    bottom: clampInset(viewport.height - rect.bottom),
    left: clampInset(rect.left),
  };
}

export function insetsEqual(a: Insets, b: Insets): boolean {
  return a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
}
