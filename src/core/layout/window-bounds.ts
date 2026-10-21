// Where the window opens: where it was last time (the app_state document `window`), as long as
// that is still on a screen. A monitor can be unplugged, or a laptop undocked, between runs; a
// window placed off every screen would be unreachable. Pure, so the rules are unit-tested.
import type { Rect, Size } from './rect';

export interface SavedWindow extends Rect {
  readonly maximized: boolean;
}

/** The title bar's strip must overlap a screen's work area by at least this much to be grabbed. */
const MIN_VISIBLE: Size = { width: 120, height: 40 };
const MAX_DIMENSION = 32_768;

/** The saved window if it is well formed and reachable, made to fit its screen; otherwise null. */
export function placeWindow(
  saved: unknown,
  workAreas: readonly Rect[],
  minSize: Size,
): SavedWindow | null {
  const window = parseSavedWindow(saved);
  if (window === null) {
    return null;
  }
  // The strip along the top edge, where the title bar is.
  const titleBar: Rect = {
    x: window.x,
    y: window.y,
    width: window.width,
    height: MIN_VISIBLE.height,
  };
  const screen = workAreas.find((area) => {
    const overlap = intersect(titleBar, area);
    return overlap.width >= MIN_VISIBLE.width && overlap.height >= MIN_VISIBLE.height;
  });
  if (screen === undefined) {
    return null;
  }
  const width = Math.max(minSize.width, Math.min(window.width, screen.width));
  const height = Math.max(minSize.height, Math.min(window.height, screen.height));
  return { ...window, width, height };
}

export function parseSavedWindow(value: unknown): SavedWindow | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const { x, y, width, height, maximized } = value as Record<string, unknown>;
  const whole = (n: unknown, min: number, max: number): n is number =>
    typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;
  if (
    !whole(x, -MAX_DIMENSION, MAX_DIMENSION) ||
    !whole(y, -MAX_DIMENSION, MAX_DIMENSION) ||
    !whole(width, 1, MAX_DIMENSION) ||
    !whole(height, 1, MAX_DIMENSION) ||
    typeof maximized !== 'boolean'
  ) {
    return null;
  }
  return { x, y, width, height, maximized };
}

function intersect(a: Rect, b: Rect): Size {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return { width: Math.max(0, width), height: Math.max(0, height) };
}
