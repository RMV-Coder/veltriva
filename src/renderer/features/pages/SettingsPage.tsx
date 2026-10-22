import { RotateCcw } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import type { ReactNode, SubmitEvent } from 'react';

import { Button } from '@/components/ui/button';
import { FOCUS_RING } from '@/lib/focus';
import { cn } from '@/lib/utils';

import { fetchSettings, setSiteRule, updateSettings } from '../../state/commands';
import type { SettingsAnswer, SettingsChange, SettingsView } from '../../state/commands';
import { useAutomation } from '../../state/workspace-store';
import {
  defaultValue,
  effectiveValue,
  engineOf,
  FIELD_ORDER,
  FIELD_UNITS,
  fieldRange,
  fieldText,
  PRESET_NAMES,
  PRESET_ORDER,
  presetDescription,
  PRESSURE_ORDER_MESSAGE,
  pressureInOrder,
  readField,
  SITE_REFUSED,
  TEMPLATE_REFUSED,
  templateProblem,
} from './settings-display';
import type { NumericField, Preset } from './settings-display';

type Apply = (change: SettingsChange) => Promise<SettingsAnswer>;

/**
 * A control shows what the user chose at once, then what main keeps once it answers: the choice
 * if main kept it, or the old value back if it refused. Without this a controlled control would
 * snap back on the click until the answer arrived, and a screen reader would say the old state.
 */
function usePending<T>(kept: T): readonly [T, (value: T, request: Promise<unknown>) => void] {
  const [pending, setPending] = useState<{ readonly value: T } | null>(null);
  const choose = (value: T, request: Promise<unknown>): void => {
    setPending({ value });
    void request.finally(() => {
      setPending(null);
    });
  };
  return [pending === null ? kept : pending.value, choose] as const;
}

/** The preset's own values: choosing a preset sets them (the pressure thresholds are not its). */
const PRESET_RESET: NonNullable<NonNullable<SettingsChange['lifecycle']>['overrides']> = {
  discardAfterMs: null,
  stripCap: null,
  shelveAfterEngagedMs: null,
  archiveAfterActiveDays: null,
  interactionGuardMs: null,
  discardPinned: null,
};

const CHECKBOX = cn('mt-0.5 size-4 shrink-0 accent-foreground', FOCUS_RING);
const TEXT_FIELD = cn(
  'h-9 min-w-0 rounded-md border border-foreground/30 bg-card px-3 text-sm',
  'aria-invalid:border-red-600 dark:aria-invalid:border-red-400',
  FOCUS_RING,
);
const ERROR_TEXT = 'text-sm text-red-700 dark:text-red-400';

/**
 * Settings (`veltriva://settings`, M5.1), the shell's own page. It shows what main keeps and sends
 * main a change for each control; main checks the change and the document it makes, and answers
 * with what it keeps now, which the page then shows. Nothing here writes the settings itself, and a
 * value main refuses is said next to its field with nothing changed. Pause automation can also
 * change from the sidebar: the page reads the settings again when it does.
 */
export function SettingsPage() {
  const [view, setView] = useState<SettingsView | null | 'failed'>(null);
  const { paused } = useAutomation();

  useEffect(() => {
    let current = true;
    void fetchSettings().then((data) => {
      if (current) {
        setView(data ?? 'failed');
      }
    });
    return () => {
      current = false;
    };
  }, [paused]);

  const apply: Apply = async (change) => {
    const answer = await updateSettings(change);
    if (answer.ok) {
      setView(answer.view);
    }
    return answer;
  };

  return (
    <div
      data-internal-page="settings"
      data-settings-state={view === null ? 'loading' : view === 'failed' ? 'failed' : 'ready'}
      className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-8 px-6 py-8"
    >
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-foreground/70">
          Changes apply at once. Everything here stays on this device.
        </p>
      </header>
      {view === null ? (
        <p className="text-sm text-foreground/70">Loading…</p>
      ) : view === 'failed' ? (
        <p data-settings-message="failed" className="text-sm">
          The settings could not be read.
        </p>
      ) : (
        <>
          <SearchSection view={view} apply={apply} />
          <StartupSection view={view} apply={apply} />
          <AutomationSection view={view} apply={apply} />
          <MemorySection view={view} apply={apply} />
          <SiteRulesSection view={view} onView={setView} />
        </>
      )}
    </div>
  );
}

function Section({
  id,
  title,
  note,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly note?: ReactNode;
  readonly children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} data-settings-section={id} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-lg font-semibold">
          {title}
        </h2>
        {note === undefined ? null : <p className="text-sm text-foreground/70">{note}</p>}
      </div>
      {children}
    </section>
  );
}

/** A checkbox with its label and what it does. */
function Toggle({
  setting,
  label,
  description,
  checked,
  onChange,
}: {
  readonly setting: string;
  readonly label: string;
  readonly description: ReactNode;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => Promise<unknown>;
}) {
  const descriptionId = useId();
  const [shown, choose] = usePending(checked);
  return (
    <label className="flex max-w-xl items-start gap-3 text-sm">
      <input
        type="checkbox"
        data-setting={setting}
        checked={shown}
        aria-describedby={descriptionId}
        onChange={(event) => {
          choose(event.target.checked, onChange(event.target.checked));
        }}
        className={CHECKBOX}
      />
      <span className="flex flex-col gap-0.5">
        <span className="font-medium">{label}</span>
        <span id={descriptionId} className="text-foreground/70">
          {description}
        </span>
      </span>
    </label>
  );
}

// ── Search engine ────────────────────────────────────────────────────────────────────────────────

function SearchSection({ view, apply }: { readonly view: SettingsView; readonly apply: Apply }) {
  const current = engineOf(view);
  const [choice, setChoice] = useState(current);
  const [custom, setCustom] = useState(current === 'custom' ? view.settings.search.template : '');
  const [problem, setProblem] = useState<string | null>(null);
  const customId = useId();
  const problemId = useId();

  const submitCustom = async (): Promise<void> => {
    const found = templateProblem(custom);
    if (found !== null) {
      setProblem(found);
      return;
    }
    const answer = await apply({ search: { template: custom.trim() } });
    setProblem(
      answer.ok ? null : answer.invalid ? TEMPLATE_REFUSED : 'The change could not be saved.',
    );
  };

  return (
    <Section
      id="search"
      title="Search engine"
      note="What the address bar searches with. Your words go to it only when you search: suggestions come from this device."
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">Search engine</legend>
        {view.searchEngines.map((engine) => (
          <label key={engine.id} className="flex items-center gap-3 text-sm">
            <input
              type="radio"
              name="search-engine"
              data-setting="engine"
              value={engine.id}
              checked={choice === engine.id}
              onChange={() => {
                setChoice(engine.id);
                setProblem(null);
                void apply({ search: { template: engine.template } });
              }}
              className={CHECKBOX}
            />
            {engine.name}
          </label>
        ))}
        <label className="flex items-center gap-3 text-sm">
          <input
            type="radio"
            name="search-engine"
            data-setting="engine"
            value="custom"
            checked={choice === 'custom'}
            onChange={() => {
              setChoice('custom');
            }}
            className={CHECKBOX}
          />
          Another engine
        </label>
      </fieldset>
      {choice === 'custom' ? (
        <form
          className="flex flex-col gap-1.5 pl-7"
          onSubmit={(event: SubmitEvent<HTMLFormElement>) => {
            event.preventDefault();
            void submitCustom();
          }}
        >
          <label htmlFor={customId} className="text-sm font-medium">
            Search address
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id={customId}
              type="text"
              data-setting="custom-template"
              spellCheck={false}
              autoComplete="off"
              maxLength={2048}
              placeholder="https://search.example/?q={searchTerms}"
              value={custom}
              aria-invalid={problem !== null}
              aria-describedby={problemId}
              onChange={(event) => {
                setCustom(event.target.value);
              }}
              className={cn(TEXT_FIELD, 'w-full max-w-md flex-1')}
            />
            <Button
              type="submit"
              variant="outline"
              data-setting="use-custom"
              className={FOCUS_RING}
            >
              Use it
            </Button>
          </div>
          <p
            id={problemId}
            data-settings-error="template"
            aria-live="polite"
            className={ERROR_TEXT}
          >
            {problem}
          </p>
        </form>
      ) : null}
    </Section>
  );
}

// ── Startup ──────────────────────────────────────────────────────────────────────────────────────

const STARTUP_CHOICES = [
  {
    value: 'restore',
    label: 'Continue where you left off',
    description: 'Your tabs come back as they were. Only the one you were on loads.',
  },
  {
    value: 'new-tab',
    label: 'Start with a new tab',
    description:
      'The tabs you had open move to the Archive, where search still finds them. Pinned tabs stay.',
  },
] as const;

function StartupSection({ view, apply }: { readonly view: SettingsView; readonly apply: Apply }) {
  const [shown, choose] = usePending(view.settings.startup);
  return (
    <Section id="startup" title="When Veltriva starts">
      <fieldset className="flex flex-col gap-3">
        <legend className="sr-only">When Veltriva starts</legend>
        {STARTUP_CHOICES.map((choice) => (
          <Choice
            key={choice.value}
            name="startup"
            setting="startup"
            value={choice.value}
            label={choice.label}
            description={choice.description}
            checked={shown === choice.value}
            onSelect={() => {
              choose(choice.value, apply({ startup: choice.value }));
            }}
          />
        ))}
      </fieldset>
    </Section>
  );
}

/** A radio button with its label and what it does. */
function Choice({
  name,
  setting,
  value,
  label,
  description,
  checked,
  onSelect,
}: {
  readonly name: string;
  readonly setting: string;
  readonly value: string;
  readonly label: string;
  readonly description: string;
  readonly checked: boolean;
  readonly onSelect: () => void;
}) {
  const descriptionId = useId();
  return (
    <label className="flex max-w-xl items-start gap-3 text-sm">
      <input
        type="radio"
        name={name}
        data-setting={setting}
        value={value}
        checked={checked}
        aria-describedby={descriptionId}
        onChange={onSelect}
        className={CHECKBOX}
      />
      <span className="flex flex-col gap-0.5">
        <span className="font-medium">{label}</span>
        <span id={descriptionId} className="text-foreground/70">
          {description}
        </span>
      </span>
    </label>
  );
}

// ── Tabs and automation ──────────────────────────────────────────────────────────────────────────

function AutomationSection({
  view,
  apply,
}: {
  readonly view: SettingsView;
  readonly apply: Apply;
}) {
  const { lifecycle } = view.settings;
  const discardPinned =
    lifecycle.overrides.discardPinned ?? view.presets[lifecycle.preset].discardPinned;
  const changed = Object.keys(lifecycle.overrides).length > 0;
  const [shownPreset, choosePreset] = usePending(lifecycle.preset);

  return (
    <Section
      id="automation"
      title="Tabs and automation"
      note="Veltriva unloads tabs you aren't using and moves ones you've left to Sleeping, then the Archive. Every move can be undone, and the Activity log says why it happened."
    >
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-medium">How much it does</legend>
        {PRESET_ORDER.map((preset: Preset) => (
          <Choice
            key={preset}
            name="preset"
            setting="preset"
            value={preset}
            label={PRESET_NAMES[preset]}
            description={presetDescription(view.presets[preset])}
            checked={shownPreset === preset}
            onSelect={() => {
              // A preset sets its own values: what the advanced fields changed goes.
              choosePreset(preset, apply({ lifecycle: { preset, overrides: PRESET_RESET } }));
            }}
          />
        ))}
      </fieldset>

      <div className="flex flex-col gap-3">
        <Toggle
          setting="automation-paused"
          label="Pause automation"
          description="Nothing is unloaded or moved for you until you resume it. The sidebar has the same switch."
          checked={lifecycle.paused}
          onChange={(paused) => apply({ lifecycle: { paused } })}
        />
        <Toggle
          setting="auto-archive"
          label="Archive Sleeping tabs"
          description="Off: tabs stay in Sleeping until you archive or close them."
          checked={lifecycle.autoArchive}
          onChange={(autoArchive) => apply({ lifecycle: { autoArchive } })}
        />
        <Toggle
          setting="freeze"
          label="Freeze hidden tabs (experiment)"
          description="Pauses a tab hidden for 10 minutes instead of waiting to unload it. It keeps its page and resumes at once, but some pages misbehave."
          checked={lifecycle.freeze}
          onChange={(freeze) => apply({ lifecycle: { freeze } })}
        />
        {view.previewActive ? (
          <div className="flex max-w-xl flex-wrap items-center gap-3 rounded-lg border px-3 py-2 text-sm">
            <p data-settings-preview="" className="flex-1">
              Preview mode: for your first days, automation marks the tabs it would move without
              moving them.
            </p>
            <Button
              variant="outline"
              size="sm"
              data-setting="end-preview"
              onClick={() => {
                void apply({ lifecycle: { preview: 'off' } });
              }}
              className={FOCUS_RING}
            >
              Start now
            </Button>
          </div>
        ) : null}
      </div>

      <details data-settings-advanced="" className="group flex flex-col gap-3" open={changed}>
        <summary className={cn('w-fit cursor-pointer rounded text-sm font-medium', FOCUS_RING)}>
          Advanced
        </summary>
        <div className="mt-3 flex flex-col gap-4">
          <p className="max-w-xl text-sm text-foreground/70">
            Each value starts as the preset's ({PRESET_NAMES[lifecycle.preset]}). One you change is
            kept until you reset it or choose a preset.
          </p>
          {FIELD_ORDER.map((field) => (
            // Keyed by what main keeps: a new value starts the field over from it.
            <NumberSetting
              key={`${field}:${String(effectiveValue(view, field))}`}
              view={view}
              field={field}
              apply={apply}
            />
          ))}
          <Toggle
            setting="discard-pinned"
            label="Unload pinned tabs too"
            description={`The ${PRESET_NAMES[lifecycle.preset]} preset ${
              view.presets[lifecycle.preset].discardPinned ? 'does' : "doesn't"
            }.`}
            checked={discardPinned}
            onChange={(checked) => {
              const preset = view.presets[lifecycle.preset].discardPinned;
              return apply({
                lifecycle: { overrides: { discardPinned: checked === preset ? null : checked } },
              });
            }}
          />
          {changed ? (
            <Button
              variant="outline"
              data-setting="reset-advanced"
              onClick={() => {
                void apply({
                  lifecycle: {
                    overrides: {
                      ...PRESET_RESET,
                      moderatePressurePercent: null,
                      criticalPressurePercent: null,
                    },
                  },
                });
              }}
              className={cn('w-fit', FOCUS_RING)}
            >
              <RotateCcw data-icon="inline-start" aria-hidden="true" />
              Reset all to the preset
            </Button>
          ) : null}
        </div>
      </details>
    </Section>
  );
}

/** One advanced number: typed in its unit, applied on Enter or when the field is left. */
function NumberSetting({
  view,
  field,
  apply,
}: {
  readonly view: SettingsView;
  readonly field: NumericField;
  readonly apply: Apply;
}) {
  const value = effectiveValue(view, field);
  const preset = defaultValue(view, view.settings.lifecycle.preset, field);
  const overridden = view.settings.lifecycle.overrides[field] !== undefined;
  const [text, setText] = useState(fieldText(field, value));
  const [problem, setProblem] = useState<string | null>(null);
  const inputId = useId();
  const helpId = useId();
  const problemId = useId();
  const unit = FIELD_UNITS[field];
  const { min, max } = fieldRange(view, field);

  const commit = async (): Promise<void> => {
    if (text.trim() === fieldText(field, value)) {
      setProblem(null);
      return;
    }
    const reading = readField(view, field, text);
    if (!reading.ok) {
      setProblem(reading.message);
      return;
    }
    if (
      (field === 'moderatePressurePercent' || field === 'criticalPressurePercent') &&
      !pressureInOrder(view, field, reading.value)
    ) {
      setProblem(PRESSURE_ORDER_MESSAGE);
      return;
    }
    // The preset's own value is no change from it.
    const answer = await apply({
      lifecycle: { overrides: { [field]: reading.value === preset ? null : reading.value } },
    });
    setProblem(
      answer.ok ? null : answer.invalid ? PRESSURE_ORDER_MESSAGE : 'The change could not be saved.',
    );
  };

  return (
    <div data-setting-field={field} className="flex max-w-xl flex-col gap-1">
      <label htmlFor={inputId} className="text-sm font-medium">
        {unit.label}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={inputId}
          type="text"
          inputMode="numeric"
          data-setting={field}
          value={text}
          aria-invalid={problem !== null}
          aria-describedby={`${helpId} ${problemId}`}
          onChange={(event) => {
            setText(event.target.value);
          }}
          onBlur={() => {
            void commit();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void commit();
            }
          }}
          className={cn(TEXT_FIELD, 'w-24 tabular-nums')}
        />
        <span className="text-sm text-foreground/70">{unit.unit}</span>
        {overridden ? (
          <Button
            variant="ghost"
            size="sm"
            data-setting-reset={field}
            aria-label={`Reset “${unit.label}” to ${fieldText(field, preset)} ${unit.unit}`}
            onClick={() => {
              setProblem(null);
              void apply({ lifecycle: { overrides: { [field]: null } } });
            }}
            className={FOCUS_RING}
          >
            <RotateCcw data-icon="inline-start" aria-hidden="true" />
            Reset
          </Button>
        ) : null}
      </div>
      <p id={helpId} className="text-sm text-foreground/70">
        {unit.help}{' '}
        {field === 'moderatePressurePercent' || field === 'criticalPressurePercent'
          ? 'Default'
          : 'Preset'}
        : {fieldText(field, preset)}; from {min.toLocaleString('en-US')} to{' '}
        {max.toLocaleString('en-US')}.
      </p>
      <p id={problemId} data-settings-error={field} aria-live="polite" className={ERROR_TEXT}>
        {problem}
      </p>
    </div>
  );
}

// ── The memory ───────────────────────────────────────────────────────────────────────────────────

function MemorySection({ view, apply }: { readonly view: SettingsView; readonly apply: Apply }) {
  return (
    <Section
      id="memory"
      title="Memory"
      note="Veltriva remembers the pages you visit, so search finds them again. It stays on this device."
    >
      <Toggle
        setting="memory-paused"
        label="Pause memory"
        description="While paused, no new page or visit is remembered: no private window needed. Your tabs, Sleeping and the Archive work as usual."
        checked={view.settings.memory.paused}
        onChange={(paused) => apply({ memory: { paused } })}
      />
    </Section>
  );
}

// ── Site rules ───────────────────────────────────────────────────────────────────────────────────

function SiteRulesSection({
  view,
  onView,
}: {
  readonly view: SettingsView;
  readonly onView: (view: SettingsView) => void;
}) {
  const [site, setSite] = useState('');
  const [protect, setProtect] = useState(true);
  const [exclude, setExclude] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const siteId = useId();
  const problemId = useId();

  const change = async (
    text: string,
    rule: { readonly protect?: boolean; readonly excludeMemory?: boolean },
  ): Promise<boolean> => {
    const answer = await setSiteRule(text, rule);
    if (answer.ok) {
      onView(answer.view);
    }
    return answer.ok;
  };

  const add = async (): Promise<void> => {
    if (site.trim() === '') {
      setProblem('Enter a site, such as example.com.');
      return;
    }
    if (!protect && !exclude) {
      setProblem('Choose what the rule does: protect the site, or not remember it, or both.');
      return;
    }
    if (await change(site, { protect, excludeMemory: exclude })) {
      setSite('');
      setProblem(null);
    } else {
      setProblem(
        view.siteRules.length >= 1000 ? 'The list is full: remove a site first.' : SITE_REFUSED,
      );
    }
  };

  return (
    <Section
      id="site-rules"
      title="Site rules"
      note={
        <>
          A rule covers a whole site: mail.example.com is example.com.{' '}
          <strong className="font-medium text-foreground">Protect</strong>: automation leaves its
          tabs alone. <strong className="font-medium text-foreground">Don't remember</strong>: none
          of its pages or visits are remembered, its tabs are never archived, and closing one keeps
          no record. Pages remembered before stay until you clear them. A tab's menu sets both too.
        </>
      }
    >
      <form
        data-settings-add-site=""
        className="flex flex-col gap-2"
        onSubmit={(event: SubmitEvent<HTMLFormElement>) => {
          event.preventDefault();
          void add();
        }}
      >
        <label htmlFor={siteId} className="text-sm font-medium">
          Add a site
        </label>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <input
            id={siteId}
            type="text"
            data-setting="site"
            spellCheck={false}
            autoComplete="off"
            maxLength={2048}
            placeholder="example.com"
            value={site}
            aria-invalid={problem !== null}
            aria-describedby={problemId}
            onChange={(event) => {
              setSite(event.target.value);
            }}
            className={cn(TEXT_FIELD, 'w-64')}
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-setting="site-protect"
              checked={protect}
              onChange={(event) => {
                setProtect(event.target.checked);
              }}
              className={CHECKBOX}
            />
            Protect
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-setting="site-exclude"
              checked={exclude}
              onChange={(event) => {
                setExclude(event.target.checked);
              }}
              className={CHECKBOX}
            />
            Don't remember
          </label>
          <Button type="submit" variant="outline" data-setting="add-site" className={FOCUS_RING}>
            Add
          </Button>
        </div>
        <p id={problemId} data-settings-error="site" aria-live="polite" className={ERROR_TEXT}>
          {problem}
        </p>
      </form>

      {view.siteRules.length === 0 ? (
        <p data-settings-message="no-site-rules" className="text-sm text-foreground/70">
          No site has a rule.
        </p>
      ) : (
        <div className="max-h-96 overflow-auto rounded-xl border bg-card">
          <table data-settings-site-rules="" className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-card text-xs text-foreground/70">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Site
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Protect
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Don't remember
                </th>
                <th scope="col" className="px-3 py-2">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {view.siteRules.map((rule) => (
                <tr key={rule.site} data-site-rule={rule.site} className="border-t">
                  <th scope="row" className="max-w-64 truncate px-3 py-2 font-medium">
                    <bdi dir="ltr">{rule.site}</bdi>
                  </th>
                  <td className="px-3 py-2">
                    <RuleBox
                      field="protect"
                      label={`Protect ${rule.site}`}
                      checked={rule.protect}
                      onChange={(protect) => change(rule.site, { protect })}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <RuleBox
                      field="exclude"
                      label={`Don't remember ${rule.site}`}
                      checked={rule.excludeMemory}
                      onChange={(excludeMemory) => change(rule.site, { excludeMemory })}
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      data-site-rule-remove=""
                      aria-label={`Remove the rules for ${rule.site}`}
                      onClick={() => {
                        void change(rule.site, { protect: false, excludeMemory: false });
                      }}
                      className={FOCUS_RING}
                    >
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

/** One rule of a site in the table, shown as chosen until main answers. */
function RuleBox({
  field,
  label,
  checked,
  onChange,
}: {
  readonly field: 'protect' | 'exclude';
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => Promise<unknown>;
}) {
  const [shown, choose] = usePending(checked);
  return (
    <input
      type="checkbox"
      data-site-rule-field={field}
      aria-label={label}
      checked={shown}
      onChange={(event) => {
        choose(event.target.checked, onChange(event.target.checked));
      }}
      className={CHECKBOX}
    />
  );
}
