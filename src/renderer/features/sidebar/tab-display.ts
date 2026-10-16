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

/** What a tab's leading icon signals, most urgent first. `null` means nothing special. */
export function tabStatus(tab: DisplayableTab): TabStatus | null {
  if (tab.runtime === 'crashed' || (tab.page.kind === 'internal' && tab.page.name === 'crashed')) {
    return 'crashed';
  }
  if (tab.page.kind === 'internal' && tab.page.name === 'network-error') {
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
