import { RefreshCw } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { FOCUS_RING } from '@/lib/focus';
import { cn } from '@/lib/utils';

import { fetchDiagnostics } from '../../state/commands';
import { diagnosticsView, updatedText } from './diagnostics-display';
import type { Diagnostics, DiagnosticsView, MetricView } from './diagnostics-display';

type DiagnosticsState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | {
      readonly kind: 'ready';
      readonly data: Diagnostics;
      /** When it was read: the times in the page are read against it. */
      readonly at: number;
      /** The last refresh failed, so this is an older reading. */
      readonly stale: boolean;
    };

/**
 * The local diagnostics page (`veltriva://diagnostics`, assessment §4.13): the regret metric that
 * tunes the defaults while dogfooding, and what automation sees. It is the shell's own page, drawn
 * in the content area like the new-tab page (ADR-0006: nothing is drawn over a web page). It asks
 * main for the numbers when it opens and when the user presses Refresh; an old answer that arrives
 * after a newer one is dropped, and a refresh that fails leaves the last reading on screen. The
 * numbers never leave this machine, and the page says so.
 */
export function DiagnosticsPage() {
  const [state, setState] = useState<DiagnosticsState>({ kind: 'loading' });
  const [refreshing, setRefreshing] = useState(true);
  const [reading, setReading] = useState(0);

  useEffect(() => {
    let current = true;
    void fetchDiagnostics().then((data) => {
      if (!current) {
        return;
      }
      setRefreshing(false);
      if (data !== undefined) {
        setState({ kind: 'ready', data, at: Date.now(), stale: false });
      } else {
        // Keep what is on screen when only a refresh failed.
        setState((previous) =>
          previous.kind === 'ready' ? { ...previous, stale: true } : { kind: 'failed' },
        );
      }
    });
    return () => {
      current = false;
    };
  }, [reading]);

  const refresh = (): void => {
    if (!refreshing) {
      setRefreshing(true);
      setReading((value) => value + 1);
    }
  };

  return (
    <div
      data-internal-page="diagnostics"
      data-diagnostics-state={state.kind}
      aria-busy={refreshing}
      className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-6 px-6 py-8"
    >
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-64">
          <h1 className="text-2xl font-semibold tracking-tight">Automation diagnostics</h1>
          <p data-diagnostics-privacy="" className="mt-1 text-sm text-foreground/70">
            Measured on this device, to tune how automation behaves. None of it ever leaves this
            machine: there is no telemetry.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {state.kind === 'ready' ? (
            <p
              role="status"
              data-diagnostics-updated=""
              className="text-sm text-foreground/70 tabular-nums"
            >
              {updatedText(state.at, state.at)}
              {state.stale ? ' (the last refresh failed)' : ''}
            </p>
          ) : null}
          <Button
            variant="outline"
            data-diagnostics-refresh=""
            aria-disabled={refreshing}
            onClick={refresh}
            className={cn(FOCUS_RING, refreshing && 'opacity-60')}
          >
            <RefreshCw
              data-icon="inline-start"
              aria-hidden="true"
              className={refreshing ? 'animate-spin motion-reduce:animate-none' : undefined}
            />
            Refresh
          </Button>
        </div>
      </header>

      <DiagnosticsBody state={state} onRetry={refresh} />
    </div>
  );
}

function DiagnosticsBody({
  state,
  onRetry,
}: {
  readonly state: DiagnosticsState;
  readonly onRetry: () => void;
}) {
  if (state.kind === 'loading') {
    return (
      <p data-diagnostics-message="loading" className="text-sm text-foreground/70">
        Loading…
      </p>
    );
  }
  if (state.kind === 'failed') {
    return (
      <div data-diagnostics-message="failed" className="flex flex-col items-start gap-2 text-sm">
        <p>The diagnostics could not be read.</p>
        <Button variant="outline" size="sm" onClick={onRetry} className={FOCUS_RING}>
          Try again
        </Button>
      </div>
    );
  }
  return <DiagnosticsSections view={diagnosticsView(state.data, state.at)} />;
}

function DiagnosticsSections({ view }: { readonly view: DiagnosticsView }) {
  return (
    <>
      <Section
        title="Regret"
        note={
          <>
            A regret is a tab you brought back, undid or reloaded within one engaged hour of
            automation moving or unloading it. Engaged time only runs while you use Veltriva.
            {view.since === null ? null : (
              <>
                {' '}
                <span data-diagnostics-field="since">{view.since}</span>.
              </>
            )}
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Metric
            kind="moves"
            title="Moves to Sleeping or the Archive"
            totalLabel="Moved by automation"
            regretsLabel="Brought back within an engaged hour"
            emptyRate="No moves yet"
            metric={view.moves}
          />
          <Metric
            kind="unloads"
            title="Unloads"
            totalLabel="Unloaded by automation"
            regretsLabel="Reloaded within an engaged hour"
            emptyRate="No unloads yet"
            metric={view.unloads}
          />
        </div>
      </Section>

      <Section
        title="Recent regret events"
        note="Newest first; the last 200 are kept. “After” is the engaged time between what automation did and what you did."
      >
        <EventsTable events={view.events} />
      </Section>

      <div className="grid gap-6 sm:grid-cols-2">
        <Section title="Engagement">
          <Fields>
            <Field name="Active day" field="active-day" value={view.activeDay} />
            <Field name="Engaged time" field="engaged" value={view.engaged} />
          </Fields>
        </Section>

        <Section title="Memory">
          <Fields>
            <Field name="Pressure" field="pressure" value={view.pressure} />
            <Field name="Available" field="memory" value={view.memory} />
          </Fields>
        </Section>
      </div>

      <Section title="Settings">
        <Fields>
          <Field name="Preset" field="preset" value={view.preset} />
          <Field name="Automation" field="automation" value={view.automation} />
          <Field name="Preview mode" field="preview" value={view.preview} />
        </Fields>
        <ProtectedSites sites={view.protectedSites} />
      </Section>
    </>
  );
}

function Section({
  title,
  note,
  children,
}: {
  readonly title: string;
  readonly note?: ReactNode;
  readonly children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h2 id={headingId} className="text-base font-semibold">
        {title}
      </h2>
      {note === undefined ? null : <p className="text-sm text-foreground/70">{note}</p>}
      {children}
    </section>
  );
}

function Metric({
  kind,
  title,
  totalLabel,
  regretsLabel,
  emptyRate,
  metric,
}: {
  readonly kind: 'moves' | 'unloads';
  readonly title: string;
  readonly totalLabel: string;
  readonly regretsLabel: string;
  /** What the rate says before there is anything to take a share of. */
  readonly emptyRate: string;
  readonly metric: MetricView;
}) {
  const titleId = useId();
  return (
    <div
      role="group"
      aria-labelledby={titleId}
      data-diagnostics-metric={kind}
      className="flex flex-col gap-2 rounded-xl border bg-card p-4 text-card-foreground"
    >
      <h3 id={titleId} className="text-sm font-medium">
        {title}
      </h3>
      <p className="flex items-baseline gap-2">
        <span
          data-diagnostics-field={`${kind}-rate`}
          // The dash stands for "no rate yet", which the words beside it say.
          aria-hidden={metric.rate === null}
          className="text-3xl font-semibold tracking-tight tabular-nums"
        >
          {metric.rate ?? '—'}
        </span>
        <span className="text-sm text-foreground/70">
          {metric.rate === null ? emptyRate : 'regret rate'}
        </span>
      </p>
      <Fields>
        <Field name={totalLabel} field={`${kind}-total`} value={metric.total} />
        <Field name={regretsLabel} field={`${kind}-regrets`} value={metric.regrets} />
      </Fields>
    </div>
  );
}

function Fields({ children }: { readonly children: ReactNode }) {
  // A short line is easier to read across than a page-wide one, so a lone list stops at a width.
  return <dl className="flex max-w-md flex-col gap-1 text-sm">{children}</dl>;
}

function Field({
  name,
  field,
  value,
}: {
  readonly name: string;
  readonly field: string;
  readonly value: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-foreground/70">{name}</dt>
      <dd data-diagnostics-field={field} className="text-right font-medium tabular-nums">
        {value}
      </dd>
    </div>
  );
}

function EventsTable({ events }: { readonly events: DiagnosticsView['events'] }) {
  if (events.length === 0) {
    return (
      <p
        data-diagnostics-message="no-events"
        className="rounded-xl border bg-card p-4 text-sm text-foreground/70"
      >
        None yet. They are listed here when you bring a tab back soon after automation moved or
        unloaded it.
      </p>
    );
  }
  return (
    <div
      role="region"
      aria-label="Recent regret events"
      tabIndex={0}
      className={cn('max-h-96 overflow-auto rounded-xl border bg-card', FOCUS_RING)}
    >
      <table data-diagnostics-events="" className="w-full min-w-xl text-left text-sm">
        <thead className="sticky top-0 bg-card text-xs text-foreground/70">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              When
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Automation
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Because
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              You
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              After
            </th>
          </tr>
        </thead>
        <tbody>
          {events.map((row, index) => (
            // Events have no id; the list is newest first and only ever replaced as a whole.
            <tr key={index} data-regret-event="" className="border-t">
              <td title={row.timeFull} className="px-3 py-2 whitespace-nowrap tabular-nums">
                {row.time}
              </td>
              <td data-regret-field="action" className="px-3 py-2">
                {row.action}
              </td>
              <td data-regret-field="rule" className="px-3 py-2">
                {row.rule}
              </td>
              <td data-regret-field="how" className="px-3 py-2">
                {row.how}
              </td>
              <td data-regret-field="after" className="px-3 py-2 whitespace-nowrap tabular-nums">
                {row.after}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProtectedSites({ sites }: { readonly sites: readonly string[] }) {
  const headingId = useId();
  return (
    <div className="mt-2 flex max-w-md flex-col gap-1">
      <h3 id={headingId} className="text-sm text-foreground/70">
        Protected sites
      </h3>
      {sites.length === 0 ? (
        <p data-diagnostics-field="protected-sites" className="text-sm font-medium">
          None
        </p>
      ) : (
        <ul
          aria-labelledby={headingId}
          data-diagnostics-field="protected-sites"
          tabIndex={0}
          className={cn(
            'flex max-h-40 flex-col gap-0.5 overflow-auto rounded-xl border bg-card px-3 py-2 text-sm',
            FOCUS_RING,
          )}
        >
          {sites.map((site, index) => (
            <li key={`${site}-${String(index)}`} className="truncate">
              <bdi dir="ltr">{site}</bdi>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
