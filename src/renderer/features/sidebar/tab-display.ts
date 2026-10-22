// What the sidebar shows for a tab, derived from its snapshot. Pure, so Vitest covers it.
import type { TabSnapshot } from '../../../shared/contracts/schemas';

interface DisplayableTab {
  /** Page-controlled text, already sanitized by main. May be empty. */
  readonly title: string;
  readonly address: { readonly text: string };
  readonly runtime: 'unloaded' | 'creating' | 'live' | 'frozen' | 'discarding' | 'crashed';
  readonly loading: boolean;
  readonly page: { readonly kind: 'web' } | { readonly kind: 'internal'; readonly name: string };
}

/** The tab's label: its title, else "New Tab" on the new-tab page, else its address, else "Untitled". */
export function tabLabel(tab: DisplayableTab): string {
  const title = tab.title.trim();
  if (title !== '') {
    return title;
  }
  if (tab.page.kind === 'internal' && tab.page.name === 'new-tab') {
    return 'New Tab';
  }
  const address = tab.address.text.trim();
  return address === '' ? 'Untitled' : address;
}

export type TabStatus = 'crashed' | 'failed' | 'loading';

/** The internal pages shown in place of a page that failed to load: the tab is "failed". */
const FAILED_PAGES: ReadonlySet<string> = new Set([
  'network-error',
  'certificate-error',
  'client-certificate',
]);

/** What a tab's leading icon signals, most urgent first. `null` means nothing special. */
export function tabStatus(tab: DisplayableTab): TabStatus | null {
  if (tab.runtime === 'crashed' || (tab.page.kind === 'internal' && tab.page.name === 'crashed')) {
    return 'crashed';
  }
  if (tab.page.kind === 'internal' && FAILED_PAGES.has(tab.page.name)) {
    return 'failed';
  }
  return tab.loading ? 'loading' : null;
}

/** The text equivalent of the status icon, for assistive technology. */
export const TAB_STATUS_TEXT: Readonly<Record<TabStatus, string>> = {
  crashed: 'Tab crashed',
  failed: 'Page failed to load',
  loading: 'Loading',
};

// ── What automation did to a tab (assessment §4.13) ─────────────────────────────────────────────

/** What a tab's lifecycle looks like from outside: enough to say, in plain words, what happened. */
interface LifecycleTab {
  readonly runtime: DisplayableTab['runtime'];
  /** Who unloaded the page, while it stays unloaded; null otherwise. */
  readonly unloadedBy: 'automation' | 'pressure' | 'user' | null;
  /** For a page memory pressure unloaded, how low memory was; null otherwise. */
  readonly unloadPressure: 'moderate' | 'critical' | null;
  /** The user protected the tab from automation. */
  readonly userProtected: boolean;
  readonly page: DisplayableTab['page'];
}

/** The line a protected tab adds to its tooltip and description. */
export const PROTECTED_TEXT = 'Protected from automation';

/** The line a tab on a protected site adds (§4.10 "Protected site"). */
export const SITE_PROTECTED_TEXT = 'Its site is protected from automation';

/** What a Sleeping row's tooltip starts with: clicking it is not a reload, it brings the tab back. */
export const SLEEPING_TEXT = 'Sleeping — click to bring it back to Tabs';

// ── Why: what automation observed, and what it did or would do (assessment §4.10, §4.13) ────────
//
// The UI never claims a tab is "safe". It says what Veltriva observed, in the present tense:
// "Kept awake: playing audio". Main already orders the reasons the way the sidebar names them.

/** One reason automation keeps a tab as it is, as main reports it (`TabSnapshot.keptAwake`). */
export type KeptAwakeReason = TabSnapshot['keptAwake'][number];
/** What automation would do to a tab if preview mode were over. */
export type PreviewMove = NonNullable<TabSnapshot['previewMove']>;
/** Who moved a Sleeping tab there. */
export type MovedBy = NonNullable<TabSnapshot['movedBy']>;

/** The "why" a tab's snapshot carries, apart from its lifecycle. */
interface WhyTab {
  readonly keptAwake: readonly KeptAwakeReason[];
  readonly previewMove: PreviewMove | null;
  /** For a Sleeping tab: who moved it there. Ignored anywhere else. */
  readonly movedBy: MovedBy | null;
}

/** What every "Kept awake" line starts with. */
export const KEPT_AWAKE_PREFIX = 'Kept awake: ';

/**
 * The words that follow "Kept awake: ", per reason. `null`: said somewhere else, so not here. The
 * user's own protection is the shield and `PROTECTED_TEXT`; a protected site has its own line.
 * (A Record over the reasons: a reason missing here fails the type check.)
 */
const KEPT_AWAKE_PHRASES: Readonly<Record<KeptAwakeReason, string | null>> = {
  'user-protected': null,
  'protected-site': null,
  fullscreen: 'in full screen',
  capture: 'using the camera or microphone',
  audio: 'playing audio',
  video: 'playing media',
  'page-unsaved-changes': 'page reported unsaved changes',
  'unsaved-input': 'unsaved text in a form',
  'open-popup': 'a sign-in or payment window is open',
  devtools: 'developer tools are open',
  editing: "you're editing",
  'sensitive-page': 'a password or payment page',
  notifications: 'the site can send you notifications',
  'background-activity': 'active in the background',
  // Main never reports this one (it is the policy's own guard, not an observation of the page),
  // but the type allows it, so it has words.
  'recent-interaction': 'you used it a moment ago',
};

/** A tooltip names at most this many reasons, then "and N more". A screen reader hears them all. */
export const TOOLTIP_REASONS = 3;

/** The phrases of the reasons that belong in a "Kept awake" line, once each, in order. */
function keptAwakePhrases(reasons: readonly KeptAwakeReason[]): string[] {
  const phrases: string[] = [];
  for (const reason of reasons) {
    const phrase = KEPT_AWAKE_PHRASES[reason];
    if (phrase !== null && !phrases.includes(phrase)) {
      phrases.push(phrase);
    }
  }
  return phrases;
}

/**
 * The "Kept awake: playing audio, in full screen" line, or null when no reason belongs in it.
 * With more than `limit` reasons it names the first `limit` and then "and N more" (never "and 1
 * more": naming that one is no longer than saying it is missing).
 */
export function keptAwakeLine(
  reasons: readonly KeptAwakeReason[],
  limit = Number.POSITIVE_INFINITY,
): string | null {
  const phrases = keptAwakePhrases(reasons);
  if (phrases.length === 0) {
    return null;
  }
  const most = Math.max(1, Math.floor(limit));
  const named = phrases.length > most + 1 ? phrases.slice(0, most) : phrases;
  const more = phrases.length - named.length;
  return `${KEPT_AWAKE_PREFIX}${named.join(', ')}${more > 0 ? `, and ${String(more)} more` : ''}`;
}

/**
 * The reasons as a row's `data-kept-awake` attribute holds them: the reason names, space-separated
 * (main's order, every one of them), or undefined for none so the attribute is left off.
 */
export function keptAwakeAttribute(reasons: readonly KeptAwakeReason[]): string | undefined {
  return reasons.length === 0 ? undefined : reasons.join(' ');
}

/** The site-protection line, or null: the tab's site is on the user's list of protected sites. */
export function siteProtectedLine(reasons: readonly KeptAwakeReason[]): string | null {
  return reasons.includes('protected-site') ? SITE_PROTECTED_TEXT : null;
}

/**
 * Preview mode (§4.13): automation marks what it would move without moving it. The words of that
 * mark, for a tooltip, a description and the marker's accessible name; null for no mark.
 */
export function previewLine(move: PreviewMove | null): string | null {
  switch (move) {
    case 'shelve':
      return 'Preview: would move to Sleeping';
    case 'archive':
      return 'Preview: would be archived';
    case null:
      return null;
  }
}

/** For a Sleeping row: who put the tab there. Null when it is not known. */
export function movedByLine(movedBy: MovedBy | null): string | null {
  switch (movedBy) {
    case 'automation':
      return 'Moved here by automation';
    case 'user':
      return 'You moved it here';
    case null:
      return null;
  }
}

/** What happened to the tab, and what a click does about it. */
interface LifecycleLine {
  readonly what: string;
  /** Null when there is nothing to click for (the tab is being unloaded, or paused). */
  readonly hint: string | null;
}

function unloadedLine(tab: LifecycleTab): LifecycleLine | null {
  switch (tab.unloadedBy) {
    case 'automation':
      return { what: 'Unloaded to save memory', hint: 'click to reload' };
    case 'pressure':
      // Say plainly that it was memory pressure, not the user's habits or a timer, and how bad.
      return {
        what:
          tab.unloadPressure === 'critical'
            ? 'Unloaded because memory was very low'
            : 'Unloaded because memory was low',
        hint: 'click to reload',
      };
    case 'user':
      return { what: 'Unloaded', hint: 'click to reload' };
    case null:
      // An internal page has nothing to load, so it has nothing to say.
      return tab.page.kind === 'web' ? { what: 'Not loaded yet', hint: 'click to load' } : null;
  }
}

function lifecycleLine(tab: LifecycleTab): LifecycleLine | null {
  if (tab.runtime === 'crashed' || (tab.page.kind === 'internal' && tab.page.name === 'crashed')) {
    return { what: 'This page stopped working', hint: 'click to reload' };
  }
  switch (tab.runtime) {
    case 'discarding':
      return { what: 'Unloading…', hint: null };
    case 'frozen':
      return { what: 'Paused in the background', hint: null };
    case 'unloaded':
      return unloadedLine(tab);
    case 'creating':
    case 'live':
      return null;
  }
}

/**
 * The tab's lifecycle in a sentence, with what a click does ("Unloaded to save memory — click to
 * reload"), or null when there is nothing to say. `withHint: false` leaves the click out, for a
 * Sleeping row, where a click brings the tab back to Tabs whatever its page is doing.
 */
export function lifecycleStatus(tab: LifecycleTab, withHint = true): string | null {
  const line = lifecycleLine(tab);
  if (line === null) {
    return null;
  }
  return withHint && line.hint !== null ? `${line.what} — ${line.hint}` : line.what;
}

/** Line breaks in all their forms, and the other controls (a tab stop) that have no place in a line. */
const LINE_BREAKS = /[\p{Cc}\p{Zl}\p{Zp}]+/gu;

interface TooltipTab extends DisplayableTab, LifecycleTab, WhyTab {}

/**
 * A tab's tooltip: its label first, then one line each for the Sleeping hint and who moved the
 * tab there, the lifecycle status, the protections, what keeps it awake (at most
 * `TOOLTIP_REASONS` of them) and the preview mark. With nothing to add it is the label alone, as
 * it always was. The label is the page's own text, so its line breaks are folded into spaces: it
 * cannot fake a line of ours.
 */
export function tabTooltip(tab: TooltipTab, options: { readonly sleeping?: boolean } = {}): string {
  const sleeping = options.sleeping === true;
  const lines = [tabLabel(tab).replace(LINE_BREAKS, ' ')];
  const add = (line: string | null): void => {
    if (line !== null) {
      lines.push(line);
    }
  };
  if (sleeping) {
    lines.push(SLEEPING_TEXT);
    add(movedByLine(tab.movedBy));
  }
  add(lifecycleStatus(tab, !sleeping));
  if (tab.userProtected) {
    lines.push(PROTECTED_TEXT);
  }
  add(siteProtectedLine(tab.keptAwake));
  add(keptAwakeLine(tab.keptAwake, TOOLTIP_REASONS));
  add(previewLine(tab.previewMove));
  return lines.join('\n');
}

export type TabDescriptionKey =
  | 'pinned'
  | 'status'
  | 'sleeping'
  | 'moved'
  | 'lifecycle'
  | 'protected'
  | 'site-protected'
  | 'kept-awake'
  | 'preview';

export interface TabDescription {
  readonly key: TabDescriptionKey;
  readonly text: string;
}

interface DescribedTab extends TooltipTab {
  readonly pinned: boolean;
}

/**
 * What assistive technology hears after a tab's label, in order. The tooltip's lines are here too
 * (a tooltip is for the mouse), minus the label, except that every reason that keeps the tab awake
 * is named, not just the first few. A crash is said once: the lifecycle sentence replaces "Tab
 * crashed".
 */
export function tabDescriptions(
  tab: DescribedTab,
  options: { readonly sleeping?: boolean } = {},
): readonly TabDescription[] {
  const sleeping = options.sleeping === true;
  const descriptions: TabDescription[] = [];
  const add = (key: TabDescriptionKey, text: string | null): void => {
    if (text !== null) {
      descriptions.push({ key, text });
    }
  };
  if (tab.pinned && !sleeping) {
    add('pinned', 'Pinned');
  }
  if (sleeping) {
    add('sleeping', SLEEPING_TEXT);
    add('moved', movedByLine(tab.movedBy));
  }
  const lifecycle = lifecycleStatus(tab, !sleeping);
  const status = tabStatus(tab);
  if (status !== null && !(status === 'crashed' && lifecycle !== null)) {
    add('status', TAB_STATUS_TEXT[status]);
  }
  add('lifecycle', lifecycle);
  if (tab.userProtected) {
    add('protected', PROTECTED_TEXT);
  }
  add('site-protected', siteProtectedLine(tab.keptAwake));
  add('kept-awake', keptAwakeLine(tab.keptAwake));
  add('preview', previewLine(tab.previewMove));
  return descriptions;
}

interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * Where a tab's context menu opens: at the pointer for a right-click, or below the tab's label
 * when the keyboard asked (the Menu key or Shift+F10 report a point that may be outside the tab,
 * often 0,0). Never negative: the command accepts only points in the window.
 */
export function tabMenuPoint(tab: Box, clientX: number, clientY: number): { x: number; y: number } {
  const inside =
    clientX >= tab.left && clientX <= tab.right && clientY >= tab.top && clientY <= tab.bottom;
  const point = inside ? { x: clientX, y: clientY } : { x: tab.left + 12, y: tab.bottom };
  return { x: Math.max(0, point.x), y: Math.max(0, point.y) };
}
