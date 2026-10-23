// E2E test hooks (ADR-0008 §4). Compiled into `--mode test` builds only: src/main/index.ts calls
// `installTestHooks` behind `import.meta.env.MODE === 'test'`, which production builds fold to
// `false` and drop, and `npm run package:dir` refuses a build that still contains the marker.
// Tests reach the hooks with `electronApp.evaluate(() => globalThis.__veltrivaTest...)`.
import { session, webContents } from 'electron';
import type { WebContentsView } from 'electron';

import type { Rect } from '../../core/layout/rect';
import type { DiscardOutcome, DiscardRequest } from '../../core/lifecycle/discard';
import type { LifecycleAction, LifecycleClock, MemoryPressure } from '../../core/lifecycle/policy';
import type { ActivityEntry } from '../../shared/contracts/activity';
import type { LifecycleSettingsDocument } from '../../shared/contracts/settings';
import type { ActivityLog } from '../lifecycle/activity-log';
import type { ActionRecord, LifecycleScheduler } from '../lifecycle/scheduler';
import type { UndoManager, UndoOffer } from '../lifecycle/undo';
import { advanceTestClock, setTestCaptured, setTestMemoryPressure } from './test-clock';
import type { TestClockAdjustment } from './test-clock';
import { isDataMethod } from '../../shared/contracts/data-rpc';
import type { ContextMenus } from '../menus/context-menu';
import type { MenuEntry, MenuItemId, MenuParams } from '../menus/context-menu-model';
import { DataClientError } from '../persistence/data-client';
import type { DataClient, DataReady } from '../persistence/data-client';
import type { DataLifecycle } from '../persistence/data-lifecycle';
import type { AppNotice, AppNotices, NewAppNotice } from '../notices/app-notices';
import { holdDataWorker } from './data-hold';
import type { Worker } from 'node:worker_threads';
import type { TabMenuEntry, TabMenuItemId } from '../menus/tab-menu-model';
import { setSearchTemplate } from '../navigation/search-engine';
import type {
  FreezeOutcome,
  LifecycleFacts,
  RuntimeTransition,
  TabId,
  TabManager,
  TabState,
} from '../tabs/tab-manager';
import { createViewWithRole, roleOf } from '../web/roles';
import type { WebContentsRole } from '../web/web-contents-role';
import { TAB_WEB_PREFERENCES } from '../web/web-preferences';
import type { FullscreenController, FullscreenState } from '../windows/fullscreen';
import type { ClientHints } from '../web/client-hints';
import type { LayoutManager } from '../windows/layout-manager';
import type { MainWindow } from '../windows/main-window';
import type { PopupWindowInfo, PopupWindows } from '../windows/popup-windows';
import { BROWSING_PARTITION } from '../../shared/constants/app-identity';
import { recordedExternalLaunches } from './external-launches';
import {
  clearNetworkRequests,
  recordNetworkRequests,
  recordedNetworkRequests,
} from './network-log';
import type { NetworkRequestEntry } from './network-log';
import { recordedDiagnosticsExports, recordedOpenedPaths } from './diagnostics-exports';
import { recordedPrintRequests } from './print-requests';
import { recordedRuntimeTransitions } from './runtime-transitions';
import { recordedFileActions, testDownloadsFolder } from './test-files';

export const TEST_HOOKS_MARKER = '__veltrivaTest';

export interface WebContentsRoleEntry {
  readonly webContentsId: number;
  readonly role: WebContentsRole | 'none';
  readonly url: string;
}

export interface TabStateEntry extends TabState {
  /** The tab's web contents, if it has one. */
  readonly webContentsId: number | null;
  /** Its DevTools target id, for matching a Playwright Page (S6: `pageForTab`). */
  readonly devToolsTargetId: string | null;
  /** Whether its view is attached to the window right now. */
  readonly attached: boolean;
  /** Its view's bounds, if it has one. */
  readonly bounds: Rect | null;
}

export interface VeltrivaTestHooks {
  /**
   * Opens a tab-role view outside TabManager, over the right half of the window, and loads
   * `url`. `preload` exists for one test only: it gives a non-shell page an IPC channel so the
   * test can prove IpcRouter rejects it. Real tabs never have a preload.
   */
  openTestTab(options: { url: string; preload?: string }): Promise<{ webContentsId: number }>;
  /** Detaches and closes every test tab opened with `openTestTab`. */
  closeTestTabs(): void;
  /** Every live web contents and the role the guard gave it. */
  webContentsRoles(): WebContentsRoleEntry[];
  /** TabManager's view of every tab, in strip order, plus its web contents details. */
  tabStates(): TabStateEntry[];
  selectedTabId(): TabId | null;
  /** The content area the selected tab fills. */
  contentRect(): Rect;
  /** Crashes a tab's renderer (`forcefullyCrashRenderer`). */
  crashTab(tabId: TabId): void;
  /** Points the omnibox's searches at a template, e.g. a local fixture. */
  setSearchTemplate(template: string): void;
  /**
   * The context menu a right-click with these params would show in the tab (Playwright can't
   * click native menus). Params not given are those of a plain click on the page.
   */
  contextMenuItems(tabId: TabId, params?: Partial<MenuParams>): MenuEntry[];
  /** Runs a context-menu item for the tab as if it had been clicked. */
  invokeContextMenuItem(tabId: TabId, params: Partial<MenuParams>, itemId: MenuItemId): void;
  /** The context menu of a tab in the sidebar, and running one of its items. */
  tabMenuItems(tabId: TabId): TabMenuEntry[];
  invokeTabMenuItem(tabId: TabId, itemId: TabMenuItemId): void;
  /** The window's views from bottom to top: `shell`, a tab's id, or `other` (a test tab). */
  viewStack(): string[];
  /** HTML fullscreen as main sees it. */
  fullscreen(): { readonly state: FullscreenState | null; readonly shellRaised: boolean };
  /**
   * Every URL the external-protocol guard launched. Test builds record them instead of opening
   * any app (src/main/testing/external-launches.ts).
   */
  externalLaunches(): string[];
  /**
   * Every request any of the app's sessions made since the last clear (M4.2): the browsing
   * session, the shell's and the default one (src/main/testing/network-log.ts).
   */
  networkRequests(): NetworkRequestEntry[];
  clearNetworkRequests(): void;
  /** The tabs whose page was asked to print (M5.0: Ctrl+P, the context menu), oldest first. */
  printRequests(): TabId[];
  /** "Export diagnostics" documents and "Open the log folder" paths, recorded (M5.3). */
  diagnosticsExports(): string[];
  openedPaths(): string[];
  /** The open popup windows, with what their address bar shows and their layout. */
  popupWindows(): PopupWindowInfo[];
  /** Whether main knows Chromium's client-hint values, so navigations carry the hints. */
  clientHintsReady(): boolean;
  /** Every Open and Show in folder the download manager asked for (recorded, never done). */
  recordedFileActions(): { readonly action: 'open' | 'show'; readonly path: string }[];
  /** Where a test build saves downloads: a folder in the test's own profile. */
  testDownloadsFolder(): string;
  /**
   * Calls the data worker as main does, through the validating client. Returns the value, or
   * the error code instead of throwing, so a spec can assert on refusals.
   */
  dataCall(
    method: string,
    input: unknown,
  ): Promise<
    { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly code: string }
  >;
  /** The data client's state: starting, ready, failed, closing or closed. */
  dataState(): string;
  /**
   * Native addons in main's own module registry. Always empty: SQLite's addon loads only in the
   * data worker, whose registry is separate (ADR-0004).
   */
  mainNativeModules(): string[];
  /** What the data worker reported on opening, or null if it failed to open. */
  dataReady(): Promise<DataReady | null>;
  /** Keeps the data worker inside one SQLite statement for about `ms` (src/data/testing/hold.ts). */
  holdDataWorker(ms: number): void;
  /** The notices the shell shows about Veltriva itself. */
  notices(): AppNotice[];
  /** Raises a notice as main does after a recovery, and returns its id. */
  showNotice(notice: NewAppNotice): string;
  /**
   * Discards a tab as the scheduler will (M3.1, assessment §4.9). The request defaults to an
   * explicit one (`origin: 'user'`), which asks the page again whatever a discard learned.
   */
  discardTab(tabId: TabId, request?: Partial<DiscardRequest>): Promise<DiscardOutcome>;
  /** Freezes a tab (the experiment, off by default in the app). */
  freezeTab(tabId: TabId): Promise<FreezeOutcome>;
  /** What the lifecycle knows about a tab: its epoch, operations, learned protections. */
  lifecycleFacts(tabId: TabId): LifecycleFacts;
  /** Every runtime transition so far (the newest 2,000), optionally of one tab. */
  runtimeTransitions(tabId?: TabId): RuntimeTransition[];
  /**
   * Fast-forwards the lifecycle's clock (M3.2, assessment §4.8): wall-clock time, engaged time and
   * active days, as seen by the policy, TabManager's activity and the protections. Returns the
   * total so far.
   */
  advanceLifecycleClock(by: Partial<TestClockAdjustment>): TestClockAdjustment;
  /** The lifecycle's clock now (with the fast-forward). */
  lifecycleClock(): LifecycleClock;
  /** What the policy plans now, without doing anything. */
  lifecyclePlan(): LifecycleAction[];
  /**
   * Evaluates now, whatever the timer and the quiet start, and resolves once every operation it
   * started has settled, with the actions it logged.
   */
  lifecycleEvaluate(): Promise<ActionRecord[]>;
  /** Every action the scheduler logged (the newest 500). */
  lifecycleLog(): ActionRecord[];
  /** Overrides the memory pressure the scheduler sees; null goes back to the real monitor. */
  setMemoryPressure(level: MemoryPressure | null): void;
  /** Replaces the lifecycle settings (as the Phase 5 settings page will), merged on the current. */
  setLifecycleSettings(settings: Partial<LifecycleSettingsDocument>): void;
  /**
   * Marks a web contents as captured (camera, microphone or screen), or not. Test builds don't
   * read `isBeingCaptured()`: Playwright makes it true for every page.
   */
  setCaptured(webContentsId: number, captured: boolean): void;
  /** Sleeping (M3.3), most recently moved there first, as `tabStates` describes strip tabs. */
  sleepingTabStates(): TabStateEntry[];
  /** The archived tabs in memory, newest first, and how many there are in all. */
  archivedTabEntries(): ArchivedTabEntry[];
  archivedTabCount(): number;
  /** What the sidebar offers to undo, if anything. */
  undoOffer(): UndoOffer | null;
  /** The activity log, newest first. */
  activityEntries(): ActivityEntry[];
}

export interface ArchivedTabEntry {
  readonly id: TabId;
  readonly url: string;
  readonly title: string;
  readonly archivedAt: number;
  readonly reason: 'auto' | 'manual';
}

declare global {
  var __veltrivaTest: VeltrivaTestHooks | undefined;
}

export interface TestHookContext {
  readonly main: MainWindow;
  readonly tabs: TabManager;
  readonly layout: LayoutManager;
  readonly views: ReadonlyMap<TabId, WebContentsView>;
  readonly contextMenus: ContextMenus;
  readonly fullscreen: FullscreenController;
  readonly popupWindows: PopupWindows;
  readonly clientHints: ClientHints;
  readonly data: DataClient;
  readonly dataWorker: Worker;
  readonly dataLifecycle: DataLifecycle;
  readonly notices: AppNotices;
  readonly lifecycle: {
    readonly scheduler: LifecycleScheduler;
    readonly clock: () => LifecycleClock;
    readonly setSettings: (settings: Partial<LifecycleSettingsDocument>) => void;
    readonly undo: UndoManager;
    readonly activity: ActivityLog;
    /** A level a test set (M5.3): the diagnostics page's history records it as the monitor's. */
    readonly testPressureSet?: (level: MemoryPressure | null) => void;
  };
}

/** A plain right-click on the page, at the top-left corner of the view. */
const PLAIN_CLICK: MenuParams = {
  x: 0,
  y: 0,
  linkURL: '',
  srcURL: '',
  mediaType: 'none',
  hasImageContents: false,
  isEditable: false,
  selectionText: '',
  misspelledWord: '',
  dictionarySuggestions: [],
  editFlags: {
    canUndo: false,
    canRedo: false,
    canCut: false,
    canCopy: false,
    canPaste: false,
    canSelectAll: false,
  },
};

export function installTestHooks({
  main,
  tabs,
  layout,
  views,
  contextMenus,
  fullscreen,
  popupWindows,
  clientHints,
  data,
  dataWorker,
  notices,
  lifecycle,
}: TestHookContext): void {
  const testTabs = new Set<WebContentsView>();
  recordNetworkRequests(
    new Map([
      ['browsing', session.fromPartition(BROWSING_PARTITION)],
      ['shell', main.shell.webContents.session],
      ['default', session.defaultSession],
    ]),
  );
  /** A tab as `tabStates` reports it: its state and its view's. */
  const stateEntry = (tab: TabState): TabStateEntry => {
    const view = views.get(tab.id);
    return {
      ...tab,
      webContentsId: view?.webContents.id ?? null,
      devToolsTargetId: view?.webContents.getOrCreateDevToolsTargetId() ?? null,
      attached: view !== undefined && main.window.contentView.children.includes(view),
      bounds: view?.getBounds() ?? null,
    };
  };
  const paramsFrom = (params: Partial<MenuParams> = {}): MenuParams => ({
    ...PLAIN_CLICK,
    ...params,
    editFlags: { ...PLAIN_CLICK.editFlags, ...params.editFlags },
  });

  const hooks: VeltrivaTestHooks = {
    async openTestTab({ url, preload }) {
      const view = createViewWithRole('tab', {
        webPreferences:
          preload === undefined ? { ...TAB_WEB_PREFERENCES } : { ...TAB_WEB_PREFERENCES, preload },
      });
      testTabs.add(view);
      main.window.contentView.addChildView(view);
      const { width, height } = main.window.getContentBounds();
      const half = Math.floor(width / 2);
      view.setBounds({ x: half, y: 0, width: width - half, height });
      await view.webContents.loadURL(url);
      return { webContentsId: view.webContents.id };
    },

    closeTestTabs() {
      for (const view of testTabs) {
        main.window.contentView.removeChildView(view);
        view.webContents.close();
      }
      testTabs.clear();
    },

    webContentsRoles() {
      return webContents.getAllWebContents().map((contents) => ({
        webContentsId: contents.id,
        role: roleOf(contents) ?? 'none',
        url: contents.getURL(),
      }));
    },

    tabStates() {
      return tabs.tabs().map(stateEntry);
    },

    selectedTabId() {
      return tabs.selectedTabId();
    },

    contentRect() {
      return layout.contentRect();
    },

    crashTab(tabId) {
      const view = views.get(tabId);
      if (view === undefined) {
        throw new Error(`Tab ${tabId} has no web contents to crash`);
      }
      view.webContents.forcefullyCrashRenderer();
    },

    setSearchTemplate(template) {
      setSearchTemplate(template);
    },

    contextMenuItems(tabId, params) {
      return contextMenus.entriesForTab(tabId, paramsFrom(params));
    },

    invokeContextMenuItem(tabId, params, itemId) {
      contextMenus.runForTab(tabId, paramsFrom(params), itemId);
    },

    tabMenuItems(tabId) {
      return contextMenus.sidebarTabEntries(tabId);
    },

    invokeTabMenuItem(tabId, itemId) {
      contextMenus.runForSidebarTab(tabId, itemId);
    },

    viewStack() {
      const owners = new Map<unknown, string>([[main.shell, 'shell']]);
      for (const [tabId, view] of views) {
        owners.set(view, tabId);
      }
      return main.window.contentView.children.map((child) => owners.get(child) ?? 'other');
    },

    fullscreen() {
      return { state: fullscreen.state(), shellRaised: fullscreen.shellRaised() };
    },

    externalLaunches() {
      return recordedExternalLaunches();
    },

    networkRequests() {
      return recordedNetworkRequests();
    },

    clearNetworkRequests() {
      clearNetworkRequests();
    },

    diagnosticsExports() {
      return recordedDiagnosticsExports();
    },

    openedPaths() {
      return recordedOpenedPaths();
    },

    printRequests() {
      return recordedPrintRequests();
    },

    popupWindows() {
      return popupWindows.list();
    },

    clientHintsReady() {
      return clientHints.ready();
    },

    recordedFileActions() {
      return recordedFileActions();
    },

    testDownloadsFolder() {
      return testDownloadsFolder();
    },

    async dataCall(method, input) {
      if (!isDataMethod(method)) {
        return { ok: false, code: 'unknown_method' };
      }
      try {
        // The client parses `input` against the method's schema before sending it.
        const value: unknown = await data.call(method, input as never);
        return { ok: true, value };
      } catch (error) {
        return { ok: false, code: error instanceof DataClientError ? error.code : 'internal' };
      }
    },

    dataState() {
      return data.state;
    },

    mainNativeModules() {
      return Object.keys(require.cache).filter((path) => path.endsWith('.node'));
    },

    async dataReady() {
      return data.ready.catch(() => null);
    },

    holdDataWorker(ms) {
      holdDataWorker(dataWorker, ms);
    },

    notices() {
      return [...notices.list()];
    },

    showNotice(notice) {
      return notices.show(notice);
    },

    discardTab(tabId, request = {}) {
      return tabs.discard(tabId, { origin: 'user', ...request });
    },

    freezeTab(tabId) {
      return tabs.freeze(tabId);
    },

    lifecycleFacts(tabId) {
      return tabs.lifecycleFacts(tabId);
    },

    runtimeTransitions(tabId) {
      const all = recordedRuntimeTransitions();
      return tabId === undefined ? all : all.filter((transition) => transition.tabId === tabId);
    },

    advanceLifecycleClock(by) {
      return advanceTestClock(by);
    },

    lifecycleClock() {
      return lifecycle.clock();
    },

    lifecyclePlan() {
      return lifecycle.scheduler.plan();
    },

    async lifecycleEvaluate() {
      const before = lifecycle.scheduler.log().length;
      await lifecycle.scheduler.evaluate();
      return lifecycle.scheduler.log().slice(before);
    },

    lifecycleLog() {
      return [...lifecycle.scheduler.log()];
    },

    setMemoryPressure(level) {
      setTestMemoryPressure(level);
      lifecycle.testPressureSet?.(level);
    },

    setLifecycleSettings(settings) {
      lifecycle.setSettings(settings);
    },

    setCaptured(webContentsId, captured) {
      setTestCaptured(webContentsId, captured);
    },

    sleepingTabStates() {
      return tabs.sleepingTabs().map(stateEntry);
    },

    archivedTabEntries() {
      return tabs.archivedTabs().map((tab) => ({
        id: tab.id,
        url: tab.url,
        title: tab.title,
        archivedAt: tab.archivedAt,
        reason: tab.reason,
      }));
    },

    archivedTabCount() {
      return tabs.archivedCount();
    },

    undoOffer() {
      return lifecycle.undo.current();
    },

    activityEntries() {
      return lifecycle.activity.entries();
    },
  };

  globalThis.__veltrivaTest = Object.freeze(hooks);
}
