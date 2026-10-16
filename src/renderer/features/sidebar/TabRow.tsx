import { Pin, PinOff, X } from 'lucide-react';
import type { KeyboardEvent, ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { FOCUS_RING } from '@/lib/focus';
import { cn } from '@/lib/utils';

import type { TabSnapshot } from '../../../shared/contracts/schemas';
import { closeTab, setTabPinned } from '../../state/commands';
import { CONTENT_AREA_ID, tabDomId } from '../layout/ids';
import { TabIcon } from './TabIcon';
import { TAB_STATUS_TEXT, tabLabel, tabStatus } from './tab-display';
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
  // What a screen reader hears after the label. The text sits in `hidden` elements: a description
  // may point at them, and they stay out of the tablist, which may only own tabs.
  const descriptions = [
    ...(tab.pinned ? [{ id: `${domId}-pinned`, text: 'Pinned' }] : []),
    ...(status === null ? [] : [{ id: `${domId}-status`, text: TAB_STATUS_TEXT[status] }]),
  ];

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
        title={label}
        data-tab-id={tab.id}
        data-pinned={tab.pinned}
        data-selected={selected}
        onClick={onActivate}
        onKeyDown={onKeyDown}
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
      </div>
      {descriptions.map(({ id, text }) => (
        <span key={id} id={id} hidden>
          {text}
        </span>
      ))}

      {/* Mouse affordances, out of the tab order and hidden from assistive technology: the
          tablist may only own tabs. The keyboard closes a tab with Delete; pinning by keyboard
          comes with the tab context menu in M1.3b. */}
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
