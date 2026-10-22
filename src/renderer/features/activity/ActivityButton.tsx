import { ScrollText } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { FOCUS_RING } from '@/lib/focus';
import { cn } from '@/lib/utils';

import { useUiStore } from '../../state/ui-store';
import { ACTIVITY_BUTTON_ID, ACTIVITY_VIEW_ID } from '../layout/ids';

/** The button's accessible name; its tooltip says more. */
export const ACTIVITY_LABEL = 'Activity';

/**
 * Opens and closes the activity log in the sidebar (`ActivityView`). Pressing it while the log is
 * open closes it, and so do Back and Escape, which return focus here.
 */
export function ActivityButton() {
  const open = useUiStore((state) => state.activityOpen);
  const setOpen = useUiStore((state) => state.setActivityOpen);

  return (
    <Button
      variant="ghost"
      size="icon"
      id={ACTIVITY_BUTTON_ID}
      aria-label={ACTIVITY_LABEL}
      title="Activity: what Veltriva did on its own"
      aria-expanded={open}
      aria-controls={open ? ACTIVITY_VIEW_ID : undefined}
      data-activity-button=""
      onClick={() => {
        setOpen(!open);
      }}
      className={cn('shrink-0 text-sidebar-foreground', FOCUS_RING)}
    >
      <ScrollText aria-hidden="true" />
    </Button>
  );
}
