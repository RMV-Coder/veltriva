import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode, SubmitEvent } from 'react';

import { Button } from '@/components/ui/button';
import { FOCUS_RING } from '@/lib/focus';
import { cn } from '@/lib/utils';

import { changePermission, clearData, fetchPermissions, forgetSite } from '../../state/commands';
import type { PermissionsView } from '../../state/commands';
import {
  ALL_TIME_NOTE,
  CLEAR_RANGE_LABELS,
  CLEAR_RANGE_ORDER,
  clearedText,
  groupByOrigin,
  hintsText,
  originText,
  PERMISSION_LABELS,
  SITE_DATA_NOTE,
} from './privacy-display';
import type { ClearRange, OriginGroup } from './privacy-display';
import { SITE_REFUSED } from './settings-display';

const CHECKBOX = cn('mt-0.5 size-4 shrink-0 accent-foreground', FOCUS_RING);
const TEXT_FIELD = cn(
  'h-9 min-w-0 rounded-md border border-foreground/30 bg-card px-3 text-sm',
  'aria-invalid:border-red-600 dark:aria-invalid:border-red-400',
  FOCUS_RING,
);
const ERROR_TEXT = 'text-sm text-red-700 dark:text-red-400';

/** A checkbox with its label and, below it, what it does. */
function Box({
  setting,
  label,
  note,
  checked,
  onChange,
}: {
  readonly setting: string;
  readonly label: string;
  readonly note?: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  const noteId = useId();
  return (
    <label className="flex max-w-xl items-start gap-3 text-sm">
      <input
        type="checkbox"
        data-setting={setting}
        checked={checked}
        aria-describedby={note === undefined ? undefined : noteId}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
        className={CHECKBOX}
      />
      <span className="flex flex-col gap-0.5">
        <span className="font-medium">{label}</span>
        {note === undefined ? null : (
          <span id={noteId} className="text-foreground/70">
            {note}
          </span>
        )}
      </span>
    </label>
  );
}

/**
 * An action that can't be undone asks once more, in the page: the question, then "Clear" and
 * "Cancel". The keyboard lands on the question's button, so nothing is cleared by a stray Enter.
 */
function Confirm({
  question,
  action,
  busy,
  onConfirm,
  onCancel,
}: {
  readonly question: ReactNode;
  readonly action: string;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const questionId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);
  return (
    <div
      role="group"
      aria-labelledby={questionId}
      data-settings-confirm=""
      className="flex max-w-xl flex-col gap-3 rounded-lg border border-red-600/40 p-3 dark:border-red-400/40"
    >
      <p id={questionId} className="text-sm">
        {question} This can't be undone.
      </p>
      <div className="flex gap-2">
        <Button
          ref={confirmRef}
          variant="destructive"
          data-settings-confirm-yes=""
          aria-disabled={busy}
          onClick={() => {
            if (!busy) {
              onConfirm();
            }
          }}
          className={FOCUS_RING}
        >
          {action}
        </Button>
        <Button variant="outline" onClick={onCancel} className={FOCUS_RING}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ── Clear data ───────────────────────────────────────────────────────────────────────────────────

/** Clearing data (§5.7): a time range, or forgetting one site. */
export function ClearDataSection({ children }: { readonly children?: ReactNode }) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-settings-section="clear-data"
      className="flex flex-col gap-5"
    >
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-lg font-semibold">
          Clear data
        </h2>
        <p className="text-sm text-foreground/70">
          Deleted for good: the database is rewritten so the words are gone from the file, not just
          hidden. Open and Sleeping tabs stay.
        </p>
      </div>
      <ClearRangeForm />
      <ForgetSiteForm />
      {children}
    </section>
  );
}

function ClearRangeForm() {
  const [range, setRange] = useState<ClearRange>('hour');
  const [memory, setMemory] = useState(true);
  const [tabs, setTabs] = useState(false);
  const [siteData, setSiteData] = useState(false);
  const [cache, setCache] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const legendId = useId();
  const nothing = !memory && !tabs && !siteData && !cache;

  const run = async (): Promise<void> => {
    setBusy(true);
    const result = await clearData({ range, memory, tabs, siteData, cache });
    setBusy(false);
    setAsking(false);
    if (result === undefined) {
      setOutcome('The data could not be cleared.');
      return;
    }
    // Say what was done: the memory's counts only when the memory was asked about.
    setOutcome(
      [
        memory || tabs ? clearedText(result) : null,
        siteData ? 'Cookies and site data are cleared.' : null,
        cache ? 'Cached files are cleared.' : null,
      ]
        .filter((part) => part !== null)
        .join(' '),
    );
  };

  return (
    <div data-settings-clear="" className="flex flex-col gap-3">
      <fieldset aria-labelledby={legendId} className="flex flex-col gap-2">
        <legend id={legendId} className="mb-1 text-sm font-medium">
          Clear what was recorded in
        </legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {CLEAR_RANGE_ORDER.map((option) => (
            <label key={option} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="clear-range"
                data-setting="clear-range"
                value={option}
                checked={range === option}
                onChange={() => {
                  setRange(option);
                  setOutcome(null);
                }}
                className={CHECKBOX}
              />
              {CLEAR_RANGE_LABELS[option]}
            </label>
          ))}
        </div>
      </fieldset>
      <Box
        setting="clear-memory"
        label="Pages you visited"
        note="The memory: visits in the range, and the pages they leave with none."
        checked={memory}
        onChange={setMemory}
      />
      <Box
        setting="clear-tabs"
        label="Archived and recently closed tabs"
        note="Those archived or closed in the range."
        checked={tabs}
        onChange={setTabs}
      />
      <Box
        setting="clear-site-data"
        label="Cookies and site data"
        note={`Signs you out of sites. ${ALL_TIME_NOTE}`}
        checked={siteData}
        onChange={setSiteData}
      />
      <Box
        setting="clear-cache"
        label="Cached images and files"
        note={ALL_TIME_NOTE}
        checked={cache}
        onChange={setCache}
      />
      {asking ? (
        <Confirm
          question={`Clear what you chose from ${CLEAR_RANGE_LABELS[range].toLowerCase()}?`}
          action="Clear"
          busy={busy}
          onConfirm={() => void run()}
          onCancel={() => {
            setAsking(false);
          }}
        />
      ) : (
        <Button
          variant="outline"
          data-setting="clear"
          aria-disabled={nothing}
          title={nothing ? 'Choose what to clear first' : undefined}
          onClick={() => {
            if (!nothing) {
              setOutcome(null);
              setAsking(true);
            }
          }}
          className={cn('w-fit', FOCUS_RING, nothing && 'opacity-60')}
        >
          Clear…
        </Button>
      )}
      <p role="status" data-settings-cleared="" className="text-sm">
        {outcome}
      </p>
    </div>
  );
}

function ForgetSiteForm() {
  const [site, setSite] = useState('');
  const [siteData, setSiteData] = useState(true);
  const [permissions, setPermissions] = useState(true);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const fieldId = useId();
  const problemId = useId();

  const run = async (): Promise<void> => {
    setBusy(true);
    const answer = await forgetSite(site, { siteData, permissions });
    setBusy(false);
    setAsking(false);
    if (answer.ok) {
      setOutcome(
        [
          `Forgot ${answer.value.site}. ${clearedText(answer.value)}`,
          siteData ? 'Its cookies, storage and cached files are cleared.' : null,
          permissions ? 'Its permissions are removed.' : null,
        ]
          .filter((part) => part !== null)
          .join(' '),
      );
      setSite('');
    } else {
      setProblem(answer.invalid ? SITE_REFUSED : 'The site could not be forgotten.');
    }
  };

  return (
    <form
      data-settings-forget-site=""
      className="flex flex-col gap-3"
      onSubmit={(event: SubmitEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (site.trim() === '') {
          setProblem('Enter a site, such as example.com.');
          return;
        }
        setProblem(null);
        setOutcome(null);
        setAsking(true);
      }}
    >
      <label htmlFor={fieldId} className="text-sm font-medium">
        Forget a site
      </label>
      <input
        id={fieldId}
        type="text"
        data-setting="forget-site"
        spellCheck={false}
        autoComplete="off"
        maxLength={2048}
        placeholder="example.com"
        value={site}
        aria-invalid={problem !== null}
        aria-describedby={problemId}
        onChange={(event) => {
          setSite(event.target.value);
          setAsking(false);
        }}
        className={cn(TEXT_FIELD, 'w-64')}
      />
      <p className="max-w-xl text-sm text-foreground/70">
        Every page and visit of the site, and its archived and recently closed tabs, wherever they
        are in time.
      </p>
      <Box
        setting="forget-site-data"
        label="Its cookies, storage and cached files"
        note={SITE_DATA_NOTE}
        checked={siteData}
        onChange={setSiteData}
      />
      <Box
        setting="forget-site-permissions"
        label="Its permissions"
        note="What you allowed or blocked, the apps its links open, and the browser details it asked for."
        checked={permissions}
        onChange={setPermissions}
      />
      {asking ? (
        <Confirm
          question={`Forget ${site.trim()}?`}
          action="Forget"
          busy={busy}
          onConfirm={() => void run()}
          onCancel={() => {
            setAsking(false);
          }}
        />
      ) : (
        <Button
          type="submit"
          variant="outline"
          data-setting="forget"
          className={cn('w-fit', FOCUS_RING)}
        >
          Forget…
        </Button>
      )}
      <p id={problemId} data-settings-error="forget-site" aria-live="polite" className={ERROR_TEXT}>
        {problem}
      </p>
      <p role="status" data-settings-forgotten="" className="text-sm">
        {outcome}
      </p>
    </form>
  );
}

// ── Site permissions ─────────────────────────────────────────────────────────────────────────────

/** What sites were allowed or refused, and the apps and details they were given (§7.2, M5.2). */
export function SitePermissionsSection() {
  const [view, setView] = useState<PermissionsView | null | 'failed'>(null);
  const headingId = useId();

  useEffect(() => {
    let current = true;
    void fetchPermissions().then((data) => {
      if (current) {
        setView(data ?? 'failed');
      }
    });
    return () => {
      current = false;
    };
  }, []);

  const change = async (request: Parameters<typeof changePermission>[0]): Promise<void> => {
    const next = await changePermission(request);
    if (next !== undefined) {
      setView(next);
    }
  };

  const groups = view === null || view === 'failed' ? [] : groupByOrigin(view);
  return (
    <section
      aria-labelledby={headingId}
      data-settings-section="permissions"
      className="flex flex-col gap-3"
    >
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-lg font-semibold">
          Site permissions
        </h2>
        <p className="text-sm text-foreground/70">
          What you answered when a site asked. Change an answer, or remove it so the site asks
          again.
        </p>
      </div>
      {view === null ? (
        <p className="text-sm text-foreground/70">Loading…</p>
      ) : view === 'failed' ? (
        <p className="text-sm">The permissions could not be read.</p>
      ) : groups.length === 0 ? (
        <p data-settings-message="no-permissions" className="text-sm text-foreground/70">
          No site has a stored answer.
        </p>
      ) : (
        <ul data-settings-permissions="" className="flex flex-col gap-3">
          {groups.map((group) => (
            <OriginAnswers key={group.origin} group={group} onChange={change} />
          ))}
        </ul>
      )}
    </section>
  );
}

function OriginAnswers({
  group,
  onChange,
}: {
  readonly group: OriginGroup;
  readonly onChange: (request: Parameters<typeof changePermission>[0]) => Promise<void>;
}) {
  const name = originText(group.origin);
  const nameId = useId();
  return (
    <li
      aria-labelledby={nameId}
      data-permission-origin={group.origin}
      className="flex flex-col gap-1 rounded-xl border bg-card p-3"
    >
      <h3 id={nameId} className="truncate text-sm font-semibold">
        <bdi dir="ltr">{name}</bdi>
      </h3>
      {group.decisions.map(({ permission, decision }) => (
        <div
          key={permission}
          data-permission={permission}
          className="flex flex-wrap items-center justify-between gap-2 text-sm"
        >
          <span>{PERMISSION_LABELS[permission]}</span>
          <span className="flex items-center gap-2">
            <select
              aria-label={`${PERMISSION_LABELS[permission]} for ${name}`}
              data-permission-decision=""
              value={decision}
              onChange={(event) => {
                void onChange({
                  kind: 'decision',
                  origin: group.origin,
                  permission,
                  decision: event.target.value === 'block' ? 'block' : 'allow',
                });
              }}
              className={cn('h-8 rounded-md border border-foreground/30 bg-card px-2', FOCUS_RING)}
            >
              <option value="allow">Allowed</option>
              <option value="block">Blocked</option>
            </select>
            <RemoveButton
              label={`Remove the answer for ${PERMISSION_LABELS[permission]} on ${name}`}
              onClick={() =>
                onChange({ kind: 'decision', origin: group.origin, permission, decision: null })
              }
            />
          </span>
        </div>
      ))}
      {group.protocols.map((scheme) => (
        <div
          key={scheme}
          data-permission-protocol={scheme}
          className="flex flex-wrap items-center justify-between gap-2 text-sm"
        >
          <span>
            Opens <code className="text-xs">{scheme}:</code> links without asking
          </span>
          <RemoveButton
            label={`Ask again before ${name} opens ${scheme}: links`}
            onClick={() => onChange({ kind: 'protocol', origin: group.origin, scheme })}
          />
        </div>
      ))}
      {group.hints.length === 0 ? null : (
        <div
          data-permission-hints=""
          className="flex flex-wrap items-center justify-between gap-2 text-sm"
        >
          <span>{hintsText(group.hints)}</span>
          <RemoveButton
            label={`Stop sending ${name} more about your browser`}
            onClick={() => onChange({ kind: 'clientHints', origin: group.origin })}
          />
        </div>
      )}
    </li>
  );
}

function RemoveButton({
  label,
  onClick,
}: {
  readonly label: string;
  readonly onClick: () => Promise<void>;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={label}
      data-permission-remove=""
      onClick={() => void onClick()}
      className={FOCUS_RING}
    >
      Remove
    </Button>
  );
}
