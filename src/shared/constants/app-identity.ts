// App identity (ADR-0007 §6). These are one-way doors: changing any of them after users have
// installed a build breaks updates, taskbar pinning or the profile location.
// package.json and electron-builder.yml repeat them; a unit test keeps the copies in sync.

export const PRODUCT_NAME = 'Veltriva Browser';

/** Windows AppUserModelID; also electron-builder's `appId`. */
export const APP_USER_MODEL_ID = 'io.github.rmv-coder.veltriva';

/** Profile folder under %APPDATA%. Deliberately not the product name. */
export const USER_DATA_DIR_NAME = 'Veltriva';

/** Packaged executable name, without the `.exe` extension. */
export const EXECUTABLE_NAME = 'Veltriva';
