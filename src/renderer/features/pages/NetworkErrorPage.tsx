import { Button } from '@/components/ui/button';
import { FOCUS_RING } from '@/lib/focus';
import { cn } from '@/lib/utils';

import { reloadTab } from '../../state/commands';

interface NetworkErrorPageProps {
  readonly tabId: string;
  /** The address that failed, as the address bar shows it. */
  readonly address: string;
  /** Chromium's error name, such as ERR_NAME_NOT_RESOLVED. */
  readonly errorName: string | undefined;
}

/** Shown when a page fails to load. Main detaches the tab's view, so the shell draws this. */
export function NetworkErrorPage({ tabId, address, errorName }: NetworkErrorPageProps) {
  return (
    <div
      data-internal-page="network-error"
      className="flex min-h-full flex-col items-center gap-4 px-6 pt-[22vh] pb-10 text-center"
    >
      <h1 className="text-2xl font-semibold tracking-tight">This page couldn&apos;t load</h1>
      {address === '' ? null : <p className="max-w-xl break-all">{address}</p>}
      {errorName === undefined ? null : (
        <p className="font-mono text-xs text-foreground/70">{errorName}</p>
      )}
      <Button
        onClick={() => {
          void reloadTab(tabId);
        }}
        className={cn(FOCUS_RING)}
      >
        Try again
      </Button>
    </div>
  );
}
