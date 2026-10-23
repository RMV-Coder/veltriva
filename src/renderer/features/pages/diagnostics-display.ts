// What the local diagnostics page says (assessment §4.13: "The regret rate appears only on a local
// diagnostics page"), derived from main's `lifecycle.diagnostics`. Pure, so Vitest covers it; the
// page only renders what this returns.
//
// Everything here is a number, an enum or a site name. A protected site is text the user's own
// list holds, so it is treated like any other untrusted text: controls and invisible formatting
// are removed (./prompts/prompt-display.ts) and the page draws it in `<bdi dir="ltr">`.
import type { CommandOutput } from '../../../shared/contracts/schemas';
import { MONTHS, activityTimeText } from '../activity/activity-display';
import { cleanText } from '../prompts/prompt-display';

export type Diagnostics = CommandOutput<'lifecycle.diagnostics'>;
export type RegretEvent = Diagnostics['regret']['events'][number];

const MINUTE = 60_000;

const COUNT_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** A whole number with thousands separators: "16,128". Anything that is not a number reads 0. */
export function countText(value: number): string {
  return COUNT_FORMAT.format(Number.isFinite(value) ? Math.max(0, value) : 0);
}

/**
 * `part` of `whole` as a percentage with at most one decimal and never more than 100: "25%",
 * "33.3%", "0%". Null when there is nothing to take a share of (`whole` is 0), because then there
 * is no rate, not a rate of 0.
 */
export function percentText(part: number, whole: number): string | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) {
    return null;
  }
  const percent = Math.min(100, Math.max(0, (part / whole) * 100));
  return `${String(Math.round(percent * 10) / 10)}%`;
}

/** "21 Oct 2026", in the user's local time. Null for a time that is not a date. */
export function dateText(at: number): string | null {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return `${String(date.getDate())} ${MONTHS[date.getMonth()] ?? ''} ${String(date.getFullYear())}`;
}

/**
 * When counting started: "Counting since 21 Oct 2026". Null when main has no start (0, which would
 * read as 1970).
 */
export function sinceText(since: number): string | null {
  if (!(since > 0)) {
    return null;
  }
  const date = dateText(since);
  return date === null ? null : `Counting since ${date}`;
}

/**
 * A stretch of engaged time (§4.6, the clock that only runs while the user uses the browser):
 * "under a minute", "12 min", "1 h", "5 h 12 min". Whole minutes, rounded down.
 */
export function engagedText(ms: number): string {
  const minutes = Number.isFinite(ms) ? Math.floor(Math.max(0, ms) / MINUTE) : 0;
  if (minutes < 1) {
    return 'under a minute';
  }
  if (minutes < 60) {
    return `${String(minutes)} min`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`;
}

// ── Regret events, in plain words ───────────────────────────────────────────────────────────────

/** What automation did. */
export function actionText(action: RegretEvent['action']): string {
  switch (action) {
    case 'shelve':
      return 'Moved to Sleeping';
    case 'archive':
      return 'Archived';
    case 'discard':
      return 'Unloaded';
  }
}

/** The rule that decided it, as the reason it gives. */
export function ruleText(rule: RegretEvent['rule']): string {
  switch (rule) {
    case 'discard-hidden':
      return 'Not used for a while';
    case 'shelve-beyond-cap':
      return 'Too many open tabs';
    case 'archive-dormant':
      return 'Not used for days';
    case 'pressure-discard':
      return 'Memory was low';
    case 'freeze-hidden':
      return 'Hidden in the background';
  }
}

/** What the user did about it. */
export function howText(how: RegretEvent['how']): string {
  switch (how) {
    case 'restore':
      return 'Brought it back';
    case 'undo':
      return 'Undid it';
    case 'reload':
      return 'Reloaded it';
  }
}

export interface EventView {
  /** "14:32", "Yesterday 14:32", "21 Oct 14:32". */
  readonly time: string;
  /** The whole date and time, for a tooltip. */
  readonly timeFull: string;
  /** "Moved to Sleeping". */
  readonly action: string;
  /** "Too many open tabs". */
  readonly rule: string;
  /** "Brought it back". */
  readonly how: string;
  /** "12 min": the engaged time between what automation did and what the user did. */
  readonly after: string;
}

/** A regret event as the table draws it, with its times read against `now`. */
export function eventView(event: RegretEvent, now: number): EventView {
  const full = new Date(event.at);
  return {
    time: activityTimeText(event.at, now),
    timeFull: Number.isNaN(full.getTime()) ? '' : full.toLocaleString(),
    action: actionText(event.action),
    rule: ruleText(event.rule),
    how: howText(event.how),
    after: engagedText(event.afterEngagedMs),
  };
}

// ── The two rates ───────────────────────────────────────────────────────────────────────────────

export interface MetricView {
  /** What automation did: all of it since counting started. */
  readonly total: string;
  /** How many of those the user undid, restored or reloaded within an engaged hour. */
  readonly regrets: string;
  /** The share, "25%", or null when automation has not done any yet. */
  readonly rate: string | null;
}

/** One rate: `regrets` of `total`. */
export function metricView(total: number, regrets: number): MetricView {
  return {
    total: countText(total),
    regrets: countText(regrets),
    rate: percentText(regrets, total),
  };
}

// ── Engagement, settings, memory ────────────────────────────────────────────────────────────────

/** The preset's name with a capital: "balanced" is "Balanced". Main's own word, cleaned. */
export function presetText(preset: string): string {
  const clean = cleanText(preset);
  return clean === '' ? 'Unknown' : clean.charAt(0).toUpperCase() + clean.slice(1);
}

/** Memory pressure as the page states it. */
export function pressureText(pressure: Diagnostics['pressure']): string {
  switch (pressure) {
    case 'none':
      return 'Normal';
    case 'moderate':
      return 'Low';
    case 'critical':
      return 'Very low';
  }
}

/** "6,432 of 16,128 MB" (available of total), or "Unknown" when the machine's memory is not known. */
export function memoryText(memory: Diagnostics['memory']): string {
  if (!(memory.totalMb > 0)) {
    return 'Unknown';
  }
  return `${countText(memory.availableMb)} of ${countText(memory.totalMb)} MB`;
}

/** Kilobytes as megabytes, rounded: "118 MB"; under 1 MB says so. */
export function megabytesText(kb: number): string {
  if (!Number.isFinite(kb) || kb < 0) {
    return 'Unknown';
  }
  return kb < 1024 ? 'Under 1 MB' : `${countText(Math.round(kb / 1024))} MB`;
}

/** Bytes as megabytes with one decimal: "12.4 MB". */
export function fileSizeText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return 'Unknown';
  }
  return `${String(Math.round((bytes / (1024 * 1024)) * 10) / 10)} MB`;
}

/** A tab's row in the memory table (M5.3). */
export interface TabMemoryView {
  readonly tabId: string;
  /** The page's title, cleaned, or "Untitled". */
  readonly title: string;
  /** "Tabs" or "Sleeping". */
  readonly where: string;
  /** "Loaded", "Unloaded", "Frozen", … */
  readonly state: string;
  /** "118 MB", or "—" when the tab holds no renderer. */
  readonly memory: string;
  /** "Shared with 2 other tabs", or null. */
  readonly shared: string | null;
}

const RUNTIME_TEXT: Readonly<Record<Diagnostics['tabs'][number]['runtime'], string>> = {
  unloaded: 'Unloaded',
  creating: 'Loading',
  live: 'Loaded',
  frozen: 'Frozen',
  discarding: 'Unloading',
  crashed: 'Crashed',
};

/** The memory table: heaviest first, then by place in the sidebar. */
export function tabMemoryViews(tabs: Diagnostics['tabs']): TabMemoryView[] {
  return tabs
    .map((tab, index) => ({ tab, index }))
    .sort((a, b) => (b.tab.privateKb ?? -1) - (a.tab.privateKb ?? -1) || a.index - b.index)
    .map(({ tab }) => ({
      tabId: tab.tabId,
      title: cleanText(tab.title) || 'Untitled',
      where: tab.placement === 'strip' ? 'Tabs' : 'Sleeping',
      state: RUNTIME_TEXT[tab.runtime],
      memory: tab.privateKb === null ? '—' : megabytesText(tab.privateKb),
      shared:
        tab.sharedWith > 0
          ? `Shared with ${countText(tab.sharedWith)} other ${tab.sharedWith === 1 ? 'tab' : 'tabs'}`
          : null,
    }));
}

/** What automation did: "3 unloads, 2 moves to Sleeping, 1 archive", or "Nothing". */
export function automationText(counts: Diagnostics['automation']['lastDay']): string {
  const parts = [
    [counts.discard, 'unload', 'unloads'],
    [counts.freeze, 'freeze', 'freezes'],
    [counts.shelve, 'move to Sleeping', 'moves to Sleeping'],
    [counts.archive, 'archive', 'archives'],
    [counts.undo, 'undo', 'undos'],
  ] as const;
  const said = parts
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => `${countText(n)} ${n === 1 ? one : many}`);
  return said.length === 0 ? 'Nothing' : said.join(', ');
}

/** One change of the pressure level, read against `now`. */
export interface PressureChangeView {
  readonly time: string;
  readonly level: string;
}

export function pressureHistoryViews(
  history: Diagnostics['pressureHistory'],
  now: number,
): PressureChangeView[] {
  return history.map(({ at, level }) => ({
    time: activityTimeText(at, now),
    level: pressureText(level),
  }));
}

/** When the last backup was taken: "21 Oct 2026", or "Not yet". */
export function backupText(lastBackupAt: number | null): string {
  if (lastBackupAt === null || !(lastBackupAt > 0)) {
    return 'Not yet';
  }
  return dateText(lastBackupAt) ?? 'Not yet';
}

/** The protected sites as they are drawn: cleaned, and without any that nothing is left of. */
export function protectedSitesText(sites: readonly string[]): string[] {
  return sites.map(cleanText).filter((site) => site !== '');
}

export interface DiagnosticsView {
  /** "Counting since 21 Oct 2026", or null. */
  readonly since: string | null;
  /** Automatic moves to Sleeping or the Archive, and the ones the user regretted. */
  readonly moves: MetricView;
  /** Automatic unloads, and the ones the user reloaded within an engaged hour. */
  readonly unloads: MetricView;
  /** Newest first, as main gives them. */
  readonly events: readonly EventView[];
  readonly activeDay: string;
  /** Engaged time in all: "5 h 12 min". */
  readonly engaged: string;
  readonly preset: string;
  /** "Paused" or "Running". */
  readonly automation: string;
  /** "On" or "Off". */
  readonly preview: string;
  readonly protectedSites: readonly string[];
  readonly pressure: string;
  readonly memory: string;
  // M5.3
  readonly tabs: readonly TabMemoryView[];
  /** "120 MB": the browser process, the GPU, and the rest of Veltriva's own. */
  readonly browserMemory: string;
  readonly gpuMemory: string;
  readonly otherMemory: string;
  readonly automationLastDay: string;
  readonly automationKept: string;
  readonly pressureHistory: readonly PressureChangeView[];
  /** Null without a database. */
  readonly database: {
    readonly size: string;
    readonly log: string;
    readonly lastBackup: string;
    readonly check: string;
  } | null;
  readonly logging: string;
  readonly logFile: string;
}

/** Everything the page shows, worked out at `now`. */
export function diagnosticsView(data: Diagnostics, now: number): DiagnosticsView {
  const { regret, engagement, settings } = data;
  return {
    since: sinceText(regret.since),
    moves: metricView(regret.moves, regret.moveRegrets),
    unloads: metricView(regret.unloads, regret.unloadRegrets),
    events: regret.events.map((event) => eventView(event, now)),
    activeDay: countText(engagement.activeDay),
    engaged: engagedText(engagement.engagedMs),
    preset: presetText(settings.preset),
    automation: settings.paused ? 'Paused' : 'Running',
    preview: settings.preview ? 'On' : 'Off',
    protectedSites: protectedSitesText(settings.protectedSites),
    pressure: pressureText(data.pressure),
    memory: memoryText(data.memory),
    tabs: tabMemoryViews(data.tabs),
    browserMemory: megabytesText(data.processes.browserKb),
    gpuMemory: megabytesText(data.processes.gpuKb),
    otherMemory: megabytesText(data.processes.otherKb),
    automationLastDay: automationText(data.automation.lastDay),
    automationKept: automationText(data.automation.kept),
    pressureHistory: pressureHistoryViews(data.pressureHistory, now),
    database:
      data.database === null
        ? null
        : {
            size: fileSizeText(data.database.sizeBytes),
            log: fileSizeText(data.database.walBytes),
            lastBackup: backupText(data.database.lastBackupAt),
            check:
              data.database.lastCheckOk === null
                ? 'Not yet'
                : data.database.lastCheckOk
                  ? 'Passed'
                  : 'Found damage',
          },
    logging: data.logging.enabled ? 'On: page addresses are logged' : 'Off: no page addresses',
    logFile: data.logging.file,
  };
}

/** "Updated 14:32", read against `now`. */
export function updatedText(at: number, now: number): string {
  const when = activityTimeText(at, now);
  return when === '' ? 'Updated' : `Updated ${when}`;
}
