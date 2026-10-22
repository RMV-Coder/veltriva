import { useCallback, useId } from 'react';

import { useNow } from '@/lib/use-now';

import { restoreTab } from '../../state/commands';
import { useUiStore } from '../../state/ui-store';
import { useArchived, useCounts } from '../../state/workspace-store';
import { ArchivedRow } from './PlacementRows';
import {
  archiveCountText,
  archiveListNote,
  archiveSummary,
  archivedRowText,
  isSectionExpanded,
} from './placement-display';
import { RowList } from './RowList';
import { EmptyLine, SidebarSection, sectionToggleId } from './SidebarSection';

/** The relative times ("2 h ago") are worked out again this often while the section is open. */
const CLOCK_TICK_MS = 60_000;

/**
 * The Archive (assessment §4.4, §4.12): "Archived today N" and the total, and the "Recently
 * archived" list, newest first, each row with when it was archived and by whom. Closed until the
 * user opens it. Clicking a row, or Enter or Space on it, brings the tab back (it may come back
 * under a new id).
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
  const archived = useArchived();
  const counts = useCounts();
  const now = useNow(CLOCK_TICK_MS);
  const headingId = useId();

  const restore = useCallback((tabId: string, keyboard: boolean): void => {
    void restoreTab(tabId, keyboard ? { keepFocus: true } : undefined);
  }, []);

  if (archived.length === 0) {
    return <EmptyLine>Nothing archived yet.</EmptyLine>;
  }

  const note = archiveListNote(archived.length, counts.archived);
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
      <RowList
        kind="archived"
        labelledBy={headingId}
        showMoreLabel="Show more archived tabs"
        fallbackFocusId={sectionToggleId('archive')}
        items={archived}
        onActivate={restore}
        renderRow={(tab, tabStop) => {
          const text = archivedRowText(tab, now);
          return (
            <ArchivedRow
              key={tab.id}
              id={tab.id}
              label={text.label}
              favicon={tab.favicon}
              alert={false}
              meta={text.meta}
              tooltip={text.tooltip}
              description={text.description}
              tabStop={tabStop}
            />
          );
        }}
      />
      {note === null ? null : (
        <p data-archive-note="" className="px-2.5 py-0.5 text-xs text-sidebar-foreground/70">
          {note}
        </p>
      )}
    </>
  );
}
