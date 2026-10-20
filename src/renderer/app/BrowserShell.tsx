import { useRef } from 'react';

import { DownloadsPanel } from '../features/downloads/DownloadsPanel';
import { useContentInsets } from '../features/layout/use-content-insets';
import { NoticeStrips } from '../features/notices/NoticeStrips';
import { ContentArea } from '../features/pages/ContentArea';
import { PromptStrip } from '../features/prompts/PromptStrip';
import { Sidebar } from '../features/sidebar/Sidebar';
import { Toolbar } from '../features/toolbar/Toolbar';

/**
 * The shell's normal UI: a toolbar across the top, then the prompt strip while the selected tab has
 * a question or a blocked popup, then a strip for each notice about Veltriva itself until the user
 * dismisses it, then the downloads panel while the user has it open, then the tab sidebar on the
 * left and the content area filling the rest (ADR-0009). Main places the selected tab's native web
 * view over the content area, so nothing the shell draws there is visible while a web page shows.
 * That is why the strips and the panel are part of the chrome above it: the content area, and with
 * it the page, gets smaller while any of them shows.
 *
 * It is its own component so that it mounts afresh when the fullscreen notice gives way to it:
 * `useContentInsets` measures the content area that exists then.
 */
export function BrowserShell() {
  const contentRef = useRef<HTMLDivElement>(null);

  useContentInsets(contentRef);

  return (
    <div className="grid h-screen grid-cols-[260px_minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-background text-foreground">
      <div className="col-span-2">
        <Toolbar />
        <PromptStrip />
        <NoticeStrips />
        <DownloadsPanel />
      </div>
      <Sidebar />
      <ContentArea ref={contentRef} />
    </div>
  );
}
