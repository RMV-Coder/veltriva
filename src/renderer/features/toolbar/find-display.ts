// What the find bar shows, derived from the tab's find state. Pure, so Vitest covers it.

interface FindState {
  /** The text main is searching for. */
  readonly text: string;
  /** The highlighted match, from 1; 0 when there is none. */
  readonly activeMatch: number;
  readonly matches: number;
}

/**
 * The match count beside the find field: "2 of 5", "No results", or nothing while there is no
 * search. It describes the search main ran, so it takes main's text, not what has just been typed.
 */
export function findCountText(find: FindState): string {
  if (find.text === '') {
    return '';
  }
  if (find.matches === 0) {
    return 'No results';
  }
  if (find.activeMatch === 0) {
    // Matches are known before one is highlighted. Say how many there are, not "0 of 5".
    return find.matches === 1 ? '1 match' : `${String(find.matches)} matches`;
  }
  return `${String(find.activeMatch)} of ${String(find.matches)}`;
}

/** "Previous match" and "Next match" have nothing to go to without a match. */
export function canStepMatches(find: Pick<FindState, 'matches'>): boolean {
  return find.matches > 0;
}
