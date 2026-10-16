import { Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { FOCUS_RING } from '@/lib/focus';
import { cn } from '@/lib/utils';

import { createTab } from '../../state/commands';
import { useUiStore } from '../../state/ui-store';

/** Creates a tab, then asks the address bar to take focus once that tab is selected. */
export function NewTabButton() {
  const requestOmniboxFocus = useUiStore((state) => state.requestOmniboxFocus);

  const onClick = (): void => {
    void createTab().then((tabId) => {
      if (tabId !== undefined) {
        requestOmniboxFocus(tabId);
      }
    });
  };

  return (
    <Button
      variant="ghost"
      onClick={onClick}
      className={cn('w-full justify-start text-sidebar-foreground', FOCUS_RING)}
    >
      <Plus data-icon="inline-start" aria-hidden="true" />
      New tab
    </Button>
  );
}
