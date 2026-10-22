// The placement dimension (assessment §4.4): where a tab is shown. Tabs (the strip), Sleeping (the
// shelf), Archive, and Recently closed. TabManager moves tabs between them; these are the shapes
// of its answers and of the moves an Undo puts back. Pure.
//
//   strip ──shelve──▶ shelf ──archive──▶ archive
//     ▲  ◀──select / restore──┘             │
//     └───────────── restore (next to the current tab) ─┘
//   strip | shelf ──archive (manual)──▶ archive;   any ──close──▶ closed (7 days)
//
// Moving never changes what a tab costs by itself: a Sleeping tab may still be live (a protected
// tab is kept awake there). An archived tab holds no web contents (I3): archiving discards first,
// and a discard that is blocked leaves the tab where it was.

import type { DiscardBlock, DiscardSkip } from './discard';

export type Placement = 'strip' | 'shelf' | 'archive';

/** Why a tab was archived (`tabs.archive_reason`). */
export type ArchiveReason = 'auto' | 'manual';

/** Who moves a tab: the scheduler or the user. Protections stop only automation. */
export type MoveOrigin = 'automation' | 'user';

export interface MoveRequest {
  readonly origin: MoveOrigin;
  /** The runtime epoch the decision saw (automation): a later transition voids it (I5). */
  readonly epoch?: number;
}

/** Why a move didn't happen. Beyond a discard's reasons: the tab is pinned, or isn't there. */
export type MoveSkip = DiscardSkip | 'pinned' | 'wrong-placement';

export type MoveOutcome =
  | { readonly outcome: 'moved'; readonly move: PlacementMove }
  | { readonly outcome: 'skipped'; readonly why: MoveSkip }
  | { readonly outcome: 'blocked'; readonly reason: DiscardBlock };

/** A move as an Undo puts it back: where the tab was, and where it went. */
export interface PlacementMove {
  readonly tabId: string;
  readonly from: 'strip' | 'shelf';
  readonly to: 'shelf' | 'archive';
  /** Its index in `from` (strip order or shelf order) just before it moved. */
  readonly index: number;
}
