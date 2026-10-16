/** The content area's id: the tabs' `aria-controls` points at it. */
export const CONTENT_AREA_ID = 'content-area';

/** The DOM id of a tab's sidebar element, which labels the content area while the tab is selected. */
export function tabDomId(tabId: string): string {
  return `tab-${tabId}`;
}
