import { describe, expect, it } from 'vitest';

import { DEFAULT_SEARCH_TEMPLATE, isValidSearchTemplate } from './omnibox';
import { SEARCH_ENGINES, searchEngineFor } from './search-engines';

describe('SEARCH_ENGINES', () => {
  it('offers DuckDuckGo first, with the default template (ADR-0009 D5)', () => {
    expect(SEARCH_ENGINES[0]).toEqual({
      id: 'duckduckgo',
      name: 'DuckDuckGo',
      template: DEFAULT_SEARCH_TEMPLATE,
    });
  });

  it('gives every engine its own id, name and template', () => {
    for (const key of ['id', 'name', 'template'] as const) {
      const values = SEARCH_ENGINES.map((engine) => engine[key]);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it.each(SEARCH_ENGINES.map((engine) => [engine.name, engine.template]))(
    '%s has a template the omnibox accepts, over https',
    (_name, template) => {
      expect(isValidSearchTemplate(template)).toBe(true);
      expect(template.startsWith('https://')).toBe(true);
    },
  );
});

describe('searchEngineFor', () => {
  it.each(SEARCH_ENGINES.map((engine) => [engine.name, engine]))(
    'names %s from its template',
    (_name, engine) => {
      expect(searchEngineFor(engine.template)).toBe(engine);
    },
  );

  it('names no engine for a custom template', () => {
    expect(searchEngineFor('https://search.example/?q={searchTerms}')).toBeNull();
  });

  it.each([
    ['another scheme', 'http://duckduckgo.com/?q={searchTerms}'],
    ['another case', 'https://DuckDuckGo.com/?q={searchTerms}'],
    ['an extra parameter', 'https://duckduckgo.com/?q={searchTerms}&ia=web'],
    ['surrounding space', ' https://duckduckgo.com/?q={searchTerms}'],
    ['no placeholder', 'https://duckduckgo.com/?q='],
    ['nothing', ''],
  ])('names no engine for a template that only resembles one (%s)', (_case, template) => {
    expect(searchEngineFor(template)).toBeNull();
  });
});
