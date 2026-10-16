import { describe, expect, it } from 'vitest';

import { isTabPermissionGranted } from './permission-policy';

describe('isTabPermissionGranted', () => {
  it('grants writing sanitized text to the clipboard', () => {
    expect(isTabPermissionGranted('clipboard-sanitized-write')).toBe(true);
  });

  it('grants HTML fullscreen, which comes with an origin notice (T6)', () => {
    expect(isTabPermissionGranted('fullscreen')).toBe(true);
  });

  it.each([
    'clipboard-read',
    'media',
    'geolocation',
    'notifications',
    'display-capture',
    'openExternal',
    'hid',
    'serial',
    'usb',
    'midiSysex',
    'pointerLock',
    'keyboardLock',
    'unknown',
    '',
    'CLIPBOARD-SANITIZED-WRITE',
    'FULLSCREEN',
  ])('denies %s until the permission broker (M1.4)', (permission) => {
    expect(isTabPermissionGranted(permission)).toBe(false);
  });
});
