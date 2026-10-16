import { ArrowLeft, ArrowRight, RotateCw, X } from 'lucide-react';

import { goBack, goForward, reloadTab, stopLoading } from '../../state/commands';
import { useSelectedTab } from '../../state/workspace-store';
import { FindBar } from './FindBar';
import { LoadingBar } from './LoadingBar';
import { Omnibox } from './Omnibox';
import { ToolbarButton } from './ToolbarButton';

/**
 * Back, Forward, Reload or Stop, and the address bar, across the full width of the window. While
 * the selected tab's find bar is open it takes the right end of the row, and the address bar shrinks.
 */
export function Toolbar() {
  const tab = useSelectedTab();
  const loading = tab?.loading ?? false;

  return (
    <header className="relative flex h-12 items-center gap-1 border-b bg-background px-2 select-none">
      <ToolbarButton
        label="Back"
        icon={ArrowLeft}
        disabled={!tab?.canGoBack}
        onClick={() => {
          if (tab !== undefined) {
            void goBack(tab.id);
          }
        }}
      />
      <ToolbarButton
        label="Forward"
        icon={ArrowRight}
        disabled={!tab?.canGoForward}
        onClick={() => {
          if (tab !== undefined) {
            void goForward(tab.id);
          }
        }}
      />
      {/* One button for both, so it keeps its place and its focus when a load starts or ends. */}
      <ToolbarButton
        label={loading ? 'Stop' : 'Reload'}
        icon={loading ? X : RotateCw}
        disabled={tab === undefined}
        onClick={() => {
          if (tab !== undefined) {
            void (loading ? stopLoading(tab.id) : reloadTab(tab.id));
          }
        }}
      />
      <Omnibox />
      <FindBar />
      <LoadingBar active={loading} />
    </header>
  );
}
