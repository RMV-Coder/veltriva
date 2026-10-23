import { describe, expect, it } from 'vitest';

import { nextFocusStop } from './focus-cycle';

describe('nextFocusStop (M6.2, F6)', () => {
  it('goes address bar → sidebar → page → address bar', () => {
    expect(nextFocusStop('elsewhere')).toBe('sidebar');
    expect(nextFocusStop('sidebar')).toBe('page');
    expect(nextFocusStop('page')).toBe('address-bar');
  });
});
