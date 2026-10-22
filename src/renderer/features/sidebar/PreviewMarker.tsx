import { Archive, Moon } from 'lucide-react';

import { previewLine } from './tab-display';
import type { PreviewMove } from './tab-display';

/**
 * Preview mode's mark on a row (assessment §4.13): a small, quiet icon saying what automation
 * would do to this tab if the preview were over, "Preview: would move to Sleeping". The icon is
 * the only visible sign; its words are its accessible name, and also in the row's tooltip and
 * description (a `tab` role's children are presentational, so a description carries them there).
 */
export function PreviewMarker({ move }: { readonly move: PreviewMove }) {
  const text = previewLine(move) ?? '';
  const Icon = move === 'shelve' ? Moon : Archive;
  return (
    <Icon
      role="img"
      aria-label={text}
      data-preview-icon={move}
      className="size-3.5 shrink-0 text-sidebar-foreground/70"
    />
  );
}
