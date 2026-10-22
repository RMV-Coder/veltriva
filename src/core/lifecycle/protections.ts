// Protections (assessment §4.10): reasons to keep a tab as it is. Each one is hard or soft and
// blocks specific actions. Hard ones always block; soft ones block unless memory pressure is
// critical. They are derived on every evaluation, never stored as a tab "state".
//
// M3.1 has the reasons the discard procedure itself learns (§4.9): the probe found unsaved input,
// the page objected to unloading, or the probe saw a focused editor or a sensitive page. M3.2,
// which starts automation, adds the signals it must never override: audio, capture, DevTools, an
// open popup, and the recent-interaction guard. The protection monitor (M3.4) adds the rest of
// the table through the same shape.

export const LIFECYCLE_ACTIONS = ['freeze', 'discard', 'shelve', 'archive'] as const;
export type LifecycleActionKind = (typeof LIFECYCLE_ACTIONS)[number];

export type ProtectionReason =
  /** The probe found changed form fields, or fields the user typed into that still hold text. */
  | 'unsaved-input'
  /** The page's `beforeunload` handler objected (`will-prevent-unload`), or the close timed out. */
  | 'page-unsaved-changes'
  /** A focused `contenteditable`: a plain click sets it, so it is only soft (S3). */
  | 'editing'
  /** Password or payment fields on the page. */
  | 'sensitive-page'
  /** Playing audio, or did in the last 2 minutes (muted playback counts, S1). */
  | 'audio'
  /** The page captures the camera, microphone or screen. */
  | 'capture'
  /** Its DevTools are open. */
  | 'devtools'
  /** It opened a popup window that is still open (a sign-in, a payment). */
  | 'open-popup'
  /** The user interacted with it within the preset's guard (wall clock). */
  | 'recent-interaction';

export interface Protection {
  readonly reason: ProtectionReason;
  readonly hard: boolean;
  readonly blocks: readonly LifecycleActionKind[];
}

const PROTECTIONS: Readonly<Record<ProtectionReason, Protection>> = {
  'unsaved-input': { reason: 'unsaved-input', hard: true, blocks: ['discard', 'archive'] },
  'page-unsaved-changes': {
    reason: 'page-unsaved-changes',
    hard: true,
    blocks: ['discard', 'archive'],
  },
  editing: { reason: 'editing', hard: false, blocks: ['discard', 'archive'] },
  'sensitive-page': { reason: 'sensitive-page', hard: false, blocks: ['discard'] },
  audio: { reason: 'audio', hard: true, blocks: ['freeze', 'discard', 'shelve'] },
  capture: { reason: 'capture', hard: true, blocks: ['freeze', 'discard', 'shelve', 'archive'] },
  devtools: { reason: 'devtools', hard: true, blocks: ['discard'] },
  'open-popup': { reason: 'open-popup', hard: true, blocks: ['discard', 'archive'] },
  'recent-interaction': {
    reason: 'recent-interaction',
    hard: false,
    blocks: ['discard', 'shelve', 'archive'],
  },
};

export function protectionFor(reason: ProtectionReason): Protection {
  return PROTECTIONS[reason];
}

/**
 * The first protection that blocks `action`: a hard one before a soft one. Soft ones don't block
 * when `overrideSoft` is set (critical memory pressure, §4.7 rule 4).
 */
export function blockingProtection(
  protections: Iterable<Protection>,
  action: LifecycleActionKind,
  options: { readonly overrideSoft?: boolean } = {},
): Protection | null {
  let soft: Protection | null = null;
  for (const protection of protections) {
    if (!protection.blocks.includes(action)) {
      continue;
    }
    if (protection.hard) {
      return protection;
    }
    soft ??= protection;
  }
  return options.overrideSoft === true ? null : soft;
}
