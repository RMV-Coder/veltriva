// F6 inside the shell (M6.2): takes the step `nextFocusStop` names when main sends `ui.cycleFocus`.
import { useEffect } from 'react';

import { focusPage } from '../../state/commands';
import { useUiStore } from '../../state/ui-store';
import { useWorkspaceStore } from '../../state/workspace-store';
import { CONTENT_AREA_ID } from './ids';
import { nextFocusStop } from './focus-cycle';
import type { FocusRegion } from './focus-cycle';

/** The sidebar's element (`Sidebar.tsx`). */
export const SIDEBAR_SELECTOR = '[data-sidebar]';

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]';

function regionOf(element: Element | null): FocusRegion {
  if (element?.closest(SIDEBAR_SELECTOR) != null) {
    return 'sidebar';
  }
  if (element?.closest(`#${CONTENT_AREA_ID}`) != null) {
    return 'page';
  }
  return 'elsewhere';
}

/** The first control a keyboard user can reach inside `root`, skipping hidden parts. */
function firstFocusable(root: Element): HTMLElement | null {
  for (const candidate of root.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (candidate.closest('[hidden], [aria-hidden="true"], [inert]') === null) {
      return candidate;
    }
  }
  return null;
}

function focusSidebar(): void {
  const sidebar = document.querySelector(SIDEBAR_SELECTOR);
  if (sidebar === null) {
    return;
  }
  // The open tabs' tab stop is the selected tab (TabList's roving tabindex).
  const tab = sidebar.querySelector<HTMLElement>('[role="tab"][tabindex="0"]');
  const target = tab !== null && tab.closest('[hidden]') === null ? tab : firstFocusable(sidebar);
  target?.focus();
}

function focusThePage(): void {
  // A page the shell draws itself (Settings, an error page) is in the content area; a web page is
  // main's to focus.
  const drawn = document.querySelector(`#${CONTENT_AREA_ID} [data-internal-page]`);
  if (drawn !== null) {
    const target = firstFocusable(drawn);
    if (target !== null) {
      target.focus();
      return;
    }
  }
  void focusPage();
}

function focusAddressBar(): void {
  const tabId = useWorkspaceStore.getState().snapshot?.selectedTabId ?? null;
  if (tabId !== null) {
    useUiStore.getState().requestOmniboxFocus(tabId);
  }
}

/** Listens for F6 while the shell has the keyboard. Mount once, in the shell. */
export function useFocusCycle(): void {
  useEffect(
    () =>
      window.veltriva.on('ui.cycleFocus', () => {
        // The palette is modal: the keyboard stays in it until it closes.
        if (useUiStore.getState().paletteOpen) {
          return;
        }
        switch (nextFocusStop(regionOf(document.activeElement))) {
          case 'sidebar':
            focusSidebar();
            return;
          case 'page':
            focusThePage();
            return;
          case 'address-bar':
            focusAddressBar();
            return;
        }
      }),
    [],
  );
}
