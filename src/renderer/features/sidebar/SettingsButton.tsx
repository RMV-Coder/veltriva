import { Settings } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { FOCUS_RING } from '@/lib/focus';
import { cn } from '@/lib/utils';

import { openSettings } from '../../state/commands';

/** The button's accessible name; its tooltip says more. */
export const SETTINGS_LABEL = 'Settings';

/**
 * Opens Settings (`veltriva://settings`, M5.1) in a tab: the one already open, or a new one. Main
 * selects the tab, so the page takes the keyboard as after any tab switch.
 */
export function SettingsButton() {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={SETTINGS_LABEL}
      title="Settings: automation, search engine, startup, the memory and site rules"
      data-settings-button=""
      onClick={() => {
        void openSettings();
      }}
      className={cn('shrink-0 text-sidebar-foreground', FOCUS_RING)}
    >
      <Settings aria-hidden="true" />
    </Button>
  );
}
