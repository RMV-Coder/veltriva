// The update-available check's pure part (M6.3, assessment §7.2 Release, ADR-0007 item 4). Off by
// default: nothing is ever sent until the user turns it on, and even then Veltriva only asks a
// release feed for the newest version and tells the user. It downloads nothing.
//
// The feed is GitHub's "latest release" answer (`/repos/<owner>/<repo>/releases/latest`), or a
// list of releases (`/releases`), of which the newest published, non-draft, non-prerelease one
// counts. Only `tag_name`, `html_url`, `draft` and `prerelease` are read.

/** Versions are plain `major.minor.patch` (a leading `v` in a tag is dropped). */
const VERSION = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

/** The feed Veltriva's own releases will be checked against, once they are published. */
export const DEFAULT_FEED_URL = 'https://api.github.com/repos/RMV-Coder/veltriva/releases/latest';
export const MAX_FEED_URL = 2048;

/**
 * Whether the user may set `url` as the release feed: https, or http to this machine (a feed
 * served locally, for testing a release), with no credentials in it.
 */
export function isFeedUrlAllowed(url: string): boolean {
  if (url.length > MAX_FEED_URL) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return false;
  }
  if (parsed.protocol === 'https:') {
    return true;
  }
  const host = parsed.hostname;
  return (
    parsed.protocol === 'http:' &&
    (host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host))
  );
}

export interface Release {
  /** `0.2.0`, without a `v`. */
  readonly version: string;
  /** The release's page, https only: the one place the notice links to. */
  readonly url: string;
}

function parts(version: string): [number, number, number] | null {
  const match = VERSION.exec(version.trim());
  if (match === null) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** `a` compared with `b`: negative, zero or positive; null if either isn't a plain version. */
export function compareVersions(a: string, b: string): number | null {
  const left = parts(a);
  const right = parts(b);
  if (left === null || right === null) {
    return null;
  }
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/** Whether `release` is newer than the running `current` version. */
export function isNewer(release: Release, current: string): boolean {
  const order = compareVersions(release.version, current);
  return order !== null && order > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function releaseOf(entry: unknown): Release | null {
  if (!isRecord(entry) || entry.draft === true || entry.prerelease === true) {
    return null;
  }
  const { tag_name: tag, html_url: page } = entry;
  if (typeof tag !== 'string' || typeof page !== 'string' || parts(tag) === null) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(page);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    return null;
  }
  return { version: tag.trim().replace(/^v/, ''), url: url.href };
}

/** The newest usable release in a feed's answer, or null. */
export function parseReleaseFeed(answer: unknown): Release | null {
  const entries = Array.isArray(answer) ? answer : [answer];
  let newest: Release | null = null;
  for (const entry of entries) {
    const release = releaseOf(entry);
    if (
      release !== null &&
      (newest === null || (compareVersions(release.version, newest.version) ?? 0) > 0)
    ) {
      newest = release;
    }
  }
  return newest;
}

/** How often a check runs while it is on. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** The first check waits this long after startup, so it never competes with restoring tabs. */
export const FIRST_CHECK_DELAY_MS = 2 * 60 * 1000;

/** When the next check is due, given the last one (null: never), or null while checks are off. */
export function nextCheckAt(
  enabled: boolean,
  lastCheckedAt: number | null,
  startedAt: number,
): number | null {
  if (!enabled) {
    return null;
  }
  const earliest = startedAt + FIRST_CHECK_DELAY_MS;
  return lastCheckedAt === null ? earliest : Math.max(earliest, lastCheckedAt + CHECK_INTERVAL_MS);
}
