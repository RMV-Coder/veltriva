import { Info } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

const BUILD_DETAILS_ID = 'build-details';

/** M1.1 placeholder shell. The real chrome (tabs, address bar, memory) arrives in later milestones. */
export function App() {
  const [detailsOpen, setDetailsOpen] = useState(false);

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
        onClick={() => {
          setDetailsOpen((open) => !open);
        }}
      >
        <Info data-icon="inline-start" aria-hidden="true" />
        About this build
      </Button>

      {detailsOpen ? <BuildDetails /> : null}
    </main>
  );
}

function BuildDetails() {
  const { electron, chrome } = window.veltriva.runtime;

  return (
    <section
      id={BUILD_DETAILS_ID}
      aria-label="Build details"
      className="w-full max-w-sm rounded-xl border bg-card p-4 text-left text-sm text-card-foreground"
    >
      <ul className="flex flex-col gap-1 font-mono">
        <li>{`Electron ${electron}`}</li>
        <li>{`Chromium ${chrome}`}</li>
      </ul>
      <p className="mt-3 text-muted-foreground">
        This is the Milestone 1.1 scaffold. Tabs, the address bar and memory come in later
        milestones.
      </p>
    </section>
  );
}
