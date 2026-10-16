import type { Ref } from 'react';

import { useSelectedTab } from '../../state/workspace-store';
import { CONTENT_AREA_ID, tabDomId } from '../layout/ids';
import { InternalPage } from './InternalPage';

/**
 * The content area. Its box is exactly the rectangle main fills with the selected tab's web view,
 * so a web page is drawn over it and it stays empty. Only for an internal page (new tab, error)
 * does main detach the view, and then this draws the page.
 */
export function ContentArea({ ref }: { readonly ref: Ref<HTMLDivElement> }) {
  const tab = useSelectedTab();

  return (
    <main className="relative min-h-0 min-w-0 bg-background">
      <div
        ref={ref}
        id={CONTENT_AREA_ID}
        role="tabpanel"
        aria-labelledby={tab === undefined ? undefined : tabDomId(tab.id)}
        className="absolute inset-0 overflow-auto"
      >
        {/* Keyed by tab, so what is typed on one tab's new-tab page isn't carried to another's. */}
        {tab?.page.kind === 'internal' ? <InternalPage key={tab.id} tab={tab} /> : null}
      </div>
    </main>
  );
}
