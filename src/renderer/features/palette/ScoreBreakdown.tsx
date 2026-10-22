import { displayTitle, scoreBreakdown } from './memory-display';
import type { MemoryResult } from './memory-display';
import { neutralizeText } from './marks';

/**
 * The debug view of the palette (assessment §5.4: "every result carries its score breakdown"):
 * the five weighted terms that add up to the active result's score, and the score itself, with
 * two decimals. Alt+S or the "Score details" button shows and hides it.
 */
export function ScoreBreakdown({ result }: { readonly result: MemoryResult }) {
  const { rows, total } = scoreBreakdown(result);
  return (
    <section
      aria-label="Score breakdown"
      data-score-breakdown=""
      className="border-t bg-muted/60 px-3 py-2 text-xs text-popover-foreground"
    >
      <h3 className="truncate pb-1 font-medium">
        Score of <bdi dir="ltr">{neutralizeText(displayTitle(result).text)}</bdi>
      </h3>
      <dl className="grid grid-cols-[repeat(6,auto)] justify-start gap-x-4 gap-y-0.5">
        {rows.map((row) => (
          <div key={row.key} className="flex flex-col">
            <dt className="text-popover-foreground/70">{row.label}</dt>
            <dd data-term={row.key} className="font-mono tabular-nums">
              {row.value}
            </dd>
          </div>
        ))}
        <div className="flex flex-col">
          <dt className="font-medium text-popover-foreground">Score</dt>
          <dd data-term="score" className="font-mono font-medium tabular-nums">
            {total}
          </dd>
        </div>
      </dl>
    </section>
  );
}
