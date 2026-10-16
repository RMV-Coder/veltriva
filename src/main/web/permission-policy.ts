// What the browsing session (tabs) may be granted before the permission broker exists (M1.4).
// Every session starts deny-all (./session-baseline.ts); tabs additionally get these, which
// Chrome grants without a prompt (assessment §6.4). Pure, so the list is unit-tested.
//
// - `clipboard-sanitized-write`: a site's "copy" button (navigator.clipboard.writeText). Writing
//   sanitized text is harmless; reading the clipboard stays denied.
//
// `fullscreen` joins this list in M1.3b, together with the origin notice (threat T6) and the
// layout that lets a tab fill the window.
const GRANTED_TO_TABS: ReadonlySet<string> = new Set(['clipboard-sanitized-write']);

export function isTabPermissionGranted(permission: string): boolean {
  return GRANTED_TO_TABS.has(permission);
}
