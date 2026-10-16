import { Info } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

import type { CommandOutput } from '../../shared/contracts/schemas';

type BuildInfo = CommandOutput<'app.getInfo'>;

const BUILD_DETAILS_ID = 'build-details';

/** Placeholder shell. The real chrome (tabs, address bar, memory) arrives in later milestones. */
export function App() {
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
    <main className="flex min-h-screen flex-col items-center gap-8 px-6 pt-[28vh] text-center">
      <header className="flex flex-col items-center gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Veltriva Browser</h1>
        <p className="text-muted-foreground">Browse freely. Remember effortlessly.</p>
      </header>

      <Button
        variant="outline"
        aria-expanded={detailsOpen}
        aria-controls={BUILD_DETAILS_ID}
        onClick={toggleDetails}
      >
        <Info data-icon="inline-start" aria-hidden="true" />
        About this build
      </Button>

      {detailsOpen ? <BuildDetails info={info} /> : null}
    </main>
  );
}

function BuildDetails({ info }: { info: BuildInfo | 'unavailable' | undefined }) {
  return (
    <section
      id={BUILD_DETAILS_ID}
      aria-label="Build details"
      aria-busy={info === undefined}
      className="w-full max-w-sm rounded-xl border bg-card p-4 text-left text-sm text-card-foreground"
    >
      {info === undefined ? <p className="text-muted-foreground">Loading…</p> : null}
      {info === 'unavailable' ? (
        <p className="text-muted-foreground">Build details are unavailable.</p>
      ) : null}
      {info !== undefined && info !== 'unavailable' ? (
        <ul className="flex flex-col gap-1 font-mono">
          <li>{`${info.productName} ${info.version}`}</li>
          <li>{`Electron ${info.versions.electron}`}</li>
          <li>{`Chromium ${info.versions.chrome}`}</li>
        </ul>
      ) : null}
      <p className="mt-3 text-muted-foreground">
        This is the Milestone 1.2 secure shell. Tabs, the address bar and memory come in later
        milestones.
      </p>
    </section>
  );
}
