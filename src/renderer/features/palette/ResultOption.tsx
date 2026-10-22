import { ChevronRight } from 'lucide-react';
import { memo } from 'react';
import type { MouseEvent } from 'react';

import { cn } from '@/lib/utils';

import { MarkedText } from './MarkedText';
import { StateBadge } from './StateBadge';
import { displayTitle, visitedText } from './memory-display';
import type { MemoryResult } from './memory-display';
import { neutralizeText } from './marks';

export type OpenTarget = 'switch' | 'newTab';

interface ResultOptionProps {
  readonly id: string;
  readonly index: number;
  readonly result: MemoryResult;
  readonly active: boolean;
  /** The time now, for "visited 3 days ago". */
  readonly now: number;
  readonly onPoint: (index: number) => void;
  readonly onOpen: (index: number, target: OpenTarget) => void;
}

/**
 * One result of the palette: the title with its marks, the address, the site, when it was last
 * visited, and where its tab is. The shell's focus stays in the search field (`aria-activedescendant`
 * names this option), so a press on it must not take the focus: the mouse-down is cancelled.
 * Click opens it where its tab is; Ctrl+click and middle click open it in a new tab.
 */
export const ResultOption = memo(function ResultOption({
  id,
  index,
  result,
  active,
  now,
  onPoint,
  onOpen,
}: ResultOptionProps) {
  const title = displayTitle(result);
  const visited = visitedText(result.lastVisitAt, now);

  const onClick = (event: MouseEvent<HTMLLIElement>): void => {
    onOpen(index, event.ctrlKey || event.metaKey ? 'newTab' : 'switch');
  };
  const onAuxClick = (event: MouseEvent<HTMLLIElement>): void => {
    if (event.button === 1) {
      event.preventDefault();
      onOpen(index, 'newTab');
    }
  };

  return (
    <li
      id={id}
      role="option"
      aria-selected={active}
      data-palette-option={result.pageId}
      data-active={active}
      data-tab-placement={result.tab?.placement}
      onMouseDown={(event) => {
        // Keeps the field focused, and keeps a middle press from starting Windows' autoscroll.
        event.preventDefault();
      }}
      onMouseMove={() => {
        if (!active) {
          onPoint(index);
        }
      }}
      onClick={onClick}
      onAuxClick={onAuxClick}
      className={cn(
        'flex cursor-default items-center gap-2 rounded-lg px-2 py-1.5 select-none',
        active ? 'bg-accent text-accent-foreground' : 'text-popover-foreground',
      )}
    >
      <ChevronRight
        aria-hidden="true"
        className={cn('size-4 shrink-0 text-popover-foreground', active ? 'visible' : 'invisible')}
      />
      <div className="min-w-0 flex-1">
        <div data-result-title="" className="truncate text-sm font-medium">
          <MarkedText text={title.text} ranges={title.ranges} />
        </div>
        <div data-result-address="" className="truncate text-xs text-popover-foreground/70">
          <bdi dir="ltr">{neutralizeText(result.address)}</bdi>
        </div>
      </div>
      <div className="flex max-w-[45%] shrink-0 flex-col items-end gap-0.5">
        <StateBadge tab={result.tab} />
        <div className="max-w-full truncate text-xs text-popover-foreground/70">
          <bdi dir="ltr" data-result-site="">
            {neutralizeText(result.site)}
          </bdi>
          {visited === null ? null : (
            <>
              {' · '}
              <span data-result-visited="">{visited}</span>
            </>
          )}
        </div>
      </div>
    </li>
  );
});
