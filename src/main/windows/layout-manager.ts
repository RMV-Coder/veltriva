// LayoutManager (assessment §3.2): sizes the shell to the whole window and the selected tab's
// view to the content area, which is the window minus the chrome the shell reports
// (`layout.setInsets`). Tab views are added after the shell, so they paint above it (§3.3).
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

  contentRect(): Rect {
    if (this.#window.isDestroyed()) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }
    const { width, height } = this.#window.getContentBounds();
    return insetRect({ width, height }, this.#insets);
  }

  /** Shows a tab's view in the content area, replacing whichever view was there. */
  showContent(view: WebContentsView): void {
    if (this.#content === view || this.#window.isDestroyed()) {
      return;
    }
    if (this.#content !== undefined) {
      this.#window.contentView.removeChildView(this.#content);
    }
    this.#content = view;
    this.#window.contentView.addChildView(view);
    view.setBounds(this.contentRect());
  }

  /**
   * Detaches a tab's view, if it's the one shown. The view stays alive (ADR-0002 §2). Tabs are
   * closed after the window is destroyed (its `closed` event), and then there is nothing left to
   * detach from: touching the window would throw "Object has been destroyed".
   */
  hideContent(view: WebContentsView): void {
    if (this.#content !== view) {
      return;
    }
    this.#content = undefined;
    if (!this.#window.isDestroyed()) {
      this.#window.contentView.removeChildView(view);
    }
  }

  #layout(): void {
    if (this.#window.isDestroyed()) {
      return;
    }
    const { width, height } = this.#window.getContentBounds();
    this.#shell.setBounds(fillRect({ width, height }));
    this.#content?.setBounds(this.contentRect());
  }
}
