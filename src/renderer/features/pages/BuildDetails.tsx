import { Info } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { FOCUS_RING } from '@/lib/focus';
import { cn } from '@/lib/utils';

import type { CommandOutput } from '../../../shared/contracts/schemas';

type BuildInfo = CommandOutput<'app.getInfo'>;

const BUILD_DETAILS_ID = 'build-details';

/** The "About this build" toggle and the versions it reveals. */
export function BuildDetails() {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [info, setInfo] = useState<BuildInfo | 'unavailable' | undefined>(undefined);

  const toggleDetails = (): void => {
    const opening = !detailsOpen;
    setDetailsOpen(opening);
    if (opening && info === undefined) {
      window.veltriva.app
        .getInfo()
        .then((result) => {
          setInfo(result.ok ? result.value : 'unavailable');
        })
        .catch(() => {
          setInfo('unavailable');
        });
    }
  };

  return (
    <>
      <Button
        variant="outline"
        aria-expanded={detailsOpen}
        aria-controls={BUILD_DETAILS_ID}
        onClick={toggleDetails}
        className={cn(FOCUS_RING)}
      >
        <Info data-icon="inline-start" aria-hidden="true" />
        About this build
      </Button>

      {detailsOpen ? <BuildDetailsPanel info={info} /> : null}
    </>
  );
}

function BuildDetailsPanel({ info }: { info: BuildInfo | 'unavailable' | undefined }) {
  return (
    <section
      id={BUILD_DETAILS_ID}
      aria-label="Build details"
      aria-busy={info === undefined}
      className="w-full max-w-sm rounded-xl border bg-card p-4 text-left text-sm text-card-foreground"
    >
      {info === undefined ? <p className="text-foreground/70">Loading…</p> : null}
      {info === 'unavailable' ? (
        <p className="text-foreground/70">Build details are unavailable.</p>
      ) : null}
      {info !== undefined && info !== 'unavailable' ? (
        <ul className="flex flex-col gap-1 font-mono">
          <li>{`${info.productName} ${info.version}`}</li>
          <li>{`Electron ${info.versions.electron}`}</li>
          <li>{`Chromium ${info.versions.chrome}`}</li>
        </ul>
      ) : null}
    </section>
  );
}
