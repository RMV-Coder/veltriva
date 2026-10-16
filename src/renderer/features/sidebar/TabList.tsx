import { useLayoutEffect, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

import type { TabSnapshot } from '../../../shared/contracts/schemas';
import { closeTab, moveTab, selectTab } from '../../state/commands';
import { useSelectedTabId, useTabs, useWorkspaceStore } from '../../state/workspace-store';
import { TabRow } from './TabRow';
import { dropTargetIndex, keyboardMoveTarget, nextFocusIndex } from './tab-order';
import { useTabReorder } from './use-tab-reorder';

/** A keyboard move or close in flight, and the tab to give focus to once main has done it. */
interface KeepFocus {
  /** `undefined` means the selected tab. */
  readonly tabId: string | undefined;
  /** The snapshot version when the command was sent: its result arrives in a newer one. */
  readonly afterVersion: number;
}

/**
 * The open tabs as a vertical WAI-ARIA tablist, pinned tabs first. Selection follows Enter or
 * Space (manual activation); the arrow keys only move focus. The list renders what main last
 * sent: every action here is a command, and the list changes when the next snapshot arrives.
 *
 * The list owns only tabs, as the pattern requires: the section labels and the separator are
 * drawn for sighted users and hidden from assistive technology, which hears "Pinned" in each
 * pinned tab's description instead.
 */
export function TabList() {
  const tabs = useTabs();
  const selectedTabId = useSelectedTabId();
  const version = useWorkspaceStore((state) => state.snapshot?.version ?? -1);
  const listRef = useRef<HTMLDivElement>(null);
  const keepFocus = useRef<KeepFocus | null>(null);
  const reorder = useTabReorder(listRef, tabs);

  const pinned = tabs.filter((tab) => tab.pinned);
  const unpinned = tabs.filter((tab) => !tab.pinned);
  // Roving tabindex: the selected tab is the list's one tab stop, or the first tab if none is.
  const tabStopId = tabs.some((tab) => tab.id === selectedTabId) ? selectedTabId : tabs[0]?.id;

  const focusTab = (tabId: string | undefined): void => {
    if (tabId !== undefined) {
      listRef.current?.querySelector<HTMLElement>(`[role="tab"][data-tab-id="${tabId}"]`)?.focus();
    }
  };

  // When main has moved or closed a tab, React moves or removes DOM nodes, and a node that was
  // focused loses its focus. Put it back, once, unless the user has moved on.
  useLayoutEffect(() => {
    const keep = keepFocus.current;
    if (keep === null || version <= keep.afterVersion) {
      return;
    }
    keepFocus.current = null;
    if (document.activeElement === document.body) {
      focusTab(keep.tabId ?? selectedTabId ?? undefined);
    }
  });

  const onKeyDown = (event: KeyboardEvent<HTMLElement>, tab: TabSnapshot): void => {
    const { key } = event;
    const moving = event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey;

    if (moving && (key === 'ArrowUp' || key === 'ArrowDown')) {
      event.preventDefault();
      const toIndex = keyboardMoveTarget(tabs, tab.id, key === 'ArrowUp' ? -1 : 1);
      if (toIndex !== null) {
        keepFocus.current = { tabId: tab.id, afterVersion: version };
        void moveTab(tab.id, toIndex);
      }
      return;
    }

    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }

    switch (key) {
      case 'ArrowUp':
      case 'ArrowDown':
      case 'Home':
      case 'End': {
        event.preventDefault();
        const current = tabs.findIndex((candidate) => candidate.id === tab.id);
        const next = nextFocusIndex(tabs.length, current, key);
        focusTab(next === null ? undefined : tabs[next]?.id);
        return;
      }
      case 'Enter':
      case ' ':
        event.preventDefault();
        void selectTab(tab.id);
        return;
      case 'Delete': {
        event.preventDefault();
        const index = tabs.findIndex((candidate) => candidate.id === tab.id);
        // Focus the tab after it, else the one before. With neither, main leaves a fresh tab,
        // which is the selected one.
        const neighbor = tabs[index + 1] ?? tabs[index - 1];
        keepFocus.current = { tabId: neighbor?.id, afterVersion: version };
        void closeTab(tab.id);
        return;
      }
    }
  };

  const { mark } = reorder;
  // No drop line where dropping would leave the tab where it is.
  const markedSection =
    mark !== null && dropTargetIndex(tabs, mark.tabId, mark.slot) !== null
      ? tabs.find((tab) => tab.id === mark.tabId)?.pinned
      : undefined;

  const renderRow = (tab: TabSnapshot, sectionIndex: number, sectionLength: number): ReactNode => {
    // The drop line belongs to the section of the tab being dragged.
    const marked = mark !== null && markedSection === tab.pinned;
    let dropEdge: 'before' | 'after' | null = null;
    if (marked && mark.slot === sectionIndex) {
      dropEdge = 'before';
    } else if (marked && mark.slot === sectionLength && sectionIndex === sectionLength - 1) {
      dropEdge = 'after';
    }

    return (
      <TabRow
        key={tab.id}
        tab={tab}
        selected={tab.id === selectedTabId}
        tabStop={tab.id === tabStopId}
        dragging={mark?.tabId === tab.id}
        dropEdge={dropEdge}
        dragBindings={reorder.bind(tab)}
        onActivate={() => {
          if (!reorder.consumeSuppressedClick()) {
            void selectTab(tab.id);
          }
        }}
        onKeyDown={(event) => {
          onKeyDown(event, tab);
        }}
      />
    );
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-orientation="vertical"
      aria-label="Open tabs"
      className="flex flex-col gap-0.5 p-2"
    >
      {pinned.length > 0 ? <SectionLabel>Pinned</SectionLabel> : null}
      {pinned.map((tab, index) => renderRow(tab, index, pinned.length))}
      {pinned.length > 0 && unpinned.length > 0 ? (
        <div aria-hidden="true" className="mx-1 my-1 h-px bg-sidebar-border" />
      ) : null}
      {unpinned.length > 0 ? <SectionLabel>Tabs</SectionLabel> : null}
      {unpinned.map((tab, index) => renderRow(tab, index, unpinned.length))}
    </div>
  );
}

function SectionLabel({ children }: { readonly children: ReactNode }) {
  return (
    <div
      aria-hidden="true"
      className="px-2.5 pt-1 pb-0.5 text-xs font-medium tracking-wide text-sidebar-foreground/70 uppercase"
    >
      {children}
    </div>
  );
}
