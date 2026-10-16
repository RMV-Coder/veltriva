import { ArrowLeft, ArrowRight, RotateCw, X } from 'lucide-react';

import { goBack, goForward, reloadTab, stopLoading } from '../../state/commands';
import { useSelectedTab } from '../../state/workspace-store';
import { LoadingBar } from './LoadingBar';
import { Omnibox } from './Omnibox';
import { ToolbarButton } from './ToolbarButton';

/** Back, Forward, Reload or Stop, and the address bar, across the full width of the window. */
export function Toolbar() {
  const tab = useSelectedTab();
  const loading = tab?.loading ?? false;

  return (
    <header className="relative col-span-2 flex items-center gap-1 border-b bg-background px-2 select-none">
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
      <LoadingBar active={loading} />
    </header>
  );
}
