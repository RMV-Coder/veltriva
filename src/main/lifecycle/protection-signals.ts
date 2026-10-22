// The protections automation must respect from its first day (assessment §4.10), read on every
// evaluation from each tab's web contents. M3.2 has the signals whose loss would be plainly wrong:
//   audio:      `isCurrentlyAudible()`, and for 2 minutes after it stops (`audio-state-changed`);
//               a muted tab that plays still reports audible (S1);
//   capture:    `isBeingCaptured()`: camera, microphone or screen;
//   devtools:   `isDevToolsOpened()`;
//   open-popup: a popup window it opened is still open (a sign-in, a payment).
// The protection monitor (M3.4) adds the rest of the table and the explanations.
import type { WebContents } from 'electron';

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
}

export class ProtectionSignals {
  readonly #options: ProtectionSignalsOptions;
  /** When each tab's page was last heard, by web contents. */
  readonly #lastAudible = new WeakMap<WebContents, number>();
  readonly #watched = new WeakSet<WebContents>();

  constructor(options: ProtectionSignalsOptions) {
    this.#options = options;
  }

  /** The protections a tab has now. O(1) reads of its web contents. */
  protectionsOf(tabId: TabId): Protection[] {
    const protections: Protection[] = [];
    const contents = this.#options.contentsOf(tabId);
    if (contents !== undefined && !contents.isDestroyed()) {
      this.#watch(contents);
      const now = this.#options.now();
      if (contents.isCurrentlyAudible()) {
        this.#lastAudible.set(contents, now);
      }
      const heard = this.#lastAudible.get(contents);
      if (heard !== undefined && now - heard < AUDIO_GRACE_MS && now >= heard) {
        protections.push(protectionFor('audio'));
      }
      if (contents.isBeingCaptured()) {
        protections.push(protectionFor('capture'));
      }
      if (contents.isDevToolsOpened()) {
        protections.push(protectionFor('devtools'));
      }
    }
    if (this.#options.hasOpenPopup(tabId)) {
      protections.push(protectionFor('open-popup'));
    }
    return protections;
  }

  /** Notes when audio stops, so the grace period starts then, not at the next evaluation. */
  #watch(contents: WebContents): void {
    if (this.#watched.has(contents)) {
      return;
    }
    this.#watched.add(contents);
    contents.on('audio-state-changed', () => {
      if (!contents.isDestroyed()) {
        this.#lastAudible.set(contents, this.#options.now());
      }
    });
  }
}
