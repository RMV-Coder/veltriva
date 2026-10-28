import { Search, X } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { FOCUS_FIELD_RING, FOCUS_RING } from '@/lib/focus';
import { cn } from '@/lib/utils';
import { useNow } from '@/lib/use-now';

import { openMemoryResult, removeMemoryEntry, showOverlay } from '../../state/commands';
import type { MemoryScope } from '../../state/commands';
import { useUiStore } from '../../state/ui-store';
import { useSelectedTabId } from '../../state/workspace-store';
import { useShellOverlay } from '../overlay/use-shell-overlay';
import { ResultOption } from './ResultOption';
import type { OpenTarget } from './ResultOption';
import { ScoreBreakdown } from './ScoreBreakdown';
import {
  MAX_QUERY_CHARS,
  PALETTE_SCOPES,
  displayTitle,
  emptyMessage,
  removeSiteWords,
  resultsAnnouncement,
  siteChipLabel,
  siteChipText,
  stepScope,
} from './memory-display';
import { moveActive, pageActive, paletteKeyAction } from './palette-keys';
import { useMemorySearch } from './use-memory-search';

/** Results per search: more than a screenful, far fewer than a list worth scrolling for. */
const RESULT_LIMIT = 30;
/** "visited 3 days ago" is worked out again this often while the palette is open. */
const CLOCK_TICK_MS = 60_000;

/** What the palette says it does, and how: the footer of the mock-up (assessment §7.3). */
const FOOTER_HINT = '↵ switch or restore · Ctrl+↵ new tab · Tab filters · Shift+Del forget';

/**
 * The memory palette (Ctrl+Shift+K, assessment §5.4 and §7.3): a modal over the content area to
 * find a page by a few words of its title, address or site, and bring it back. It is an A′
 * overlay (ADR-0006): main raises the transparent shell above the tab once the palette has
 * painted, so the page underneath stays visible, live and unthrottled behind the scrim.
 *
 * The field keeps the keyboard throughout. The results are a listbox that the field points at with
 * `aria-activedescendant` (WAI-ARIA combobox), the filters a radio group that Tab steps through,
 * and a press on anything but the field is cancelled so focus cannot leave it. Search happens at
 * every change; main does the ranking and says which tab (if any) shows each page.
 */
export function MemoryPalette() {
  const closePalette = useUiStore((state) => state.closePalette);
  const openCount = useUiStore((state) => state.paletteOpenCount);
  const setFocusPageOnHide = useShellOverlay('palette', true);
  const now = useNow(CLOCK_TICK_MS);

  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<MemoryScope>('all');
  const [debug, setDebug] = useState(false);
  const [refresh, setRefresh] = useState(0);
  /** What Shift+Delete just removed (M5.2), said until the next search. */
  const [removed, setRemoved] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const opening = useRef(false);
  const listId = useId();

  const answer = useMemorySearch({ query, scope, limit: RESULT_LIMIT, enabled: true, refresh });
  const results = answer?.results ?? [];

  // The active result follows the best match until the user moves it (Up, Down, the pointer);
  // then it stays on that page as new answers arrive, if the page is still listed. Typing or a
  // new filter starts over.
  const [pick, setPick] = useState<number | null>(null);
  const activeIndex =
    results.length === 0
      ? -1
      : pick === null
        ? 0
        : Math.max(
            results.findIndex((result) => result.pageId === pick),
            0,
          );
  const activeResult = activeIndex >= 0 ? results[activeIndex] : undefined;
  const optionId = (index: number): string => `${listId}-option-${String(index)}`;

  // The field has the keyboard from the moment the palette opens, and again when main reports
  // another Ctrl+Shift+K (the count): its words are selected, ready to be typed over.
  useLayoutEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [openCount]);

  // Keep the active result in view as the keys move it.
  useEffect(() => {
    if (activeIndex >= 0) {
      document.getElementById(`${listId}-option-${String(activeIndex)}`)?.scrollIntoView({
        block: 'nearest',
      });
    }
  }, [activeIndex, listId, answer]);

  // The palette stays open when the selected tab changes (Ctrl+Tab, say), but main gives the new
  // tab's page the keyboard as it selects it. Asking for the overlay again hands the keyboard back
  // to the field; the shell is above the tab already, so nothing else changes.
  const selectedTabId = useSelectedTabId();
  const shownFor = useRef(selectedTabId);
  useEffect(() => {
    if (shownFor.current !== selectedTabId) {
      shownFor.current = selectedTabId;
      void showOverlay('palette');
    }
  }, [selectedTabId]);

  const close = useCallback(
    (focusPage: boolean): void => {
      setFocusPageOnHide(focusPage);
      closePalette();
    },
    [setFocusPageOnHide, closePalette],
  );

  // Ctrl+L and Ctrl+F hand the keyboard to the address bar or the find bar: the palette gives way.
  useEffect(() => {
    const stops = [
      window.veltriva.on('ui.focusAddressBar', () => {
        close(false);
      }),
      window.veltriva.on('ui.focusFind', () => {
        close(false);
      }),
    ];
    return () => {
      for (const stop of stops) {
        stop();
      }
    };
  }, [close]);

  const openResult = useCallback(
    (index: number, target: OpenTarget): void => {
      const result = answer?.results[index];
      if (result === undefined || opening.current) {
        return;
      }
      opening.current = true;
      void openMemoryResult(
        result.pageId,
        target,
        target === 'switch' ? result.tab?.tabId : undefined,
      ).then((tabId) => {
        opening.current = false;
        if (tabId === undefined) {
          // The page or its tab went since the search: show what is there now.
          setRefresh((count) => count + 1);
          return;
        }
        // The opened page has the keyboard already (main focused it): the palette just goes.
        close(false);
      });
    },
    [answer, close],
  );

  const point = useCallback(
    (index: number): void => {
      setPick(answer?.results[index]?.pageId ?? null);
    },
    [answer],
  );

  const changeScope = (next: MemoryScope): void => {
    setScope(next);
    setPick(null);
    setRemoved(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const action = paletteKeyAction({
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
    switch (action.kind) {
      case 'move':
        point(moveActive(results.length, activeIndex, action.delta));
        return;
      case 'page':
        point(pageActive(results.length, activeIndex, action.delta));
        return;
      case 'open':
        openResult(activeIndex, action.target);
        return;
      case 'close':
        close(true);
        return;
      case 'scope':
        changeScope(stepScope(scope, action.direction));
        inputRef.current?.focus();
        return;
      case 'toggleDebug':
        setDebug((shown) => !shown);
        return;
      case 'remove': {
        if (activeResult === undefined) {
          return;
        }
        const title = displayTitle(activeResult).text;
        const archived =
          activeResult.tab?.placement === 'archive' ? activeResult.tab.tabId : undefined;
        void removeMemoryEntry(activeResult.pageId, archived).then((outcome) => {
          if (outcome !== undefined) {
            setRemoved(`Removed “${title}” from the memory`);
            setRefresh((count) => count + 1);
          }
        });
        return;
      }
    }
  };

  const site = answer?.site ?? null;
  const mode = answer?.mode ?? 'recent';

  return (
    <div
      data-palette-layer=""
      onMouseDown={(event) => {
        // A press on the scrim, outside the panel, dismisses it.
        if (event.target === event.currentTarget) {
          close(true);
        }
      }}
      className="fixed inset-0 z-50 bg-black/40 select-none motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-100 dark:bg-black/60"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search memory"
        data-palette=""
        onKeyDown={onKeyDown}
        className="mx-auto mt-[12vh] flex max-h-[76vh] w-[min(42rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl"
      >
        <div
          className={cn('m-2 flex items-center gap-2 rounded-lg bg-muted px-3', FOCUS_FIELD_RING)}
        >
          <Search aria-hidden="true" className="size-4 shrink-0 text-popover-foreground/70" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-label="Search memory"
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-expanded={results.length > 0}
            aria-controls={listId}
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            placeholder="Search your tabs and history"
            spellCheck={false}
            autoComplete="off"
            maxLength={MAX_QUERY_CHARS}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setRemoved(null);
              setPick(null);
            }}
            className="h-10 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-foreground/60"
          />
          {site === null ? null : (
            <button
              type="button"
              data-site-chip=""
              aria-label={siteChipLabel(site)}
              title={siteChipLabel(site)}
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => {
                setQuery(removeSiteWords(query));
                setPick(null);
                inputRef.current?.focus();
              }}
              className={cn(
                'inline-flex shrink-0 items-center gap-1 rounded-full border border-foreground/25 bg-background px-2 py-0.5 text-xs font-medium text-foreground',
                FOCUS_RING,
              )}
            >
              <bdi dir="ltr">{siteChipText(site)}</bdi>
              <X aria-hidden="true" className="size-3" />
            </button>
          )}
        </div>

        <div
          role="radiogroup"
          aria-label="Show"
          data-palette-filters=""
          className="flex flex-wrap gap-1 px-2 pb-2"
        >
          {PALETTE_SCOPES.map((entry) => {
            const checked = entry.scope === scope;
            return (
              <button
                key={entry.scope}
                type="button"
                role="radio"
                aria-checked={checked}
                data-scope={entry.scope}
                tabIndex={checked ? 0 : -1}
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={() => {
                  changeScope(entry.scope);
                  inputRef.current?.focus();
                }}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs font-medium',
                  checked
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-foreground/25 text-popover-foreground hover:bg-accent',
                  FOCUS_RING,
                )}
              >
                {entry.label}
              </button>
            );
          })}
        </div>

        {/* Always in the page, so assistive technology hears how many results each search found. */}
        <p role="status" className="sr-only" data-palette-status="">
          {removed ?? (answer === null ? '' : resultsAnnouncement(results.length, mode, scope))}
        </p>

        <div className="min-h-0 flex-1 overflow-y-auto border-t px-2 py-1">
          <ul
            id={listId}
            role="listbox"
            aria-label="Results"
            hidden={results.length === 0}
            data-palette-results=""
            className="flex flex-col gap-0.5"
          >
            {results.map((result, index) => (
              <ResultOption
                key={result.pageId}
                id={optionId(index)}
                index={index}
                result={result}
                active={index === activeIndex}
                now={now}
                onPoint={point}
                onOpen={openResult}
              />
            ))}
          </ul>
          {answer !== null && results.length === 0 ? (
            <p
              data-palette-empty=""
              className="px-3 py-6 text-center text-sm text-popover-foreground/70"
            >
              {emptyMessage(mode)}
            </p>
          ) : null}
        </div>

        {debug && activeResult !== undefined ? <ScoreBreakdown result={activeResult} /> : null}

        <div className="flex items-center gap-2 border-t px-3 py-1.5 text-xs text-popover-foreground/70">
          <span data-palette-hint="" className="min-w-0 flex-1 truncate">
            {removed ?? FOOTER_HINT}
          </span>
          <button
            type="button"
            aria-pressed={debug}
            data-debug-toggle=""
            title="Show how each result was scored (Alt+S)"
            aria-keyshortcuts="Alt+S"
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={() => {
              setDebug((shown) => !shown);
              inputRef.current?.focus();
            }}
            className={cn(
              'shrink-0 rounded-md border px-2 py-0.5 text-xs font-medium',
              debug
                ? 'border-foreground bg-foreground text-background'
                : 'border-foreground/25 text-popover-foreground hover:bg-accent',
              FOCUS_RING,
            )}
          >
            Score details
          </button>
        </div>
      </div>
    </div>
  );
}
