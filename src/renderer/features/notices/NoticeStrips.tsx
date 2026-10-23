import { CircleArrowUp, DatabaseBackup, History, ShieldAlert, TriangleAlert } from 'lucide-react';
import { Fragment, useRef } from 'react';
import type { FocusEvent } from 'react';

import { Button } from '@/components/ui/button';
import { FOCUS_RING } from '@/lib/focus';
import { cn } from '@/lib/utils';

import { openReleasePage, skipUpdate } from '../../state/commands';
import { useWorkspaceStore } from '../../state/workspace-store';
import { DISMISS_LABEL } from '../prompts/prompt-display';
import { dismissNotice } from './dismiss-notice';
import { noticeLabel, noticeSentence } from './notice-display';
import type { Notice, NoticePart } from './notice-display';

const NO_NOTICES: readonly Notice[] = [];

/** Veltriva's own notices, oldest first. The same array until the next snapshot. */
/** One icon per kind of notice. */
const NOTICE_ICONS = {
  'database-restored': DatabaseBackup,
  'database-reset': TriangleAlert,
  'session-recovered': History,
  'safe-mode': ShieldAlert,
  'update-available': CircleArrowUp,
} as const satisfies Record<Notice['kind'], unknown>;

function useNotices(): readonly Notice[] {
  return useWorkspaceStore((state) => state.snapshot?.notices ?? NO_NOTICES);
}

/**
 * The notice strips: one row each, across the full width, under the toolbar and its prompt strip,
 * for as long as main lists the notice. They tell the user something about Veltriva itself (the
 * database was damaged and had to be restored), not about a page, so they show whichever tab is
 * selected and only the user's Dismiss ends them. They are part of the chrome, so the content area
 * is smaller while one shows and the page's view is placed below it (`useContentInsets`): a web
 * page is a native view above the shell and would cover anything drawn over it (ADR-0006).
 *
 * It renders what main reports and sends a dismissal by id; all of its words come from
 * ./notice-display.ts. It never takes keyboard focus on its own: a keyboard user reaches Dismiss
 * with Tab from the toolbar, as with the prompt strip. After a keyboard Dismiss the button is
 * about to go, so focus moves first, to the next notice's button or else back to where it came
 * from, and never falls to the page behind. After a click it stays where it is: the user's
 * keyboard is theirs, and a notice isn't a question about the page.
 */
export function NoticeStrips() {
  const notices = useNotices();
  const frame = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  if (notices.length === 0) {
    return null;
  }

  /** Remembers the element focus came from when it entered the strips, for a keyboard Dismiss. */
  const noteFocus = (event: FocusEvent<HTMLElement>): void => {
    const from = event.relatedTarget;
    if (from instanceof Node && frame.current?.contains(from) === true) {
      return; // moving between the strips' own buttons
    }
    // Entering from the page's side (no element), or from another control: forget the old one.
    returnTo.current = from instanceof HTMLElement ? from : null;
  };

  const dismiss = (noticeId: string, button: HTMLElement): void => {
    // Only a keyboard Dismiss shows a focus ring on the button, and only then must focus be kept.
    if (button.matches(':focus-visible')) {
      moveFocusAway(button, returnTo.current);
    }
    void dismissNotice(noticeId);
  };

  return (
    <div ref={frame} data-notice-strips="" onFocus={noteFocus}>
      {notices.map((notice) => (
        <NoticeStrip key={notice.id} notice={notice} onDismiss={dismiss} />
      ))}
    </div>
  );
}

/**
 * Moves keyboard focus off a Dismiss button that is about to disappear: to the next notice's
 * button, else the previous one's, else back to the element focus came from if it is still there.
 * When there is nowhere to give it, focus stays put and Chromium carries on from where the button
 * was, which is under the toolbar and not in the page.
 */
function moveFocusAway(button: HTMLElement, origin: HTMLElement | null): void {
  const row = button.closest('[data-notice-strip]');
  const neighbor = row?.nextElementSibling ?? row?.previousElementSibling ?? null;
  const next = neighbor?.querySelector('button') ?? null;
  if (next !== null) {
    next.focus({ preventScroll: true });
    return;
  }
  const disabled = origin !== null && 'disabled' in origin && origin.disabled === true;
  if (origin !== null && origin.isConnected && !disabled) {
    origin.focus({ preventScroll: true });
  }
}

function NoticeStrip({
  notice,
  onDismiss,
}: {
  readonly notice: Notice;
  readonly onDismiss: (noticeId: string, button: HTMLElement) => void;
}) {
  const textId = `notice-text-${notice.id}`;
  // The restore went well; a reset lost the user's data, so it gets the warning sign.
  const Icon = NOTICE_ICONS[notice.kind];

  return (
    <div
      role="region"
      aria-label={noticeLabel(notice.kind)}
      data-notice-strip=""
      data-notice-kind={notice.kind}
      data-notice-id={notice.id}
      className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted py-1.5 pr-2 pl-4 select-none"
    >
      <Icon className="size-4 shrink-0 text-foreground/70" aria-hidden="true" />
      {/* The sentence is the live text, and selectable: the user may want the file name. */}
      <p
        id={textId}
        aria-live="polite"
        aria-atomic="true"
        className="min-w-0 flex-1 text-sm break-words select-text"
      >
        <Parts parts={noticeSentence(notice)} />
      </p>
      {notice.kind === 'update-available' ? (
        <>
          {/* Main opens the release page it read from the feed: the shell never names a URL. */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-notice-action="view-release"
            aria-describedby={textId}
            onClick={() => {
              void openReleasePage();
            }}
            className={cn(
              'shrink-0 rounded-full px-3.5 focus-visible:border-transparent',
              FOCUS_RING,
            )}
          >
            View release
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-notice-action="skip-version"
            aria-describedby={textId}
            onClick={(event) => {
              void skipUpdate(notice.version);
              onDismiss(notice.id, event.currentTarget);
            }}
            className={cn(
              'shrink-0 rounded-full px-3.5 focus-visible:border-transparent',
              FOCUS_RING,
            )}
          >
            Skip this version
          </Button>
        </>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-describedby={textId}
        onClick={(event) => {
          onDismiss(notice.id, event.currentTarget);
        }}
        className={cn('shrink-0 rounded-full px-3.5 focus-visible:border-transparent', FOCUS_RING)}
      >
        {DISMISS_LABEL}
      </Button>
    </div>
  );
}

/**
 * The runs of a sentence. Everything from outside goes in `<bdi dir="ltr">`, so bidirectional
 * text can't reorder the words around it; the whole text of a shortened one is its tooltip.
 */
function Parts({ parts }: { readonly parts: readonly NoticePart[] }) {
  return parts.map((part, index) =>
    part.untrusted ? (
      <bdi key={index} dir="ltr" title={part.full}>
        {part.text}
      </bdi>
    ) : (
      <Fragment key={index}>{part.text}</Fragment>
    ),
  );
}
