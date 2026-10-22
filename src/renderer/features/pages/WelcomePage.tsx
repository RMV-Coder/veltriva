import { useEffect, useId, useState } from 'react';
import type { SubmitEvent } from 'react';

import { Button } from '@/components/ui/button';
import { FOCUS_RING } from '@/lib/focus';
import { cn } from '@/lib/utils';

import { fetchSettings, submitAddress, updateSettings } from '../../state/commands';
import type { SettingsView } from '../../state/commands';
import { PRESET_NAMES, PRESET_ORDER, presetDescription } from './settings-display';
import type { Preset } from './settings-display';

const RADIO = cn('mt-0.5 size-4 shrink-0 accent-foreground', FOCUS_RING);

/**
 * First-run onboarding (`veltriva://welcome`, M5.1, §7.2): the search engine (DuckDuckGo chosen,
 * ADR-0009 D5), how much automation does, and whether it shows its moves first (preview mode,
 * §4.13). Nothing is changed until "Start browsing", which sends one change and opens the new-tab
 * page in this tab. Every choice is in Settings later, and skipping keeps the defaults.
 */
export function WelcomePage({ tabId }: { readonly tabId: string }) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [engine, setEngine] = useState<string | null>(null);
  const [preset, setPreset] = useState<Preset>('balanced');
  const [preview, setPreview] = useState<'auto' | 'off'>('auto');
  const [failed, setFailed] = useState(false);
  const engineLegend = useId();
  const presetLegend = useId();
  const previewLegend = useId();

  useEffect(() => {
    let current = true;
    void fetchSettings().then((data) => {
      if (current && data !== undefined) {
        setView(data);
        setPreset(data.settings.lifecycle.preset);
        setEngine(
          data.searchEngines.find((known) => known.template === data.settings.search.template)
            ?.id ?? null,
        );
      }
    });
    return () => {
      current = false;
    };
  }, []);

  const start = async (event: SubmitEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const template = view?.searchEngines.find((known) => known.id === engine)?.template;
    const answer = await updateSettings({
      ...(template === undefined ? {} : { search: { template } }),
      lifecycle: { preset, preview },
    });
    if (!answer.ok) {
      setFailed(true);
      return;
    }
    void submitAddress(tabId, 'veltriva://newtab');
  };

  return (
    <div
      data-internal-page="welcome"
      className="mx-auto flex min-h-full w-full max-w-2xl flex-col gap-8 px-6 py-10"
    >
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Welcome to Veltriva</h1>
        <p className="text-foreground/70">
          Three choices to start with. Each one can be changed later in Settings.
        </p>
      </header>

      {view === null ? (
        <p className="text-sm text-foreground/70">Loading…</p>
      ) : (
        <form className="flex flex-col gap-8" onSubmit={(event) => void start(event)}>
          <fieldset aria-labelledby={engineLegend} className="flex flex-col gap-2">
            <legend id={engineLegend} className="mb-1 text-lg font-semibold">
              Search with
            </legend>
            <p className="mb-1 text-sm text-foreground/70">
              Your words go to it only when you search: suggestions come from this device.
            </p>
            {view.searchEngines.map((known) => (
              <label key={known.id} className="flex items-center gap-3 text-sm">
                <input
                  type="radio"
                  name="welcome-engine"
                  data-welcome="engine"
                  value={known.id}
                  checked={engine === known.id}
                  onChange={() => {
                    setEngine(known.id);
                  }}
                  className={RADIO}
                />
                {known.name}
              </label>
            ))}
          </fieldset>

          <fieldset aria-labelledby={presetLegend} className="flex flex-col gap-3">
            <legend id={presetLegend} className="mb-1 text-lg font-semibold">
              How much Veltriva tidies for you
            </legend>
            {PRESET_ORDER.map((known) => (
              <label key={known} className="flex items-start gap-3 text-sm">
                <input
                  type="radio"
                  name="welcome-preset"
                  data-welcome="preset"
                  value={known}
                  checked={preset === known}
                  onChange={() => {
                    setPreset(known);
                  }}
                  className={RADIO}
                />
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium">{PRESET_NAMES[known]}</span>
                  <span className="text-foreground/70">
                    {presetDescription(view.presets[known])}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>

          <fieldset aria-labelledby={previewLegend} className="flex flex-col gap-3">
            <legend id={previewLegend} className="mb-1 text-lg font-semibold">
              The first days
            </legend>
            <label className="flex items-start gap-3 text-sm">
              <input
                type="radio"
                name="welcome-preview"
                data-welcome="preview"
                value="auto"
                checked={preview === 'auto'}
                onChange={() => {
                  setPreview('auto');
                }}
                className={RADIO}
              />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">Show me first</span>
                <span className="text-foreground/70">
                  For your first 3 days, Veltriva marks the tabs it would move, without moving them.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-3 text-sm">
              <input
                type="radio"
                name="welcome-preview"
                data-welcome="preview"
                value="off"
                checked={preview === 'off'}
                onChange={() => {
                  setPreview('off');
                }}
                className={RADIO}
              />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">Start now</span>
                <span className="text-foreground/70">
                  Automation works from today. Every move can be undone.
                </span>
              </span>
            </label>
          </fieldset>

          <div className="flex flex-col items-start gap-2">
            <Button type="submit" data-welcome="start" className={FOCUS_RING}>
              Start browsing
            </Button>
            {failed ? (
              <p role="alert" className="text-sm text-red-700 dark:text-red-400">
                Your choices could not be saved. Try again, or change them later in Settings.
              </p>
            ) : null}
          </div>
        </form>
      )}
    </div>
  );
}
