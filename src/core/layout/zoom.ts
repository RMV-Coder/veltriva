// Page zoom steps (Ctrl+=, Ctrl+−, Ctrl+0 and Ctrl+wheel): the same preset levels as Chrome, so a
// page zoomed in Veltriva looks the same as in Chrome at each step. Pure.

/** Chrome's `kPresetZoomFactors`: a third and two thirds are exact, shown as 33% and 67%. */
export const ZOOM_FACTORS = [
  0.25,
  1 / 3,
  0.5,
  2 / 3,
  0.75,
  0.8,
  0.9,
  1,
  1.1,
  1.25,
  1.5,
  1.75,
  2,
  2.5,
  3,
  4,
  5,
] as const;

export const MIN_ZOOM_FACTOR = ZOOM_FACTORS[0];
export const MAX_ZOOM_FACTOR = ZOOM_FACTORS[ZOOM_FACTORS.length - 1] ?? 5;

export type ZoomDirection = 'in' | 'out' | 'reset';

/** Tolerance for factors that went through floating point (1.2 ** level) on their way here. */
const EPSILON = 0.001;

/**
 * The next preset factor in a direction, from any current factor (a page can be at a level that
 * isn't a preset). At either end it stays put; `reset` is always 100%.
 */
export function nextZoomFactor(current: number, direction: ZoomDirection): number {
  if (direction === 'reset' || !Number.isFinite(current) || current <= 0) {
    return 1;
  }
  if (direction === 'in') {
    return ZOOM_FACTORS.find((factor) => factor > current + EPSILON) ?? MAX_ZOOM_FACTOR;
  }
  return (
    [...ZOOM_FACTORS].reverse().find((factor) => factor < current - EPSILON) ?? MIN_ZOOM_FACTOR
  );
}

/** The whole percentage the shell shows, such as 110 for a factor of 1.1. */
export function zoomPercent(factor: number): number {
  return Number.isFinite(factor) && factor > 0 ? Math.round(factor * 100) : 100;
}
