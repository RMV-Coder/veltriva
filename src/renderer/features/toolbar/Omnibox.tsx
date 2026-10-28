import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent, SubmitEvent } from 'react';
import { flushSync } from 'react-dom';

import { FOCUS_FIELD_RING } from '@/lib/focus';
import { cn } from '@/lib/utils';

import { openMemoryResult, submitAddress, zoomTab } from '../../state/commands';
import { useUiStore } from '../../state/ui-store';
import { useSelectedTab } from '../../state/workspace-store';
import { suggestionOpenFor } from '../palette/memory-display';
import { AddressIndicator, CredentialsRemovedIndicator } from './AddressIndicator';
import { SuggestionDropdown } from './SuggestionDropdown';
import { ZoomIndicator } from './ZoomIndicator';
import { suggestionsAnnouncement } from './suggestion-display';
import { suggestionKeyAction } from './suggestion-keys';
import { useSuggestions } from './use-suggestions';
import { isZoomIndicatorVisible } from './zoom-display';

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
 *
 * While the user edits the field, the memory's suggestions hang under it (M4.2, assessment §7.3):
 * up to six pages, ranked by main from the local database, and "Switch to tab" on a page that a
 * tab in the strip already shows. Down and Up select one, Enter opens it (switching to its tab, or
 * going there in this tab), Escape closes the list and a second Escape reverts the field. With no
 * suggestion selected, Enter submits the typed text as it always did.
 */
export function Omnibox() {
  const tab = useSelectedTab();
  const tabId = tab?.id ?? null;
  const address = tab?.address.text ?? '';
  const loading = tab?.loading ?? false;
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const selectOnMouseUp = useRef(false);
  const choosing = useRef(false);
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
  // Suggestions are for text the user is editing: not for the address as it is, nor for nothing.
  const suggestions = useSuggestions(
    editing && draft.text.trim() !== '' && draft.text !== address ? draft.text : null,
    wrapperRef,
  );

  // Honors a "focus the address bar" request (the "New tab" button) once its tab is selected.
  useEffect(() => {
    if (focusRequest === null || focusRequest !== tabId) {
      return;
    }
    inputRef.current?.focus();
    inputRef.current?.select();
    clearFocusRequest();
  }, [focusRequest, tabId, clearFocusRequest]);

  // Main gave the shell the keyboard (Ctrl+L, Alt+D, F6, Ctrl+T): take it in the field, selected.
  useEffect(
    () =>
      window.veltriva.on('ui.focusAddressBar', () => {
        const input = inputRef.current;
        if (input !== null && !input.disabled) {
          input.focus();
          input.select();
        }
      }),
    [],
  );

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
      // Nothing is going to load for these, so show the tab's address again now. (An external
      // link is a question in the prompt strip; the tab stays where it is.)
      if (
        action === undefined ||
        action === 'none' ||
        action === 'internal' ||
        action === 'external'
      ) {
        setSubmitted((held) => (held?.tabId === tabId && held.text === text ? null : held));
      }
    });
  };

  /** Opens a suggestion: its tab if the strip has one, else in this tab (as if it were typed). */
  const choose = (index: number): void => {
    const result = suggestions.results[index];
    if (tabId === null || result === undefined || choosing.current) {
      return;
    }
    choosing.current = true;
    const how = suggestionOpenFor(result);
    void openMemoryResult(result.pageId, how.target, how.tabId).then((openedTabId) => {
      choosing.current = false;
      if (openedTabId === undefined) {
        return;
      }
      // The dropdown stayed until main had the answer, so the old page never showed in between.
      setDraft(null);
      if (how.target === 'current') {
        // Main only publishes the address when the navigation commits: until then the field
        // keeps what the user chose, as it does for a submitted text.
        setSubmitted({ tabId, text: result.address, address, loadingSeen: false });
      }
      // Main focuses the page it opened (switch) or the one that commits (current).
      inputRef.current?.blur();
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    const action = suggestionKeyAction(
      {
        key: event.key,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        isComposing: event.nativeEvent.isComposing,
      },
      { open: suggestions.open, selected: suggestions.selected >= 0 },
    );
    if (action !== null) {
      event.preventDefault();
      switch (action) {
        case 'next':
          suggestions.move(1);
          return;
        case 'previous':
          suggestions.move(-1);
          return;
        case 'open':
          choose(suggestions.selected);
          return;
        case 'dismiss':
          // The first Escape closes the list; the field keeps the keyboard and the text.
          suggestions.dismiss(false);
          return;
      }
    }
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
    <div ref={wrapperRef} className="relative flex min-w-0 flex-1">
      <form
        onSubmit={submit}
        className={cn(
          'flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full bg-muted px-3',
          FOCUS_FIELD_RING,
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
          role="combobox"
          aria-label="Address and search bar"
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-expanded={suggestions.open}
          aria-controls={suggestions.open ? suggestions.listId : undefined}
          aria-activedescendant={
            suggestions.selected >= 0 ? suggestions.optionId(suggestions.selected) : undefined
          }
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
          onBlur={(event) => {
            // The mouse-down on a suggestion is cancelled, so a blur is the keyboard or the window
            // moving on: the list goes with it.
            if (suggestions.open && !wrapperRef.current?.contains(event.relatedTarget)) {
              suggestions.dismiss(false);
            }
          }}
          onMouseDown={onMouseDown}
          onMouseUp={onMouseUp}
          onKeyDown={onKeyDown}
          className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-foreground/60"
        />
        {tab !== undefined && isZoomIndicatorVisible(tab.zoomPercent) ? (
          <ZoomIndicator
            percent={tab.zoomPercent}
            onReset={(viaKeyboard) => {
              void zoomTab(tab.id, 'reset');
              // The indicator disappears at 100%; a keyboard user's focus moves to the field, not to nowhere.
              if (viaKeyboard) {
                inputRef.current?.focus();
              }
            }}
          />
        ) : null}
      </form>
      {/* Always in the page, so a screen reader hears when the list appears and how long it is. */}
      <p role="status" className="sr-only" data-suggestions-status="">
        {suggestionsAnnouncement(suggestions.open, suggestions.results.length)}
      </p>
      {suggestions.open ? (
        <SuggestionDropdown
          listId={suggestions.listId}
          optionId={suggestions.optionId}
          results={suggestions.results}
          selected={suggestions.selected}
          onPoint={suggestions.point}
          onChoose={choose}
        />
      ) : null}
    </div>
  );
}
