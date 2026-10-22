import { Pin, PinOff, ShieldCheck, X } from 'lucide-react';
import type { KeyboardEvent, ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { FOCUS_RING } from '@/lib/focus';
import { cn } from '@/lib/utils';

import type { TabSnapshot } from '../../../shared/contracts/schemas';
import { closeTab, setTabPinned, showTabMenu } from '../../state/commands';
import { CONTENT_AREA_ID, tabDomId } from '../layout/ids';
import { PreviewMarker } from './PreviewMarker';
import { TabIcon } from './TabIcon';
import {
  PROTECTED_TEXT,
  keptAwakeAttribute,
  tabDescriptions,
  tabLabel,
  tabMenuPoint,
  tabStatus,
  tabTooltip,
} from './tab-display';
import type { TabDragBindings } from './use-tab-reorder';

interface TabRowProps {
  readonly tab: TabSnapshot;
  readonly selected: boolean;
  /** The one tab that is in the page's tab order (roving tabindex). */
  readonly tabStop: boolean;
  /** This row is being dragged. */
  readonly dragging: boolean;
  /** Draws the drop indicator above or below this row. */
  readonly dropEdge: 'before' | 'after' | null;
  readonly dragBindings: TabDragBindings;
  readonly onActivate: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

/** Room for the two action buttons at the row's right end, so a label never runs under them. */
const LABEL_MAKES_ROOM = 'group-hover/row:pr-15 group-has-[[aria-selected=true]]/row:pr-15';

export function TabRow({
  tab,
  selected,
  tabStop,
  dragging,
  dropEdge,
  dragBindings,
  onActivate,
  onKeyDown,
}: TabRowProps) {
  const label = tabLabel(tab);
  const status = tabStatus(tab);
  const domId = tabDomId(tab.id);
  // What a screen reader hears after the label: pinned, the status, what automation did to the
  // tab, its protection. The text sits in `hidden` elements: a description may point at them, and
  // they stay out of the tablist, which may only own tabs.
  const descriptions = tabDescriptions(tab).map(({ key, text }) => ({
    id: `${domId}-${key}`,
    text,
  }));

  return (
    // The row only groups the tab with its action buttons, which are its siblings: a button
    // can't sit inside a role="tab" element.
    <div role="presentation" data-tab-row={tab.id} className="group/row relative">
      {dropEdge === 'before' ? <DropLine edge="top" /> : null}

      <div
        role="tab"
        id={domId}
        aria-selected={selected}
        aria-controls={CONTENT_AREA_ID}
        aria-label={label}
        aria-describedby={
          descriptions.length === 0 ? undefined : descriptions.map(({ id }) => id).join(' ')
        }
        tabIndex={tabStop ? 0 : -1}
        // The label first, then what automation did to the tab, any protection, and what Veltriva
        // observed that keeps it awake (§4.10, §4.13).
        title={tabTooltip(tab)}
        data-tab-id={tab.id}
        data-pinned={tab.pinned}
        data-selected={selected}
        data-runtime={tab.runtime}
        data-unloaded-by={tab.unloadedBy ?? undefined}
        data-unload-pressure={tab.unloadPressure ?? undefined}
        data-user-protected={tab.userProtected}
        data-kept-awake={keptAwakeAttribute(tab.keptAwake)}
        data-preview-move={tab.previewMove ?? undefined}
        onClick={onActivate}
        onKeyDown={onKeyDown}
        // Right-click, the Menu key or Shift+F10: main shows the tab's native menu (pin, duplicate,
        // close, reopen), which is also how the keyboard reaches those actions.
        onContextMenu={(event) => {
          event.preventDefault();
          const point = tabMenuPoint(
            event.currentTarget.getBoundingClientRect(),
            event.clientX,
            event.clientY,
          );
          void showTabMenu(tab.id, point.x, point.y);
        }}
        {...dragBindings}
        className={cn(
          'relative flex h-9 w-full cursor-default items-center gap-2 rounded-lg px-2.5 text-sm select-none',
          FOCUS_RING,
          selected
            ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full before:bg-sidebar-primary'
            : 'text-sidebar-foreground group-hover/row:bg-sidebar-accent/60',
          LABEL_MAKES_ROOM,
          dragging && 'opacity-50',
        )}
      >
        <TabIcon tab={tab} status={status} />
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        {tab.userProtected ? (
          <ShieldCheck
            role="img"
            aria-label={PROTECTED_TEXT}
            data-protected-icon=""
            className="size-3.5 shrink-0 text-sidebar-foreground/70"
          />
        ) : null}
        {tab.previewMove === null ? null : <PreviewMarker move={tab.previewMove} />}
      </div>
      {descriptions.map(({ id, text }) => (
        <span key={id} id={id} hidden>
          {text}
        </span>
      ))}

      {/* Mouse affordances, out of the tab order and hidden from assistive technology: the
          tablist may only own tabs. The keyboard closes a tab with Delete, and pins it from the
          tab's context menu (the Menu key or Shift+F10). */}
      <div
        aria-hidden="true"
        className="absolute inset-y-0 right-1 flex items-center gap-0.5 opacity-0 group-hover/row:opacity-100 group-has-[[aria-selected=true]]/row:opacity-100"
      >
        <RowButton
          label={tab.pinned ? 'Unpin tab' : 'Pin tab'}
          onClick={() => {
            void setTabPinned(tab.id, !tab.pinned);
          }}
        >
          {tab.pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
        </RowButton>
        <RowButton
          label="Close tab"
          onClick={() => {
            void closeTab(tab.id);
          }}
        >
          <X aria-hidden="true" />
        </RowButton>
      </div>

      {dropEdge === 'after' ? <DropLine edge="bottom" /> : null}
    </div>
  );
}

function RowButton({
  label,
  onClick,
  children,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      tabIndex={-1}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn('text-sidebar-foreground/80 hover:bg-sidebar-border', FOCUS_RING)}
    >
      {children}
    </Button>
  );
}

function DropLine({ edge }: { readonly edge: 'top' | 'bottom' }) {
  return (
    <div
      aria-hidden="true"
      data-drop-indicator={edge}
      className={cn(
        'pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-sidebar-primary',
        edge === 'top' ? '-top-px' : '-bottom-px',
      )}
    />
  );
}
