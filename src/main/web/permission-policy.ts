// What the browsing session (tabs) may be granted before the permission broker exists (M1.4).
// Every session starts deny-all (./session-baseline.ts); tabs additionally get these, which
// Chrome grants without a prompt (assessment §6.4). Pure, so the list is unit-tested.
//
// - `clipboard-sanitized-write`: a site's "copy" button (navigator.clipboard.writeText). Writing
//   sanitized text is harmless; reading the clipboard stays denied.
// - `fullscreen` (M1.3b): a video's or a slide deck's fullscreen button. Chromium still requires a
//   user gesture, Esc always leaves, and the shell names the page's origin for a few seconds
//   (threat T6, src/main/windows/fullscreen.ts). Pointer lock stays denied.
const GRANTED_TO_TABS: ReadonlySet<string> = new Set(['clipboard-sanitized-write', 'fullscreen']);

export function isTabPermissionGranted(permission: string): boolean {
  return GRANTED_TO_TABS.has(permission);
}
