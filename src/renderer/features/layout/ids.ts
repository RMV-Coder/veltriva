/** The content area's id: the tabs' `aria-controls` points at it. */
export const CONTENT_AREA_ID = 'content-area';

/** The DOM id of a tab's sidebar element, which labels the content area while the tab is selected. */
export function tabDomId(tabId: string): string {
  return `tab-${tabId}`;
}

/** The downloads button, which opens and closes the panel under the toolbar. */
export const DOWNLOADS_BUTTON_ID = 'downloads-button';
/** The downloads panel: the button's `aria-controls` points at it. */
export const DOWNLOADS_PANEL_ID = 'downloads-panel';
