import { ArrowRightToLine } from 'lucide-react';
import { memo } from 'react';

import { cn } from '@/lib/utils';

import { MarkedText } from '../palette/MarkedText';
import { neutralizeText } from '../palette/marks';
import { SWITCH_TO_TAB_TEXT, displayTitle, isOpenInStrip } from '../palette/memory-display';
import type { MemoryResult } from '../palette/memory-display';

interface SuggestionOptionProps {
  readonly id: string;
  readonly index: number;
  readonly result: MemoryResult;
  readonly selected: boolean;
  readonly onPoint: (index: number) => void;
  readonly onChoose: (index: number) => void;
}

/**
 * One suggestion: the page's title with its marks, its address, and "Switch to tab" when a tab in
 * the strip already shows it. The address bar keeps the keyboard (`aria-activedescendant`), so a
 * press on a suggestion must not take the focus: the mouse-down is cancelled.
 */
const SuggestionOption = memo(function SuggestionOption({
  id,
  index,
  result,
  selected,
  onPoint,
  onChoose,
}: SuggestionOptionProps) {
  const title = displayTitle(result);
  return (
    <li
      id={id}
      role="option"
      aria-selected={selected}
      data-suggestion={result.pageId}
      data-selected={selected}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onMouseMove={() => {
        if (!selected) {
          onPoint(index);
        }
      }}
      onClick={() => {
        onChoose(index);
      }}
      className={cn(
        'flex cursor-default items-center gap-3 rounded-lg px-3 py-1.5 select-none',
        selected ? 'bg-accent text-accent-foreground' : 'text-popover-foreground',
      )}
    >
      <div className="min-w-0 flex-1">
        <div data-suggestion-title="" className="truncate text-sm font-medium">
          <MarkedText text={title.text} ranges={title.ranges} />
        </div>
        <div data-suggestion-address="" className="truncate text-xs text-popover-foreground/70">
          <bdi dir="ltr">{neutralizeText(result.address)}</bdi>
        </div>
      </div>
      {isOpenInStrip(result) ? (
        <span
          data-switch-to-tab=""
          className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-popover-foreground"
        >
          <ArrowRightToLine aria-hidden="true" className="size-3.5" />
          {SWITCH_TO_TAB_TEXT}
        </span>
      ) : null}
    </li>
  );
});

interface SuggestionDropdownProps {
  readonly listId: string;
  readonly optionId: (index: number) => string;
  readonly results: readonly MemoryResult[];
  readonly selected: number;
  readonly onPoint: (index: number) => void;
  readonly onChoose: (index: number) => void;
}

/**
 * The address bar's suggestions, hanging under the field over the content area. It is an A′
 * overlay (ADR-0006): main raises the transparent shell above the page once it has painted, so
 * the page stays visible and live behind it. Draws only inside the field's own wrapper, which
 * is `relative`.
 */
export function SuggestionDropdown({
  listId,
  optionId,
  results,
  selected,
  onPoint,
  onChoose,
}: SuggestionDropdownProps) {
  return (
    <div
      data-suggestions=""
      className="absolute inset-x-0 top-full z-50 mt-1.5 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg"
    >
      <ul id={listId} role="listbox" aria-label="Suggestions" className="flex flex-col gap-0.5 p-1">
        {results.map((result, index) => (
          <SuggestionOption
            key={result.pageId}
            id={optionId(index)}
            index={index}
            result={result}
            selected={index === selected}
            onPoint={onPoint}
            onChoose={onChoose}
          />
        ))}
      </ul>
    </div>
  );
}
