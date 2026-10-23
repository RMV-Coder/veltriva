// What Settings and About say about updates (M6.3). Pure, so Vitest covers it. Main decides
// everything (src/main/updates/update-checker.ts); this only words its view.
import type { CommandOutput } from '../../../shared/contracts/schemas';

export type UpdateView = CommandOutput<'updates.status'>;

/** When a check happened, in the user's own language. */
function when(ms: number, locale?: string, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      ...(timeZone === undefined ? {} : { timeZone }),
    }).format(ms);
  } catch {
    return 'recently';
  }
}

/** One sentence: where the update check stands. */
export function updateStatusText(
  view: UpdateView,
  format: { readonly locale?: string; readonly timeZone?: string } = {},
): string {
  if (!view.enabled) {
    return 'Off. Veltriva never contacts the release feed while this is off.';
  }
  if (view.checking) {
    return 'Checking…';
  }
  if (view.available !== null) {
    return `Veltriva ${view.available.version} is available. You have ${view.currentVersion}.`;
  }
  if (view.lastCheckedAt === null || view.lastStatus === null) {
    return 'Not checked yet: the first check runs two minutes after Veltriva starts.';
  }
  const at = when(view.lastCheckedAt, format.locale, format.timeZone);
  return view.lastStatus === 'failed'
    ? `The last check didn't get an answer (${at}). Veltriva tries again a day later.`
    : `Veltriva ${view.currentVersion} is the newest version (checked ${at}).`;
}

/** What's wrong with a typed feed address before main sees it, or null. Main checks it again. */
export function feedProblem(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') {
    return 'Enter the address of a release feed.';
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    return 'Use an https address, such as https://api.github.com/repos/owner/name/releases/latest.';
  }
  return null;
}

/** Main refused the feed address: what one needs. */
export const FEED_REFUSED =
  'Veltriva only checks an https address (or http on this computer), with no user name or password in it.';
