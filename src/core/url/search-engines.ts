// The search engines Veltriva offers by name (ADR-0009 D5): DuckDuckGo, preselected for privacy,
// then other well-known engines. Any other engine is a custom template (core/url/omnibox.ts checks
// it). Nothing is sent to an engine until the user searches: there is no suggestion service.
import { DEFAULT_SEARCH_TEMPLATE } from './omnibox';

export interface SearchEngine {
  readonly id: string;
  readonly name: string;
  readonly template: string;
}

export const SEARCH_ENGINES: readonly SearchEngine[] = [
  { id: 'duckduckgo', name: 'DuckDuckGo', template: DEFAULT_SEARCH_TEMPLATE },
  { id: 'google', name: 'Google', template: 'https://www.google.com/search?q={searchTerms}' },
  { id: 'bing', name: 'Bing', template: 'https://www.bing.com/search?q={searchTerms}' },
  {
    id: 'brave',
    name: 'Brave Search',
    template: 'https://search.brave.com/search?q={searchTerms}',
  },
  { id: 'ecosia', name: 'Ecosia', template: 'https://www.ecosia.org/search?q={searchTerms}' },
  {
    id: 'startpage',
    name: 'Startpage',
    template: 'https://www.startpage.com/do/search?q={searchTerms}',
  },
];

/** The named engine with exactly this template, if there is one. */
export function searchEngineFor(template: string): SearchEngine | null {
  return SEARCH_ENGINES.find((engine) => engine.template === template) ?? null;
}
