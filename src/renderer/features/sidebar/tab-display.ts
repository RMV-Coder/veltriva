// What the sidebar shows for a tab, derived from its snapshot. Pure, so Vitest covers it.

interface DisplayableTab {
  /** Page-controlled text, already sanitized by main. May be empty. */
  readonly title: string;
  readonly address: { readonly text: string };
  readonly runtime: 'unloaded' | 'creating' | 'live' | 'crashed';
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
