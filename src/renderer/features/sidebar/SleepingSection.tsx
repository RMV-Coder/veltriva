import { useCallback } from 'react';

import { restoreTab } from '../../state/commands';
import { useUiStore } from '../../state/ui-store';
import { useCounts, useSleeping } from '../../state/workspace-store';
import { SleepingRow } from './PlacementRows';
import { isSectionExpanded, tabCount } from './placement-display';
import { RowList } from './RowList';
import { EmptyLine, SidebarSection, sectionToggleId } from './SidebarSection';
import {
  keptAwakeAttribute,
  tabDescriptions,
  tabLabel,
  tabStatus,
  tabTooltip,
} from './tab-display';

/**
 * Sleeping (assessment §4.4): the tabs automation or the user put to rest, most recently moved
 * first. Open while something sleeps, until the user chooses otherwise. Clicking a row, or Enter
 * or Space on it, brings the tab back to the strip next to the current tab.
 */
export function SleepingSection() {
  const { sleeping } = useCounts();
  const choice = useUiStore((state) => state.sleepingExpanded);
  const setChoice = useUiStore((state) => state.setSleepingExpanded);
  const expanded = isSectionExpanded(choice, sleeping > 0);

  return (
    <SidebarSection
      kind="sleeping"
      name="Sleeping"
      count={sleeping}
      countText={tabCount(sleeping)}
      expanded={expanded}
      onToggle={() => {
        setChoice(!expanded);
      }}
    >
      <SleepingRows />
    </SidebarSection>
  );
}

function SleepingRows() {
  const sleeping = useSleeping();

  // `keepFocus`: a keyboard user stays in the sidebar; a click gives the restored page the keyboard.
  const restore = useCallback((tabId: string, keyboard: boolean): void => {
    void restoreTab(tabId, keyboard ? { keepFocus: true } : undefined);
  }, []);

  if (sleeping.length === 0) {
    return <EmptyLine>Nothing is sleeping.</EmptyLine>;
  }

  return (
    <RowList
      kind="sleeping"
      label="Sleeping tabs"
      showMoreLabel="Show more sleeping tabs"
      fallbackFocusId={sectionToggleId('sleeping')}
      items={sleeping}
      onActivate={restore}
      renderRow={(tab, tabStop) => (
        <SleepingRow
          key={tab.id}
          id={tab.id}
          label={tabLabel(tab)}
          favicon={tab.favicon}
          alert={tabStatus(tab) === 'crashed'}
          protectedTab={tab.userProtected}
          keptAwake={keptAwakeAttribute(tab.keptAwake)}
          previewMove={tab.previewMove}
          movedBy={tab.movedBy}
          unloadPressure={tab.unloadPressure}
          tooltip={tabTooltip(tab, { sleeping: true })}
          description={tabDescriptions(tab, { sleeping: true })
            .map((description) => description.text)
            .join('. ')}
          tabStop={tabStop}
        />
      )}
    />
  );
}
