import { useCallback, useEffect, useId, useState } from 'react';
import type { RefObject } from 'react';

import { useShellOverlay } from '../overlay/use-shell-overlay';
import { MAX_QUERY_CHARS } from '../palette/memory-display';
import type { MemoryResult } from '../palette/memory-display';
import { useMemorySearch } from '../palette/use-memory-search';
import { moveSelection } from './suggestion-keys';

/** How many suggestions the address bar shows. */
export const SUGGESTION_LIMIT = 6;

const NO_RESULTS: readonly MemoryResult[] = [];

export interface Suggestions {
  /** The dropdown is showing (there is something to show for what is typed). */
  readonly open: boolean;
  readonly results: readonly MemoryResult[];
  /** The selected suggestion, or -1 for none. */
  readonly selected: number;
  readonly listId: string;
  readonly optionId: (index: number) => string;
  /** Down (1) and Up (-1) through the suggestions. */
  readonly move: (direction: 1 | -1) => void;
  /** Select a suggestion (the pointer is over it). */
  readonly point: (index: number) => void;
  /**
   * Closes the dropdown for the text now typed; typing more opens it again. `focusPage`: main
   * gives the page the keyboard as it lowers the shell (a click on the page area), else not.
   */
  readonly dismiss: (focusPage: boolean) => void;
}

/** Whether a press landed on the part of the window where the page shows. */
function isOverPage(target: Node): boolean {
  return target instanceof Element && target.closest('[data-content-backdrop]') !== null;
}

/**
 * The address bar's suggestions (M4.2): while the user edits the field (`draft` is the text,
 * null when they are not), the memory is searched at every change, and up to six results hang
 * under the field. Nothing else leaves the shell while they type: the search is `memory.search`,
 * answered from the local database, and the address bar sends nothing anywhere until Enter.
 *
 * The dropdown is an A′ overlay (use-shell-overlay.ts), shown only while there is a result for
 * the text (a text search: fewer than two characters in a word gets the recent list, not shown). It closes on Escape (the caller's `dismiss`), on a press outside `containerRef` (the
 * field and the dropdown), and when the window loses the keyboard.
 */
export function useSuggestions(
  draft: string | null,
  containerRef: RefObject<HTMLElement | null>,
): Suggestions {
  const listId = useId();
  // The text for which the user closed the dropdown; typing something else brings it back.
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  // The suggestion the user picked, by its page: a newer answer to the same text (the previous
  // character's reply arriving late) keeps the pick if the page is still listed. Typing resets it.
  const [pick, setPick] = useState<{
    readonly draft: string | null;
    readonly pageId: number | null;
  }>({ draft, pageId: null });

  if (draft === null && dismissedFor !== null) {
    setDismissedFor(null);
  }
  if (pick.draft !== draft) {
    setPick({ draft, pageId: null });
  }
  const wanted = draft !== null && draft !== dismissedFor;
  const answer = useMemorySearch({
    query: (draft ?? '').slice(0, MAX_QUERY_CHARS),
    scope: 'all',
    limit: SUGGESTION_LIMIT,
    enabled: wanted,
  });
  const results = answer?.results ?? NO_RESULTS;
  // Only for words the memory could search: a single character gets the recent-and-frequent list,
  // which has nothing to do with what is typed, and the address bar has no use for it.
  const open = wanted && answer?.mode === 'text' && results.length > 0;

  // Nothing is selected until the user picks: Enter submits what was typed.
  const selected =
    open && pick.pageId !== null
      ? results.findIndex((result) => result.pageId === pick.pageId)
      : -1;

  const setFocusPageOnHide = useShellOverlay('suggestions', open);

  const dismiss = useCallback(
    (focusPage: boolean): void => {
      setFocusPageOnHide(focusPage);
      setDismissedFor(draft);
    },
    [setFocusPageOnHide, draft],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node) || containerRef.current?.contains(target) === true) {
        return;
      }
      dismiss(isOverPage(target));
    };
    const onWindowBlur = (): void => {
      dismiss(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('blur', onWindowBlur);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('blur', onWindowBlur);
    };
  }, [open, containerRef, dismiss]);

  const pickIndex = useCallback(
    (index: number): void => {
      setPick((held) => ({ draft: held.draft, pageId: results[index]?.pageId ?? null }));
    },
    [results],
  );

  const move = useCallback(
    (direction: 1 | -1): void => {
      pickIndex(moveSelection(results.length, selected, direction));
    },
    [pickIndex, results.length, selected],
  );

  return {
    open,
    results: open ? results : NO_RESULTS,
    selected,
    listId,
    optionId: (index) => `${listId}-suggestion-${String(index)}`,
    move,
    point: pickIndex,
    dismiss,
  };
}
