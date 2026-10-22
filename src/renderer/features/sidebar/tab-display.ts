// What the sidebar shows for a tab, derived from its snapshot. Pure, so Vitest covers it.

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
  /** The user protected the tab from automation. */
  readonly userProtected: boolean;
  readonly page: DisplayableTab['page'];
}

/** The line a protected tab adds to its tooltip and description. */
export const PROTECTED_TEXT = 'Protected from automation';

/** What a Sleeping row's tooltip starts with: clicking it is not a reload, it brings the tab back. */
export const SLEEPING_TEXT = 'Sleeping — click to bring it back to Tabs';

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
      // Say plainly that it was memory pressure, not the user's habits or a timer.
      return { what: 'Unloaded because memory was low', hint: 'click to reload' };
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

interface TooltipTab extends DisplayableTab, LifecycleTab {}

/**
 * A tab's tooltip: its label first, then one line each for the Sleeping hint, the lifecycle status
 * and the protection. With nothing to add it is the label alone, as it always was. The label is
 * the page's own text, so its line breaks are folded into spaces: it cannot fake a line of ours.
 */
export function tabTooltip(tab: TooltipTab, options: { readonly sleeping?: boolean } = {}): string {
  const sleeping = options.sleeping === true;
  const lines = [tabLabel(tab).replace(LINE_BREAKS, ' ')];
  if (sleeping) {
    lines.push(SLEEPING_TEXT);
  }
  const status = lifecycleStatus(tab, !sleeping);
  if (status !== null) {
    lines.push(status);
  }
  if (tab.userProtected) {
    lines.push(PROTECTED_TEXT);
  }
  return lines.join('\n');
}

export type TabDescriptionKey = 'pinned' | 'status' | 'sleeping' | 'lifecycle' | 'protected';

export interface TabDescription {
  readonly key: TabDescriptionKey;
  readonly text: string;
}

interface DescribedTab extends TooltipTab {
  readonly pinned: boolean;
}

/**
 * What assistive technology hears after a tab's label, in order. The tooltip's lines are here too
 * (a tooltip is for the mouse), minus the label. A crash is said once: the lifecycle sentence
 * replaces "Tab crashed".
 */
export function tabDescriptions(
  tab: DescribedTab,
  options: { readonly sleeping?: boolean } = {},
): readonly TabDescription[] {
  const sleeping = options.sleeping === true;
  const descriptions: TabDescription[] = [];
  if (tab.pinned && !sleeping) {
    descriptions.push({ key: 'pinned', text: 'Pinned' });
  }
  if (sleeping) {
    descriptions.push({ key: 'sleeping', text: SLEEPING_TEXT });
  }
  const lifecycle = lifecycleStatus(tab, !sleeping);
  const status = tabStatus(tab);
  if (status !== null && !(status === 'crashed' && lifecycle !== null)) {
    descriptions.push({ key: 'status', text: TAB_STATUS_TEXT[status] });
  }
  if (lifecycle !== null) {
    descriptions.push({ key: 'lifecycle', text: lifecycle });
  }
  if (tab.userProtected) {
    descriptions.push({ key: 'protected', text: PROTECTED_TEXT });
  }
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
