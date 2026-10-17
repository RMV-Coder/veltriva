import { Button } from '@/components/ui/button';
import { FOCUS_RING } from '@/lib/focus';
import { cn } from '@/lib/utils';

import { goBack, reloadTab } from '../../state/commands';

interface ErrorPageActionsProps {
  readonly tabId: string;
  /** "Go back" is offered only when the tab has somewhere to go back to. */
  readonly canGoBack: boolean;
}

/**
 * The two ways out of a security error page: load the address again, or leave it. There is no
 * third one: these pages never offer to continue to the site anyway.
 */
export function ErrorPageActions({ tabId, canGoBack }: ErrorPageActionsProps) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      <Button
        onClick={() => {
          void reloadTab(tabId);
        }}
        className={cn(FOCUS_RING)}
      >
        Try again
      </Button>
      {canGoBack ? (
        <Button
          variant="outline"
          onClick={() => {
            void goBack(tabId);
          }}
          className={cn(FOCUS_RING)}
        >
          Go back
        </Button>
      ) : null}
    </div>
  );
}
