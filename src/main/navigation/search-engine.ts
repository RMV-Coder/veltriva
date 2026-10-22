// The search template the omnibox uses (assessment §3.6 step 6): the settings document's, set at
// startup and whenever the user picks an engine (ADR-0009 D5, M5.1); test builds point it at a
// local fixture.
import { DEFAULT_SEARCH_TEMPLATE, isValidSearchTemplate } from '../../core/url/omnibox';
import { searchEngineFor } from '../../core/url/search-engines';

let template = DEFAULT_SEARCH_TEMPLATE;

export function searchTemplate(): string {
  return template;
}

export function setSearchTemplate(next: string): void {
  if (!isValidSearchTemplate(next)) {
    throw new Error('Invalid search template');
  }
  template = next;
}

/** What to call the search engine in menus: its name ("DuckDuckGo"), or the template's host. */
export function searchEngineName(): string {
  const named = searchEngineFor(template);
  if (named !== null) {
    return named.name;
  }
  try {
    return new URL(template.replaceAll('{searchTerms}', 'x')).host;
  } catch {
    return 'the web';
  }
}
