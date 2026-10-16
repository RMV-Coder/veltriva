// Thin wrappers over `window.veltriva`. The shell is advisory (ADR-0005): it sends a command and
// waits for the next workspace snapshot to change, so nothing here updates any state. A failed
// command resolves (it doesn't throw) and is logged; these helpers never reject either.
import type { Result } from '../../shared/contracts/ipc';
import type { CommandInput, CommandOutput } from '../../shared/contracts/schemas';
import type { Insets } from '../features/layout/insets';

async function run<T>(name: string, call: () => Promise<Result<T>>): Promise<Result<T>> {
  let result: Result<T>;
  try {
    result = await call();
  } catch (error) {
    // The transport itself failed. Report it the way main reports a failed handler.
    console.warn(`veltriva: ${name} could not reach the main process`, error);
    return { ok: false, code: 'internal' };
  }
  if (!result.ok) {
    console.warn(`veltriva: ${name} failed (${result.code})`);
  }
  return result;
}

/** Creates a tab, appended and selected. Resolves to its id, or undefined if main refused. */
export async function createTab(): Promise<string | undefined> {
  const result = await run('tabs.create', () => window.veltriva.tabs.create());
  return result.ok ? result.value.tabId : undefined;
}

/**
 * `keepFocus`: the user is at the keyboard in the sidebar, so keyboard focus stays in the shell.
 * Without it main gives the page keyboard focus, which is what a mouse click expects.
 */
export interface FocusOptions {
  readonly keepFocus?: boolean;
}

/** The command's input, leaving `keepFocus` out unless it is set. */
function withFocus(tabId: string, options: FocusOptions | undefined) {
  return options?.keepFocus === true ? { tabId, keepFocus: true } : { tabId };
}

export async function closeTab(tabId: string, options?: FocusOptions): Promise<boolean> {
  return (await run('tabs.close', () => window.veltriva.tabs.close(withFocus(tabId, options)))).ok;
}

export async function selectTab(tabId: string, options?: FocusOptions): Promise<boolean> {
  return (await run('tabs.select', () => window.veltriva.tabs.select(withFocus(tabId, options))))
    .ok;
}

/** `toIndex` is the tab's final index in the whole strip. Main clamps it into the tab's section. */
export async function moveTab(tabId: string, toIndex: number): Promise<boolean> {
  return (await run('tabs.move', () => window.veltriva.tabs.move({ tabId, toIndex }))).ok;
}

export async function setTabPinned(tabId: string, pinned: boolean): Promise<boolean> {
  return (await run('tabs.setPinned', () => window.veltriva.tabs.setPinned({ tabId, pinned }))).ok;
}

export type SubmitAction = CommandOutput<'navigation.submit'>['action'];

/**
 * Hands main what the user typed. Main decides whether it is a URL, a search or an internal page,
 * and this resolves to what it did, or undefined if the command failed.
 */
export async function submitAddress(
  tabId: string,
  text: string,
): Promise<SubmitAction | undefined> {
  const result = await run('navigation.submit', () =>
    window.veltriva.navigation.submit({ tabId, text }),
  );
  return result.ok ? result.value.action : undefined;
}

export async function goBack(tabId: string): Promise<boolean> {
  return (await run('navigation.back', () => window.veltriva.navigation.back({ tabId }))).ok;
}

export async function goForward(tabId: string): Promise<boolean> {
  return (await run('navigation.forward', () => window.veltriva.navigation.forward({ tabId }))).ok;
}

export async function reloadTab(tabId: string): Promise<boolean> {
  return (await run('navigation.reload', () => window.veltriva.navigation.reload({ tabId }))).ok;
}

export async function stopLoading(tabId: string): Promise<boolean> {
  return (await run('navigation.stop', () => window.veltriva.navigation.stop({ tabId }))).ok;
}

export async function setLayoutInsets(insets: Insets): Promise<boolean> {
  return (await run('layout.setInsets', () => window.veltriva.layout.setInsets(insets))).ok;
}

/**
 * The context menu of a sidebar tab, at a point in the shell's view (CSS px, which are the
 * window's DIPs). Main builds and shows the native menu.
 */
export async function showTabMenu(tabId: string, x: number, y: number): Promise<boolean> {
  return (await run('tabs.showMenu', () => window.veltriva.tabs.showMenu({ tabId, x, y }))).ok;
}

export type ZoomDirection = CommandInput<'tabs.zoom'>['direction'];

/** One zoom step for the tab, or `reset` back to 100%. Main owns the steps and the limits. */
export async function zoomTab(tabId: string, direction: ZoomDirection): Promise<boolean> {
  return (await run('tabs.zoom', () => window.veltriva.tabs.zoom({ tabId, direction }))).ok;
}

/** The find bar's text changed: main searches again from the top ('' clears the search). */
export async function updateFind(tabId: string, text: string): Promise<boolean> {
  return (await run('find.update', () => window.veltriva.find.update({ tabId, text }))).ok;
}

export async function findNext(tabId: string, forward: boolean): Promise<boolean> {
  return (await run('find.next', () => window.veltriva.find.next({ tabId, forward }))).ok;
}

/** Closes the tab's find bar. Main gives keyboard focus back to the page. */
export async function closeFind(tabId: string): Promise<boolean> {
  return (await run('find.close', () => window.veltriva.find.close({ tabId }))).ok;
}

/** The fullscreen notice has painted: main may raise the shell above the page now. */
export async function fullscreenNoticeShown(): Promise<boolean> {
  return (await run('fullscreen.noticeShown', () => window.veltriva.fullscreen.noticeShown())).ok;
}

/** The user clicked the fullscreen notice: main hides it. */
export async function dismissFullscreenNotice(): Promise<boolean> {
  return (await run('fullscreen.dismissNotice', () => window.veltriva.fullscreen.dismissNotice()))
    .ok;
}
