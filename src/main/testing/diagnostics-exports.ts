// Test builds only: "Export diagnostics" and "Open the log folder" (M5.3) are recorded here instead
// of showing the save dialog or opening Explorer, so the specs can read what would have been saved.
const exports: string[] = [];
const openedPaths: string[] = [];

export function recordDiagnosticsExport(json: string): void {
  exports.push(json);
}

export function recordedDiagnosticsExports(): string[] {
  return [...exports];
}

export function recordOpenedPath(path: string): void {
  openedPaths.push(path);
}

export function recordedOpenedPaths(): string[] {
  return [...openedPaths];
}
