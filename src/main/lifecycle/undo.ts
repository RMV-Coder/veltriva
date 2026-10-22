// Undo for moves (assessment §4.12–§4.13, M3.3): the tabs one evaluation moved to Sleeping or the
// Archive are a batch, and the sidebar offers to undo the latest batch for a minute; the user's
// own move to Sleeping or the Archive is offered the same way. Undo puts each tab back where it
// was (TabManager.undoMoves); a tab the user moved meanwhile stays where the user put it. A newer
// batch replaces the offer: an automated one is still in the activity log, and its tabs are a
// click away in Sleeping and the Archive.
import type { Timers } from '../../core/lifecycle/discard';
import type { PlacementMove } from '../../core/lifecycle/placement';
import type { MoveBatch } from './scheduler';

/** How long the sidebar offers to undo a batch. */
export const UNDO_WINDOW_MS = 60_000;

/** What the sidebar shows: how many tabs went where. */
export interface UndoOffer {
  readonly batchId: string;
  /** Automation made the moves (or else the user did). */
  readonly automated: boolean;
  readonly shelved: number;
  readonly archived: number;
}

export interface UndoManagerOptions {
  readonly timers: Timers;
  /** Puts the tabs back; returns the moves it undid (a tab the user moved since stays put). */
  readonly undoMoves: (moves: readonly PlacementMove[]) => readonly PlacementMove[];
  /** The offer changed (made, taken, dismissed or expired). */
  readonly onChange: () => void;
}

export class UndoManager {
  readonly #options: UndoManagerOptions;
  #batch: MoveBatch | null = null;
  #automated = false;
  #timer: unknown;
  #stopped = false;

  constructor(options: UndoManagerOptions) {
    this.#options = options;
  }

  /** Offers to undo a batch, in place of any earlier offer. */
  offer(batch: MoveBatch, options: { readonly automated: boolean }): void {
    // After stop (shutdown), a discard that settles late may still report its batch: ignored.
    if (batch.moves.length === 0 || this.#stopped) {
      return;
    }
    this.#clearTimer();
    this.#batch = batch;
    this.#automated = options.automated;
    this.#timer = this.#options.timers.setTimeout(() => {
      this.#timer = undefined;
      this.#batch = null;
      this.#options.onChange();
    }, UNDO_WINDOW_MS);
    this.#options.onChange();
  }

  current(): UndoOffer | null {
    const batch = this.#batch;
    if (batch === null) {
      return null;
    }
    const archived = batch.moves.filter((move) => move.to === 'archive').length;
    return {
      batchId: batch.id,
      automated: this.#automated,
      shelved: batch.moves.length - archived,
      archived,
    };
  }

  /**
   * Undoes the offered batch. Returns the moves it undid, or null when `batchId` isn't the one
   * offered (it expired or a newer one replaced it): a late click never undoes another batch.
   */
  undo(batchId: string): readonly PlacementMove[] | null {
    const batch = this.#batch;
    if (batch?.id !== batchId) {
      return null;
    }
    this.#clearTimer();
    this.#batch = null;
    try {
      return this.#options.undoMoves(batch.moves);
    } finally {
      // The offer is gone whatever happened: the sidebar must stop showing it.
      this.#options.onChange();
    }
  }

  /** The user closed the offer. */
  dismiss(batchId: string): void {
    if (this.#batch?.id !== batchId) {
      return;
    }
    this.#clearTimer();
    this.#batch = null;
    this.#options.onChange();
  }

  stop(): void {
    this.#stopped = true;
    this.#clearTimer();
    this.#batch = null;
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) {
      this.#options.timers.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }
}
