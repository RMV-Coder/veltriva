// What the settings page says (M5.1): the presets in plain words, each advanced number in the unit
// a person thinks in, and what is wrong with a value typed. Pure, so Vitest covers it. Main checks
// every value again and is the one that decides; this only lets the page say why before asking.
import type { SettingsView } from '../../../shared/contracts/schemas';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

type Settings = SettingsView['settings'];
export type Preset = Settings['lifecycle']['preset'];
export type PresetValues = SettingsView['presets'][Preset];
export type NumericField = keyof SettingsView['limits'];

export const PRESET_ORDER: readonly Preset[] = ['gentle', 'balanced', 'aggressive'];

export const PRESET_NAMES: Readonly<Record<Preset, string>> = {
  gentle: 'Gentle',
  balanced: 'Balanced',
  aggressive: 'Aggressive',
};

const plural = (count: number, one: string, many: string): string =>
  `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;

/** A whole number of milliseconds as people say it: "15 minutes", "1 hour", "1 hour 30 minutes". */
export function durationText(ms: number): string {
  if (ms <= 0) {
    return 'no time';
  }
  if (ms % DAY_MS === 0 && ms >= DAY_MS) {
    return plural(ms / DAY_MS, 'day', 'days');
  }
  const hours = Math.floor(ms / HOUR_MS);
  const minutes = Math.round((ms % HOUR_MS) / MINUTE_MS);
  if (hours === 0) {
    return plural(Math.max(1, minutes), 'minute', 'minutes');
  }
  return minutes === 0
    ? plural(hours, 'hour', 'hours')
    : `${plural(hours, 'hour', 'hours')} ${plural(minutes, 'minute', 'minutes')}`;
}

/** What a preset does, in plain words (§4.13: presets come with plain-language descriptions). */
export function presetDescription(values: PresetValues): string {
  return [
    `Unloads a tab you haven't looked at for ${durationText(values.discardAfterMs)}${
      values.discardPinned ? ', pinned tabs too' : ''
    }.`,
    `Keeps your ${
      values.stripCap === 1 ? 'most recent tab' : `${String(values.stripCap)} most recent tabs`
    } in Tabs; one beyond them you haven't used for ${durationText(
      values.shelveAfterEngagedMs,
    )} of browsing moves to Sleeping.`,
    `Archives a Sleeping tab after ${plural(
      values.archiveAfterActiveDays,
      'day',
      'days',
    )} you use Veltriva without it.`,
  ].join(' ');
}

/** How each advanced number is shown and typed: its unit, and how many milliseconds one is. */
interface FieldUnit {
  readonly label: string;
  /** The unit, as the field's suffix says it: "minutes". */
  readonly unit: string;
  /** Stored value per unit typed: 60,000 for minutes, 1 for a count. */
  readonly scale: number;
  /** What it does, for the field's description. */
  readonly help: string;
}

export const FIELD_UNITS: Readonly<Record<NumericField, FieldUnit>> = {
  discardAfterMs: {
    label: 'Unload a hidden tab after',
    unit: 'minutes',
    scale: MINUTE_MS,
    help: 'Time since you last looked at the tab. Unloading frees its memory; the tab stays where it is and reloads when you pick it.',
  },
  stripCap: {
    label: 'Tabs kept in Tabs',
    unit: 'tabs',
    scale: 1,
    help: 'Your most recently used tabs, not counting pinned ones. Others can move to Sleeping.',
  },
  shelveAfterEngagedMs: {
    label: 'Move a tab beyond them to Sleeping after',
    unit: 'minutes of browsing',
    scale: MINUTE_MS,
    help: 'Only time you spend using Veltriva counts, so a weekend away moves nothing.',
  },
  archiveAfterActiveDays: {
    label: 'Archive a Sleeping tab after',
    unit: 'days you use Veltriva',
    scale: 1,
    help: 'The Archive keeps the tab, and search finds it.',
  },
  interactionGuardMs: {
    label: 'Leave a tab you used alone for',
    unit: 'minutes',
    scale: MINUTE_MS,
    help: 'A tab you clicked or typed in within this time is not unloaded or moved, unless memory is very low.',
  },
  moderatePressurePercent: {
    label: 'Memory is low below',
    unit: '% available',
    scale: 1,
    help: 'Then Veltriva unloads a hidden tab now and then. It never moves a tab because memory is low.',
  },
  criticalPressurePercent: {
    label: 'Memory is very low below',
    unit: '% available',
    scale: 1,
    help: 'Then it unloads hidden tabs faster, and only hard protections keep a tab. It must be below the low threshold.',
  },
};

/** The fields in the order the page shows them. */
export const FIELD_ORDER: readonly NumericField[] = [
  'discardAfterMs',
  'stripCap',
  'shelveAfterEngagedMs',
  'archiveAfterActiveDays',
  'interactionGuardMs',
  'moderatePressurePercent',
  'criticalPressurePercent',
];

/** What applies now: the override, or the preset's value (the default threshold for pressure). */
export function effectiveValue(view: SettingsView, field: NumericField): number {
  const { overrides, preset } = view.settings.lifecycle;
  const override = overrides[field];
  if (override !== undefined) {
    return override;
  }
  return defaultValue(view, preset, field);
}

/** The value a preset (or the defaults) gives the field. */
export function defaultValue(view: SettingsView, preset: Preset, field: NumericField): number {
  switch (field) {
    case 'moderatePressurePercent':
      return view.pressureDefaults.moderate;
    case 'criticalPressurePercent':
      return view.pressureDefaults.critical;
    default:
      return view.presets[preset][field];
  }
}

/** The field's value as typed in its unit. */
export function fieldText(field: NumericField, value: number): string {
  return String(value / FIELD_UNITS[field].scale);
}

/** The range of the field, in its unit. */
export function fieldRange(
  view: SettingsView,
  field: NumericField,
): { readonly min: number; readonly max: number } {
  const { min, max } = view.limits[field];
  const { scale } = FIELD_UNITS[field];
  return { min: Math.ceil(min / scale), max: Math.floor(max / scale) };
}

export type FieldReading =
  { readonly ok: true; readonly value: number } | { readonly ok: false; readonly message: string };

/** What the user typed, as the stored value; or what is wrong with it, in words. */
export function readField(view: SettingsView, field: NumericField, text: string): FieldReading {
  const { min, max } = fieldRange(view, field);
  const unit = FIELD_UNITS[field].unit;
  const message = `Enter a whole number from ${min.toLocaleString('en-US')} to ${max.toLocaleString('en-US')} (${unit}).`;
  const trimmed = text.trim();
  if (!/^\d{1,9}$/.test(trimmed)) {
    return { ok: false, message };
  }
  const typed = Number(trimmed);
  if (typed < min || typed > max) {
    return { ok: false, message };
  }
  return { ok: true, value: typed * FIELD_UNITS[field].scale };
}

/** Whether the thresholds stay in order with this one changed: very low below low. */
export function pressureInOrder(
  view: SettingsView,
  field: 'moderatePressurePercent' | 'criticalPressurePercent',
  value: number,
): boolean {
  const moderate =
    field === 'moderatePressurePercent' ? value : effectiveValue(view, 'moderatePressurePercent');
  const critical =
    field === 'criticalPressurePercent' ? value : effectiveValue(view, 'criticalPressurePercent');
  return critical < moderate;
}

export const PRESSURE_ORDER_MESSAGE =
  '"Very low" must be below "low": pick a lower number here, or change the other one first.';

/** The named engine the template is, or 'custom'. */
export function engineOf(view: SettingsView): string {
  return (
    view.searchEngines.find((engine) => engine.template === view.settings.search.template)?.id ??
    'custom'
  );
}

/** What is wrong with a custom template before main is asked, or null. Main checks it fully. */
export function templateProblem(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') {
    return 'Enter the address of a search, with {searchTerms} where your words go.';
  }
  if (!trimmed.includes('{searchTerms}')) {
    return 'Put {searchTerms} where your words go, for example https://search.example/?q={searchTerms}.';
  }
  return null;
}

/** Main refused the template: what a template needs. */
export const TEMPLATE_REFUSED =
  "Veltriva can't search with that address: it needs https, and {searchTerms} in its path or query.";

/** Main refused a site the user typed. */
export const SITE_REFUSED =
  "That isn't a site Veltriva can name: enter something like example.com, or a page's address.";
