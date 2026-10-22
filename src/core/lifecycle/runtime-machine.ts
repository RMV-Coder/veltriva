// The runtime dimension of a tab (ADR-0003, assessment §4.3): what its web contents is doing, and
// the only ways it may change. TabManager asks `nextRuntime` before every change, so an illegal
// transition throws instead of leaving a tab in a state nothing expects, and every transition
// bumps the tab's runtime epoch (§4.11), which voids decisions made before it.
//
//   unloaded ──load / ensureLive──▶ creating ──ready──▶ live ◀──thaw──▶ frozen (experimental, off)
//      ▲  ▲                            │                  │  ▲
//      │  └────creationFailed──────────┘           discard│  │discardBlocked (the page objects,
//      │                                                  ▼  │ the probe finds unsaved input,
//      └───────────── discarded ──────────────────── discarding   a timeout, a stale decision)
//                                                        │
//                                         revive (the tab was selected while closing) ──▶ creating
//
//   creating | live | frozen ──rendererGone──▶ crashed ──load / ensureLive──▶ creating
//   anything but discarding ──internalPage──▶ unloaded (the tab shows a new-tab page now)
//   creating | live | frozen | crashed ──gone──▶ unloaded (its web contents was lost)
//
// Pure: no Electron, no timers. Unit tests walk every (state, event) pair.

export const RUNTIME_STATES = [
  'unloaded',
  'creating',
  'live',
  'frozen',
  'discarding',
  'crashed',
] as const;

export type RuntimeState = (typeof RUNTIME_STATES)[number];

/** What can happen to a tab's runtime. */
export type RuntimeEvent =
  /** A URL is loaded into the tab: a new web contents, or one that crashed or is still creating. */
  | 'load'
  /** An unloaded or crashed tab is brought back from its saved stack (selection, Reload). */
  | 'ensureLive'
  /** The new web contents committed a page, or failed to load one (it shows an error page). */
  | 'ready'
  /** `restore()` failed in a way that leaves the web contents unusable (S2). */
  | 'creationFailed'
  | 'freeze'
  | 'thaw'
  /** A discard starts: probe, snapshot, close (§4.9). */
  | 'discard'
  /** The discarded web contents is gone; the tab keeps its snapshot. */
  | 'discarded'
  /** The discard stopped and the page lives on: it objected, was dirty, timed out or got stale. */
  | 'discardBlocked'
  /** The tab was selected while its web contents was closing: it comes back as soon as it is. */
  | 'revive'
  | 'rendererGone'
  /** The tab shows an internal page now (new tab): its web contents is closed. */
  | 'internalPage'
  /** The web contents was destroyed without TabManager asking (a late close, an outside close). */
  | 'gone';

const TRANSITIONS: Readonly<
  Record<RuntimeEvent, { readonly from: readonly RuntimeState[]; readonly to: RuntimeState }>
> = {
  load: { from: ['unloaded', 'creating', 'crashed'], to: 'creating' },
  ensureLive: { from: ['unloaded', 'crashed'], to: 'creating' },
  ready: { from: ['creating'], to: 'live' },
  creationFailed: { from: ['creating'], to: 'unloaded' },
  freeze: { from: ['live'], to: 'frozen' },
  thaw: { from: ['frozen'], to: 'live' },
  discard: { from: ['live', 'frozen'], to: 'discarding' },
  discarded: { from: ['discarding'], to: 'unloaded' },
  discardBlocked: { from: ['discarding'], to: 'live' },
  revive: { from: ['discarding'], to: 'creating' },
  rendererGone: { from: ['creating', 'live', 'frozen'], to: 'crashed' },
  internalPage: { from: ['unloaded', 'creating', 'live', 'frozen', 'crashed'], to: 'unloaded' },
  gone: { from: ['creating', 'live', 'frozen', 'crashed'], to: 'unloaded' },
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: RuntimeState,
    readonly event: RuntimeEvent,
  ) {
    super(`Illegal runtime transition: ${event} from ${from}`);
    this.name = 'IllegalTransitionError';
  }
}

/** Whether `event` may happen to a tab whose runtime is `from`. */
export function canTransition(from: RuntimeState, event: RuntimeEvent): boolean {
  return TRANSITIONS[event].from.includes(from);
}

/** The runtime after `event`; throws IllegalTransitionError if it may not happen now. */
export function nextRuntime(from: RuntimeState, event: RuntimeEvent): RuntimeState {
  if (!canTransition(from, event)) {
    throw new IllegalTransitionError(from, event);
  }
  return TRANSITIONS[event].to;
}

/** Runtimes that hold a web contents (invariant I4: a view exists exactly in these). */
export function holdsWebContents(state: RuntimeState): boolean {
  return state !== 'unloaded';
}
