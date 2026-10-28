// The update-available notification (M6.3, assessment §7.2 Release, ADR-0007 item 4, threat T14).
// **Off by default, and silent while off:** no request, no DNS lookup, no timer. Only once the
// user turns "Check for new versions" on in Settings does Veltriva ask the release feed for the
// newest version: 2 minutes after startup, then once a day, or when the user presses "Check now".
// A newer version shows a notice with a link to its release page. Nothing is ever downloaded or
// installed (auto-update waits for signed builds, ADR-0007 item 4).
//
// The feed's answer is read as data only (core/updates/release-feed.ts): a version and an https
// page. What was learnt is kept in the `updates` app_state document, so a restart doesn't ask
// again before the day is up, and a version the user skipped stays skipped.
import { z } from 'zod';

import { isNewer, nextCheckAt, parseReleaseFeed } from '../../core/updates/release-feed';
import type { Release } from '../../core/updates/release-feed';
import type { Logger } from '../platform/logger';

export const UPDATES_DOCUMENT = 'updates';
/** How long a check may take, the answer included. */
export const CHECK_TIMEOUT_MS = 15_000;

export type CheckStatus = 'up-to-date' | 'available' | 'failed';

export interface UpdateState {
  /** When the last check finished (wall clock), or null if none ever did. */
  readonly lastCheckedAt: number | null;
  readonly lastStatus: CheckStatus | null;
  /** The newest release the feed named at the last successful check. */
  readonly latest: Release | null;
  /** A version the user chose to skip: its notice doesn't come back. */
  readonly skipped: string | null;
}

export const EMPTY_UPDATE_STATE: UpdateState = {
  lastCheckedAt: null,
  lastStatus: null,
  latest: null,
  skipped: null,
};

const storedSchema = z.object({
  lastCheckedAt: z.number().int().nonnegative().nullable(),
  lastStatus: z.enum(['up-to-date', 'available', 'failed']).nullable(),
  latest: z
    .object({ version: z.string().max(32), url: z.url({ protocol: /^https$/ }).max(2048) })
    .nullable(),
  skipped: z.string().max(32).nullable(),
});

/** A stored document, or the empty state if it's missing or not one of ours. */
export function parseUpdateState(value: unknown): UpdateState {
  const parsed = storedSchema.safeParse(value);
  return parsed.success ? parsed.data : EMPTY_UPDATE_STATE;
}

/** What Settings and About show. */
export interface UpdateView {
  readonly enabled: boolean;
  readonly feedUrl: string;
  readonly currentVersion: string;
  readonly lastCheckedAt: number | null;
  readonly lastStatus: CheckStatus | null;
  /** The newer release, if the last check found one. */
  readonly available: Release | null;
  readonly checking: boolean;
}

export interface UpdateCheckerOptions {
  /** The user's "Check for new versions" setting. */
  readonly enabled: () => boolean;
  readonly feedUrl: () => string;
  /** The running version, `app.getVersion()`. */
  readonly currentVersion: string;
  /** One request for the feed: the parsed JSON, or a throw. */
  readonly fetchFeed: (url: string, signal: AbortSignal) => Promise<unknown>;
  readonly load: () => Promise<UpdateState>;
  readonly save: (state: UpdateState) => Promise<void>;
  /** A newer release the user hasn't skipped: show the notice. */
  readonly onAvailable: (release: Release) => void;
  /** The view changed (a check started or ended): Settings and About refresh. */
  readonly onChange: () => void;
  readonly logger: Logger;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

export class UpdateChecker {
  readonly #options: UpdateCheckerOptions;
  readonly #startedAt: number;
  #state: UpdateState = EMPTY_UPDATE_STATE;
  #timer: unknown = null;
  #checking: Promise<void> | null = null;
  #started = false;
  /** The version this run already showed a notice for. */
  #notified: string | null = null;

  constructor(options: UpdateCheckerOptions) {
    this.#options = options;
    this.#startedAt = this.#now();
  }

  /** Reads what earlier runs learnt, then schedules the next check if checks are on. */
  async start(): Promise<void> {
    this.#state = await this.#options.load();
    this.#started = true;
    this.reschedule();
  }

  /** The setting changed: schedule a check, or cancel the one waiting. */
  reschedule(): void {
    if (this.#timer !== null) {
      (this.#options.clearTimer ?? clearTimeout)(this.#timer as ReturnType<typeof setTimeout>);
      this.#timer = null;
    }
    if (!this.#started) {
      return;
    }
    const due = nextCheckAt(this.#options.enabled(), this.#state.lastCheckedAt, this.#startedAt);
    if (due === null) {
      return;
    }
    this.#timer = (this.#options.setTimer ?? setTimeout)(
      () => {
        this.#timer = null;
        void this.checkNow().then(() => {
          this.reschedule();
        });
      },
      Math.max(0, due - this.#now()),
    );
  }

  view(): UpdateView {
    const { latest } = this.#state;
    return {
      enabled: this.#options.enabled(),
      feedUrl: this.#options.feedUrl(),
      currentVersion: this.#options.currentVersion,
      lastCheckedAt: this.#state.lastCheckedAt,
      lastStatus: this.#state.lastStatus,
      available: latest !== null && isNewer(latest, this.#options.currentVersion) ? latest : null,
      checking: this.#checking !== null,
    };
  }

  /**
   * Asks the feed now. Does nothing while checks are off: the user turns them on first, so
   * Veltriva never contacts the feed without that choice.
   */
  checkNow(): Promise<UpdateView> {
    if (!this.#options.enabled()) {
      return Promise.resolve(this.view());
    }
    this.#checking ??= this.#check().finally(() => {
      this.#checking = null;
      this.#options.onChange();
    });
    this.#options.onChange();
    // The view once the check has settled, so it no longer says "checking".
    return this.#checking.then(() => this.view());
  }

  /** "Skip this version": its notice won't come back; a newer one will. */
  async skip(version: string): Promise<void> {
    this.#state = { ...this.#state, skipped: version };
    await this.#save();
  }

  async #check(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, CHECK_TIMEOUT_MS);
    let latest: Release | null = null;
    let status: CheckStatus = 'failed';
    try {
      latest = parseReleaseFeed(
        await this.#options.fetchFeed(this.#options.feedUrl(), controller.signal),
      );
      if (latest === null) {
        this.#options.logger.warn('updates.unreadableFeed');
      } else {
        status = isNewer(latest, this.#options.currentVersion) ? 'available' : 'up-to-date';
      }
    } catch (error) {
      this.#options.logger.warn('updates.checkFailed', {
        error: error instanceof Error ? error.name : typeof error,
      });
    } finally {
      clearTimeout(timer);
    }
    this.#state = {
      ...this.#state,
      lastCheckedAt: this.#now(),
      lastStatus: status,
      latest: latest ?? this.#state.latest,
    };
    await this.#save();
    // One notice per version per run: the daily check doesn't stack them.
    if (
      status === 'available' &&
      latest !== null &&
      latest.version !== this.#state.skipped &&
      latest.version !== this.#notified
    ) {
      this.#notified = latest.version;
      this.#options.onAvailable(latest);
    }
  }

  async #save(): Promise<void> {
    try {
      await this.#options.save(this.#state);
    } catch {
      this.#options.logger.warn('updates.saveFailed');
    }
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }
}
