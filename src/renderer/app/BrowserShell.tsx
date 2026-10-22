import { useRef } from 'react';

import { DownloadsPanel } from '../features/downloads/DownloadsPanel';
import { useContentInsets } from '../features/layout/use-content-insets';
import { NoticeStrips } from '../features/notices/NoticeStrips';
import { ContentArea } from '../features/pages/ContentArea';
import { PaletteHost } from '../features/palette/PaletteHost';
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
 * The memory palette (M4.2) is drawn over all of it as a modal, and the address bar's suggestions
 * hang from the toolbar over the content area. Both are overlays above the page (ADR-0006 A′):
 * while one shows, main raises this transparent view above the tab, so the chrome here paints its
 * own opaque backgrounds, and the content area is the one part that clears (globals.css).
 *
 * It is its own component so that it mounts afresh when the fullscreen notice gives way to it:
 * `useContentInsets` measures the content area that exists then.
 */
export function BrowserShell() {
  const contentRef = useRef<HTMLDivElement>(null);

  useContentInsets(contentRef);

  return (
    <div className="grid h-screen grid-cols-[260px_minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden text-foreground">
      {/* The chrome paints its own background: the grid behind it is clear while an overlay is up. */}
      <div className="col-span-2 bg-background">
        <Toolbar />
        <PromptStrip />
        <NoticeStrips />
        <DownloadsPanel />
      </div>
      <Sidebar />
      <ContentArea ref={contentRef} />
      <PaletteHost />
    </div>
  );
}
