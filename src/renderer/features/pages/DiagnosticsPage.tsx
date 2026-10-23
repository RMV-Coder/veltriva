import { RefreshCw } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { FOCUS_RING } from '@/lib/focus';
import { cn } from '@/lib/utils';

import { exportDiagnostics, fetchDiagnostics, openLogFolder } from '../../state/commands';
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

      <Section
        title="Memory per tab"
        note="Each loaded tab's renderer, as Windows counts its private memory. Chromium may put a site's tabs in one renderer: they then share the number."
      >
        <TabMemoryTable tabs={view.tabs} />
        <Fields>
          <Field
            name="Veltriva itself (browser process)"
            field="browser-memory"
            value={view.browserMemory}
          />
          <Field name="Graphics (GPU process)" field="gpu-memory" value={view.gpuMemory} />
          <Field name="Other processes" field="other-memory" value={view.otherMemory} />
        </Fields>
      </Section>

      <div className="grid gap-6 sm:grid-cols-2">
        <Section title="Automation" note="From the activity log, which keeps the last 500 actions.">
          <Fields>
            <Field name="Last 24 hours" field="automation-day" value={view.automationLastDay} />
            <Field name="In the log" field="automation-kept" value={view.automationKept} />
          </Fields>
        </Section>

        <Section title="Memory pressure" note="Each change of level since Veltriva started.">
          {view.pressureHistory.length === 0 ? (
            <p data-diagnostics-field="pressure-history" className="text-sm font-medium">
              No change yet
            </p>
          ) : (
            <ul
              data-diagnostics-field="pressure-history"
              className="flex max-w-md flex-col gap-0.5 text-sm"
            >
              {view.pressureHistory.map((change, index) => (
                // Changes have no id; the list is newest first and only ever replaced as a whole.
                <li key={index} className="flex justify-between gap-4">
                  <span className="text-foreground/70 tabular-nums">{change.time}</span>
                  <span className="font-medium">{change.level}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <Section title="Database">
          {view.database === null ? (
            <p data-diagnostics-field="database" className="text-sm">
              Not open: Veltriva is running without its database.
            </p>
          ) : (
            <Fields>
              <Field name="Size" field="database-size" value={view.database.size} />
              <Field name="Write-ahead log" field="database-log" value={view.database.log} />
              <Field name="Last backup" field="database-backup" value={view.database.lastBackup} />
              <Field name="Last check" field="database-check" value={view.database.check} />
            </Fields>
          )}
        </Section>

        <Section
          title="Log"
          note="Errors and warnings, by tab and code. Page addresses only while diagnostic logging is on in Settings."
        >
          <Fields>
            <Field name="Diagnostic logging" field="logging" value={view.logging} />
          </Fields>
          <p
            data-diagnostics-field="log-file"
            className="max-w-md truncate text-xs text-foreground/70"
            title={view.logFile}
          >
            <bdi dir="ltr">{view.logFile}</bdi>
          </p>
          <Button
            variant="outline"
            size="sm"
            data-diagnostics-open-log=""
            onClick={() => void openLogFolder()}
            className={cn('w-fit', FOCUS_RING)}
          >
            Show the log folder
          </Button>
        </Section>
      </div>

      <ExportSection />
    </>
  );
}

function TabMemoryTable({ tabs }: { readonly tabs: DiagnosticsView['tabs'] }) {
  if (tabs.length === 0) {
    return (
      <p data-diagnostics-message="no-tabs" className="text-sm text-foreground/70">
        No tabs.
      </p>
    );
  }
  return (
    <div
      role="region"
      aria-label="Memory per tab"
      tabIndex={0}
      className={cn('max-h-96 overflow-auto rounded-xl border bg-card', FOCUS_RING)}
    >
      <table data-diagnostics-tabs="" className="w-full min-w-xl text-left text-sm">
        <thead className="sticky top-0 bg-card text-xs text-foreground/70">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Tab
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Where
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              State
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Memory
            </th>
          </tr>
        </thead>
        <tbody>
          {tabs.map((row) => (
            <tr key={row.tabId} data-tab-memory={row.tabId} className="border-t">
              <th scope="row" className="max-w-64 truncate px-3 py-2 font-medium" title={row.title}>
                <bdi>{row.title}</bdi>
              </th>
              <td className="px-3 py-2">{row.where}</td>
              <td className="px-3 py-2">{row.state}</td>
              <td
                data-tab-memory-field="memory"
                className="px-3 py-2 text-right whitespace-nowrap tabular-nums"
                title={row.shared ?? undefined}
              >
                {row.memory}
                {row.shared === null ? null : <span className="sr-only">, {row.shared}</span>}
                {row.shared === null ? null : (
                  <span aria-hidden="true" className="ml-1 text-foreground/60">
                    *
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** "Export diagnostics": a JSON file to attach to a report. No addresses unless asked. */
function ExportSection() {
  const [addresses, setAddresses] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const noteId = useId();
  return (
    <Section
      title="Export"
      note="Saves what this page shows as a JSON file, to attach to a problem report. It never holds a page's title."
    >
      <label className="flex max-w-xl items-start gap-3 text-sm">
        <input
          type="checkbox"
          data-diagnostics-include-addresses=""
          checked={addresses}
          aria-describedby={noteId}
          onChange={(event) => {
            setAddresses(event.target.checked);
          }}
          className={cn('mt-0.5 size-4 shrink-0 accent-foreground', FOCUS_RING)}
        />
        <span className="flex flex-col gap-0.5">
          <span className="font-medium">Include the addresses of open tabs</span>
          <span id={noteId} className="text-foreground/70">
            Off, the file holds no address of a page you visited.
          </span>
        </span>
      </label>
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          data-diagnostics-export=""
          aria-disabled={busy}
          onClick={() => {
            if (busy) {
              return;
            }
            setBusy(true);
            setOutcome(null);
            void exportDiagnostics(addresses).then((saved) => {
              setBusy(false);
              setOutcome(
                saved === undefined
                  ? 'The file could not be saved.'
                  : saved
                    ? 'Saved.'
                    : 'Not saved.',
              );
            });
          }}
          className={cn('w-fit', FOCUS_RING)}
        >
          Export diagnostics…
        </Button>
        <p role="status" data-diagnostics-exported="" className="text-sm">
          {outcome}
        </p>
      </div>
    </Section>
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
