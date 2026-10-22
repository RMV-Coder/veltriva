import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FocusEvent, KeyboardEvent } from 'react';

import { listArchive, restoreTab } from '../../state/commands';
import { useArchived, useWorkspaceStore } from '../../state/workspace-store';
import { ArchivedRow } from './PlacementRows';
import { archivedRowText } from './placement-display';
import type { ArchivedTab } from './placement-display';
import { RowActivateContext } from './RowList';
import {
  ARCHIVE_OVERSCAN,
  ARCHIVE_ROW_HEIGHT,
  ARCHIVE_VIEWPORT_ROWS,
  ARCHIVE_WINDOW,
  MAX_KEPT_WINDOWS,
  alignedOffset,
  listHeight,
  neededOffsets,
  nextRowIndex,
  pageRows,
  scrollToReveal,
  viewportHeight,
  visibleRange,
  windowsToDrop,
} from './virtual-window';
import type { RowRange } from './virtual-window';

/** A fetched window of the Archive, and the epoch (count of the Archive) it was fetched in. */
interface HeldWindow {
  readonly epoch: number;
  readonly tabs: readonly ArchivedTab[];
}

/**
 * The windows of the Archive that the snapshot does not carry (it holds the newest 200), fetched
 * with `archive.list` as the rows come into view, `ARCHIVE_WINDOW` rows at a time, at aligned
 * offsets, each kept under its offset. A window already fetched is not asked for again, one being
 * fetched is not asked for twice, and only the `MAX_KEPT_WINDOWS` nearest the view are kept.
 *
 * When the Archive's count changes (a tab came in or went out) every window is out of date: they
 * stay on screen, so nothing blinks, and the ones in view are fetched again.
 */
function useArchiveWindows(
  total: number,
  snapshotRows: number,
  range: RowRange,
): ReadonlyMap<number, HeldWindow> {
  const [epoch, setEpoch] = useState(0);
  const [seenTotal, setSeenTotal] = useState(total);
  if (seenTotal !== total) {
    setSeenTotal(total);
    setEpoch(epoch + 1);
  }
  const [held, setHeld] = useState<ReadonlyMap<number, HeldWindow>>(() => new Map());
  const inFlight = useRef(new Set<string>());
  const latest = useRef({ epoch, center: 0 });
  useLayoutEffect(() => {
    latest.current = { epoch, center: Math.floor((range.start + range.end) / 2) };
  });

  const needed = neededOffsets(range, snapshotRows, total, ARCHIVE_WINDOW).join(',');
  useEffect(() => {
    const offsets = needed === '' ? [] : needed.split(',').map(Number);
    for (const offset of offsets) {
      const key = `${String(epoch)}:${String(offset)}`;
      if (held.get(offset)?.epoch === epoch || inFlight.current.has(key)) {
        continue;
      }
      inFlight.current.add(key);
      void listArchive(offset, ARCHIVE_WINDOW).then((window) => {
        inFlight.current.delete(key);
        // Unreadable, or from an Archive that has changed since: the next look asks again.
        if (window === undefined || latest.current.epoch !== epoch) {
          return;
        }
        setHeld((previous) => {
          const next = new Map(previous);
          next.set(offset, { epoch, tabs: window.tabs });
          for (const far of windowsToDrop(
            [...next.keys()],
            latest.current.center,
            ARCHIVE_WINDOW,
            MAX_KEPT_WINDOWS,
            offset,
          )) {
            next.delete(far);
          }
          return next;
        });
      });
    }
  }, [needed, epoch, held]);

  return held;
}

/** The index in a row's `data-row-index`, from an element inside the row. */
function rowIndexOf(target: EventTarget): number | null {
  if (!(target instanceof Element)) {
    return null;
  }
  const value = target.closest('[data-row-index]')?.getAttribute('data-row-index');
  return value === null || value === undefined ? null : Number(value);
}

type NavigationKey = 'ArrowUp' | 'ArrowDown' | 'Home' | 'End' | 'PageUp' | 'PageDown';

function isNavigationKey(key: string): key is NavigationKey {
  return (
    key === 'ArrowUp' ||
    key === 'ArrowDown' ||
    key === 'Home' ||
    key === 'End' ||
    key === 'PageUp' ||
    key === 'PageDown'
  );
}

/** The part of the Archive list that keeps focus when a row goes away under the keyboard. */
interface KeepFocus {
  readonly index: number;
  /** The snapshot version when the command was sent: its result arrives in a newer one. */
  readonly afterVersion: number;
}

/**
 * Every archived tab, newest first, in a list that draws only the rows in view (M4.2). The rows
 * have one fixed height and sit at `index × height` in a list `total × height` tall, so the
 * scroll bar is the whole Archive's; the DOM holds the rows in view plus a few more on each side,
 * ten thousand archived tabs or ten. The newest 200 come with the workspace snapshot and are
 * always current; the rest are fetched in windows as they scroll into view, and a row whose
 * window has not arrived is a "Loading…" placeholder of the same size.
 *
 * Keyboard, as in the Sleeping list: one tab stop (the row last focused); Up and Down move
 * between rows and wrap, Home and End go to the first and last, PageUp and PageDown a page; the
 * row that gets focus is scrolled into view, and fetched if need be. Enter, Space and a click
 * bring the tab back; for the keyboard focus then goes to the row that takes its place, once the
 * snapshot without the tab has arrived.
 */
export function ArchiveList({
  total,
  now,
  labelledBy,
  fallbackFocusId,
}: {
  /** How many tabs are archived (the snapshot's count). */
  readonly total: number;
  readonly now: number;
  readonly labelledBy: string;
  /** Where focus goes when the last row leaves: the section's toggle. */
  readonly fallbackFocusId: string;
}) {
  const archived = useArchived();
  const version = useWorkspaceStore((state) => state.snapshot?.version ?? -1);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [stopIndex, setStopIndex] = useState(0);
  const pendingFocus = useRef<number | null>(null);
  const keepFocus = useRef<KeepFocus | null>(null);

  const height = viewportHeight(total, ARCHIVE_ROW_HEIGHT, ARCHIVE_VIEWPORT_ROWS);
  const range = visibleRange({
    scrollTop,
    viewportHeight: height,
    rowHeight: ARCHIVE_ROW_HEIGHT,
    total,
    overscan: ARCHIVE_OVERSCAN,
  });
  const windows = useArchiveWindows(total, archived.length, range);

  const tabAt = (index: number): ArchivedTab | undefined => {
    const fromSnapshot = archived[index];
    if (fromSnapshot !== undefined) {
      return fromSnapshot;
    }
    const offset = alignedOffset(index, ARCHIVE_WINDOW);
    return windows.get(offset)?.tabs[index - offset];
  };

  const focusRow = (index: number): HTMLElement | null =>
    scrollerRef.current?.querySelector<HTMLElement>(`button[data-row-index="${String(index)}"]`) ??
    null;

  // What `activate` reads when it runs, kept in a ref so that it keeps one identity.
  const latest = useRef({ stopIndex, total, version });
  useLayoutEffect(() => {
    latest.current = { stopIndex, total, version };
  });

  const activate = useCallback((id: string, keyboard: boolean): void => {
    if (keyboard) {
      const current = latest.current;
      keepFocus.current = { index: current.stopIndex, afterVersion: current.version };
    }
    void restoreTab(id, keyboard ? { keepFocus: true } : undefined);
  }, []);

  // Focus a row a key asked for, once it is drawn; and put focus back after a keyboard restore.
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (pending !== null) {
      const row = focusRow(pending);
      if (row !== null) {
        pendingFocus.current = null;
        row.focus({ preventScroll: true });
      }
    }
    const keep = keepFocus.current;
    if (keep !== null && version > keep.afterVersion) {
      keepFocus.current = null;
      if (document.activeElement === document.body) {
        const next = Math.min(keep.index, total - 1);
        const target = next < 0 ? null : focusRow(next);
        (target ?? document.getElementById(fallbackFocusId))?.focus({ preventScroll: true });
      }
    }
  });

  // The list is shorter than the scroll position (tabs left): follow it.
  const maxScroll = Math.max(0, listHeight(total, ARCHIVE_ROW_HEIGHT) - height);
  if (scrollTop > maxScroll) {
    setScrollTop(maxScroll);
  }

  const revealAndFocus = (index: number): void => {
    const scroller = scrollerRef.current;
    if (scroller === null) {
      return;
    }
    const top = scrollToReveal({
      index,
      scrollTop: scroller.scrollTop,
      viewportHeight: height,
      rowHeight: ARCHIVE_ROW_HEIGHT,
      total,
    });
    pendingFocus.current = index;
    if (top !== scroller.scrollTop) {
      scroller.scrollTop = top;
    }
    setScrollTop(top);
    setStopIndex(index);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }
    const current = rowIndexOf(event.target);
    if (!isNavigationKey(event.key) || current === null) {
      return;
    }
    event.preventDefault();
    const next = nextRowIndex(total, current, event.key, pageRows(ARCHIVE_VIEWPORT_ROWS));
    if (next !== null && next !== current) {
      revealAndFocus(next);
    }
  };

  // The row that has focus is the list's tab stop from now on.
  const onFocus = (event: FocusEvent<HTMLUListElement>): void => {
    const index = rowIndexOf(event.target);
    if (index !== null) {
      setStopIndex(index);
    }
  };

  // Always a row that is drawn, so Tab can reach the list wherever it is scrolled.
  const tabStop = Math.min(Math.max(stopIndex, range.start), range.end - 1);

  const rows = [];
  for (let index = range.start; index < range.end; index += 1) {
    const tab = tabAt(index);
    const top = index * ARCHIVE_ROW_HEIGHT;
    if (tab === undefined) {
      rows.push(
        <ArchivedRow
          key={index}
          id={`loading-${String(index)}`}
          label="Loading…"
          favicon={null}
          alert={false}
          meta=""
          tooltip=""
          description="Loading"
          tabStop={index === tabStop}
          index={index}
          setSize={total}
          top={top}
          height={ARCHIVE_ROW_HEIGHT}
          loading
        />,
      );
      continue;
    }
    const text = archivedRowText(tab, now);
    rows.push(
      <ArchivedRow
        key={index}
        id={tab.id}
        label={text.label}
        favicon={tab.favicon}
        alert={false}
        meta={text.meta}
        tooltip={text.tooltip}
        description={text.description}
        tabStop={index === tabStop}
        index={index}
        setSize={total}
        top={top}
        height={ARCHIVE_ROW_HEIGHT}
      />,
    );
  }

  return (
    <div
      ref={scrollerRef}
      data-archive-scroller=""
      style={{ height }}
      onScroll={(event) => {
        setScrollTop(event.currentTarget.scrollTop);
      }}
      className="overflow-y-auto"
    >
      <RowActivateContext value={activate}>
        <ul
          aria-labelledby={labelledBy}
          data-row-list="archived"
          data-archive-total={total}
          onKeyDown={onKeyDown}
          onFocus={onFocus}
          style={{ position: 'relative', height: listHeight(total, ARCHIVE_ROW_HEIGHT) }}
        >
          {rows}
        </ul>
      </RowActivateContext>
    </div>
  );
}
