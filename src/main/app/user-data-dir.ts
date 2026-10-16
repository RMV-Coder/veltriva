import { isAbsolute, join } from 'node:path';

import { USER_DATA_DIR_NAME } from '../../shared/constants/app-identity';

/** Unpackaged builds only: points the profile somewhere else, e.g. a temp folder per E2E run. */
export const USER_DATA_DIR_OVERRIDE_ENV = 'VELTRIVA_USER_DATA_DIR';

export interface UserDataDirInput {
  /** `app.getPath('appData')`, i.e. %APPDATA%. */
  readonly appData: string;
  readonly isPackaged: boolean;
  /** Value of `VELTRIVA_USER_DATA_DIR`, if set. Ignored in packaged builds. */
  readonly override: string | undefined;
}

/**
 * Where the profile lives: `%APPDATA%\Veltriva` (ADR-0007 §6), so it doesn't follow the
 * product name. Unpackaged builds (development, E2E) may override it with an absolute path.
 */
export function resolveUserDataDir({ appData, isPackaged, override }: UserDataDirInput): string {
  if (!isPackaged && override !== undefined && override !== '') {
    if (!isAbsolute(override)) {
      throw new Error(`${USER_DATA_DIR_OVERRIDE_ENV} must be an absolute path`);
    }
    return override;
  }
  return join(appData, USER_DATA_DIR_NAME);
}
