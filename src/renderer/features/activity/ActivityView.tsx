import { ArrowLeft } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { FOCUS_RING } from '@/lib/focus';
import { cn } from '@/lib/utils';

import type { ActivityEntry } from '../../../shared/contracts/activity';
import { fetchActivity } from '../../state/commands';
import { useUiStore } from '../../state/ui-store';
import { useWorkspaceStore } from '../../state/workspace-store';
import { ACTIVITY_BUTTON_ID, ACTIVITY_VIEW_ID } from '../layout/ids';
import { ROWS_PER_PAGE, rowWindow } from '../sidebar/placement-display';
import { activityRefreshKey, activityRowView } from './activity-display';

type ActivityState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | {
      readonly kind: 'ready';
      readonly entries: readonly ActivityEntry[];
      /** When they were fetched: the times read against it ("Yesterday 14:32"). */
      readonly at: number;
    };

/** Closes the view and gives keyboard focus back to the button that opened it. */
export function closeActivity(): void {
  useUiStore.getState().setActivityOpen(false);
  document.getElementById(ACTIVITY_BUTTON_ID)?.focus();
}

/**
 * The activity log (assessment §4.12): every automatic action, the rule that decided it in plain
 * words, and the user's undos, newest first. It takes the place of the open tabs and the sections
 * inside the sidebar, which are part of the chrome, so nothing is drawn over a page (ADR-0006).
 * Back, the Activity button and Escape (the sidebar handles it) close it and focus returns to the
 * button.
 *
 * It asks main for the log when it opens and again when the snapshot's counts, the Undo offer or
 * the number of unloaded tabs change while it is open (`activityRefreshKey`). An old answer that
 * arrives after a newer one is dropped. A page's title and address are untrusted text: they come
 * cleaned from ./activity-display.ts and are drawn in `<bdi dir="ltr">`.
 */
export function ActivityView() {
  const refreshKey = useWorkspaceStore((state) => activityRefreshKey(state.snapshot));
  const [state, setState] = useState<ActivityState>({ kind: 'loading' });
  const [retry, setRetry] = useState(0);
  const [limit, setLimit] = useState(ROWS_PER_PAGE);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let current = true;
    void fetchActivity().then((entries) => {
      if (!current) {
        return;
      }
      if (entries !== undefined) {
        setState({ kind: 'ready', entries, at: Date.now() });
      } else {
        // Keep what is on screen when only a refresh failed.
        setState((previous) => (previous.kind === 'ready' ? previous : { kind: 'failed' }));
      }
    });
    return () => {
      current = false;
    };
  }, [refreshKey, retry]);

  // The view opened because the user asked: keyboard focus goes to its heading.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <section
      id={ACTIVITY_VIEW_ID}
      aria-labelledby="activity-title"
      data-activity-view=""
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex shrink-0 items-center gap-1 px-2 pt-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back to tabs"
          title="Back to tabs"
          data-activity-back=""
          onClick={closeActivity}
          className={FOCUS_RING}
        >
          <ArrowLeft aria-hidden="true" />
        </Button>
        <h2
          id="activity-title"
          ref={headingRef}
          tabIndex={-1}
          className={cn('rounded-sm text-sm font-semibold', FOCUS_RING)}
        >
          Activity
        </h2>
      </div>
      <p className="shrink-0 px-3 pt-1 pb-1.5 text-xs text-sidebar-foreground/70">
        What Veltriva did on its own, newest first. Kept on this device.
      </p>
      <div
        role="region"
        aria-label="Activity log"
        tabIndex={0}
        className={cn('min-h-0 flex-1 overflow-y-auto px-2 pb-2', FOCUS_RING)}
      >
        <ActivityBody
          state={state}
          limit={limit}
          onShowMore={() => {
            setLimit((value) => value + ROWS_PER_PAGE);
          }}
          onRetry={() => {
            setState({ kind: 'loading' });
            setRetry((value) => value + 1);
          }}
        />
      </div>
    </section>
  );
}

function ActivityBody({
  state,
  limit,
  onShowMore,
  onRetry,
}: {
  readonly state: ActivityState;
  readonly limit: number;
  readonly onShowMore: () => void;
  readonly onRetry: () => void;
}) {
  if (state.kind === 'loading') {
    return (
      <p role="status" data-activity-state="loading" className="px-1 py-1 text-sm">
        Loading…
      </p>
    );
  }
  if (state.kind === 'failed') {
    return (
      <div data-activity-state="failed" className="flex flex-col items-start gap-2 px-1 py-1">
        <p className="text-sm">The activity log could not be loaded.</p>
        <Button variant="outline" size="sm" onClick={onRetry} className={FOCUS_RING}>
          Retry
        </Button>
      </div>
    );
  }
  if (state.entries.length === 0) {
    return (
      <p data-activity-state="empty" className="px-1 py-1 text-sm text-sidebar-foreground/80">
        Nothing yet. Automatic actions will be listed here.
      </p>
    );
  }

  const view = rowWindow(state.entries.length, limit);
  return (
    <>
      <ol data-activity-list="" className="flex flex-col">
        {state.entries.slice(0, view.shown).map((entry) => (
          <ActivityRow key={entry.id} entry={entry} now={state.at} />
        ))}
      </ol>
      {view.remaining > 0 ? (
        <Button
          variant="ghost"
          size="sm"
          aria-label="Show more activity"
          data-show-more="activity"
          onClick={onShowMore}
          className={cn('mt-1 w-full justify-start px-2.5 text-sidebar-foreground', FOCUS_RING)}
        >
          Show more
          <span className="text-sidebar-foreground/70" aria-hidden="true">
            {view.remaining} more
          </span>
        </Button>
      ) : null}
    </>
  );
}

function ActivityRow({ entry, now }: { readonly entry: ActivityEntry; readonly now: number }) {
  const row = activityRowView(entry, now);
  return (
    <li
      data-activity-entry={entry.id}
      data-activity-action={entry.action}
      data-activity-rule={entry.rule ?? undefined}
      className="border-b border-sidebar-border/60 px-1 py-1.5 last:border-b-0"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span data-activity-sentence="" className="min-w-0 text-sm font-medium">
          {row.sentence}
        </span>
        <span
          data-activity-time=""
          title={new Date(entry.at).toLocaleString()}
          className="shrink-0 text-xs tabular-nums text-sidebar-foreground/70"
        >
          {row.time}
        </span>
      </div>
      {/* The page's own words: cleaned in activity-display.ts and isolated here in <bdi>. */}
      <span className="block truncate text-sm">
        <bdi dir="ltr" title={row.title.full} data-activity-title="">
          {row.title.text}
        </bdi>
      </span>
      {row.address === null ? null : (
        <span className="block truncate text-xs text-sidebar-foreground/70">
          <bdi dir="ltr" title={row.address.full} data-activity-address="">
            {row.address.text}
          </bdi>
        </span>
      )}
    </li>
  );
}
