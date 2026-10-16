import { describe, expect, it } from 'vitest';

import { isTabPermissionGranted } from './permission-policy';

describe('isTabPermissionGranted', () => {
  it('grants writing sanitized text to the clipboard', () => {
    expect(isTabPermissionGranted('clipboard-sanitized-write')).toBe(true);
  });

  it.each([
    'clipboard-read',
    'fullscreen',
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
    'unknown',
    '',
    'CLIPBOARD-SANITIZED-WRITE',
  ])('denies %s until the permission broker (M1.4)', (permission) => {
    expect(isTabPermissionGranted(permission)).toBe(false);
  });
});
