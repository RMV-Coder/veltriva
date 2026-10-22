// LayoutManager (assessment §3.2): sizes the shell to the whole window and the selected tab's
// view to the content area, which is the window minus the chrome the shell reports
// (`layout.setInsets`). Tab views are added after the shell, so they paint above it (§3.3).
//
// Two more modes (M1.3b): in HTML fullscreen the tab fills the whole window, and for something
// the shell must draw over the page (the fullscreen notice) the transparent shell is raised above
// the tab (ADR-0006, option A′). The page stays visible and live underneath.
import type { BaseWindow, WebContentsView } from 'electron';

import { fillRect, insetRect } from '../../core/layout/rect';
import type { Insets, Rect } from '../../core/layout/rect';

/** Until the shell measures its chrome: ADR-0009's toolbar and sidebar, so a tab never covers them. */
const DEFAULT_INSETS: Insets = { top: 48, right: 0, bottom: 0, left: 260 };

export class LayoutManager {
  readonly #window: BaseWindow;
  readonly #shell: WebContentsView;
  #insets: Insets = DEFAULT_INSETS;
  #content: WebContentsView | undefined;
  /**
   * Tab views attached but invisible, at the bottom of the stack: a tab restoring in the
   * background (M3.1). Restoring into a detached view puts the scroll position off by the
   * display's scale factor; attached and invisible, it is exact (spike S2).
   */
  readonly #hidden = new Set<WebContentsView>();
  #fullscreen = false;
  #shellRaised = false;

  constructor(window: BaseWindow, shell: WebContentsView) {
    this.#window = window;
    this.#shell = shell;
    window.on('resize', () => {
      this.#layout();
    });
    this.#layout();
  }

  setInsets(insets: Insets): void {
    this.#insets = insets;
    this.#layout();
  }

  /** In HTML fullscreen the tab fills the window: no chrome around it. */
  setFullscreen(fullscreen: boolean): void {
    this.#fullscreen = fullscreen;
    this.#layout();
  }

  contentRect(): Rect {
    if (this.#window.isDestroyed()) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }
    const { width, height } = this.#window.getContentBounds();
    return this.#fullscreen
      ? fillRect({ width, height })
      : insetRect({ width, height }, this.#insets);
  }

  /** Shows a tab's view in the content area, replacing whichever view was there. */
  showContent(view: WebContentsView): void {
    if (this.#content === view || this.#window.isDestroyed()) {
      return;
    }
    if (this.#hidden.delete(view)) {
      view.setVisible(true);
    }
    if (this.#content !== undefined) {
      this.#window.contentView.removeChildView(this.#content);
    }
    this.#content = view;
    this.#window.contentView.addChildView(view);
    view.setBounds(this.contentRect());
    if (this.#shellRaised) {
      this.#window.contentView.addChildView(this.#shell);
    }
  }

  /**
   * Detaches a tab's view, if it's the one shown. The view stays alive (ADR-0002 §2). Tabs are
   * closed after the window is destroyed (its `closed` event), and then there is nothing left to
   * detach from: touching the window would throw "Object has been destroyed".
   */
  hideContent(view: WebContentsView): void {
    if (this.#hidden.delete(view)) {
      if (!this.#window.isDestroyed()) {
        this.#window.contentView.removeChildView(view);
      }
      view.setVisible(true);
      return;
    }
    if (this.#content !== view) {
      return;
    }
    this.#content = undefined;
    if (!this.#window.isDestroyed()) {
      this.#window.contentView.removeChildView(view);
    }
  }

  /**
   * Attaches a tab's view where nothing shows it: invisible, under every other view, sized like
   * the content area. For a restore while the tab isn't selected (spike S2). `showContent` makes
   * it the content; `hideContent` detaches it.
   */
  attachHidden(view: WebContentsView): void {
    if (this.#window.isDestroyed() || this.#hidden.has(view)) {
      return;
    }
    if (this.#content === view) {
      this.#content = undefined;
      view.setVisible(false);
      this.#hidden.add(view);
      return;
    }
    view.setVisible(false);
    this.#window.contentView.addChildView(view, 0);
    view.setBounds(this.contentRect());
    this.#hidden.add(view);
  }

  /**
   * Puts the shell above the tab (A′). The shell's view background is transparent, and while it is
   * raised it must draw nothing but what belongs over the page. It gets every click over the
   * content area until it is lowered; keyboard focus stays where it was.
   */
  raiseShell(): void {
    if (this.#window.isDestroyed()) {
      return;
    }
    this.#shellRaised = true;
    // Adding a child view it already has moves it to the top.
    this.#window.contentView.addChildView(this.#shell);
  }

  /** Puts the tab back above the shell. */
  lowerShell(): void {
    if (this.#window.isDestroyed()) {
      return;
    }
    this.#shellRaised = false;
    if (this.#content !== undefined) {
      this.#window.contentView.addChildView(this.#content);
    }
  }

  #layout(): void {
    if (this.#window.isDestroyed()) {
      return;
    }
    const { width, height } = this.#window.getContentBounds();
    this.#shell.setBounds(fillRect({ width, height }));
    this.#content?.setBounds(this.contentRect());
    for (const view of this.#hidden) {
      view.setBounds(this.contentRect());
    }
  }
}
