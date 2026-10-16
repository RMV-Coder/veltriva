import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveUserDataDir } from './user-data-dir';

const appData = 'C:\\Users\\someone\\AppData\\Roaming';

describe('resolveUserDataDir', () => {
  it('uses %APPDATA%\\Veltriva, not the product name', () => {
    expect(resolveUserDataDir({ appData, isPackaged: true, override: undefined })).toBe(
      join(appData, 'Veltriva'),
    );
  });

  it('ignores the override in packaged builds', () => {
    expect(resolveUserDataDir({ appData, isPackaged: true, override: 'C:\\elsewhere' })).toBe(
      join(appData, 'Veltriva'),
    );
  });

  it('honors an absolute override in unpackaged builds', () => {
    expect(resolveUserDataDir({ appData, isPackaged: false, override: 'C:\\temp\\e2e' })).toBe(
      'C:\\temp\\e2e',
    );
  });

  it('treats an empty override as unset', () => {
    expect(resolveUserDataDir({ appData, isPackaged: false, override: '' })).toBe(
      join(appData, 'Veltriva'),
    );
  });

  it('rejects a relative override', () => {
    expect(() =>
      resolveUserDataDir({ appData, isPackaged: false, override: 'relative\\profile' }),
    ).toThrow(/absolute path/);
  });
});
