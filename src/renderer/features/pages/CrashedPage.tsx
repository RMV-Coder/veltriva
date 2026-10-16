import { Button } from '@/components/ui/button';
import { FOCUS_RING } from '@/lib/focus';
import { cn } from '@/lib/utils';

import { reloadTab } from '../../state/commands';

interface CrashedPageProps {
  readonly tabId: string;
  /** Why it crashed, as main reports it. */
  readonly reason: string | undefined;
}

/** Shown when a tab's renderer process dies. Main detaches the tab's view, so the shell draws this. */
export function CrashedPage({ tabId, reason }: CrashedPageProps) {
  return (
    <div
      data-internal-page="crashed"
      className="flex min-h-full flex-col items-center gap-4 px-6 pt-[22vh] pb-10 text-center"
    >
      <h1 className="text-2xl font-semibold tracking-tight">This tab crashed</h1>
      <p className="max-w-md">
        The page stopped working, but the rest of Veltriva is fine. Reload the tab to try again.
      </p>
      {reason === undefined ? null : (
        <p className="font-mono text-xs text-foreground/70">{reason}</p>
      )}
      <Button
        onClick={() => {
          void reloadTab(tabId);
        }}
        className={cn(FOCUS_RING)}
      >
        Reload tab
      </Button>
    </div>
  );
}
