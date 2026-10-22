import {
  AppWindow,
  ExternalLink,
  KeyRound,
  LogOut,
  ShieldQuestionMark,
  TriangleAlert,
  X,
} from 'lucide-react';
import { Fragment, useEffect, useRef, useState } from 'react';
import type { FocusEvent, ReactNode, RefObject, SubmitEvent } from 'react';
import type { LucideIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { FOCUS_RING } from '@/lib/focus';
import { cn } from '@/lib/utils';

import {
  dismissBlockedPopups,
  openBlockedPopup,
  respondToPrompt,
  signInToPrompt,
} from '../../state/commands';
import { useSelectedTab } from '../../state/workspace-store';
import { ToolbarButton } from '../toolbar/ToolbarButton';
import {
  DISMISS_LABEL,
  OPEN_POPUP_LABEL,
  activeStrip,
  blockedPopupsDisplay,
  insecureSignInWarning,
  promptActionLabels,
  promptSentence,
  realmLine,
  rememberFor,
  rememberLabel,
  stripLabel,
} from './prompt-display';
import type {
  BlockedPopups,
  HttpAuthPrompt,
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
 * user reaches it with Tab from the address bar (F6 gets there from the page). The one exception
 * is the sign-in form, whose username field takes the keyboard when it appears: the user came to
 * sign in, and the form is useless without typing.
 */
export function PromptStrip() {
  const tab = useSelectedTab();
  const active = activeStrip(tab);
  if (tab === undefined || active === null) {
    return null;
  }
  // A question wins; the blocked-popup notice waits. Keyed by prompt: each question starts with
  // an unticked box and empty sign-in fields, so "always allow" can't carry over to the next site
  // or scheme, and what was typed for one server is never offered to the next.
  if (active.kind === 'blocked-popups') {
    return <BlockedPopupsBar key={tab.id} tabId={tab.id} blocked={active.blocked} />;
  }
  return active.prompt.kind === 'http-auth' ? (
    <SignInBar key={active.prompt.id} tabId={tab.id} prompt={active.prompt} />
  ) : (
    <QuestionBar key={active.prompt.id} tabId={tab.id} prompt={active.prompt} />
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
   * Call from an answer's click handler, before the strip goes away. True for a keyboard answer
   * whose focus the strip gave back itself; main then leaves focus alone (`keepFocus`). After a
   * mouse answer, or when there is nowhere to give it back to (the keyboard came from the page's
   * side), main gives the page the keyboard.
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
      if (target === null || !target.isConnected || disabled) {
        return false;
      }
      target.focus({ preventScroll: true });
      return true;
    },
  };
}

function QuestionBar({
  tabId,
  prompt,
}: {
  readonly tabId: string;
  readonly prompt: Exclude<Prompt, HttpAuthPrompt>;
}) {
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
      icon={QUESTION_ICONS[prompt.kind]}
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

const QUESTION_ICONS: Record<Exclude<Prompt, HttpAuthPrompt>['kind'], LucideIcon> = {
  permission: ShieldQuestionMark,
  'external-protocol': ExternalLink,
  'leave-page': LogOut,
};

const SIGN_IN_FIELD = cn(
  'h-8 w-44 min-w-0 rounded-full border border-input bg-background px-3 text-sm text-foreground placeholder:text-foreground/60',
  FOCUS_RING,
);

/**
 * The HTTP sign-in form: a username and a password for the server named in the sentence, under
 * which the server's own words for what it asks (the realm) are shown as untrusted text. Enter
 * sends it, and an address that isn't HTTPS gets a plain warning.
 *
 * What is typed lives only in this component's state, for as long as it takes to send it: it is
 * cleared right after sending or cancelling, never logged, and kept out of every store. Main hands
 * it to Chromium once and keeps nothing (src/main/auth/sign-in.ts).
 */
function SignInBar({ tabId, prompt }: { readonly tabId: string; readonly prompt: HttpAuthPrompt }) {
  const { frame, noteFocus, giveBack } = useFocusReturn();
  const usernameField = useRef<HTMLInputElement>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const labels = promptActionLabels(prompt.kind);
  const realm = realmLine(prompt);
  const warning = insecureSignInWarning(prompt);
  const textId = `sign-in-text-${prompt.id}`;

  // The one question that takes the keyboard when it appears: the user came to sign in. The strip
  // is keyed by prompt, so this runs once per question, and the focus return remembers where the
  // keyboard came from. This is the DOM focus only: the shell's view must also hold the window's
  // keyboard focus for typing to reach it, and giving it that is main's call (FocusManager).
  useEffect(() => {
    usernameField.current?.focus({ preventScroll: true });
  }, []);

  const forget = (): void => {
    setUsername('');
    setPassword('');
  };

  const signIn = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const keepFocus = giveBack();
    void signInToPrompt(tabId, prompt.id, { username, password }, { keepFocus });
    forget();
  };

  const answer = (decision: PromptDecision): void => {
    const keepFocus = giveBack();
    forget();
    void respondToPrompt(tabId, prompt.id, decision, false, { keepFocus });
  };

  return (
    <form onSubmit={signIn} noValidate autoComplete="off">
      <StripFrame
        kind={prompt.kind}
        icon={KeyRound}
        frame={frame}
        onFocus={noteFocus}
        promptId={prompt.id}
        textId={textId}
        text={
          <>
            <Parts parts={promptSentence(prompt)} />
            {realm === null ? null : (
              <span data-sign-in-realm="" className="block text-xs text-foreground/70">
                <Parts parts={realm} />
              </span>
            )}
            {warning === null ? null : (
              <span
                data-sign-in-warning=""
                className="mt-0.5 flex items-center gap-1 text-xs font-medium text-red-700 dark:text-red-400"
              >
                <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
                {warning}
              </span>
            )}
          </>
        }
        extra={
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={usernameField}
              type="text"
              name="username"
              aria-label="Username"
              aria-describedby={textId}
              placeholder="Username"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              maxLength={1024}
              value={username}
              onChange={(event) => {
                setUsername(event.target.value);
              }}
              className={SIGN_IN_FIELD}
            />
            <input
              type="password"
              name="password"
              aria-label="Password"
              aria-describedby={textId}
              placeholder="Password"
              autoComplete="off"
              maxLength={1024}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
              className={SIGN_IN_FIELD}
            />
          </div>
        }
        actions={
          <>
            <StripButton variant="default" type="submit">
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
    </form>
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
  /** The sentence's DOM id, for a field to point its description at. */
  readonly textId?: string;
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
  textId,
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
        <p
          id={textId}
          aria-live="polite"
          aria-atomic="true"
          className="min-w-0 text-sm break-words"
        >
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
  type = 'button',
  onClick,
  children,
}: {
  readonly variant: 'default' | 'outline';
  /** `submit` sends the sign-in form, and so does Enter in its fields. */
  readonly type?: 'button' | 'submit';
  readonly onClick?: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Button
      type={type}
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
