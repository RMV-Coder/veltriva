// Frecency (assessment §5.4): how recently and how often a page was visited, as one decaying
// score. Each visit decays the stored score to now and adds the visit's weight; a query decays it
// to the query's time. Updates are O(1), with no nightly recomputation. The weights are starting
// points, to be tuned against the golden query set in Phase 4.

/** The score halves every 30 days (the expression index in 0001_init.sql uses the same H). */
export const FRECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

export const VISIT_TRANSITIONS = [
  'link',
  'typed',
  'reload',
  'back_forward',
  'redirect',
  'restore',
  'generated',
  'other',
] as const;
export type VisitTransition = (typeof VISIT_TRANSITIONS)[number];

/**
 * §5.4: typed 2, link 1, restore or back/forward 0.5, reload or redirect 0. A search typed in
 * the address bar (`generated`) counts as a link; anything else as half a visit.
 */
export const VISIT_WEIGHTS: Readonly<Record<VisitTransition, number>> = {
  typed: 2,
  link: 1,
  generated: 1,
  restore: 0.5,
  back_forward: 0.5,
  reload: 0,
  redirect: 0,
  other: 0.5,
};

/** The score `frecency`, last updated at `at`, as of `now`. Never grows: a clock that went back counts as no time passing. */
export function decayedFrecency(frecency: number, at: number, now: number): number {
  const elapsed = Math.max(0, now - at);
  return frecency * 2 ** (-elapsed / FRECENCY_HALF_LIFE_MS);
}

/** The score after a visit of this kind at `now`. */
export function frecencyAfterVisit(
  frecency: number,
  at: number,
  now: number,
  transition: VisitTransition,
): number {
  return decayedFrecency(frecency, at, now) + VISIT_WEIGHTS[transition];
}
