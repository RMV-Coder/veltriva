// Protections (assessment §4.10): reasons to keep a tab as it is. Each one is hard or soft and
// blocks specific actions. Hard ones always block; soft ones block unless memory pressure is
// critical. They are derived on every evaluation, never stored as a tab "state".
//
// M3.1 has the reasons the discard procedure itself learns (§4.9): the probe found unsaved input,
// the page objected to unloading, or the probe saw a focused editor or a sensitive page. M3.2,
// which starts automation, adds the signals it must never override: audio, capture, DevTools, an
// open popup, and the recent-interaction guard. M3.3 adds the user's protection of a tab. The
// protection monitor (M3.4) completes the table: a protected site, video, fullscreen, the
// camera or microphone granted to the page, notifications, and a page active in the background.

export const LIFECYCLE_ACTIONS = ['freeze', 'discard', 'shelve', 'archive'] as const;

/**
 * A background page's title or icon change counts as activity (a chat, a mail inbox) only once it
 * has been hidden this long: a page that finishes loading in the background isn't "active".
 */
export const BACKGROUND_SETTLE_MS = 30 * 1000;
/** Background activity keeps a tab softly this long after the last change (§4.10). */
export const BACKGROUND_ACTIVITY_MS = 60 * 60 * 1000;
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
  | 'recent-interaction'
  /** The user protected the tab (M3.3): automation leaves it alone. */
  | 'user-protected'
  /** The user protected the tab's site (M3.4): every tab on it is left alone. */
  | 'protected-site'
  /** A video or audio element is playing (`media-started-playing`, M3.4). */
  | 'video'
  /** The page is in HTML fullscreen. */
  | 'fullscreen'
  /** The site may show notifications (the user allowed it): soft, as Chrome's Memory Saver. */
  | 'notifications'
  /** Its title or icon changed while it was hidden (a chat, a mail inbox): soft, heuristic. */
  | 'background-activity';

/**
 * Every reason, in the order the "why" names them: what the user did first, then the page. (The
 * table below is a Record over the union, so a reason missing here fails its unit test.)
 */
export const PROTECTION_REASONS = [
  'user-protected',
  'protected-site',
  'fullscreen',
  'capture',
  'audio',
  'video',
  'page-unsaved-changes',
  'unsaved-input',
  'open-popup',
  'devtools',
  'editing',
  'sensitive-page',
  'notifications',
  'background-activity',
  'recent-interaction',
] as const satisfies readonly ProtectionReason[];

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
  'user-protected': {
    reason: 'user-protected',
    hard: true,
    blocks: ['freeze', 'discard', 'shelve', 'archive'],
  },
  'protected-site': {
    reason: 'protected-site',
    hard: true,
    blocks: ['freeze', 'discard', 'shelve', 'archive'],
  },
  video: { reason: 'video', hard: true, blocks: ['freeze', 'discard'] },
  fullscreen: {
    reason: 'fullscreen',
    hard: true,
    blocks: ['freeze', 'discard', 'shelve', 'archive'],
  },
  notifications: { reason: 'notifications', hard: false, blocks: ['freeze', 'discard'] },
  'background-activity': {
    reason: 'background-activity',
    hard: false,
    blocks: ['freeze', 'discard'],
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
