import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent, SubmitEvent } from 'react';
import { flushSync } from 'react-dom';

import { FOCUS_WITHIN_RING } from '@/lib/focus';
import { cn } from '@/lib/utils';

import { submitAddress } from '../../state/commands';
import { useUiStore } from '../../state/ui-store';
import { useSelectedTab } from '../../state/workspace-store';
import { AddressIndicator, CredentialsRemovedIndicator } from './AddressIndicator';

/** What the user has typed, and the tab they typed it in. */
interface Draft {
  readonly tabId: string;
  readonly text: string;
}

/**
 * What the user pressed Enter on. Main only publishes an address once a navigation commits or
 * fails, so until then the field keeps showing what was sent instead of jumping back to the old
 * address for the whole load.
 */
interface Submitted extends Draft {
  /** The tab's address when it was sent. The commit or the failure replaces it. */
  readonly address: string;
  /** The tab has started loading since, so the end of that load ends the wait too. */
  readonly loadingSeen: boolean;
}

/**
 * The address bar. While the user isn't typing it shows the selected tab's address exactly as main
 * built it. The shell never parses or classifies what is typed: Enter hands the text to main.
 */
export function Omnibox() {
  const tab = useSelectedTab();
  const tabId = tab?.id ?? null;
  const address = tab?.address.text ?? '';
  const loading = tab?.loading ?? false;
  const inputRef = useRef<HTMLInputElement>(null);
  const selectOnMouseUp = useRef(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [submitted, setSubmitted] = useState<Submitted | null>(null);

  const focusRequest = useUiStore((state) => state.omniboxFocusRequest);
  const clearFocusRequest = useUiStore((state) => state.clearOmniboxFocusRequest);

  // An edit belongs to the tab it was typed in: switching tabs throws it away for good, so coming
  // back to the first tab shows its address, not the abandoned text.
  if (draft !== null && draft.tabId !== tabId) {
    setDraft(null);
  }
  // A submitted text gives way to main's address once the tab's address changes (the commit or
  // the failure), or once a load that started after the submission ends (the same address again).
  if (submitted !== null) {
    if (submitted.tabId !== tabId || submitted.address !== address) {
      setSubmitted(null);
    } else if (loading && !submitted.loadingSeen) {
      setSubmitted({ ...submitted, loadingSeen: true });
    } else if (!loading && submitted.loadingSeen) {
      setSubmitted(null);
    }
  }
  const editing = draft !== null && draft.tabId === tabId;
  const value = editing ? draft.text : submitted?.tabId === tabId ? submitted.text : address;

  // Honors a "focus the address bar" request (the "New tab" button) once its tab is selected.
  useEffect(() => {
    if (focusRequest === null || focusRequest !== tabId) {
      return;
    }
    inputRef.current?.focus();
    inputRef.current?.select();
    clearFocusRequest();
  }, [focusRequest, tabId, clearFocusRequest]);

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (tabId === null) {
      return;
    }
    const text = value;
    setDraft(null);
    setSubmitted({ tabId, text, address, loadingSeen: false });
    // Main moves keyboard focus to the page when the navigation commits.
    inputRef.current?.blur();
    void submitAddress(tabId, text).then((action) => {
      // Nothing is going to load for these, so show the tab's address again now.
      if (action === undefined || action === 'none' || action === 'internal') {
        setSubmitted((held) => (held?.tabId === tabId && held.text === text ? null : held));
      }
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Escape') {
      return;
    }
    event.preventDefault();
    const input = event.currentTarget;
    // Commit the revert before selecting: changing a controlled input's value drops its selection.
    flushSync(() => {
      setDraft(null);
      setSubmitted(null);
    });
    input.select();
  };

  // Clicking into the field selects everything, like clicking into any browser's address bar. The
  // focus handler selects, and the mouse-up that follows would drop that selection, so it is cancelled.
  const onMouseDown = (): void => {
    selectOnMouseUp.current = document.activeElement !== inputRef.current;
  };
  const onMouseUp = (event: MouseEvent<HTMLInputElement>): void => {
    if (selectOnMouseUp.current) {
      event.preventDefault();
    }
    selectOnMouseUp.current = false;
  };

  return (
    <form
      onSubmit={submit}
      className={cn(
        'flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full bg-muted px-3',
        FOCUS_WITHIN_RING,
      )}
    >
      {tab === undefined ? null : (
        <>
          <AddressIndicator security={tab.address.security} />
          {tab.address.hadCredentials ? <CredentialsRemovedIndicator /> : null}
        </>
      )}
      <input
        ref={inputRef}
        type="text"
        aria-label="Address and search bar"
        placeholder="Search or enter address"
        spellCheck={false}
        autoComplete="off"
        maxLength={16_384}
        disabled={tab === undefined}
        value={value}
        onChange={(event) => {
          if (tabId !== null) {
            setDraft({ tabId, text: event.target.value });
          }
        }}
        onFocus={(event) => {
          event.currentTarget.select();
        }}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onKeyDown={onKeyDown}
        className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-foreground/60"
      />
    </form>
  );
}
