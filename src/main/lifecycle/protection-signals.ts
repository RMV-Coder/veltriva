// The protection monitor (assessment §4.10): what each tab's web contents says about keeping it
// as it is, read on every evaluation and for the "why" in the sidebar. TabManager adds what only
// it knows (fullscreen, background activity, the user's protection, what discards learned).
//   audio:          `isCurrentlyAudible()`, and for 2 minutes after it stops (`audio-state-changed`);
//                   a muted tab that plays still reports audible (S1);
//   capture:        `isBeingCaptured()`, or the camera or microphone granted to the page by the
//                   permission broker. Chromium says when capture starts, not exactly when it
//                   stops, so a grant protects until the next document or the close (§4.10);
//   devtools:       `isDevToolsOpened()`;
//   open-popup:     a popup window it opened is still open (a sign-in, a payment);
//   notifications:  the user allowed the page's origin to show notifications (soft);
//   protected-site: the user protected the page's site.
// The last two read the tab's address from TabManager (`urlOf`), so they hold for an unloaded
// tab too: a protected site's tab is never shelved or archived, loaded or not.
// Each tab's web contents is watched from its creation (`attach`), so a grant or a sound before
// the first evaluation is seen. A change that alters what the sidebar shows calls `onChange`.
// Playing media isn't read here: Chromium's `media-started-playing` has no end for a Web Audio
// context a page keeps open, even silent (found by E2E), so the discard's probe asks the page at
// decision time instead (core/lifecycle/probe.ts), and what it finds is learned.
import type { WebContents } from 'electron';

import type { Timers } from '../../core/lifecycle/discard';
import { protectionFor } from '../../core/lifecycle/protections';
import type { Protection } from '../../core/lifecycle/protections';
import type { TabId } from '../tabs/tab-manager';

/** Audio protects a tab this long after it stops (§4.10). */
export const AUDIO_GRACE_MS = 2 * 60 * 1000;

export interface ProtectionSignalsOptions {
  /** The tab's web contents, if it has one. */
  readonly contentsOf: (tabId: TabId) => WebContents | undefined;
  /** Whether a popup window this tab opened is still open. */
  readonly hasOpenPopup: (tabId: TabId) => boolean;
  readonly now: () => number;
  /**
   * Whether the page is being captured: `isBeingCaptured()` by default. Test builds read their own
   * answer, because Playwright's focus emulation makes every page report captured (found by E2E).
   */
  readonly isCaptured?: (contents: WebContents) => boolean;
  /** The address of the tab's page, as TabManager has it ('' for none). */
  readonly urlOf?: (tabId: TabId) => string;
  /** Whether the user allowed this page's origin to show notifications. */
  readonly notificationsAllowed?: (url: string) => boolean;
  /** Whether the user protected this page's site (M3.4). */
  readonly siteProtected?: (url: string) => boolean;
  /** Something the "why" shows changed: audio, capture. */
  readonly onChange?: () => void;
  /** For the audio grace's end (the "why" changes then, with no event). */
  readonly timers?: Timers;
}

interface Watch {
  /** When the page was last heard. */
  lastAudible: number | undefined;
  /** The camera or microphone was granted to this document. */
  captureGranted: boolean;
  /** The timer that announces the end of the audio grace. */
  graceTimer: unknown;
}

export class ProtectionSignals {
  readonly #options: ProtectionSignalsOptions;
  readonly #watches = new WeakMap<WebContents, Watch>();

  constructor(options: ProtectionSignalsOptions) {
    this.#options = options;
  }

  /** Starts watching a tab's new web contents. Idempotent. */
  attach(contents: WebContents): void {
    this.#watch(contents);
  }

  /**
   * The permission broker granted the camera or the microphone to this page: it may be capturing
   * from now until its next document, whatever `isBeingCaptured()` says later.
   */
  mediaGranted(contents: WebContents): void {
    if (contents.isDestroyed()) {
      return;
    }
    const watch = this.#watch(contents);
    if (!watch.captureGranted) {
      watch.captureGranted = true;
      this.#changed();
    }
  }

  /** The protections a tab has now. O(1) reads of its web contents. */
  protectionsOf(tabId: TabId): Protection[] {
    const protections: Protection[] = [];
    const contents = this.#options.contentsOf(tabId);
    if (contents !== undefined && !contents.isDestroyed()) {
      const watch = this.#watch(contents);
      const now = this.#options.now();
      if (contents.isCurrentlyAudible()) {
        watch.lastAudible = now;
      }
      const heard = watch.lastAudible;
      if (heard !== undefined && now - heard < AUDIO_GRACE_MS && now >= heard) {
        protections.push(protectionFor('audio'));
      }
      if (
        watch.captureGranted ||
        (this.#options.isCaptured?.(contents) ?? contents.isBeingCaptured())
      ) {
        protections.push(protectionFor('capture'));
      }
      if (contents.isDevToolsOpened()) {
        protections.push(protectionFor('devtools'));
      }
    }
    if (this.#options.hasOpenPopup(tabId)) {
      protections.push(protectionFor('open-popup'));
    }
    const url = this.#options.urlOf?.(tabId) ?? '';
    if (url !== '' && this.#options.notificationsAllowed?.(url) === true) {
      protections.push(protectionFor('notifications'));
    }
    if (url !== '' && this.#options.siteProtected?.(url) === true) {
      protections.push(protectionFor('protected-site'));
    }
    return protections;
  }

  #watch(contents: WebContents): Watch {
    const known = this.#watches.get(contents);
    if (known !== undefined) {
      return known;
    }
    const watch: Watch = {
      lastAudible: undefined,
      captureGranted: false,
      graceTimer: undefined,
    };
    this.#watches.set(contents, watch);
    // Notes when audio stops, so the grace period starts then, not at the next evaluation, and
    // says when it ends.
    contents.on('audio-state-changed', () => {
      if (contents.isDestroyed()) {
        return;
      }
      watch.lastAudible = this.#options.now();
      this.#armGrace(watch);
      this.#changed();
    });
    // A new document: its grants are its own (§4.10: capture lasts until navigation).
    contents.on('did-navigate', () => {
      if (watch.captureGranted) {
        watch.captureGranted = false;
        this.#changed();
      }
    });
    contents.once('destroyed', () => {
      if (watch.graceTimer !== undefined) {
        this.#options.timers?.clearTimeout(watch.graceTimer);
        watch.graceTimer = undefined;
      }
    });
    return watch;
  }

  #armGrace(watch: Watch): void {
    const timers = this.#options.timers;
    if (timers === undefined) {
      return;
    }
    if (watch.graceTimer !== undefined) {
      timers.clearTimeout(watch.graceTimer);
    }
    watch.graceTimer = timers.setTimeout(() => {
      watch.graceTimer = undefined;
      this.#changed();
    }, AUDIO_GRACE_MS + 1000);
  }

  #changed(): void {
    try {
      this.#options.onChange?.();
    } catch {
      // A listener's bug must not break the web contents' event.
    }
  }
}
