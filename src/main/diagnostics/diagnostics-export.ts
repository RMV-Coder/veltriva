// "Export diagnostics" (M5.3): what the diagnostics page shows, as one JSON document the user can
// attach to a report. It never holds what the user browsed unless they ask for it: no address and
// no page title by default; with `includeAddresses`, each tab's address (never its title, never
// the search template's address). Pure, so Vitest covers exactly what can leave the machine.

export const DIAGNOSTICS_EXPORT_VERSION = 1;

export interface DiagnosticsTabInput {
  readonly placement: 'strip' | 'shelf';
  readonly runtime: string;
  readonly privateKb: number | null;
  /** How many tabs share its renderer process (Chromium puts a site's tabs together). */
  readonly sharedWith: number;
  readonly address: string;
}

export interface DiagnosticsInput {
  readonly exportedAt: number;
  readonly app: Readonly<Record<string, string>>;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly regret: {
    readonly since: number;
    readonly moves: number;
    readonly moveRegrets: number;
    readonly unloads: number;
    readonly unloadRegrets: number;
    readonly events: readonly unknown[];
  };
  readonly automation: Readonly<Record<string, unknown>>;
  readonly pressure: Readonly<Record<string, unknown>>;
  readonly memory: Readonly<Record<string, unknown>>;
  readonly tabs: readonly DiagnosticsTabInput[];
  readonly database: Readonly<Record<string, unknown>>;
}

export function buildDiagnosticsExport(
  input: DiagnosticsInput,
  options: { readonly includeAddresses: boolean },
): Record<string, unknown> {
  return {
    version: DIAGNOSTICS_EXPORT_VERSION,
    exportedAt: new Date(input.exportedAt).toISOString(),
    includesAddresses: options.includeAddresses,
    app: input.app,
    settings: input.settings,
    regret: input.regret,
    automation: input.automation,
    pressure: input.pressure,
    memory: input.memory,
    tabs: input.tabs.map(({ address, ...tab }) =>
      options.includeAddresses ? { ...tab, address } : tab,
    ),
    database: input.database,
  };
}
