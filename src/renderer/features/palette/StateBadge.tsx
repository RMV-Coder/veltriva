import { Archive, CircleDot, Moon } from 'lucide-react';

import { stateBadgeLabel } from './memory-display';
import type { MemoryTab } from './memory-display';

const ICONS = { strip: CircleDot, shelf: Moon, archive: Archive } as const;

/**
 * Where the page's tab is: "Open", "Sleeping" or "Archived", in words (the icon is decoration).
 * Nothing for a page that has no tab.
 */
export function StateBadge({ tab }: { readonly tab: MemoryTab }) {
  const label = stateBadgeLabel(tab);
  if (tab === null || label === null) {
    return null;
  }
  const Icon = ICONS[tab.placement];
  return (
    <span
      data-state-badge={tab.placement}
      className="inline-flex items-center gap-1 rounded-full border border-foreground/25 px-2 py-0.5 text-xs font-medium text-popover-foreground"
    >
      <Icon aria-hidden="true" className="size-3" />
      {label}
    </span>
  );
}
