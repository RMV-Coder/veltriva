import { useId } from 'react';

import { useNow } from '@/lib/use-now';

import { useUiStore } from '../../state/ui-store';
import { useCounts } from '../../state/workspace-store';
import { ArchiveList } from './ArchiveList';
import { archiveCountText, archiveSummary, isSectionExpanded } from './placement-display';
import { EmptyLine, SidebarSection, sectionToggleId } from './SidebarSection';

/** The relative times ("2 h ago") are worked out again this often while the section is open. */
const CLOCK_TICK_MS = 60_000;

/**
 * The Archive (assessment §4.4, §4.12): "Archived today N" and the total, and the list of every
 * archived tab, newest first, each row with when it was archived and by whom. The list is
 * virtual (ArchiveList): it draws the rows in view, so ten thousand archived tabs scroll as
 * smoothly as ten. Closed until the user opens it. Clicking a row, or Enter or Space on it, brings
 * the tab back (it may come back under a new id).
 */
export function ArchiveSection() {
  const counts = useCounts();
  const choice = useUiStore((state) => state.archiveExpanded);
  const setChoice = useUiStore((state) => state.setArchiveExpanded);
  const expanded = isSectionExpanded(choice, false);

  return (
    <SidebarSection
      kind="archive"
      name="Archive"
      count={counts.archived}
      countText={archiveCountText(counts)}
      expanded={expanded}
      onToggle={() => {
        setChoice(!expanded);
      }}
    >
      <ArchiveBody />
    </SidebarSection>
  );
}

function ArchiveBody() {
  const counts = useCounts();
  const now = useNow(CLOCK_TICK_MS);
  const headingId = useId();

  if (counts.archived === 0) {
    return <EmptyLine>Nothing archived yet.</EmptyLine>;
  }

  return (
    <>
      <p data-archive-summary="" className="px-2.5 py-0.5 text-sm text-sidebar-foreground/80">
        {archiveSummary(counts)}
      </p>
      <h3
        id={headingId}
        className="px-2.5 pt-1 pb-0.5 text-xs font-medium tracking-wide text-sidebar-foreground/70 uppercase"
      >
        Recently archived
      </h3>
      <ArchiveList
        total={counts.archived}
        now={now}
        labelledBy={headingId}
        fallbackFocusId={sectionToggleId('archive')}
      />
    </>
  );
}
