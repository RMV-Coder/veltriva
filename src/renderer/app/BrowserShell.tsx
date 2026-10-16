import { useRef } from 'react';

import { useContentInsets } from '../features/layout/use-content-insets';
import { ContentArea } from '../features/pages/ContentArea';
import { Sidebar } from '../features/sidebar/Sidebar';
import { Toolbar } from '../features/toolbar/Toolbar';

/**
 * The shell's normal UI: a toolbar across the top, the tab sidebar below it on the left, and the
 * content area filling the rest (ADR-0009). Main places the selected tab's native web view over
 * the content area, so nothing the shell draws there is visible while a web page shows.
 *
 * It is its own component so that it mounts afresh when the fullscreen notice gives way to it:
 * `useContentInsets` measures the content area that exists then.
 */
export function BrowserShell() {
  const contentRef = useRef<HTMLDivElement>(null);

  useContentInsets(contentRef);

  return (
    <div className="grid h-screen grid-cols-[260px_minmax(0,1fr)] grid-rows-[48px_minmax(0,1fr)] overflow-hidden bg-background text-foreground">
      <Toolbar />
      <Sidebar />
      <ContentArea ref={contentRef} />
    </div>
  );
}
