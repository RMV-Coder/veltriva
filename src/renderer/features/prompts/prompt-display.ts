// What the prompt strip says, derived from the selected tab's prompt or blocked popups. Pure, so
// Vitest covers it; the components only render what this returns.
//
// These are security rules (threat T6, ADR-0002 §4). The strip is the one place the browser asks
// the user about a site, so a page must not be able to make it read as another site:
//   - The site is cut at its START when it is too long, never at the end. The registrable domain
//     is at the end of a host, so cutting there would let `accounts.google.com.evil.example` read
//     as google.com. The full text stays available for a tooltip.
//   - Every piece of text that doesn't come from this file is a "part" with `untrusted` set. The
//     component renders those in `<bdi dir="ltr">`, so bidirectional text can't reorder the
//     sentence around it. Controls and invisible formatting (bidi overrides included) are removed
//     here as well, because `<bdi>` isolates a run from the words around it, not from an override
//     inside it. Main already cleans these; this is the second line of defense.
//   - The blocked popup's address may be cut at the end, because its host comes first.
import type { CommandInput, TabSnapshot } from '../../../shared/contracts/schemas';

export type Prompt = NonNullable<TabSnapshot['prompt']>;
export type PermissionPrompt = Extract<Prompt, { readonly kind: 'permission' }>;
export type ExternalProtocolPrompt = Extract<Prompt, { readonly kind: 'external-protocol' }>;
export type HttpAuthPrompt = Extract<Prompt, { readonly kind: 'http-auth' }>;
export type LeavePagePrompt = Extract<Prompt, { readonly kind: 'leave-page' }>;
export type BlockedPopups = NonNullable<TabSnapshot['blockedPopups']>;
type Permission = PermissionPrompt['permissions'][number];

/** Which of the four strips shows. It is `data-prompt-kind` and chooses the region's name. */
export type StripKind = Prompt['kind'] | 'blocked-popups';

/** The sentence is shown with the site at most this many characters long, ellipsis included. */
export const MAX_SITE_CHARS = 60;
/** A blocked popup's address is shown with at most this many characters, ellipsis included. */
export const MAX_POPUP_ADDRESS_CHARS = 80;
/** A server's realm is shown with at most this many characters (main already stops at 100). */
export const MAX_REALM_CHARS = 100;
/** Shown when there is no site text at all; main's own fallback label for an unknown page. */
const UNKNOWN_SITE = 'This page';

const ELLIPSIS = '…';
/** Controls and invisible formatting (bidi overrides and isolates, zero-width marks). */
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** Removes what must never reach the screen and tidies spaces. */
export function cleanText(text: string): string {
  return text.replace(UNSAFE_TEXT, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The last `maxChars` characters, behind an ellipsis, when the text is longer. For a site: the
 * end of a host is the part that says who it is. Counts characters (code points), so a pair of
 * surrogates is never split, and the result, ellipsis included, is `maxChars` long.
 */
export function truncateStart(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) {
    return text;
  }
  if (maxChars < 1) {
    return '';
  }
  return ELLIPSIS + chars.slice(chars.length - (maxChars - 1)).join('');
}

/** The first `maxChars` characters, followed by an ellipsis, when the text is longer. */
export function truncateEnd(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) {
    return text;
  }
  if (maxChars < 1) {
    return '';
  }
  return chars.slice(0, maxChars - 1).join('') + ELLIPSIS;
}

/** One run of the sentence. */
export interface PromptPart {
  readonly text: string;
  /** From a page, the registry or the network: render it in `<bdi dir="ltr">`. */
  readonly untrusted: boolean;
  /** The subject of the sentence: bold. */
  readonly strong: boolean;
  /** The whole text, when `text` is a shortened form of it: the tooltip. */
  readonly full?: string;
}

function plain(text: string): PromptPart {
  return { text, untrusted: false, strong: false };
}

function untrustedPart(
  text: string,
  options: { readonly strong: boolean; readonly full?: string | undefined },
): PromptPart {
  const base = { text, untrusted: true, strong: options.strong };
  return options.full === undefined ? base : { ...base, full: options.full };
}

/** The site that asks, cut at the start if it is long. */
function sitePart(site: string, strong: boolean): PromptPart {
  const full = cleanText(site) || UNKNOWN_SITE;
  const text = truncateStart(full, MAX_SITE_CHARS);
  return untrustedPart(text, { strong, full: text === full ? undefined : full });
}

/** The scheme of an external link. Main's contract already limits it to a short ASCII name. */
function schemePart(scheme: string): PromptPart {
  return untrustedPart(cleanText(scheme), { strong: false });
}

/** The text of a sentence, as plain text: what assistive technology reads, and what tests check. */
export function partsText(parts: readonly PromptPart[]): string {
  return parts.map((part) => part.text).join('');
}

const PERMISSION_ORDER: readonly Permission[] = [
  'camera',
  'microphone',
  'geolocation',
  'notifications',
  'clipboard-read',
];

const PERMISSION_PHRASES: Readonly<Record<Permission, string>> = {
  camera: 'use your camera',
  microphone: 'use your microphone',
  geolocation: 'know your location',
  notifications: 'show notifications',
  'clipboard-read': 'see text and images you copied',
};

const CAMERA_AND_MICROPHONE = 'use your camera and microphone';

/**
 * What the page asks to do, in a fixed order whatever order it asked in: "use your camera and
 * microphone", "know your location", or several joined naturally.
 */
export function permissionPhrase(permissions: readonly Permission[]): string {
  const asked = new Set(permissions);
  const phrases: string[] = [];
  for (const permission of PERMISSION_ORDER) {
    if (!asked.has(permission)) {
      continue;
    }
    if (permission === 'microphone' && asked.has('camera')) {
      continue; // said together with the camera
    }
    phrases.push(
      permission === 'camera' && asked.has('microphone')
        ? CAMERA_AND_MICROPHONE
        : PERMISSION_PHRASES[permission],
    );
  }
  return joinPhrases(phrases);
}

function joinPhrases(phrases: readonly string[]): string {
  const last = phrases.at(-1);
  if (last === undefined) {
    return 'use a feature that needs your permission';
  }
  const head = phrases.slice(0, -1);
  if (head.length === 0) {
    return last;
  }
  // A comma before the last "and" keeps "camera and microphone, and know your location" clear.
  const comma = phrases.length >= 3 || phrases.some((phrase) => phrase.includes(' and '));
  return `${head.join(', ')}${comma ? ',' : ''} and ${last}`;
}

/** The strip's sentence for a prompt, as parts. */
export function promptSentence(prompt: Prompt): readonly PromptPart[] {
  if (prompt.kind === 'permission') {
    return [
      sitePart(prompt.site, true),
      plain(` wants to ${permissionPhrase(prompt.permissions)}`),
    ];
  }
  if (prompt.kind === 'http-auth') {
    return [sitePart(prompt.site, true), plain(' wants you to sign in')];
  }
  if (prompt.kind === 'leave-page') {
    // The page's own words are never shown: Chromium ignores them too.
    return [
      plain('Leave '),
      sitePart(prompt.site, true),
      plain('? Changes you made may not be saved.'),
    ];
  }
  const appName = cleanText(prompt.appName);
  if (prompt.site === null) {
    // A typed address: nobody asks, so no site is named.
    return appName === ''
      ? [plain('Open this “'), schemePart(prompt.scheme), plain(':” link in another app?')]
      : [plain('Open '), untrustedPart(appName, { strong: true }), plain('?')];
  }
  return appName === ''
    ? [
        sitePart(prompt.site, true),
        plain(' wants to open a “'),
        schemePart(prompt.scheme),
        plain(':” link in another app'),
      ]
    : [
        sitePart(prompt.site, true),
        plain(' wants to open '),
        untrustedPart(appName, { strong: true }),
      ];
}

/**
 * The label of "always allow this site", or null when it isn't offered: main says whether it can
 * be (`canRemember`), and it needs a site to name.
 */
export function rememberLabel(prompt: ExternalProtocolPrompt): readonly PromptPart[] | null {
  if (!prompt.canRemember || prompt.site === null) {
    return null;
  }
  return [
    plain('Always allow '),
    sitePart(prompt.site, false),
    plain(' to open '),
    schemePart(prompt.scheme),
    plain(': links'),
  ];
}

export type PromptDecision = CommandInput<'prompts.respond'>['decision'];

/** The checkbox counts only for Open: Cancel and Dismiss never remember anything. */
export function rememberFor(decision: PromptDecision, checked: boolean): boolean {
  return decision === 'allow' && checked;
}

/**
 * The line under a sign-in question: what the server calls the thing to sign in to, in its own
 * words ("The server says: “Staff area”"). The realm is the server's text, so it is cleaned and
 * marked untrusted; null when the server said nothing worth showing.
 */
export function realmLine(prompt: HttpAuthPrompt): readonly PromptPart[] | null {
  const full = cleanText(prompt.realm);
  if (full === '') {
    return null;
  }
  const text = truncateEnd(full, MAX_REALM_CHARS);
  return [
    plain('The server says: “'),
    untrustedPart(text, { strong: false, full: text === full ? undefined : full }),
    plain('”'),
  ];
}

/** The warning on a sign-in question for an address that isn't HTTPS, or null when it is safe. */
export const INSECURE_SIGN_IN_WARNING = 'Your password will be sent unencrypted';

export function insecureSignInWarning(prompt: HttpAuthPrompt): string | null {
  return prompt.secure ? null : INSECURE_SIGN_IN_WARNING;
}

/** The button names. Dismiss is the same for every strip. */
export function promptActionLabels(kind: Prompt['kind']): {
  readonly allow: string;
  readonly block: string;
} {
  switch (kind) {
    case 'permission':
      return { allow: 'Allow', block: 'Block' };
    case 'http-auth':
      return { allow: 'Sign in', block: 'Cancel' };
    case 'external-protocol':
      return { allow: 'Open', block: 'Cancel' };
    case 'leave-page':
      return { allow: 'Leave', block: 'Stay' };
  }
}

export const DISMISS_LABEL = 'Dismiss';
export const OPEN_POPUP_LABEL = 'Open pop-up';

/** The region's accessible name. */
export function stripLabel(kind: StripKind): string {
  switch (kind) {
    case 'permission':
      return 'Permission request';
    case 'external-protocol':
      return 'Open another app';
    case 'http-auth':
      return 'Sign in';
    case 'leave-page':
      return 'Leave page';
    case 'blocked-popups':
      return 'Pop-up blocked';
  }
}

export interface BlockedPopupsDisplay {
  /** "Pop-up blocked", or "3 pop-ups blocked". */
  readonly headline: string;
  /** Joins the headline to the address; with several blocked it says the address is the latest. */
  readonly addressLead: string;
  readonly address: PromptPart;
}

/** The blocked-popup notice: the count, and the latest address cut at its end. */
export function blockedPopupsDisplay(blocked: BlockedPopups): BlockedPopupsDisplay {
  const full = cleanText(blocked.latest);
  const text = truncateEnd(full, MAX_POPUP_ADDRESS_CHARS);
  return {
    headline: blocked.count === 1 ? 'Pop-up blocked' : `${String(blocked.count)} pop-ups blocked`,
    addressLead: blocked.count === 1 ? ': ' : '. Latest: ',
    address: untrustedPart(text, { strong: false, full: text === full ? undefined : full }),
  };
}

interface StripSource {
  readonly prompt: Prompt | null;
  readonly blockedPopups: BlockedPopups | null;
}

export type ActiveStrip =
  | { readonly kind: 'prompt'; readonly prompt: Prompt }
  | { readonly kind: 'blocked-popups'; readonly blocked: BlockedPopups };

/** What the strip shows for a tab: a question wins, and the blocked-popup notice waits behind it. */
export function activeStrip(tab: StripSource | undefined): ActiveStrip | null {
  if (tab === undefined) {
    return null;
  }
  if (tab.prompt !== null) {
    return { kind: 'prompt', prompt: tab.prompt };
  }
  if (tab.blockedPopups !== null) {
    return { kind: 'blocked-popups', blocked: tab.blockedPopups };
  }
  return null;
}
