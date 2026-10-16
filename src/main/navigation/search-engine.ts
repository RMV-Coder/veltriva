// The search template the omnibox uses (assessment §3.6 step 6). DuckDuckGo until the first-run
// choice and settings arrive (ADR-0009 D5, Phase 5); test builds point it at a local fixture.
import { DEFAULT_SEARCH_TEMPLATE, isValidSearchTemplate } from '../../core/url/omnibox';

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

/** What to call the search engine in menus: "DuckDuckGo", or the template's host. */
export function searchEngineName(): string {
  if (template === DEFAULT_SEARCH_TEMPLATE) {
    return 'DuckDuckGo';
  }
  try {
    return new URL(template.replaceAll('{searchTerms}', 'x')).host;
  } catch {
    return 'the web';
  }
}
