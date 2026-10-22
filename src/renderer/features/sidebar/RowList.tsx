import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from 'react';
import type { FocusEvent, KeyboardEvent, MouseEvent, ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { FOCUS_RING } from '@/lib/focus';
import { cn } from '@/lib/utils';

import { useWorkspaceStore } from '../../state/workspace-store';
import { ROWS_PER_PAGE, rowWindow } from './placement-display';
import { nextFocusIndex } from './tab-order';
import type { FocusKey } from './tab-order';

type Activate = (id: string, keyboard: boolean) => void;

const RowActivateContext = createContext<Activate>(() => undefined);

/**
 * What a row calls when it is activated: `keyboard` is true for Enter or Space, and then the list
 * sees to it that keyboard focus is not lost when the row goes away. It comes by context, not as a
 * prop, so it never changes and a memoized row is not drawn again for it.
 */
export function useRowActivate(): Activate {
  return useContext(RowActivateContext);
}

// A row marks its button with `data-row-button` and carries its id in `data-row-id` (PlacementRows):
// the list finds the rows, and the one to give focus to, by them.
const ROW_BUTTON_ATTRIBUTE = 'data-row-button';
const ROW_ID_ATTRIBUTE = 'data-row-id';

interface RowListProps<Item extends { readonly id: string }> {
  readonly items: readonly Item[];
  /** The list's accessible name, from a visible heading's id when there is one. */
  readonly labelledBy?: string;
  readonly label?: string;
  /** `data-row-list`: which list this is. */
  readonly kind: 'sleeping' | 'archived';
  /** The name of the "Show more" button. */
  readonly showMoreLabel: string;
  /** Where focus goes when a row leaves and none is left to take it: the section's toggle. */
  readonly fallbackFocusId: string;
  /**
   * Draws one row, which must carry `key`. `tabStop`: it is the one row in the page's tab order
   * (roving tabindex). Memoize the row on primitives: a long list is drawn again at every snapshot.
   */
  readonly renderRow: (item: Item, tabStop: boolean) => ReactNode;
  /** A row was activated by a click (the mouse) or by Enter or Space. */
  readonly onActivate: Activate;
}

/** A row that is about to go away under the keyboard, and the row to give its focus to. */
interface KeepFocus {
  /** Undefined when no row is left: the fallback gets it. */
  readonly rowId: string | undefined;
  /** The snapshot version when the command was sent: its result arrives in a newer one. */
  readonly afterVersion: number;
}

function isFocusKey(key: string): key is FocusKey {
  return key === 'ArrowUp' || key === 'ArrowDown' || key === 'Home' || key === 'End';
}

/**
 * A list of buttons, one per Sleeping or archived tab. Keyboard: one tab stop (the row last
 * focused, or the first); the arrow keys, Home and End move between rows; Enter and Space (a
 * button's click) activate. It draws at most `ROWS_PER_PAGE` rows until the user asks for more, so
 * a thousand Sleeping tabs cost no more than a few hundred rows.
 *
 * Activating a row moves the tab out of the list, and the row it had goes with it. For the
 * keyboard that would drop focus onto the page, so the list gives focus to the next row, else the
 * previous one, else the fallback, once the snapshot without the row has arrived (as the tab list
 * does when it closes a tab). Pointer activation leaves focus alone.
 */
export function RowList<Item extends { readonly id: string }>({
  items,
  labelledBy,
  label,
  kind,
  showMoreLabel,
  fallbackFocusId,
  renderRow,
  onActivate,
}: RowListProps<Item>) {
  const version = useWorkspaceStore((state) => state.snapshot?.version ?? -1);
  const [limit, setLimit] = useState(ROWS_PER_PAGE);
  const [stopId, setStopId] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const keepFocus = useRef<KeepFocus | null>(null);
  /** The index of the first row a keyboard "Show more" added: it takes focus. */
  const growFocus = useRef<number | null>(null);

  const view = rowWindow(items.length, limit);
  const rows = items.slice(0, view.shown);

  // What `activate` reads when it runs. Kept in a ref, written after each render, so `activate`
  // can keep one identity and the rows, memoized, are not drawn again for it.
  const latest = useRef({ rows, version, onActivate });
  useLayoutEffect(() => {
    latest.current = { rows, version, onActivate };
  });

  const activate = useCallback((id: string, keyboard: boolean): void => {
    const current = latest.current;
    if (keyboard) {
      const index = current.rows.findIndex((row) => row.id === id);
      const neighbor = current.rows[index + 1] ?? current.rows[index - 1];
      keepFocus.current = { rowId: neighbor?.id, afterVersion: current.version };
    }
    current.onActivate(id, keyboard);
  }, []);

  const rowButtons = (): HTMLElement[] =>
    Array.from(listRef.current?.querySelectorAll<HTMLElement>(`[${ROW_BUTTON_ATTRIBUTE}]`) ?? []);

  // When main has moved a tab out of the list, React removes its row, and a button that was
  // focused loses its focus. Put it back, once, unless the user has moved on.
  useLayoutEffect(() => {
    const keep = keepFocus.current;
    if (keep !== null && version > keep.afterVersion) {
      keepFocus.current = null;
      if (document.activeElement === document.body) {
        const target =
          keep.rowId === undefined
            ? null
            : listRef.current?.querySelector<HTMLElement>(
                `[${ROW_ID_ATTRIBUTE}="${CSS.escape(keep.rowId)}"]`,
              );
        (target ?? document.getElementById(fallbackFocusId))?.focus();
      }
    }
    const grown = growFocus.current;
    if (grown !== null) {
      growFocus.current = null;
      rowButtons()[grown]?.focus();
    }
  });

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }
    const { key } = event;
    if (!isFocusKey(key) || !(event.target instanceof HTMLElement)) {
      return;
    }
    const buttons = rowButtons();
    const current = buttons.indexOf(event.target);
    if (current < 0) {
      return;
    }
    event.preventDefault();
    const next = nextFocusIndex(buttons.length, current, key);
    if (next !== null) {
      buttons[next]?.focus();
    }
  };

  // The row that has focus is the list's tab stop from now on.
  const onFocus = (event: FocusEvent<HTMLUListElement>): void => {
    const id =
      event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>(`[${ROW_ID_ATTRIBUTE}]`)?.getAttribute(ROW_ID_ATTRIBUTE)
        : null;
    if (id !== null && id !== undefined) {
      setStopId(id);
    }
  };

  const onShowMore = (event: MouseEvent<HTMLButtonElement>): void => {
    // A click has detail 1 or more; Enter and Space report 0. Only the keyboard's focus moves.
    if (event.detail === 0) {
      growFocus.current = view.shown;
    }
    setLimit(limit + view.step);
  };

  const stop = rows.some((row) => row.id === stopId) ? stopId : rows[0]?.id;

  return (
    <>
      <RowActivateContext value={activate}>
        <ul
          ref={listRef}
          aria-label={label}
          aria-labelledby={labelledBy}
          data-row-list={kind}
          onKeyDown={onKeyDown}
          onFocus={onFocus}
          className="flex flex-col gap-0.5"
        >
          {rows.map((row) => renderRow(row, row.id === stop))}
        </ul>
      </RowActivateContext>
      {view.remaining > 0 ? (
        <Button
          variant="ghost"
          size="sm"
          aria-label={showMoreLabel}
          data-show-more={kind}
          onClick={onShowMore}
          className={cn('mt-0.5 w-full justify-start px-2.5 text-sidebar-foreground', FOCUS_RING)}
        >
          Show more
          <span className="text-sidebar-foreground/70" aria-hidden="true">
            {view.remaining} more
          </span>
        </Button>
      ) : null}
    </>
  );
}
