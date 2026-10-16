import { useLayoutEffect } from 'react';

import { dismissFullscreenNotice, fullscreenNoticeShown } from '../../state/commands';
import { useRootOverlay } from './use-root-overlay';

/** Names the overlay on `<html>`; globals.css makes the shell transparent while it is set. */
const OVERLAY = 'fullscreen-notice';

/**
 * The fullscreen notice (threat T6): a page that goes fullscreen must not be able to pass for the
 * browser, so the shell tells the user which site it is and how to leave. It is the only thing the
 * shell draws while it shows (ADR-0006 A′): main raises the shell's transparent view above the
 * fullscreen page, so everything else here is clear, and a click anywhere dismisses the notice.
 *
 * `origin` is a label main built, shown as text only.
 */
export function FullscreenNotice({ origin }: { readonly origin: string }) {
  useRootOverlay(OVERLAY);

  // Main raises the shell only after this tells it the notice is on screen, so the toolbar never
  // flashes over the page. The notice is in the DOM now; the second frame comes after the one that
  // painted it. One notice, one message: cleaning up cancels it if the notice ends first.
  useLayoutEffect(() => {
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        void fullscreenNoticeShown();
      });
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div
      data-fullscreen-notice-layer=""
      onClick={() => {
        void dismissFullscreenNotice();
      }}
      className="fixed inset-0 flex cursor-default items-start justify-center px-6 pt-10 select-none"
    >
      {/* Dark in either color scheme, with a light edge: the page behind it can be any color. */}
      <div
        role="status"
        data-fullscreen-notice=""
        className="flex max-w-xl flex-col items-center gap-0.5 rounded-3xl bg-neutral-900 px-6 py-3 text-center text-neutral-50 shadow-lg ring-1 ring-white/30"
      >
        {/* <bdi>: the origin is untrusted text and must not reorder the words around it. */}
        <p className="text-sm font-medium break-all">
          <bdi>{origin}</bdi> is now full screen
        </p>
        <p className="text-xs text-neutral-300">Press Esc to exit full screen</p>
      </div>
    </div>
  );
}
