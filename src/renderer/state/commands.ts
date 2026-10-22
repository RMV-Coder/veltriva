// Thin wrappers over `window.veltriva`. The shell is advisory (ADR-0005): it sends a command and
// waits for the next workspace snapshot to change, so nothing here updates any state. A failed
// command resolves (it doesn't throw) and is logged; these helpers never reject either.
import type { ActivityEntry } from '../../shared/contracts/activity';
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

/**
 * Moves a strip tab to Sleeping (the tab's menu also offers it). Resolves to true only if the tab
 * moved: a pinned tab stays. Main offers Undo in the next snapshot.
 */
export async function shelveTab(tabId: string): Promise<boolean> {
  const result = await run('tabs.shelve', () => window.veltriva.tabs.shelve({ tabId }));
  return result.ok && result.value.moved;
}

/**
 * Archives a tab from the strip or Sleeping. A loaded page is unloaded first, and a page that
 * objects (unsaved changes) keeps the tab where it is: false.
 */
export async function archiveTab(tabId: string): Promise<boolean> {
  const result = await run('tabs.archive', () => window.veltriva.tabs.archive({ tabId }));
  return result.ok && result.value.moved;
}

/**
 * Brings a tab back from Sleeping or the Archive to the strip, next to the current tab, and
 * selects it. An archived tab may come back under a new id, so this resolves to the id the tab has
 * now, or undefined if main refused (the tab is gone). `keepFocus` as for `selectTab`.
 */
export async function restoreTab(
  tabId: string,
  options?: FocusOptions,
): Promise<string | undefined> {
  const result = await run('tabs.restore', () =>
    window.veltriva.tabs.restore(withFocus(tabId, options)),
  );
  return result.ok ? result.value.tabId : undefined;
}

/** Protects the tab from automation (or ends the protection). */
export async function setTabProtected(tabId: string, protect: boolean): Promise<boolean> {
  return (
    await run('tabs.setProtected', () =>
      window.veltriva.tabs.setProtected({ tabId, protected: protect }),
    )
  ).ok;
}

/**
 * Undoes the batch of moves the toast offers. Resolves to how many tabs went back (0 if the offer
 * had already expired), or undefined if the command failed.
 */
export async function undoBatch(batchId: string): Promise<number | undefined> {
  const result = await run('lifecycle.undo', () => window.veltriva.lifecycle.undo({ batchId }));
  return result.ok ? result.value.undone : undefined;
}

/** Closes the Undo offer without undoing anything. */
export async function dismissUndo(batchId: string): Promise<boolean> {
  return (
    await run('lifecycle.dismissUndo', () => window.veltriva.lifecycle.dismissUndo({ batchId }))
  ).ok;
}

/** The activity log, newest first, or undefined if it could not be read. */
export async function fetchActivity(): Promise<readonly ActivityEntry[] | undefined> {
  const result = await run('lifecycle.activity', () => window.veltriva.lifecycle.activity());
  return result.ok ? result.value.entries : undefined;
}

/**
 * "Pause automation" (or resume it): while it is paused nothing is unloaded or moved on its own.
 * Main saves the choice and shows it in the next snapshot's `automation.paused`.
 */
export async function setAutomationPaused(paused: boolean): Promise<boolean> {
  return (await run('lifecycle.setPaused', () => window.veltriva.lifecycle.setPaused({ paused })))
    .ok;
}

/** Ends preview mode early: automation carries its moves out from now on. */
export async function endPreview(): Promise<boolean> {
  return (await run('lifecycle.endPreview', () => window.veltriva.lifecycle.endPreview())).ok;
}

/**
 * Protects the site of the tab's page from automation (or ends it). Resolves to the site, or
 * undefined if main refused: a tab without a site (not an http(s) page) has nothing to protect.
 */
export async function setSiteProtected(
  tabId: string,
  protect: boolean,
): Promise<string | undefined> {
  const result = await run('tabs.setSiteProtected', () =>
    window.veltriva.tabs.setSiteProtected({ tabId, protected: protect }),
  );
  return result.ok ? result.value.site : undefined;
}

/** What the local diagnostics page shows (assessment §4.13): the regret metric and what automation sees. */
export type Diagnostics = CommandOutput<'lifecycle.diagnostics'>;

/** The diagnostics, or undefined if they could not be read. */
export async function fetchDiagnostics(): Promise<Diagnostics | undefined> {
  const result = await run('lifecycle.diagnostics', () => window.veltriva.lifecycle.diagnostics());
  return result.ok ? result.value : undefined;
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

/**
 * Answers the question the toolbar shows for a tab. Only the question with `promptId` can be
 * answered: if the page has gone away or another one took its place, main ignores this.
 * `remember` is the external-protocol prompt's "always allow", and it is false for every answer
 * that isn't `allow`.
 */
export async function respondToPrompt(
  tabId: string,
  promptId: string,
  decision: CommandInput<'prompts.respond'>['decision'],
  remember: boolean,
  options?: FocusOptions,
): Promise<boolean> {
  return (
    await run('prompts.respond', () =>
      window.veltriva.prompts.respond({
        tabId,
        promptId,
        decision,
        remember,
        keepFocus: options?.keepFocus === true,
      }),
    )
  ).ok;
}

/** Opens the tab's latest blocked popup in a new tab after it, and clears the notice. */
export async function openBlockedPopup(tabId: string): Promise<boolean> {
  return (await run('popups.openBlocked', () => window.veltriva.popups.openBlocked({ tabId }))).ok;
}

/** Clears the tab's "Pop-up blocked" notice without opening anything. */
export async function dismissBlockedPopups(
  tabId: string,
  options?: FocusOptions,
): Promise<boolean> {
  return (
    await run('popups.dismissBlocked', () =>
      window.veltriva.popups.dismissBlocked(withFocus(tabId, options)),
    )
  ).ok;
}

/**
 * Signs in to the server's HTTP authentication question shown for a tab. The credentials go to
 * main once, for Chromium, and are never kept: this wrapper does not log, store or return them
 * (a failure is logged by name and code only). As with `respondToPrompt`, a stale id is ignored,
 * and so is a sign-in that comes too soon after the question appeared. Cancelling is
 * `respondToPrompt(..., 'block')`.
 */
export async function signInToPrompt(
  tabId: string,
  promptId: string,
  credentials: { readonly username: string; readonly password: string },
  options?: FocusOptions,
): Promise<boolean> {
  return (
    await run('prompts.signIn', () =>
      window.veltriva.prompts.signIn({
        tabId,
        promptId,
        username: credentials.username,
        password: credentials.password,
        keepFocus: options?.keepFocus === true,
      }),
    )
  ).ok;
}

export async function pauseDownload(downloadId: string): Promise<boolean> {
  return (await run('downloads.pause', () => window.veltriva.downloads.pause({ downloadId }))).ok;
}

export async function resumeDownload(downloadId: string): Promise<boolean> {
  return (await run('downloads.resume', () => window.veltriva.downloads.resume({ downloadId }))).ok;
}

export async function cancelDownload(downloadId: string): Promise<boolean> {
  return (await run('downloads.cancel', () => window.veltriva.downloads.cancel({ downloadId }))).ok;
}

/** Opens a finished file. Main acts on its own record of the path, and only for a file the user kept. */
export async function openDownload(downloadId: string): Promise<boolean> {
  return (await run('downloads.open', () => window.veltriva.downloads.open({ downloadId }))).ok;
}

export async function showDownloadInFolder(downloadId: string): Promise<boolean> {
  return (
    await run('downloads.showInFolder', () =>
      window.veltriva.downloads.showInFolder({ downloadId }),
    )
  ).ok;
}

/** Keeps a finished dangerous file: it gets its real name and can be opened. */
export async function keepDownload(downloadId: string): Promise<boolean> {
  return (await run('downloads.keep', () => window.veltriva.downloads.keep({ downloadId }))).ok;
}

/** Discards a dangerous file that was not kept: deleted if finished, cancelled if running. */
export async function discardDownload(downloadId: string): Promise<boolean> {
  return (await run('downloads.discard', () => window.veltriva.downloads.discard({ downloadId })))
    .ok;
}

/** Removes a finished download from the list. The file stays where it is. */
export async function clearDownload(downloadId: string): Promise<boolean> {
  return (await run('downloads.clear', () => window.veltriva.downloads.clear({ downloadId }))).ok;
}

// ── The memory (M4.2): the palette, the address bar's suggestions, the Archive list ─────────────

export type MemoryScope = CommandInput<'memory.search'>['scope'];
export type MemorySearch = CommandOutput<'memory.search'>;
export type MemoryOpenTarget = CommandInput<'memory.open'>['target'];

/**
 * Searches the memory (all local: main asks its data worker, nothing goes to the network). The
 * words go as typed; main reads a `site:<domain>` word out of them and says which site it kept
 * the results to. Resolves to the ranked results, or undefined if the search failed.
 */
export async function searchMemory(
  query: string,
  scope: MemoryScope,
  limit: number,
): Promise<MemorySearch | undefined> {
  const result = await run('memory.search', () =>
    window.veltriva.memory.search({ query, scope, limit }),
  );
  return result.ok ? result.value : undefined;
}

/**
 * Opens a search result. `switch`: the tab that shows the page (brought back from Sleeping or the
 * Archive if need be), else a new tab; `newTab`: always a new tab; `current`: the selected tab
 * goes there. Resolves to the tab now showing the page, or undefined if main refused. The page
 * has the keyboard afterwards, so a caller closes its overlay without asking for the page's focus.
 */
export async function openMemoryResult(
  pageId: number,
  target: MemoryOpenTarget,
  tabId?: string,
): Promise<string | undefined> {
  const result = await run('memory.open', () =>
    window.veltriva.memory.open(
      tabId === undefined ? { pageId, target } : { pageId, target, tabId },
    ),
  );
  return result.ok ? result.value.tabId : undefined;
}

export type ShellOverlay = CommandInput<'overlay.show'>['overlay'];

/**
 * The overlay has painted on a transparent page: main raises the shell above the tab and gives it
 * the keyboard (ADR-0006 A′).
 */
export async function showOverlay(overlay: ShellOverlay): Promise<boolean> {
  return (await run('overlay.show', () => window.veltriva.overlay.show({ overlay }))).ok;
}

/**
 * The overlay closed: main lowers the shell once nothing else wants it raised. `focusPage`: the
 * user dismissed it without opening anything, so the page gets the keyboard back; after
 * `openMemoryResult` it is false, since that already focused the page it opened.
 */
export async function hideOverlay(overlay: ShellOverlay, focusPage: boolean): Promise<boolean> {
  return (await run('overlay.hide', () => window.veltriva.overlay.hide({ overlay, focusPage }))).ok;
}

export type ArchiveWindow = CommandOutput<'archive.list'>;

/**
 * A window of the Archive, newest first, from the database: `limit` tabs from `offset`, with how
 * many are archived now. Resolves to undefined if main could not read it.
 */
export async function listArchive(
  offset: number,
  limit: number,
): Promise<ArchiveWindow | undefined> {
  const result = await run('archive.list', () => window.veltriva.archive.list({ offset, limit }));
  return result.ok ? result.value : undefined;
}

// ── Settings (M5.1) ──────────────────────────────────────────────────────────────────────────────

export type SettingsView = CommandOutput<'settings.get'>;
export type SettingsChange = CommandInput<'settings.update'>;

/** What main says to a change: the view it keeps now, or why nothing changed. */
export type SettingsAnswer =
  | { readonly ok: true; readonly view: SettingsView }
  | { readonly ok: false; readonly invalid: boolean };

/** The settings as main keeps them, or undefined if it could not answer. */
export async function fetchSettings(): Promise<SettingsView | undefined> {
  const result = await run('settings.get', () => window.veltriva.settings.get());
  return result.ok ? result.value : undefined;
}

/**
 * Asks main to apply a change. Main checks it and the document it makes; `invalid` says it
 * refused a value, which the page says next to the field, and nothing changed.
 */
export async function updateSettings(change: SettingsChange): Promise<SettingsAnswer> {
  const result = await run('settings.update', () => window.veltriva.settings.update(change));
  return result.ok
    ? { ok: true, view: result.value }
    : { ok: false, invalid: result.code === 'invalid_input' };
}

/** Sets a site's rules from what the user typed; `invalid`: it names no site, or the list is full. */
export async function setSiteRule(
  site: string,
  change: { readonly protect?: boolean; readonly excludeMemory?: boolean },
): Promise<SettingsAnswer> {
  const result = await run('settings.setSiteRule', () =>
    window.veltriva.settings.setSiteRule({ site, ...change }),
  );
  return result.ok
    ? { ok: true, view: result.value }
    : { ok: false, invalid: result.code === 'invalid_input' };
}

/**
 * Removes one entry from the memory (M5.2): the page, and the archived tab showing it when that is
 * the entry. Resolves to what went, or undefined if main refused.
 */
export async function removeMemoryEntry(
  pageId: number,
  archivedTabId: string | undefined,
): Promise<CommandOutput<'memory.remove'> | undefined> {
  const result = await run('memory.remove', () =>
    window.veltriva.memory.remove(
      archivedTabId === undefined ? { pageId } : { pageId, tabId: archivedTabId },
    ),
  );
  return result.ok ? result.value : undefined;
}

/** Shows Settings: its tab if one is open, else a new one. */
export async function openSettings(): Promise<boolean> {
  return (await run('settings.open', () => window.veltriva.settings.open())).ok;
}

// ── Clearing data and stored answers (M5.2) ──────────────────────────────────────────────────────

export type ClearRequest = CommandInput<'privacy.clear'>;
export type ClearResult = CommandOutput<'privacy.clear'>;
export type PermissionsView = CommandOutput<'permissions.list'>;
export type PermissionChange = CommandInput<'permissions.change'>;

/** Clears what the request names; undefined if main refused or failed. */
export async function clearData(request: ClearRequest): Promise<ClearResult | undefined> {
  const result = await run('privacy.clear', () => window.veltriva.privacy.clear(request));
  return result.ok ? result.value : undefined;
}

/** Forgets a site: `invalid` when what was typed names no site. */
export async function forgetSite(
  site: string,
  options: { readonly siteData: boolean; readonly permissions: boolean },
): Promise<
  | { readonly ok: true; readonly value: CommandOutput<'privacy.forgetSite'> }
  | { readonly ok: false; readonly invalid: boolean }
> {
  const result = await run('privacy.forgetSite', () =>
    window.veltriva.privacy.forgetSite({ site, ...options }),
  );
  return result.ok
    ? { ok: true, value: result.value }
    : { ok: false, invalid: result.code === 'invalid_input' };
}

/** The stored answers to sites, or undefined if main could not answer. */
export async function fetchPermissions(): Promise<PermissionsView | undefined> {
  const result = await run('permissions.list', () => window.veltriva.permissions.list());
  return result.ok ? result.value : undefined;
}

/** Changes or revokes one; resolves to the list main keeps now, or undefined. */
export async function changePermission(
  change: PermissionChange,
): Promise<PermissionsView | undefined> {
  const result = await run('permissions.change', () => window.veltriva.permissions.change(change));
  return result.ok ? result.value : undefined;
}
