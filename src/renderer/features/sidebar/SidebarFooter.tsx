import { ActivityButton } from '../activity/ActivityButton';
import { useCounts } from '../../state/workspace-store';
import { AutomationStatus } from './AutomationStatus';
import { NewTabButton } from './NewTabButton';
import { SettingsButton } from './SettingsButton';
import { countsLine } from './placement-display';

/**
 * The foot of the sidebar, which stays in view while the lists scroll: the summary line (assessment
 * §4.13, "Sleeping 12 · Archived today 3"), which is there whether the sections are open or not,
 * automation's status (pause, preview, memory), then the New tab button, the Activity button and
 * the Settings button (M5.1).
 */
export function SidebarFooter() {
  const line = countsLine(useCounts());
  return (
    <div className="shrink-0 border-t border-sidebar-border px-2 pt-1.5 pb-2">
      <p
        data-sidebar-summary=""
        title={line}
        className="truncate px-2.5 pb-1 text-xs text-sidebar-foreground/70"
      >
        {line}
      </p>
      <AutomationStatus />
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1">
          <NewTabButton />
        </div>
        <ActivityButton />
        <SettingsButton />
      </div>
    </div>
  );
}
