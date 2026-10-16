// What the address bar's zoom indicator shows. Pure, so Vitest covers it.

/** The page's normal size: the indicator is hidden here. */
export const DEFAULT_ZOOM_PERCENT = 100;

/** The indicator shows only while the page is zoomed away from 100%. */
export function isZoomIndicatorVisible(zoomPercent: number): boolean {
  return zoomPercent !== DEFAULT_ZOOM_PERCENT;
}

/** The indicator's visible text, e.g. "110%". */
export function zoomIndicatorText(zoomPercent: number): string {
  return `${String(zoomPercent)}%`;
}

/** The indicator's accessible name and tooltip: it says what a click does. */
export function zoomIndicatorLabel(zoomPercent: number): string {
  return `Zoom ${zoomIndicatorText(zoomPercent)}: reset to ${zoomIndicatorText(DEFAULT_ZOOM_PERCENT)}`;
}
