// Internal pages (ADR-0002 §3): views the shell renders in the content area. Their `veltriva://`
// identifiers are never loaded into any web contents; only these names exist.

export const INTERNAL_PAGES = [
  'new-tab',
  'network-error',
  'certificate-error',
  'client-certificate',
  'crashed',
  /** The local diagnostics page (M3.4, §4.13): the regret metric and what automation sees. */
  'diagnostics',
] as const;
export type InternalPage = (typeof INTERNAL_PAGES)[number];

/**
 * Pages a user may open by typing `veltriva://<name>`. Error pages are only ever shown by main.
 * A Map, not an object literal: `veltriva://constructor` must not find `Object.prototype`.
 */
export const TYPEABLE_INTERNAL_PAGES: ReadonlyMap<string, InternalPage> = new Map([
  ['newtab', 'new-tab'],
  ['diagnostics', 'diagnostics'],
]);

export const INTERNAL_SCHEME = 'veltriva';
