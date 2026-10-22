import { ShieldCheck } from 'lucide-react';
import { memo } from 'react';

import { FOCUS_RING } from '@/lib/focus';
import { cn } from '@/lib/utils';

import { showTabMenu } from '../../state/commands';
import { PreviewMarker } from './PreviewMarker';
import { RowIcon } from './RowIcon';
import { useRowActivate } from './RowList';
import { PROTECTED_TEXT, tabMenuPoint } from './tab-display';
import type { MovedBy, PreviewMove } from './tab-display';

/**
 * Both kinds of row are memoized on primitives, and all the words come from the display modules:
 * a list of hundreds is drawn again at every snapshot, and a row whose words did not change costs
 * nothing then.
 */
interface RowProps {
  readonly id: string;
  readonly label: string;
  readonly favicon: string | null;
  /** The page stopped working. */
  readonly alert: boolean;
  /** The native tooltip: the label, then the lines that explain the row. */
  readonly tooltip: string;
  /** What a screen reader hears after the label. */
  readonly description: string;
  /** The one row in the page's tab order. */
  readonly tabStop: boolean;
}

const ROW_BUTTON =
  'flex w-full cursor-default items-center gap-2 rounded-lg px-2.5 text-left text-sm text-sidebar-foreground select-none hover:bg-sidebar-accent/60';

/** A click has detail 1 or more; Enter and Space on a button report 0, and so does assistive tech. */
function isKeyboardClick(event: { readonly detail: number }): boolean {
  return event.detail === 0;
}

export interface SleepingRowProps extends RowProps {
  /** The user protected the tab from automation: a shield shows. */
  readonly protectedTab: boolean;
  /** Why automation keeps the tab as it is, space-separated, for `data-kept-awake` (or undefined). */
  readonly keptAwake: string | undefined;
  /** Preview mode: what automation would do to the tab, which draws a small marker. */
  readonly previewMove: PreviewMove | null;
  /** Who moved the tab to Sleeping, when it is known. */
  readonly movedBy: MovedBy | null;
  /** How low memory was when it unloaded the page; null for any other way a page is unloaded. */
  readonly unloadPressure: 'moderate' | 'critical' | null;
}

/**
 * A Sleeping tab: icon and title. A click, Enter or Space brings it back to Tabs; the context menu
 * (right-click, the Menu key, Shift+F10) is main's native menu for a Sleeping tab. Not a `tab`
 * role: it belongs to no tablist, and nothing selects it.
 */
export const SleepingRow = memo(function SleepingRow({
  id,
  label,
  favicon,
  alert,
  tooltip,
  description,
  protectedTab,
  keptAwake,
  previewMove,
  movedBy,
  unloadPressure,
  tabStop,
}: SleepingRowProps) {
  const onActivate = useRowActivate();
  const descriptionId = `sleeping-description-${id}`;
  return (
    <li data-sleeping-row={id}>
      <button
        type="button"
        data-row-button=""
        data-row-id={id}
        data-sleeping-tab={id}
        data-user-protected={protectedTab}
        data-kept-awake={keptAwake}
        data-preview-move={previewMove ?? undefined}
        data-moved-by={movedBy ?? undefined}
        data-unload-pressure={unloadPressure ?? undefined}
        title={tooltip}
        aria-describedby={descriptionId}
        tabIndex={tabStop ? 0 : -1}
        onClick={(event) => {
          onActivate(id, isKeyboardClick(event));
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          const point = tabMenuPoint(
            event.currentTarget.getBoundingClientRect(),
            event.clientX,
            event.clientY,
          );
          void showTabMenu(id, point.x, point.y);
        }}
        className={cn(ROW_BUTTON, 'h-9', FOCUS_RING)}
      >
        <RowIcon favicon={favicon} alert={alert} />
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        {protectedTab ? (
          <ShieldCheck
            role="img"
            aria-label={PROTECTED_TEXT}
            data-protected-icon=""
            className="size-3.5 shrink-0 text-sidebar-foreground/70"
          />
        ) : null}
        {previewMove === null ? null : <PreviewMarker move={previewMove} />}
      </button>
      <span id={descriptionId} hidden>
        {description}
      </span>
    </li>
  );
});

export interface ArchivedRowProps extends RowProps {
  /** "2 h ago · by automation". */
  readonly meta: string;
  /**
   * In the Archive's virtual list (M4.2): the row's place among `setSize` rows, `top` pixels from
   * the top of the list, `height` tall. Rows then hold a position, not a place in the flow, and
   * a row with no data yet (`loading`) is a placeholder that does nothing when pressed. All
   * primitives, so the memoized row is drawn again only when its own words change.
   */
  readonly index?: number;
  readonly setSize?: number;
  readonly top?: number;
  readonly height?: number;
  readonly loading?: boolean;
}

/**
 * An archived tab: icon and title, and under them when it was archived and by whom. A click, Enter
 * or Space brings it back to Tabs (it may come back under a new id). No context menu: the only
 * thing to do with an archived tab is to restore it.
 *
 * In the virtual list the same element serves a placeholder and the row that replaces it, so a
 * placeholder that has keyboard focus keeps it when its tab arrives.
 */
export const ArchivedRow = memo(function ArchivedRow({
  id,
  label,
  favicon,
  alert,
  tooltip,
  description,
  meta,
  tabStop,
  index,
  setSize,
  top,
  height,
  loading = false,
}: ArchivedRowProps) {
  const onActivate = useRowActivate();
  const descriptionId = `archived-description-${id}`;
  return (
    <li
      data-archived-row={loading ? undefined : id}
      data-archived-loading={loading ? '' : undefined}
      aria-posinset={index === undefined ? undefined : index + 1}
      aria-setsize={setSize}
      style={
        top === undefined ? undefined : { position: 'absolute', top, left: 0, right: 0, height }
      }
    >
      <button
        type="button"
        data-row-button=""
        data-row-id={id}
        data-row-index={index}
        data-archived-tab={loading ? undefined : id}
        title={tooltip === '' ? undefined : tooltip}
        aria-describedby={descriptionId}
        aria-disabled={loading ? true : undefined}
        tabIndex={tabStop ? 0 : -1}
        onClick={(event) => {
          if (!loading) {
            onActivate(id, isKeyboardClick(event));
          }
        }}
        className={cn(
          ROW_BUTTON,
          height === undefined ? 'min-h-9 py-1' : 'h-full py-1',
          FOCUS_RING,
        )}
      >
        <RowIcon favicon={favicon} alert={alert} />
        <span className="min-w-0 flex-1 text-left">
          <span className="block truncate">{label}</span>
          <span data-archived-meta="" className="block truncate text-xs text-sidebar-foreground/70">
            {meta}
          </span>
        </span>
      </button>
      <span id={descriptionId} hidden>
        {description}
      </span>
    </li>
  );
});
