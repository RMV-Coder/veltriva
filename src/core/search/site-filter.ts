// The palette's site filter (M4.2, assessment §7.3): a `site:` word in the search box keeps the
// results on one site, as in a web search engine: `site:github.com rust`. Pure, so main can read
// it out of the words before they reach the data worker, and the rule is unit-tested.
//
// The site is a registrable domain, as the memory stores it (`pages.site`): `site:docs.github.com`
// and `site:https://github.com/x` both mean github.com. A `site:` word that names no site is
// dropped, and the search goes on without a filter.
import { siteOf } from '../url/site';

const SITE_WORD = /(?:^|\s)site:(\S*)/giu;

export interface SiteFilterInput {
  /** The words without the `site:` word. */
  readonly text: string;
  /** The site the results are kept to; null for none. With several, the last one counts. */
  readonly site: string | null;
}

/** The registrable domain a `site:` value names, or null. */
export function siteFromValue(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > 2048) {
    return null;
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  return siteOf(withScheme);
}

export function splitSiteFilter(input: string): SiteFilterInput {
  let site: string | null = null;
  const text = input.replace(SITE_WORD, (_word, value: string) => {
    site = siteFromValue(value) ?? site;
    return ' ';
  });
  return { text: text.replace(/\s+/gu, ' ').trim(), site };
}
