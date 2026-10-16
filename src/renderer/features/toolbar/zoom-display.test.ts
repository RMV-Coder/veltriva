import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ZOOM_PERCENT,
  isZoomIndicatorVisible,
  zoomIndicatorLabel,
  zoomIndicatorText,
} from './zoom-display';

describe('isZoomIndicatorVisible', () => {
  it('is hidden at 100%', () => {
    expect(isZoomIndicatorVisible(100)).toBe(false);
    expect(isZoomIndicatorVisible(DEFAULT_ZOOM_PERCENT)).toBe(false);
  });

  it('shows for any other zoom, in or out, up to the limits', () => {
    for (const percent of [25, 50, 90, 110, 125, 300, 500]) {
      expect(isZoomIndicatorVisible(percent)).toBe(true);
    }
  });
});

describe('zoomIndicatorText', () => {
  it('is the percentage', () => {
    expect(zoomIndicatorText(110)).toBe('110%');
    expect(zoomIndicatorText(25)).toBe('25%');
    expect(zoomIndicatorText(500)).toBe('500%');
  });
});

describe('zoomIndicatorLabel', () => {
  it('names the zoom and what a click does', () => {
    expect(zoomIndicatorLabel(110)).toBe('Zoom 110%: reset to 100%');
    expect(zoomIndicatorLabel(75)).toBe('Zoom 75%: reset to 100%');
  });
});
