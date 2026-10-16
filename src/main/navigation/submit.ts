// What happens when the user presses Enter in the address bar. Main classifies the text (the
// shell never decides what a string means), then acts on the tab.
import { buildSearchUrl, classifyOmniboxInput } from '../../core/url/omnibox';
import type { TabId, TabManager } from '../tabs/tab-manager';

export type SubmitOutcome = 'navigate' | 'search' | 'internal' | 'none';

export function submitAddress(
  tabs: TabManager,
  tabId: TabId,
  text: string,
  searchTemplate: string,
): SubmitOutcome {
  const action = classifyOmniboxInput(text);
  switch (action.kind) {
    case 'navigate':
      tabs.navigate(tabId, action.url, { credentialsRemoved: action.credentialsRemoved === true });
      return 'navigate';
    case 'search':
      tabs.navigate(tabId, buildSearchUrl(searchTemplate, action.query));
      return 'search';
    case 'external':
      // Another app's scheme. Nothing is handed to the OS until the external-protocol guard
      // (M1.4) can ask the user. Nor is the text searched for: "user:pass@host" reads exactly like
      // "xmpp:user@host", and a password must not reach the search engine.
      return 'none';
    case 'internal':
      tabs.showInternal(tabId, action.page);
      return 'internal';
    case 'none':
      return 'none';
  }
}
