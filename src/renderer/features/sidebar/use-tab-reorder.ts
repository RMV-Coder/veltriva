import { useRef, useState } from 'react';
import type { PointerEvent, RefObject } from 'react';

import { moveTab } from '../../state/commands';
import { dropSlot, dropTargetIndex } from './tab-order';
import type { StripTab } from './tab-order';

/** How far (px) the pointer must travel before a press on a tab becomes a drag. */
const DRAG_THRESHOLD_PX = 4;

interface Gesture {
  readonly tabId: string;
  readonly pointerId: number;
  readonly startY: number;
  /** True once the pointer has moved past the threshold. Until then it is still a click. */
  active: boolean;
}

/** Where the dragged tab would land: before row `slot` of its own section. */
export interface DropMark {
  readonly tabId: string;
  readonly slot: number;
}

/** The pointer handlers to spread onto one tab's element. */
export interface TabDragBindings {
  readonly onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
  readonly onLostPointerCapture: (event: PointerEvent<HTMLElement>) => void;
}

export interface TabReorder {
  /** The drag in progress, or null. */
  readonly mark: DropMark | null;
  readonly bind: (tab: StripTab) => TabDragBindings;
  /** True once, right after a drag ends, so the click that follows it doesn't also select the tab. */
  readonly consumeSuppressedClick: () => boolean;
}

/** The vertical midpoints of one section's rows, top to bottom. DOM order is strip order. */
function sectionMidpoints(list: HTMLElement | null, pinned: boolean): number[] {
  if (list === null) {
    return [];
  }
  const rows = list.querySelectorAll<HTMLElement>(`[role="tab"][data-pinned="${String(pinned)}"]`);
  return Array.from(rows, (row) => {
    const box = row.getBoundingClientRect();
    return box.top + box.height / 2;
  });
}

/**
 * Drag-to-reorder for the tab list, within a tab's own section. It uses pointer events with pointer
 * capture, not HTML5 drag-and-drop: a drag-and-drop could be dropped onto the web page beside the
 * sidebar, and the page would receive the dragged data. A press that never moves is a plain click.
 */
export function useTabReorder(
  listRef: RefObject<HTMLElement | null>,
  tabs: readonly StripTab[],
): TabReorder {
  const gesture = useRef<Gesture | null>(null);
  const clickSuppressed = useRef(false);
  const [mark, setMark] = useState<DropMark | null>(null);

  const bind = (tab: StripTab): TabDragBindings => {
    /** The gesture, if this event belongs to it. */
    const ownGesture = (event: PointerEvent<HTMLElement>): Gesture | null => {
      const current = gesture.current;
      return current?.tabId === tab.id && current.pointerId === event.pointerId ? current : null;
    };
    const slotAt = (clientY: number): number =>
      dropSlot(sectionMidpoints(listRef.current, tab.pinned), clientY);
    const cancel = (): void => {
      gesture.current = null;
      setMark(null);
    };

    return {
      onPointerDown: (event) => {
        if (event.button !== 0 || !event.isPrimary) {
          return;
        }
        clickSuppressed.current = false;
        gesture.current = {
          tabId: tab.id,
          pointerId: event.pointerId,
          startY: event.clientY,
          active: false,
        };
        try {
          // From here the tab's element gets every pointer event, even over the web page.
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // The pointer is already gone. A click still selects the tab.
        }
      },

      onPointerMove: (event) => {
        const current = ownGesture(event);
        if (current === null) {
          return;
        }
        if (!current.active) {
          if (Math.abs(event.clientY - current.startY) < DRAG_THRESHOLD_PX) {
            return;
          }
          current.active = true;
        }
        const slot = slotAt(event.clientY);
        setMark((held) =>
          held?.tabId === tab.id && held.slot === slot ? held : { tabId: tab.id, slot },
        );
      },

      onPointerUp: (event) => {
        const current = ownGesture(event);
        if (current === null) {
          return;
        }
        const wasDrag = current.active;
        cancel();
        if (!wasDrag) {
          return;
        }
        clickSuppressed.current = true;
        const toIndex = dropTargetIndex(tabs, tab.id, slotAt(event.clientY));
        if (toIndex !== null) {
          void moveTab(tab.id, toIndex);
        }
      },

      onPointerCancel: (event) => {
        if (ownGesture(event) !== null) {
          cancel();
        }
      },

      // Fires after a pointer-up too, when there is nothing left to cancel.
      onLostPointerCapture: (event) => {
        if (ownGesture(event) !== null) {
          cancel();
        }
      },
    };
  };

  const consumeSuppressedClick = (): boolean => {
    const suppressed = clickSuppressed.current;
    clickSuppressed.current = false;
    return suppressed;
  };

  return { mark, bind, consumeSuppressedClick };
}
