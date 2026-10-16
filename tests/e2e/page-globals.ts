// What specs use inside `page.evaluate`. The function runs in the page, a browser, but this
// project's Node tsconfig has no DOM types. In a page `globalThis` is the window, so each
// callback starts with `const page = globalThis as PageGlobal;` and reaches the DOM through it.
// Only what the specs touch is described here; add to it as needed.
import type { ShellApi } from '../../src/shared/shell-api';

export interface PageElement {
  textContent: string | null;
  append(...nodes: PageElement[]): void;
  checkVisibility(): boolean;
}

export interface PageStyleSheet {
  readonly href: string | null;
  readonly cssRules: { readonly length: number };
}

export interface PageComputedStyle {
  readonly margin: string;
  readonly boxSizing: string;
}

export interface SecurityPolicyViolation {
  readonly effectiveDirective: string;
  readonly blockedURI: string;
}

export interface PageDocument {
  readonly head: PageElement;
  readonly body: PageElement;
  readonly styleSheets: ArrayLike<PageStyleSheet>;
  querySelector(selector: string): PageElement | null;
  createElement(tagName: string): PageElement;
  addEventListener(
    type: 'securitypolicyviolation',
    listener: (event: SecurityPolicyViolation) => void,
    options?: { once?: boolean },
  ): void;
}

/** The window's own members, beside the ones `lib` already declares. */
export interface PageGlobals {
  /** Present in the shell only: the shell preload's frozen API. */
  veltriva: ShellApi;
  document: PageDocument;
  location: { href: string };
  getComputedStyle(element: PageElement): PageComputedStyle;
  open(url: string): unknown;
}
export type PageGlobal = typeof globalThis & PageGlobals;
