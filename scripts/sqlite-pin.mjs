// The reviewed better-sqlite3 build (ADR-0004). To upgrade: pin the new version in package.json,
// then record it here with the SHA-256 of `prebuilds/win32-x64.node` from its published tarball.
export const SQLITE_MODULE_VERSION = '13.0.3';
export const SQLITE_BINARY_SHA256 =
  'e21e5efd71fba66578e95b62554d9028064a80dafd7221bf8a8ef155de8d240a';
/** The binary's path inside the module, the one file packaging unpacks from app.asar. */
export const SQLITE_BINARY = 'prebuilds/win32-x64.node';
