import { describe, expect, it } from 'vitest';

import { FOCUS_REQUEST_MAX_AGE_MS, isFocusRequestFresh } from './focus-request';

describe('isFocusRequestFresh', () => {
  it('honors a request made just now', () => {
    expect(isFocusRequestFresh(1000, 1000)).toBe(true);
    expect(isFocusRequestFresh(1000, 1016)).toBe(true);
  });

  it('honors a request up to the limit', () => {
    expect(isFocusRequestFresh(1000, 1000 + FOCUS_REQUEST_MAX_AGE_MS)).toBe(true);
  });

  it('drops a request older than the limit', () => {
    expect(isFocusRequestFresh(1000, 1000 + FOCUS_REQUEST_MAX_AGE_MS + 1)).toBe(false);
    expect(isFocusRequestFresh(0, 60_000)).toBe(false);
  });

  it('drops a request from the future, which the clock cannot produce', () => {
    expect(isFocusRequestFresh(2000, 1000)).toBe(false);
  });
});
