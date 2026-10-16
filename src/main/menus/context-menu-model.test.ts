import { describe, expect, it } from 'vitest';

import { buildContextMenu } from './context-menu-model';
import type { MenuContext, MenuEntry, MenuParams } from './context-menu-model';

const NO_EDITS = {
  canUndo: false,
  canRedo: false,
  canCut: false,
  canCopy: false,
  canPaste: false,
  canSelectAll: false,
};

function params(overrides: Partial<MenuParams> = {}): MenuParams {
  return {
    x: 10,
    y: 20,
    linkURL: '',
    srcURL: '',
    mediaType: 'none',
    hasImageContents: false,
    isEditable: false,
    selectionText: '',
    misspelledWord: '',
    dictionarySuggestions: [],
    editFlags: NO_EDITS,
    ...overrides,
  };
}

const webOnly = (url: string): boolean => /^https?:/.test(url);

function context(overrides: Partial<MenuContext> = {}): MenuContext {
  return {
    source: 'tab',
    canGoBack: true,
    canGoForward: false,
    canOpen: webOnly,
    searchEngine: 'DuckDuckGo',
    ...overrides,
  };
}

/** The menu as text: an item's label (with "(disabled)"), or "---" for a separator. */
const shape = (entries: readonly MenuEntry[]): string[] =>
  entries.map((entry) =>
    entry.type === 'separator' ? '---' : `${entry.label}${entry.enabled ? '' : ' (disabled)'}`,
  );
const ids = (entries: readonly MenuEntry[]): string[] =>
  entries.flatMap((entry) => (entry.type === 'item' ? [entry.id] : []));

describe('buildContextMenu', () => {
  it('offers page actions on a plain part of a page', () => {
    expect(shape(buildContextMenu(params(), context()))).toEqual([
      'Back',
      'Forward (disabled)',
      'Reload',
      '---',
      'Inspect',
    ]);
  });

  it('offers to open and copy a link', () => {
    const menu = buildContextMenu(params({ linkURL: 'https://a.example/next' }), context());
    expect(shape(menu)).toEqual(['Open link in new tab', 'Copy link address', '---', 'Inspect']);
  });

  it('never offers to open a link the tab policy refuses, but still copies it', () => {
    for (const linkURL of [
      'javascript:alert(1)',
      'data:text/html,<p>x</p>',
      'file:///C:/Windows/win.ini',
      'veltriva://newtab',
    ]) {
      const menu = buildContextMenu(params({ linkURL }), context());
      expect(ids(menu)).not.toContain('open-link-in-new-tab');
      expect(ids(menu)).toContain('copy-link');
    }
  });

  it('offers image actions, and Copy image only when the image has loaded', () => {
    const image = params({ mediaType: 'image', srcURL: 'https://img.example/a.png' });
    expect(shape(buildContextMenu({ ...image, hasImageContents: true }, context()))).toEqual([
      'Open image in new tab',
      'Copy image',
      'Copy image address',
      '---',
      'Inspect',
    ]);
    expect(ids(buildContextMenu(image, context()))).not.toContain('copy-image');
    const inline = { ...image, srcURL: 'data:image/png;base64,iVBORw0KGgo=' };
    expect(ids(buildContextMenu(inline, context()))).not.toContain('open-image-in-new-tab');
  });

  it('offers a linked image both sets of actions', () => {
    const menu = buildContextMenu(
      params({
        linkURL: 'https://a.example/',
        mediaType: 'image',
        srcURL: 'https://img.example/a.png',
        hasImageContents: true,
      }),
      context(),
    );
    expect(ids(menu)).toEqual([
      'open-link-in-new-tab',
      'copy-link',
      'open-image-in-new-tab',
      'copy-image',
      'copy-image-address',
      'inspect',
    ]);
  });

  it('offers Copy and a search for selected text, quoting it safely', () => {
    const menu = buildContextMenu(
      params({ selectionText: '  An \u202eevil\u202c\nselection that is rather long indeed  ' }),
      context(),
    );
    expect(shape(menu)).toEqual([
      'Copy',
      'Search DuckDuckGo for “An evil selection that is rathe…”',
      '---',
      'Inspect',
    ]);
  });

  it('offers editing, enabled by what the field allows', () => {
    const menu = buildContextMenu(
      params({
        isEditable: true,
        editFlags: { ...NO_EDITS, canPaste: true, canSelectAll: true, canUndo: true },
      }),
      context(),
    );
    expect(shape(menu)).toEqual([
      'Undo',
      'Redo (disabled)',
      '---',
      'Cut (disabled)',
      'Copy (disabled)',
      'Paste',
      'Paste as plain text',
      'Select all',
      '---',
      'Inspect',
    ]);
  });

  it('puts spelling suggestions first, at most five', () => {
    const menu = buildContextMenu(
      params({
        isEditable: true,
        misspelledWord: 'teh',
        dictionarySuggestions: ['the', 'ten', 'tea', 'tee', 'teg', 'tel'],
      }),
      context(),
    );
    expect(shape(menu).slice(0, 7)).toEqual([
      'the',
      'ten',
      'tea',
      'tee',
      'teg',
      'Add to dictionary',
      '---',
    ]);
    expect(ids(menu).slice(0, 5)).toEqual([
      'suggestion-0',
      'suggestion-1',
      'suggestion-2',
      'suggestion-3',
      'suggestion-4',
    ]);
  });

  it('says so when there are no suggestions', () => {
    const menu = buildContextMenu(
      params({ isEditable: true, misspelledWord: 'qzx', dictionarySuggestions: [] }),
      context(),
    );
    expect(shape(menu).slice(0, 2)).toEqual([
      'No spelling suggestions (disabled)',
      'Add to dictionary',
    ]);
  });

  it('gives the shell only editing: no page actions, no search, no Inspect', () => {
    const shell = context({ source: 'shell' });
    expect(buildContextMenu(params(), shell)).toEqual([]);
    expect(shape(buildContextMenu(params({ selectionText: 'text' }), shell))).toEqual(['Copy']);
    expect(ids(buildContextMenu(params({ isEditable: true }), shell))).toEqual([
      'undo',
      'redo',
      'cut',
      'copy',
      'paste',
      'paste-plain',
      'select-all',
    ]);
    // Links and images in the shell are its own, not a page's.
    expect(buildContextMenu(params({ linkURL: 'https://a.example/' }), shell)).toEqual([]);
  });

  it('never starts or ends with a separator, or doubles one', () => {
    const menus = [
      buildContextMenu(params({ isEditable: true }), context({ source: 'shell' })),
      buildContextMenu(params({ selectionText: 'x' }), context({ source: 'shell' })),
      buildContextMenu(params({ linkURL: 'javascript:x' }), context()),
    ];
    for (const menu of menus) {
      const kinds = menu.map((entry) => entry.type);
      expect(kinds[0]).not.toBe('separator');
      expect(kinds.at(-1)).not.toBe('separator');
      expect(kinds.join(' ')).not.toContain('separator separator');
    }
  });
});
