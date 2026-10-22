import { Fragment } from 'react';

import { splitMarks } from './marks';
import type { MarkRange } from './marks';

/**
 * A page's title with its matched words in `<mark>`. The text only ever becomes text nodes (never
 * markup), in a `<bdi>` so that a title written right to left cannot reorder the words around it.
 * Controls and bidi overrides are replaced by spaces first (marks.ts), without moving the marks.
 */
export function MarkedText({
  text,
  ranges,
}: {
  readonly text: string;
  readonly ranges: readonly MarkRange[];
}) {
  return (
    <bdi dir="ltr">
      {splitMarks(text, ranges).map((segment, index) =>
        segment.marked ? (
          <mark
            // The segments of one title never reorder; their index is their identity.
            key={index}
            className="rounded-[3px] bg-amber-200 px-px text-neutral-950 dark:bg-amber-300"
          >
            {segment.text}
          </mark>
        ) : (
          <Fragment key={index}>{segment.text}</Fragment>
        ),
      )}
    </bdi>
  );
}
