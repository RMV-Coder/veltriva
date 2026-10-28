import type { KeyboardEvent } from 'react';

import { ActivityView, closeActivity } from '../activity/ActivityView';
import { SearchMemoryButton } from '../palette/SearchMemoryButton';
import { useUiStore } from '../../state/ui-store';
import { ArchiveSection } from './ArchiveSection';
import { SidebarFooter } from './SidebarFooter';
import { SleepingSection } from './SleepingSection';
import { TabList } from './TabList';
import { UndoToast } from './UndoToast';

/**
 * The sidebar: a "Search memory…" entry point for the palette (M4.2), the open tabs, then the
 * Sleeping and Archive sections (ADR-0009), with the Undo toast and a footer (counts, a button for a new tab, and the Activity button) that stay in view
 * while the lists scroll.
 *
 * The activity log takes the place of the tabs and sections while it is open. They stay in the
 * document, hidden, so the tab list keeps its focus, scroll position and state; Escape closes the
 * log and returns focus to the Activity button.
 */
export function Sidebar() {
  const activityOpen = useUiStore((state) => state.activityOpen);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (
      activityOpen &&
      event.key === 'Escape' &&
      !event.defaultPrevented &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      closeActivity();
    }
  };

  return (
    <aside
      aria-label="Sidebar"
      data-sidebar=""
      onKeyDown={onKeyDown}
      className="flex min-h-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground select-none"
    >
      <div hidden={activityOpen} className="shrink-0 px-2 pt-2 pb-1">
        <SearchMemoryButton />
      </div>
      <div hidden={activityOpen} className="min-h-0 flex-1 overflow-y-auto">
        <TabList />
        <div className="flex flex-col gap-1 border-t border-sidebar-border px-2 pt-1 pb-2">
          <SleepingSection />
          <ArchiveSection />
        </div>
      </div>
      {activityOpen ? <ActivityView /> : null}
      <UndoToast />
      <SidebarFooter />
    </aside>
  );
}
