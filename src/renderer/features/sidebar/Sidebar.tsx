import { NewTabButton } from './NewTabButton';
import { TabList } from './TabList';

/**
 * The sidebar: the open tabs and a button for a new one. Sleeping and Archive sections join them
 * in a later phase (ADR-0009). The list scrolls when it is long; the button then stays in view.
 */
export function Sidebar() {
  return (
    <aside
      aria-label="Sidebar"
      className="flex min-h-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground select-none"
    >
      <div className="min-h-0 overflow-y-auto">
        <TabList />
      </div>
      <div className="shrink-0 px-2 pb-2">
        <NewTabButton />
      </div>
    </aside>
  );
}
