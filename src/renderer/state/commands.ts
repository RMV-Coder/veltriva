// Thin wrappers over `window.veltriva`. The shell is advisory (ADR-0005): it sends a command and
// waits for the next workspace snapshot to change, so nothing here updates any state. A failed
// command resolves (it doesn't throw) and is logged; these helpers never reject either.
import type { Result } from '../../shared/contracts/ipc';
import type { CommandOutput } from '../../shared/contracts/schemas';
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

export async function closeTab(tabId: string): Promise<boolean> {
  return (await run('tabs.close', () => window.veltriva.tabs.close({ tabId }))).ok;
}

export async function selectTab(tabId: string): Promise<boolean> {
  return (await run('tabs.select', () => window.veltriva.tabs.select({ tabId }))).ok;
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
