// What the settings page says about clearing data and the stored answers to sites (M5.2). Pure, so
// Vitest covers it. The words for what Chromium can't scope are here, so the page says it plainly.
import type { CommandOutput, PermissionsView } from '../../../shared/contracts/schemas';

export type ClearRange = 'hour' | 'day' | 'week' | 'all';
export type ClearResult = CommandOutput<'privacy.clear'>;
export type Permission = PermissionsView['decisions'][number]['permission'];

export const CLEAR_RANGE_LABELS: Readonly<Record<ClearRange, string>> = {
  hour: 'The last hour',
  day: 'The last 24 hours',
  week: 'The last 7 days',
  all: 'Everything',
};
export const CLEAR_RANGE_ORDER: readonly ClearRange[] = ['hour', 'day', 'week', 'all'];

export const PERMISSION_LABELS: Readonly<Record<Permission, string>> = {
  camera: 'Camera',
  microphone: 'Microphone',
  geolocation: 'Location',
  notifications: 'Notifications',
  'clipboard-read': 'See what you copied',
};

/** Said next to the cookies and cache boxes: Electron can't clear them for a time range. */
export const ALL_TIME_NOTE =
  "Whatever the range: Chromium can't clear these by time, so they go for all time.";

/** Said for forgetting a site's data: what can and can't be scoped to it. */
export const SITE_DATA_NOTE =
  'Its cookies on every address of the site; its storage and cached files on the addresses Veltriva has seen it use. Files it loaded from other servers stay cached.';

const count = (n: number, one: string, many: string): string =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** What a clear did, in a sentence. */
export function clearedText(result: ClearResult): string {
  const parts = [
    result.pages > 0 ? count(result.pages, 'page', 'pages') : null,
    result.visits > 0 ? count(result.visits, 'visit', 'visits') : null,
    result.tabs > 0
      ? count(result.tabs, 'archived or closed tab', 'archived or closed tabs')
      : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) {
    return 'Done. Nothing in the memory matched.';
  }
  const last = parts.pop() ?? '';
  return `Removed ${parts.length === 0 ? last : `${parts.join(', ')} and ${last}`}.`;
}

/** An origin as the list shows it: the host, with its scheme when it isn't https. */
export function originText(origin: string): string {
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' ? url.host : `${url.protocol}//${url.host}`;
  } catch {
    return origin;
  }
}

export interface OriginGroup {
  readonly origin: string;
  readonly decisions: readonly {
    readonly permission: Permission;
    readonly decision: 'allow' | 'block';
  }[];
  readonly protocols: readonly string[];
  readonly hints: readonly string[];
}

/** Every stored answer, one group per origin, origins in order. */
export function groupByOrigin(view: PermissionsView): OriginGroup[] {
  const groups = new Map<
    string,
    {
      decisions: { permission: Permission; decision: 'allow' | 'block' }[];
      protocols: string[];
      hints: string[];
    }
  >();
  const group = (origin: string) => {
    let found = groups.get(origin);
    if (found === undefined) {
      found = { decisions: [], protocols: [], hints: [] };
      groups.set(origin, found);
    }
    return found;
  };
  for (const { origin, permission, decision } of view.decisions) {
    group(origin).decisions.push({ permission, decision });
  }
  for (const { origin, scheme } of view.protocols) {
    group(origin).protocols.push(scheme);
  }
  for (const { origin, hints } of view.clientHints) {
    group(origin).hints.push(...hints);
  }
  return [...groups]
    .sort(([a], [b]) =>
      originText(a) < originText(b) ? -1 : originText(a) > originText(b) ? 1 : 0,
    )
    .map(([origin, entries]) => ({ origin, ...entries }));
}

/** What the client-hint opt-in means, for its row. */
export function hintsText(hints: readonly string[]): string {
  return `Sends more about your browser and device (${hints.join(', ')})`;
}
