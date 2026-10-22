// The context menu's entries for a right-click, from Chromium's context-menu params. Pure (no
// Electron), so the entries are unit-tested and a test hook can show them for any params:
// Playwright can't click a native menu. ./context-menu.ts pops the menu up and runs the actions.

/** The parts of Electron's `ContextMenuParams` the menu reads. */
export interface MenuParams {
  /** Where the click was, in the view's coordinates. */
  readonly x: number;
  readonly y: number;
  readonly linkURL: string;
  readonly srcURL: string;
  /** 'none' | 'image' | 'audio' | 'video' | 'canvas' | 'file' | 'plugin'. */
  readonly mediaType: string;
  readonly hasImageContents: boolean;
  readonly isEditable: boolean;
  readonly selectionText: string;
  readonly misspelledWord: string;
  readonly dictionarySuggestions: readonly string[];
  readonly editFlags: {
    readonly canUndo: boolean;
    readonly canRedo: boolean;
    readonly canCut: boolean;
    readonly canCopy: boolean;
    readonly canPaste: boolean;
    readonly canSelectAll: boolean;
  };
}

export interface MenuContext {
  /** A page in a tab, or the shell's own fields (only editing there). */
  readonly source: 'tab' | 'shell';
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  /** Whether a URL may be opened in a tab: the tab navigation policy. */
  readonly canOpen: (url: string) => boolean;
  /** The search engine's name, for "Search … for “selection”". */
  readonly searchEngine: string;
}

/** What may be downloaded from a menu: what a tab may open, and `data:` images. */
export function canSave(url: string, context: Pick<MenuContext, 'canOpen'>): boolean {
  return context.canOpen(url) || url.toLowerCase().startsWith('data:image/');
}

export type MenuItemId =
  | 'open-link-in-new-tab'
  | 'copy-link'
  | 'save-link'
  | 'open-image-in-new-tab'
  | 'save-image'
  | 'copy-image'
  | 'copy-image-address'
  | 'search-selection'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'paste-plain'
  | 'select-all'
  | 'print'
  /** A spelling suggestion, by its index among `dictionarySuggestions`. */
  | `suggestion-${string}`
  | 'add-to-dictionary'
  | 'back'
  | 'forward'
  | 'reload'
  | 'inspect';

export type MenuEntry =
  | {
      readonly type: 'item';
      readonly id: MenuItemId;
      readonly label: string;
      readonly enabled: boolean;
    }
  | { readonly type: 'separator' };

/** Chrome offers at most this many spelling suggestions. */
const MAX_SUGGESTIONS = 5;
/** How much of the selection the "Search for" item quotes. */
const MAX_QUOTED = 32;
// Controls and bidi formatting: page text in a menu label must not reorder or hide anything.
const UNSAFE_LABEL_TEXT =
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point.
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

const item = (id: MenuItemId, label: string, enabled = true): MenuEntry => ({
  type: 'item',
  id,
  label,
  enabled,
});
const SEPARATOR: MenuEntry = { type: 'separator' };

export function buildContextMenu(params: MenuParams, context: MenuContext): MenuEntry[] {
  const entries: MenuEntry[] = [];
  const inTab = context.source === 'tab';

  // Spelling first, as in Chrome: the menu is most likely about the underlined word.
  if (params.isEditable && params.misspelledWord !== '') {
    const suggestions = params.dictionarySuggestions.slice(0, MAX_SUGGESTIONS);
    if (suggestions.length === 0) {
      entries.push(item('suggestion-0', 'No spelling suggestions', false));
    }
    suggestions.forEach((suggestion, index) => {
      entries.push(item(`suggestion-${String(index)}`, quoteSafe(suggestion, 64)));
    });
    entries.push(item('add-to-dictionary', 'Add to dictionary'), SEPARATOR);
  }

  if (inTab && params.linkURL !== '') {
    if (context.canOpen(params.linkURL)) {
      entries.push(item('open-link-in-new-tab', 'Open link in new tab'));
    }
    if (canSave(params.linkURL, context)) {
      // No save dialog in the MVP: it goes to the Downloads folder, so the label says so.
      entries.push(item('save-link', 'Save link to Downloads'));
    }
    entries.push(item('copy-link', 'Copy link address'), SEPARATOR);
  }

  if (inTab && params.mediaType === 'image' && params.srcURL !== '') {
    if (context.canOpen(params.srcURL)) {
      entries.push(item('open-image-in-new-tab', 'Open image in new tab'));
    }
    if (canSave(params.srcURL, context)) {
      entries.push(item('save-image', 'Save image to Downloads'));
    }
    if (params.hasImageContents) {
      entries.push(item('copy-image', 'Copy image'));
    }
    entries.push(item('copy-image-address', 'Copy image address'), SEPARATOR);
  }

  const selection = params.selectionText.trim();
  if (params.isEditable) {
    const flags = params.editFlags;
    entries.push(
      item('undo', 'Undo', flags.canUndo),
      item('redo', 'Redo', flags.canRedo),
      SEPARATOR,
      item('cut', 'Cut', flags.canCut),
      item('copy', 'Copy', flags.canCopy),
      item('paste', 'Paste', flags.canPaste),
      item('paste-plain', 'Paste as plain text', flags.canPaste),
      item('select-all', 'Select all', flags.canSelectAll),
      SEPARATOR,
    );
  } else if (selection !== '') {
    entries.push(item('copy', 'Copy'));
    if (inTab) {
      const quoted = quoteSafe(selection, MAX_QUOTED);
      entries.push(item('search-selection', `Search ${context.searchEngine} for “${quoted}”`));
    }
    entries.push(SEPARATOR);
  }

  const onPage =
    params.linkURL === '' && params.mediaType !== 'image' && !params.isEditable && selection === '';
  if (inTab && onPage) {
    entries.push(
      item('back', 'Back', context.canGoBack),
      item('forward', 'Forward', context.canGoForward),
      item('reload', 'Reload'),
      SEPARATOR,
      item('print', 'Print…'),
      SEPARATOR,
    );
  }

  if (inTab) {
    entries.push(item('inspect', 'Inspect'));
  }
  return tidy(entries);
}

/** Page text for a label: one line, no controls or bidi formatting, cut with an ellipsis. */
function quoteSafe(text: string, max: number): string {
  const line = text.replace(UNSAFE_LABEL_TEXT, ' ').replace(/\s+/g, ' ').trim();
  const characters = Array.from(line);
  return characters.length > max ? `${characters.slice(0, max - 1).join('')}…` : line;
}

/** No separator first, last or twice in a row. */
function tidy(entries: readonly MenuEntry[]): MenuEntry[] {
  const tidied: MenuEntry[] = [];
  for (const entry of entries) {
    const previous = tidied.at(-1);
    if (entry.type === 'separator' && (previous === undefined || previous.type === 'separator')) {
      continue;
    }
    tidied.push(entry);
  }
  if (tidied.at(-1)?.type === 'separator') {
    tidied.pop();
  }
  return tidied;
}
