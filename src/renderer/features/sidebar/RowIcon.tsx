import { Globe, TriangleAlert } from 'lucide-react';

interface RowIconProps {
  /** A data: URL main validated, or null. */
  readonly favicon: string | null;
  /** The page stopped working. */
  readonly alert: boolean;
}

/**
 * The icon at the start of a Sleeping or archived row: an alert for a crashed page, the favicon,
 * else a globe. Decoration only; what it signals is said in the row's description.
 */
export function RowIcon({ favicon, alert }: RowIconProps) {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      {alert ? (
        <TriangleAlert className="size-4 text-red-700 dark:text-red-400" aria-hidden="true" />
      ) : favicon !== null ? (
        // `draggable` is off so a favicon can't start a native drag.
        <img src={favicon} alt="" draggable={false} className="size-4 rounded-[3px]" />
      ) : (
        <Globe className="size-4 text-foreground/70" aria-hidden="true" />
      )}
    </span>
  );
}
