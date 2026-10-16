import { AppWindow, ExternalLink, ShieldQuestionMark, X } from 'lucide-react';
import { Fragment, useRef, useState } from 'react';
import type { FocusEvent, ReactNode, RefObject } from 'react';
import type { LucideIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { FOCUS_RING } from '@/lib/focus';
import { cn } from '@/lib/utils';

import { dismissBlockedPopups, openBlockedPopup, respondToPrompt } from '../../state/commands';
import { useSelectedTab } from '../../state/workspace-store';
import { ToolbarButton } from '../toolbar/ToolbarButton';
import {
  DISMISS_LABEL,
  OPEN_POPUP_LABEL,
  activeStrip,
  blockedPopupsDisplay,
  promptActionLabels,
  promptSentence,
  rememberFor,
  rememberLabel,
  stripLabel,
} from './prompt-display';
import type {
  BlockedPopups,
  Prompt,
  PromptDecision,
  PromptPart,
  StripKind,
} from './prompt-display';

/**
 * The prompt strip: a row across the full width, directly under the toolbar, while the selected
 * tab has a question (a permission, or another app's link) or a blocked popup. It is part of the
 * chrome, so the content area is smaller while it shows and the page's view is placed below it
 * (`useContentInsets`): a web page is a native view above the shell and would cover anything
 * drawn over it (ADR-0006), and the question must never sit where the page can hide or imitate it
 * (threat T6).
 *
 * It renders what main reports and sends typed commands; all of its words come from
 * ./prompt-display.ts. It never takes keyboard focus on its own, as Chrome's don't: a keyboard
 * user reaches it with Tab from the address bar (F6 gets there from the page).
 */
export function PromptStrip() {
  const tab = useSelectedTab();
  const active = activeStrip(tab);
  if (tab === undefined || active === null) {
    return null;
  }
  // A question wins; the blocked-popup notice waits. Keyed by prompt: each question starts with
  // an unticked box, so "always allow" can't carry over to the next site or scheme.
  return active.kind === 'prompt' ? (
    <QuestionBar key={active.prompt.id} tabId={tab.id} prompt={active.prompt} />
  ) : (
    <BlockedPopupsBar key={tab.id} tabId={tab.id} blocked={active.blocked} />
  );
}

/**
 * Remembers the element keyboard focus came from when it entered the strip, so a keyboard answer
 * can return it there. A mouse answer doesn't: the shell then keeps whatever main's focus rules
 * give it, and focus never goes to the address bar uninvited.
 */
function useFocusReturn(): {
  readonly frame: RefObject<HTMLDivElement | null>;
  readonly noteFocus: (event: FocusEvent<HTMLElement>) => void;
  /**
   * Call from an answer's click handler, before the strip goes away. True for a keyboard answer,
   * whose focus the strip gave back itself; main then leaves focus alone (`keepFocus`). After a
   * mouse answer, main gives the page the keyboard.
   */
  readonly giveBack: () => boolean;
} {
  const frame = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  return {
    frame,
    noteFocus: (event) => {
      const from = event.relatedTarget;
      if (from instanceof Node && frame.current?.contains(from) === true) {
        return; // moving between the strip's own controls
      }
      // Entering from the page's side (no element), or from another control: forget the old one.
      returnTo.current = from instanceof HTMLElement ? from : null;
    },
    giveBack: () => {
      // Only a keyboard answer moves focus: the clicked button shows a focus ring then, and a
      // click with the mouse is not asking for it.
      const button = document.activeElement;
      if (
        !(button instanceof HTMLElement) ||
        frame.current?.contains(button) !== true ||
        !button.matches(':focus-visible')
      ) {
        return false;
      }
      const target = returnTo.current;
      const disabled = target !== null && 'disabled' in target && target.disabled === true;
      if (target !== null && target.isConnected && !disabled) {
        target.focus({ preventScroll: true });
      }
      return true;
    },
  };
}

function QuestionBar({ tabId, prompt }: { readonly tabId: string; readonly prompt: Prompt }) {
  const { frame, noteFocus, giveBack } = useFocusReturn();
  const [remember, setRemember] = useState(false);
  const labels = promptActionLabels(prompt.kind);
  const label = prompt.kind === 'external-protocol' ? rememberLabel(prompt) : null;

  const answer = (decision: PromptDecision): void => {
    const keepFocus = giveBack();
    // The box counts only for Open; Cancel and Dismiss never remember anything.
    void respondToPrompt(tabId, prompt.id, decision, rememberFor(decision, remember), {
      keepFocus,
    });
  };

  return (
    <StripFrame
      kind={prompt.kind}
      icon={prompt.kind === 'permission' ? ShieldQuestionMark : ExternalLink}
      frame={frame}
      onFocus={noteFocus}
      promptId={prompt.id}
      text={<Parts parts={promptSentence(prompt)} />}
      extra={
        label === null ? null : (
          <label className="flex items-center gap-1.5 text-xs text-foreground/80">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => {
                setRemember(event.target.checked);
              }}
              className={cn('size-3.5 rounded-sm accent-primary', FOCUS_RING)}
            />
            <span>
              <Parts parts={label} />
            </span>
          </label>
        )
      }
      actions={
        <>
          <StripButton
            variant="default"
            onClick={() => {
              answer('allow');
            }}
          >
            {labels.allow}
          </StripButton>
          <StripButton
            variant="outline"
            onClick={() => {
              answer('block');
            }}
          >
            {labels.block}
          </StripButton>
          <ToolbarButton
            label={DISMISS_LABEL}
            icon={X}
            size="compact"
            disabled={false}
            onClick={() => {
              answer('dismiss');
            }}
          />
        </>
      }
    />
  );
}

function BlockedPopupsBar({
  tabId,
  blocked,
}: {
  readonly tabId: string;
  readonly blocked: BlockedPopups;
}) {
  const { frame, noteFocus, giveBack } = useFocusReturn();
  const display = blockedPopupsDisplay(blocked);

  return (
    <StripFrame
      kind="blocked-popups"
      icon={AppWindow}
      frame={frame}
      onFocus={noteFocus}
      text={
        <>
          <span className="font-semibold">{display.headline}</span>
          {display.addressLead}
          <span className="text-foreground/70">
            <Parts parts={[display.address]} />
          </span>
        </>
      }
      extra={null}
      actions={
        <>
          <StripButton
            variant="outline"
            onClick={() => {
              giveBack();
              void openBlockedPopup(tabId);
            }}
          >
            {OPEN_POPUP_LABEL}
          </StripButton>
          <ToolbarButton
            label={DISMISS_LABEL}
            icon={X}
            size="compact"
            disabled={false}
            onClick={() => {
              void dismissBlockedPopups(tabId, { keepFocus: giveBack() });
            }}
          />
        </>
      }
    />
  );
}

interface StripFrameProps {
  readonly kind: StripKind;
  readonly icon: LucideIcon;
  readonly frame: RefObject<HTMLDivElement | null>;
  readonly onFocus: (event: FocusEvent<HTMLElement>) => void;
  /** For tests: the id of the question shown. */
  readonly promptId?: string;
  /** The sentence. It is the live text: assistive technology reads it when it appears or changes. */
  readonly text: ReactNode;
  readonly extra: ReactNode;
  readonly actions: ReactNode;
}

/** The row itself: an icon, the sentence, an optional extra control, and the buttons at the end. */
function StripFrame({
  kind,
  icon: Icon,
  frame,
  onFocus,
  promptId,
  text,
  extra,
  actions,
}: StripFrameProps) {
  return (
    <div
      ref={frame}
      role="region"
      aria-label={stripLabel(kind)}
      data-prompt-strip=""
      data-prompt-kind={kind}
      data-prompt-id={promptId}
      onFocus={onFocus}
      className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted py-1.5 pr-2 pl-4 select-none"
    >
      <Icon className="size-4 shrink-0 text-foreground/70" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1">
        <p aria-live="polite" aria-atomic="true" className="min-w-0 text-sm break-words">
          {text}
        </p>
        {extra}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
    </div>
  );
}

function StripButton({
  variant,
  onClick,
  children,
}: {
  readonly variant: 'default' | 'outline';
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant={variant}
      size="sm"
      onClick={onClick}
      className={cn('rounded-full px-3.5 focus-visible:border-transparent', FOCUS_RING)}
    >
      {children}
    </Button>
  );
}

/**
 * The runs of a sentence. Everything from outside goes in `<bdi dir="ltr">`, so bidirectional
 * text can't reorder the words around it; the whole text of a shortened one is its tooltip.
 */
function Parts({ parts }: { readonly parts: readonly PromptPart[] }) {
  return parts.map((part, index) =>
    part.untrusted ? (
      <bdi
        key={index}
        dir="ltr"
        title={part.full}
        className={part.strong ? 'font-semibold' : undefined}
      >
        {part.text}
      </bdi>
    ) : (
      <Fragment key={index}>{part.text}</Fragment>
    ),
  );
}
