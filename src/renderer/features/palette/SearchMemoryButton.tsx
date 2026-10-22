import { Search } from 'lucide-react';

import { FOCUS_RING } from '@/lib/focus';
import { cn } from '@/lib/utils';

import { useUiStore } from '../../state/ui-store';

/**
 * "Search memory…" at the top of the sidebar (assessment §7.3): the click that opens the memory
 * palette, for a user who does not know Ctrl+Shift+K. The shortcut is on it, as text.
 */
export function SearchMemoryButton() {
  const openPalette = useUiStore((state) => state.openPalette);

  return (
    <button
      type="button"
      data-search-memory=""
      aria-keyshortcuts="Control+Shift+K"
      title="Search memory (Ctrl+Shift+K)"
      onClick={() => {
        openPalette();
      }}
      className={cn(
        'flex h-8 w-full items-center gap-2 rounded-lg border border-sidebar-border bg-background px-2.5 text-left text-sm text-sidebar-foreground/80 hover:bg-sidebar-accent/60',
        FOCUS_RING,
      )}
    >
      <Search aria-hidden="true" className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">Search memory…</span>
      <kbd className="shrink-0 font-sans text-xs text-sidebar-foreground/70">Ctrl+Shift+K</kbd>
    </button>
  );
}
