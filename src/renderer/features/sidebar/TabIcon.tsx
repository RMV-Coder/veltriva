import { Globe, LoaderCircle, TriangleAlert } from 'lucide-react';

import type { TabSnapshot } from '../../../shared/contracts/schemas';
import type { TabStatus } from './tab-display';

interface TabIconProps {
  readonly tab: TabSnapshot;
  readonly status: TabStatus | null;
}

/**
 * The icon at the start of a tab row, most urgent first: an alert for a crashed or failed tab, a
 * spinner while loading, the favicon, else a globe. Its meaning for assistive technology is the
 * status text in TabRow; the icon itself is decoration.
 */
export function TabIcon({ tab, status }: TabIconProps) {
  return (
    <span
      data-tab-status={status ?? undefined}
      className="flex size-4 shrink-0 items-center justify-center"
    >
      <Icon tab={tab} status={status} />
    </span>
  );
}

function Icon({ tab, status }: TabIconProps) {
  if (status === 'crashed' || status === 'failed') {
    return <TriangleAlert className="size-4 text-red-700 dark:text-red-400" aria-hidden="true" />;
  }
  if (status === 'loading') {
    // A still arc under prefers-reduced-motion.
    return (
      <LoaderCircle
        className="size-4 animate-spin text-foreground/70 motion-reduce:animate-none"
        aria-hidden="true"
      />
    );
  }
  if (tab.favicon !== null) {
    // Main validated this data: URL. `draggable` is off so a favicon can't start a native drag.
    return <img src={tab.favicon} alt="" draggable={false} className="size-4 rounded-[3px]" />;
  }
  return <Globe className="size-4 text-foreground/70" aria-hidden="true" />;
}
