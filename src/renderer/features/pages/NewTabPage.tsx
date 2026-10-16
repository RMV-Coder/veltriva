import { Search } from 'lucide-react';
import { useState } from 'react';
import type { SubmitEvent } from 'react';

import { FOCUS_WITHIN_RING } from '@/lib/focus';
import { cn } from '@/lib/utils';

import { submitAddress } from '../../state/commands';
import { BuildDetails } from './BuildDetails';

/** The new-tab page: the shell draws it, since a new tab has no web view (ADR-0002 §3). */
export function NewTabPage({ tabId }: { readonly tabId: string }) {
  const [text, setText] = useState('');

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void submitAddress(tabId, text);
  };

  return (
    <div
      data-internal-page="new-tab"
      className="flex min-h-full flex-col items-center gap-8 px-6 pt-[22vh] pb-10 text-center"
    >
      <header className="flex flex-col items-center gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Veltriva Browser</h1>
        <p className="text-foreground/70">Browse freely. Remember effortlessly.</p>
      </header>

      <form
        onSubmit={submit}
        className={cn(
          'flex h-12 w-full max-w-xl items-center gap-3 rounded-full border border-foreground/30 bg-card px-5',
          FOCUS_WITHIN_RING,
        )}
      >
        <Search className="size-5 shrink-0 text-foreground/70" aria-hidden="true" />
        <input
          type="text"
          aria-label="Search or enter address"
          placeholder="Search the web or enter an address"
          spellCheck={false}
          autoComplete="off"
          maxLength={16_384}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
          }}
          className="h-full min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-foreground/60"
        />
      </form>

      <BuildDetails />
    </div>
  );
}
