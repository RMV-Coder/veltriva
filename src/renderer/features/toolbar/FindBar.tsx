import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { FOCUS_FIELD_RING } from '@/lib/focus';
import { cn } from '@/lib/utils';

import type { TabSnapshot } from '../../../shared/contracts/schemas';
import { closeFind, findNext, updateFind } from '../../state/commands';
import { isFocusRequestFresh } from '../../state/focus-request';
import { useUiStore } from '../../state/ui-store';
import { useSelectedTab } from '../../state/workspace-store';
import { canStepMatches, findCountText } from './find-display';
import { findKeyAction } from './find-keys';
import { ToolbarButton } from './ToolbarButton';

type Find = NonNullable<TabSnapshot['find']>;

/**
 * The find bar, shown at the right end of the toolbar row while the selected tab's find state is
 * open (never over the content area: a web page would cover it). It renders what main reports and
 * sends typed commands; main does the searching, and `find.close` returns keyboard focus to the page.
 *
 * Main opens the find state, gives the shell keyboard focus and sends `ui.focusFind`. That event
 * usually beats the snapshot that draws the bar, so this component, which is always mounted,
 * turns it into a request that the bar honors as soon as its field exists.
 */
export function FindBar() {
  const tab = useSelectedTab();
  const requestFindFocus = useUiStore((state) => state.requestFindFocus);

  useEffect(
    () =>
      window.veltriva.on('ui.focusFind', () => {
        requestFindFocus();
      }),
    [requestFindFocus],
  );

  const find = tab?.find ?? null;
  if (tab === undefined || find === null) {
    return null;
  }
  // Keyed by tab: the field starts from main's text for each tab, and for each time the bar opens.
  return <OpenFindBar key={tab.id} tabId={tab.id} find={find} />;
}

function OpenFindBar({ tabId, find }: { readonly tabId: string; readonly find: Find }) {
  const inputRef = useRef<HTMLInputElement>(null);
  // The field's value is the user's to type. It starts from main's text and is sent on every change.
  const [text, setText] = useState(find.text);
  const focusRequest = useUiStore((state) => state.findFocusRequest);
  const clearFocusRequest = useUiStore((state) => state.clearFindFocusRequest);

  // Honors a "focus the find field" request, whether it came before the bar or while it is open.
  useEffect(() => {
    if (focusRequest === null) {
      return;
    }
    clearFocusRequest();
    if (isFocusRequestFresh(focusRequest, performance.now())) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [focusRequest, clearFocusRequest]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    const action = findKeyAction({
      key: event.key,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      isComposing: event.nativeEvent.isComposing,
    });
    if (action === null) {
      return;
    }
    event.preventDefault();
    if (action === 'close') {
      void closeFind(tabId);
    } else {
      void findNext(tabId, action === 'next');
    }
  };

  const canStep = canStepMatches(find);

  return (
    <div
      role="search"
      aria-label="Find in page"
      data-find-bar=""
      className={cn(
        'flex h-9 w-80 shrink-0 items-center gap-0.5 rounded-full bg-muted pr-1 pl-3',
        FOCUS_FIELD_RING,
      )}
    >
      <input
        ref={inputRef}
        type="text"
        aria-label="Find in page"
        placeholder="Find in page"
        spellCheck={false}
        autoComplete="off"
        maxLength={1024}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          void updateFind(tabId, event.target.value);
        }}
        onKeyDown={onKeyDown}
        className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-foreground/60"
      />
      {/* Always in the page, so assistive technology announces each change to it. */}
      <span
        aria-live="polite"
        aria-atomic="true"
        data-find-count=""
        className="w-[4.5rem] shrink-0 text-right text-xs text-foreground/70 tabular-nums"
      >
        {findCountText(find)}
      </span>
      <ToolbarButton
        label="Previous match"
        icon={ChevronUp}
        size="compact"
        disabled={!canStep}
        onClick={() => {
          void findNext(tabId, false);
        }}
      />
      <ToolbarButton
        label="Next match"
        icon={ChevronDown}
        size="compact"
        disabled={!canStep}
        onClick={() => {
          void findNext(tabId, true);
        }}
      />
      <ToolbarButton
        label="Close find bar"
        icon={X}
        size="compact"
        disabled={false}
        onClick={() => {
          void closeFind(tabId);
        }}
      />
    </div>
  );
}
