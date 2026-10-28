// What a screen reader hears when the address bar's suggestions change (M6.2). The field keeps the
// keyboard (aria-activedescendant), so nothing else tells a Narrator user that a list appeared.

/** The sentence for `count` suggestions: empty when the list is closed, so nothing is repeated. */
export function suggestionsAnnouncement(open: boolean, count: number): string {
  if (!open || count === 0) {
    return '';
  }
  const noun = count === 1 ? 'suggestion' : 'suggestions';
  return `${String(count)} ${noun}. Use Up and Down to choose.`;
}
