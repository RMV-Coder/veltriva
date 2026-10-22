import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

import { FOCUS_RING } from '@/lib/focus';
import { cn } from '@/lib/utils';

export type SectionKind = 'sleeping' | 'archive';

/** The DOM id of a section's toggle: a list's focus falls back to it when its last row leaves. */
export function sectionToggleId(kind: SectionKind): string {
  return `sidebar-${kind}-toggle`;
}

function sectionBodyId(kind: SectionKind): string {
  return `sidebar-${kind}-body`;
}

interface SidebarSectionProps {
  readonly kind: SectionKind;
  /** The visible name and the accessible name of both the region and its toggle. */
  readonly name: string;
  /** The number beside the name. */
  readonly count: number;
  /** The count in words, which a screen reader hears after the name. */
  readonly countText: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  /** Drawn only while the section is open: a collapsed one costs no rows. */
  readonly children: ReactNode;
}

/**
 * A collapsible section of the sidebar, below the open tabs: a region named `name` whose heading
 * is a toggle button (WAI-ARIA disclosure). The heading stays in view while its rows scroll.
 */
export function SidebarSection({
  kind,
  name,
  count,
  countText,
  expanded,
  onToggle,
  children,
}: SidebarSectionProps) {
  const bodyId = sectionBodyId(kind);
  const countId = `sidebar-${kind}-count`;
  return (
    <section
      aria-label={name}
      data-sidebar-section={kind}
      data-expanded={expanded}
      data-count={count}
      className="flex flex-col gap-0.5"
    >
      <h2 className="sticky top-0 z-10 bg-sidebar">
        <button
          type="button"
          id={sectionToggleId(kind)}
          aria-expanded={expanded}
          aria-controls={expanded ? bodyId : undefined}
          aria-describedby={countId}
          data-section-toggle={kind}
          onClick={onToggle}
          className={cn(
            'flex h-7 w-full items-center gap-1 rounded-lg px-1.5 text-xs font-medium tracking-wide text-sidebar-foreground/70 uppercase select-none hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
            FOCUS_RING,
          )}
        >
          <ChevronRight
            aria-hidden="true"
            className={cn(
              'size-3.5 shrink-0 transition-transform motion-reduce:transition-none',
              expanded && 'rotate-90',
            )}
          />
          <span className="min-w-0 flex-1 truncate text-left">{name}</span>
          <span
            aria-hidden="true"
            data-section-count=""
            className="shrink-0 font-normal tracking-normal tabular-nums"
          >
            {count}
          </span>
        </button>
      </h2>
      <span id={countId} hidden>
        {countText}
      </span>
      {expanded ? (
        <div id={bodyId} data-section-body="" className="flex flex-col gap-0.5">
          {children}
        </div>
      ) : null}
    </section>
  );
}

/** The one short line of a section with nothing in it. */
export function EmptyLine({ children }: { readonly children: ReactNode }) {
  return (
    <p data-empty="" className="px-2.5 py-1 text-sm text-sidebar-foreground/70">
      {children}
    </p>
  );
}
