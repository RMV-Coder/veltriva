// Model-based tests of TabManager's lifecycle and placement (ADR-0008 item 2, assessment §4.4,
// §4.5, §9.2): random sequences of user actions, discards, freezes, crashes, outside closes and,
// since M3.3, shelving, archiving, restoring, Undo, protecting and "Leave page?" closes run against
// fake runtimes whose answers (probes, closes, restores, loads, timers) fast-check's scheduler
// releases in random order. Invariants I1–I8 are checked after every command and every released
// task: each tab is in exactly one placement (the strip, Sleeping, or the Archive in memory), the
// selected tab is in the strip, the strip is never empty, an archived tab holds no web contents
// (I3), and a pinned tab is in the strip (I8).
//
// The fakes follow the Electron runtime's contract (./tab-runtime.ts): a discard's close settles
// as `closed` and reports `gone`; `destroy()` settles pending closes without `gone`; `restore()`
// only on a fresh, attached runtime (S2); nothing is reported after the runtime is gone.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { DiscardOutcome, DiscardRequest, Timers } from '../../core/lifecycle/discard';
import type { MoveOutcome, MoveRequest, PlacementMove } from '../../core/lifecycle/placement';
import { planLifecycle, PRESETS, resolveLifecycleSettings } from '../../core/lifecycle/policy';
import type { MemoryPressure } from '../../core/lifecycle/policy';
import type { CloseMode } from '../../core/lifecycle/probe';
import { blockingProtection, protectionFor } from '../../core/lifecycle/protections';
import type { Protection, ProtectionReason } from '../../core/lifecycle/protections';
import type { NavigationSnapshot } from '../../core/lifecycle/snapshot';
import type { TabHistory } from '../../core/session/history';
import { MAX_ARCHIVED_IN_MEMORY, TabManager } from './tab-manager';
import type {
  CloseResult,
  RuntimeTransition,
  TabHistoryObserver,
  TabId,
  TabRuntime,
  TabRuntimeEvents,
} from './tab-manager';

/** What a page does when probed and closed. */
interface PageProfile {
  readonly probe:
    'clean' | 'changed' | 'edited' | 'focused' | 'sensitive' | 'busy' | 'garbage' | 'unresponsive';
  readonly activated: boolean;
  /** On a `beforeunload` close: closes, objects, or never answers. */
  readonly unload: 'closes' | 'objects' | 'stuck';
}

const CLEAN: PageProfile = { probe: 'clean', activated: false, unload: 'closes' };

type RestoreOutcome = 'commits' | 'fails-load' | 'creation-fails';

/** How the user answers "Leave page?" (generated per close): leave, stay, a failing dialog, or never. */
type LeaveAnswer = 'leave' | 'stay' | 'fail' | 'never';

const URLS = [
  'https://a.example/',
  'https://b.example/page',
  'http://c.example/x?y=1',
  'https://d.example/#token=secret',
  'file:///C:/notes.txt',
  'about:blank',
];

/** Everything the fakes share: the scheduler, the pages' behaviour, and what was observed. */
interface World {
  readonly scheduler: fc.Scheduler;
  readonly runtimes: FakeRuntime[];
  /** The runtimes whose web contents still exists. */
  readonly alive: Set<FakeRuntime>;
  readonly profiles: Map<TabId, PageProfile>;
  /** Protections the (fake) protection monitor reports. */
  readonly protections: Map<TabId, Protection[]>;
  restoreOutcome: RestoreOutcome;
  freezeFails: boolean;
  now: number;
  /** Set by the model: the manager, once created. */
  manager: TabManager | null;
  readonly transitions: RuntimeTransition[];
  /** Epoch of each tab when its current discard started. */
  readonly discardStartEpoch: Map<TabId, number>;
  readonly ephemeral: Set<TabId>;
  readonly remembered: Set<TabId>;
  readonly failures: string[];
  steps: number;
  /** What the user will answer when a tab's page objects to a user close (set per close). */
  readonly leaveAnswers: Map<TabId, LeaveAnswer>;
  /** Tabs a user close was requested for: the next ordinary-state `closeForDiscard` is theirs. */
  readonly userCloses: Set<TabId>;
  /** "Leave page?" questions asked. */
  questions: number;
  /** Tabs archived and not brought back, as the model counts them (`archivedCount()` must agree). */
  archiveBalance: number;
}

let runtimeSerial = 0;

class FakeRuntime implements TabRuntime {
  readonly serial = (runtimeSerial += 1);
  alive = true;
  shown = false;
  hiddenAttached = false;
  /** Whether anything was ever loaded or restored (S2: restore only into a fresh one). */
  used = false;
  url = '';
  frozen = false;
  readonly #closeWaiters = new Set<(result: CloseResult) => void>();

  constructor(
    readonly tabId: TabId,
    readonly events: TabRuntimeEvents,
    readonly world: World,
  ) {
    world.alive.add(this);
  }

  #later(label: string, action: () => void): void {
    void this.world.scheduler.schedule(Promise.resolve(), label).then(() => {
      if (this.alive) {
        action();
      }
    });
  }

  #commit(url: string): void {
    this.url = url;
    this.events.committed({ url, sameDocument: false, canGoBack: false, canGoForward: false });
    this.events.loadingChanged(false);
  }

  load(url: string): void {
    this.#assertAlive('load');
    this.used = true;
    this.#later(`load ${this.tabId}`, () => {
      this.#commit(url);
    });
  }
  goBack(): void {
    this.#assertAlive('goBack');
  }
  goForward(): void {
    this.#assertAlive('goForward');
  }
  reload(): void {
    this.#assertAlive('reload');
    this.#later(`reload ${this.tabId}`, () => {
      this.#commit(this.url === '' ? 'https://a.example/' : this.url);
    });
  }
  stop(): void {
    // Nothing to stop in a fake.
  }
  find(): number {
    return 1;
  }
  stopFind(): void {
    // No find in these tests.
  }
  zoomFactor(): number {
    return 1;
  }
  setZoomFactor(): void {
    // No zoom in these tests.
  }
  toggleDevTools(): void {
    // No DevTools in these tests.
  }
  exitFullscreen(): void {
    // No fullscreen in these tests.
  }
  show(): void {
    this.#assertAlive('show');
    this.shown = true;
    this.hiddenAttached = false;
  }
  showHidden(): void {
    this.#assertAlive('showHidden');
    this.shown = false;
    this.hiddenAttached = true;
  }
  hide(): void {
    this.shown = false;
    this.hiddenAttached = false;
  }
  focus(): void {
    // Focus isn't modelled.
  }
  destroy(): void {
    this.shown = false;
    this.hiddenAttached = false;
    this.#gone(false);
  }
  restore(history: NavigationSnapshot): void {
    this.#assertAlive('restore');
    if (this.used) {
      this.world.failures.push(`S2: restore() into runtime ${String(this.serial)} after a load`);
    }
    if (!this.shown && !this.hiddenAttached) {
      this.world.failures.push(`S2: restore() into a detached runtime of ${this.tabId}`);
    }
    if (history.entries.length === 0 || history.index < 0) {
      this.world.failures.push('restore() with no entries');
    }
    this.used = true;
    const outcome = this.world.restoreOutcome;
    const active = history.entries[history.index]?.url ?? 'https://a.example/';
    this.#later(`restore ${this.tabId} ${outcome}`, () => {
      if (outcome === 'commits') {
        this.#commit(active);
      } else if (outcome === 'fails-load') {
        this.url = active;
        this.events.loadFailed({ code: -105, name: 'ERR_NAME_NOT_RESOLVED', url: active });
        this.events.loadingChanged(false);
      } else {
        this.events.restoreFailed();
      }
    });
  }
  history(): TabHistory | null {
    return this.url === '' ? null : { index: 0, entries: [{ url: this.url, title: 'T' }] };
  }
  ping(): Promise<unknown> {
    this.#assertAlive('ping');
    const profile = this.world.profiles.get(this.tabId) ?? CLEAN;
    if (profile.probe === 'unresponsive') {
      return new Promise(() => undefined); // The renderer never gets to it.
    }
    return this.world.scheduler.schedule(Promise.resolve(0), `ping ${this.tabId}`);
  }
  probe(): Promise<unknown> {
    this.#assertAlive('probe');
    if (this.frozen) {
      this.world.failures.push(`probe() of a frozen page in ${this.tabId}`);
    }
    const profile = this.world.profiles.get(this.tabId) ?? CLEAN;
    if (profile.probe === 'busy') {
      return new Promise(() => undefined); // The page never answers in time.
    }
    const reading =
      profile.probe === 'garbage'
        ? { changedFields: -1 }
        : {
            changedFields: profile.probe === 'changed' ? 2 : 0,
            editedFields: profile.probe === 'edited' ? 1 : 0,
            focusedEditable: profile.probe === 'focused',
            sensitive: profile.probe === 'sensitive',
            playingMedia: false,
            hasBeenActive: profile.activated,
            flushed: true,
          };
    return this.world.scheduler.schedule(Promise.resolve(reading), `probe ${this.tabId}`);
  }
  snapshot(): { readonly index: number; readonly entries: readonly unknown[] } | null {
    if (!this.alive || this.url === '') {
      return null;
    }
    return { index: 0, entries: [{ url: this.url, title: 'T', pageState: `ps-${this.url}` }] };
  }
  closeForDiscard(mode: CloseMode): Promise<CloseResult> {
    this.#assertAlive('closeForDiscard');
    if (!this.#isUserClose(mode)) {
      this.#checkI5();
    }
    const profile = this.world.profiles.get(this.tabId) ?? CLEAN;
    return new Promise<CloseResult>((resolve) => {
      this.#closeWaiters.add(resolve);
      if (mode === 'beforeunload' && profile.unload === 'stuck') {
        return; // Settles only if the page closes later (CloseLate) or is destroyed.
      }
      const objects = mode === 'beforeunload' && profile.unload === 'objects';
      this.#later(`close ${this.tabId} ${objects ? 'prevented' : 'closed'}`, () => {
        if (objects) {
          this.#closeWaiters.delete(resolve);
          resolve('prevented');
        } else {
          this.#gone(true);
        }
      });
    });
  }
  freeze(): Promise<void> {
    this.#assertAlive('freeze');
    this.frozen = true;
    const fails = this.world.freezeFails;
    return this.world.scheduler.schedule(Promise.resolve(), `freeze ${this.tabId}`).then(() => {
      if (fails) {
        throw new Error('no debugger');
      }
    });
  }
  thaw(): void {
    this.frozen = false;
  }

  /** The web contents is destroyed: by destroy() (`report` false) or by itself (gone). */
  #gone(report: boolean): void {
    if (!this.alive) {
      return;
    }
    this.alive = false;
    this.world.alive.delete(this);
    this.shown = false;
    this.hiddenAttached = false;
    for (const settle of [...this.#closeWaiters]) {
      settle('closed');
    }
    this.#closeWaiters.clear();
    if (report) {
      this.events.gone();
    }
  }

  /** Something outside TabManager closes the web contents (or a stuck close finishes late). */
  closeFromOutside(): void {
    this.#gone(true);
  }

  crash(): void {
    if (this.alive) {
      this.events.crashed({ code: 1, name: 'crashed' });
    }
  }

  /** The user touches the page: Chromium's user activation, as main sees it. */
  activate(): void {
    if (this.alive) {
      this.events.activated?.();
    }
  }

  /**
   * Whether this close is requestClose's question to the page (a user close, §4.9 Close) rather
   * than a discard's: the tab is live (a frozen one is thawed first), not discarding.
   */
  #isUserClose(mode: CloseMode): boolean {
    const manager = this.world.manager;
    if (!this.world.userCloses.has(this.tabId) || !manager?.has(this.tabId)) {
      return false;
    }
    const state = manager.get(this.tabId);
    if (state.runtime === 'discarding') {
      return false; // A discard's own close.
    }
    this.world.userCloses.delete(this.tabId);
    if (mode !== 'beforeunload') {
      this.world.failures.push(`a user close of ${this.tabId} without beforeunload`);
    }
    if (state.runtime !== 'live' || state.page.kind !== 'web') {
      this.world.failures.push(`a user close of ${this.tabId} while ${state.runtime}`);
    }
    return true;
  }

  /** I5: automation acts only on an unselected, unprotected tab whose epoch is its own. */
  #checkI5(): void {
    const manager = this.world.manager;
    if (!manager?.has(this.tabId)) {
      this.world.failures.push(`I5: close for a tab TabManager no longer has (${this.tabId})`);
      return;
    }
    if (manager.selectedTabId() === this.tabId) {
      this.world.failures.push(`I5: the selected tab ${this.tabId} is being closed for a discard`);
    }
    const state = manager.get(this.tabId);
    if (state.runtime !== 'discarding') {
      this.world.failures.push(`close for a discard while ${state.runtime} (${this.tabId})`);
    }
    if (state.loading) {
      this.world.failures.push(`I5: close for a discard while loading (${this.tabId})`);
    }
    const hard = blockingProtection(
      (this.world.protections.get(this.tabId) ?? []).filter((protection) => protection.hard),
      'discard',
    );
    if (hard !== null) {
      this.world.failures.push(`I5: closing ${this.tabId} despite hard ${hard.reason}`);
    }
    const started = this.world.discardStartEpoch.get(this.tabId);
    const epoch = manager.lifecycleFacts(this.tabId).epoch;
    if (started !== epoch) {
      this.world.failures.push(
        `I5: ${this.tabId}'s epoch moved from ${String(started)} to ${String(epoch)} mid-discard`,
      );
    }
  }

  #assertAlive(call: string): void {
    if (!this.alive) {
      this.world.failures.push(`${call}() on runtime ${String(this.serial)} after it was gone`);
    }
  }
}

/** Timers whose callbacks the scheduler releases, in any order relative to everything else. */
function scheduledTimers(scheduler: fc.Scheduler): Timers {
  return {
    setTimeout(callback, ms) {
      const handle = { cleared: false };
      void scheduler.schedule(Promise.resolve(), `timer ${String(ms)}`).then(() => {
        if (!handle.cleared) {
          callback();
        }
      });
      return handle;
    },
    clearTimeout(handle) {
      (handle as { cleared: boolean }).cleared = true;
    },
  };
}

/** Lets every pending microtask run, so a check never sees a half-finished continuation. */
const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/** Invariants I1–I8 plus TabManager's own (order, ids, one shown view). */
function checkInvariants(world: World, final = false): void {
  const manager = world.manager;
  if (manager === null) {
    return;
  }
  world.steps += 1;
  const fail = (message: string): void => {
    world.failures.push(message);
  };
  const strip = manager.tabs();
  const sleeping = manager.sleepingTabs();
  const archived = manager.archivedTabs();
  // `tabs` is every tab that is still a live record (strip and Sleeping), as I3 to I7 see them.
  const tabs = [...strip, ...sleeping];
  const ids = new Set(tabs.map((tab) => tab.id));
  const stripIds = new Set(strip.map((tab) => tab.id));
  // I1: every tab is in exactly one placement. A live record is in the strip or in Sleeping, never
  // both and never twice; an archived tab is data, not a record.
  if (ids.size !== tabs.length) {
    fail('I1: duplicate tab ids, or a tab in both the strip and Sleeping');
  }
  for (const tab of archived) {
    if (ids.has(tab.id) || manager.has(tab.id)) {
      fail(`I1: archived ${tab.id} is also a live record`);
    }
    // I8
    if (tab.pinned) {
      fail(`I8: archived ${tab.id} is pinned`);
    }
  }
  if (new Set(archived.map((tab) => tab.id)).size !== archived.length) {
    fail('I1: a tab is archived twice');
  }
  if (archived.length > MAX_ARCHIVED_IN_MEMORY || manager.archivedCount() < archived.length) {
    fail('the Archive in memory is over its limit, or the count is below it');
  }
  const firstUnpinned = strip.findIndex((tab) => !tab.pinned);
  if (firstUnpinned !== -1 && strip.slice(firstUnpinned).some((tab) => tab.pinned)) {
    fail('a pinned tab after an unpinned one');
  }
  const selected = manager.selectedTabId();
  // The strip is never empty, and the selected tab is in it.
  if (strip.length === 0) {
    fail('I1: the strip is empty');
  }
  if (selected === null || !stripIds.has(selected)) {
    fail(`I1: ${String(selected)} is not one of the strip's tabs`);
  }
  for (const tab of strip) {
    if (tab.placement !== 'strip') {
      fail(`I1: ${tab.id} is in the strip with placement ${tab.placement}`);
    }
  }
  for (const tab of sleeping) {
    if (tab.placement !== 'shelf') {
      fail(`I1: ${tab.id} is Sleeping with placement ${tab.placement}`);
    }
    // I8: a pinned tab is in the strip.
    if (tab.pinned) {
      fail(`I8: pinned ${tab.id} is Sleeping`);
    }
  }
  // I2
  if (selected !== null && stripIds.has(selected)) {
    const tab = manager.get(selected);
    const facts = manager.lifecycleFacts(selected);
    const unloadedOk =
      tab.runtime === 'unloaded' && (tab.page.kind === 'internal' || facts.heldUnloaded);
    if (!['creating', 'live', 'crashed'].includes(tab.runtime) && !unloadedOk) {
      fail(`I2: the selected tab ${selected} is ${tab.runtime}`);
    }
  }
  // I4 and I3: a tab holds one live runtime exactly when it isn't unloaded; nobody else does.
  const alive = new Map<TabId, FakeRuntime[]>();
  for (const runtime of world.alive) {
    alive.set(runtime.tabId, [...(alive.get(runtime.tabId) ?? []), runtime]);
  }
  const archivedIds = new Set(archived.map((tab) => tab.id));
  for (const [tabId, runtimes] of alive) {
    if (archivedIds.has(tabId)) {
      fail(`I3: archived ${tabId} holds a web contents`);
    } else if (!ids.has(tabId)) {
      fail(`I3/I4: a zombie runtime for ${tabId}, which is closed`);
    }
    if (runtimes.length > 1) {
      fail(`I4: ${tabId} has ${String(runtimes.length)} live runtimes`);
    }
  }
  for (const tab of tabs) {
    const count = alive.get(tab.id)?.length ?? 0;
    if ((tab.runtime === 'unloaded') !== (count === 0)) {
      fail(`I4: ${tab.id} is ${tab.runtime} with ${String(count)} live runtimes`);
    }
    // I7
    const facts = manager.lifecycleFacts(tab.id);
    if (facts.running > 1) {
      fail(`I7: ${tab.id} runs ${String(facts.running)} lifecycle operations`);
    }
  }
  // At most one view shown: the selected tab's, while it shows web content.
  const shown = [...world.alive].filter((runtime) => runtime.shown);
  if (shown.length > 1) {
    fail(`${String(shown.length)} views shown`);
  }
  for (const runtime of shown) {
    if (runtime.tabId !== selected) {
      fail(`the view of ${runtime.tabId} is shown but ${String(selected)} is selected`);
    } else if (manager.get(runtime.tabId).runtime === 'crashed') {
      fail('a crashed page is shown');
    }
  }
  // I6. Reading the session parses every stack, so it is checked every 25 steps (and at the end).
  if (world.steps % 25 !== 0 && !final) {
    return;
  }
  for (const tab of [...manager.sessionTabs(), ...manager.shelfSessionTabs()]) {
    if (world.ephemeral.has(tab.id)) {
      fail(`I6: ephemeral ${tab.id} reached the session`);
    }
  }
  for (const tab of archived) {
    if (world.ephemeral.has(tab.id)) {
      fail(`I6: ephemeral ${tab.id} reached the Archive`);
    }
  }
  for (const tabId of [...world.userCloses]) {
    if (!manager.has(tabId)) {
      world.userCloses.delete(tabId); // That close needed no question to the page.
    }
  }
  for (const tab of manager.closedTabs()) {
    if (world.ephemeral.has(tab.id)) {
      fail(`I6: ephemeral ${tab.id} reached Recently closed`);
    }
  }
  for (const tabId of world.remembered) {
    if (world.ephemeral.has(tabId)) {
      fail(`I6: ephemeral ${tabId} reached the memory`);
    }
  }
}

interface Model {
  /** The discards issued, with the epoch their decision saw and how they ended. */
  readonly discards: {
    readonly tabId: TabId;
    readonly request: DiscardRequest;
    outcome: DiscardOutcome | null;
    rejected: boolean;
  }[];
  /** The archives issued (by a command or by the policy), and how they ended. */
  readonly archives: {
    readonly tabId: TabId;
    outcome: MoveOutcome | null;
    rejected: boolean;
  }[];
  /** Moves that happened, oldest first: what an Undo takes the latest of. */
  readonly moves: PlacementMove[];
  /** Every user close requested: how often `onClosed` ran (at most once, and the tab is gone). */
  readonly closes: { readonly tabId: TabId; closedCalls: number }[];
}

interface Real {
  readonly world: World;
  readonly manager: TabManager;
}

function setupModel(scheduler: fc.Scheduler): { model: Model; real: Real } {
  const world: World = {
    scheduler,
    runtimes: [],
    alive: new Set(),
    profiles: new Map(),
    protections: new Map(),
    restoreOutcome: 'commits',
    freezeFails: false,
    now: 1_000_000,
    manager: null,
    transitions: [],
    discardStartEpoch: new Map(),
    ephemeral: new Set(),
    remembered: new Set(),
    failures: [],
    steps: 0,
    leaveAnswers: new Map(),
    userCloses: new Set(),
    questions: 0,
    archiveBalance: 0,
  };
  const remember = (tabId: TabId): void => {
    world.remembered.add(tabId);
  };
  const history: TabHistoryObserver = {
    committed: remember,
    titleChanged: remember,
    faviconChanged: remember,
    closed: remember,
  };
  let nextId = 0;
  const manager = new TabManager({
    createRuntime: (tabId, events) => {
      const runtime = new FakeRuntime(tabId, events, world);
      world.runtimes.push(runtime);
      return runtime;
    },
    newId: () => `tab-${String((nextId += 1))}`,
    onChange: () => undefined,
    history,
    now: () => world.now,
    // The engagement clock moves with the wall clock here; active days every 6 hours.
    activityClock: () => ({
      wallNow: world.now,
      engagedNow: world.now,
      activeDay: 1 + Math.floor(world.now / (6 * 60 * 60 * 1000)),
    }),
    timers: scheduledTimers(scheduler),
    protections: (tabId) => world.protections.get(tabId) ?? [],
    onTransition: (transition) => {
      world.transitions.push(transition);
      transitionCounts.set(transition.event, (transitionCounts.get(transition.event) ?? 0) + 1);
      if (transition.event === 'discard') {
        world.discardStartEpoch.set(transition.tabId, transition.epoch);
      }
    },
    // "Leave page?": the user answers as the close command generated, when the scheduler lets
    // the dialog be answered. A dialog is only ever shown for the tab the user is looking at.
    confirmLeave: (tabId) => {
      world.questions += 1;
      const shown = world.manager;
      if (shown?.selectedTabId() !== tabId || shown.get(tabId).placement !== 'strip') {
        world.failures.push(`"Leave page?" for ${tabId}, which the user is not looking at`);
      }
      const answer = world.leaveAnswers.get(tabId) ?? 'stay';
      if (answer === 'never') {
        return new Promise<boolean>(() => undefined);
      }
      return scheduler.schedule(Promise.resolve(answer), `leave? ${tabId}`).then((chosen) => {
        if (chosen === 'fail') {
          throw new Error('the dialog failed');
        }
        return chosen === 'leave';
      });
    },
  });
  world.manager = manager;
  activeWorld = world;
  manager.create();
  return { model: { discards: [], archives: [], moves: [], closes: [] }, real: { world, manager } };
}

/**
 * Opening stops here, so long runs keep a workspace of realistic size and checks stay cheap. It
 * counts the strip and Sleeping together: shelving must not make room for endless new tabs.
 */
const MAX_TABS = 40;

/** How many tabs are open: the strip and Sleeping. */
const openTabs = (manager: TabManager): number =>
  manager.tabs().length + manager.sleepingTabs().length;

/**
 * The tab at `index` (modulo the count) among every live record: the strip first, then Sleeping.
 * A Sleeping tab may be live, so every command that works on a page can reach it.
 */
function tabAt(manager: TabManager, index: number): TabId | undefined {
  const tabs = [...manager.tabs(), ...manager.sleepingTabs()];
  return tabs.length === 0 ? undefined : tabs[index % tabs.length]?.id;
}

/** The tab at `index` (modulo the strip), or undefined for an empty strip. */
function stripTabAt(manager: TabManager, index: number): TabId | undefined {
  const tabs = manager.tabs();
  return tabs.length === 0 ? undefined : tabs[index % tabs.length]?.id;
}

/** Everything that protects a tab right now, as TabManager sees it. */
function protectionsOf(world: World, manager: TabManager, tabId: TabId): Protection[] {
  return [
    ...(world.protections.get(tabId) ?? []),
    ...(manager.get(tabId).userProtected ? [protectionFor('user-protected')] : []),
    ...manager.lifecycleFacts(tabId).learned.map((reason) => protectionFor(reason)),
  ];
}

/** How the moves of every sequence ended, so the coverage test can show they reached each path. */
const placementOutcomes = new Map<string, number>();

function countPlacement(
  kind: 'shelve' | 'archive',
  request: MoveRequest,
  outcome: MoveOutcome,
): void {
  const how =
    outcome.outcome === 'moved'
      ? 'moved'
      : outcome.outcome === 'skipped'
        ? `skipped:${outcome.why}`
        : `blocked:${outcome.reason}`;
  const key = `${kind}:${request.origin}:${how}`;
  placementOutcomes.set(key, (placementOutcomes.get(key) ?? 0) + 1);
}

/** A move request as the scheduler would make it (an epoch, fresh or stale) or the user would. */
function moveRequest(
  manager: TabManager,
  tabId: TabId,
  origin: MoveRequest['origin'],
  epoch: 'fresh' | 'stale' | 'none',
): MoveRequest {
  if (origin === 'user' || epoch === 'none') {
    return { origin };
  }
  const current = manager.lifecycleFacts(tabId).epoch;
  return { origin, epoch: epoch === 'fresh' ? current : current - 1 };
}

/**
 * Shelves a tab and checks the answer against what the model saw just before: where it was, who
 * asked, and what could stop automation (I5). A refusal changes nothing; the user's own request
 * for an unpinned strip tab always goes through.
 */
function shelveChecked(real: Real, model: Model, tabId: TabId, request: MoveRequest): void {
  const { manager, world } = real;
  const fail = (message: string): void => {
    world.failures.push(`shelve(${tabId}, ${request.origin}): ${message}`);
  };
  const before = manager.get(tabId);
  const selectedBefore = manager.selectedTabId();
  const stripIndex = manager.tabs().findIndex((tab) => tab.id === tabId);
  const epochBefore = manager.lifecycleFacts(tabId).epoch;
  const protections = protectionsOf(world, manager, tabId);
  const outcome = manager.shelve(tabId, request);
  countPlacement('shelve', request, outcome);
  const now = manager.get(tabId);
  if (outcome.outcome !== 'moved') {
    if (now.placement !== before.placement) {
      fail('a refused tab changed placement');
    }
    if (outcome.outcome === 'skipped') {
      if (outcome.why === 'pinned' && !before.pinned) {
        fail('refused as pinned, but it is not');
      }
      if (outcome.why === 'wrong-placement' && before.placement !== 'shelf') {
        fail('refused as already Sleeping, but it is in the strip');
      }
      if (outcome.why === 'closed') {
        fail('refused as closed, but it is there');
      }
    } else if (request.origin !== 'automation') {
      fail('the user was blocked by a protection');
    } else if (!protections.some((protection) => protection.reason === outcome.reason)) {
      fail(`blocked by ${outcome.reason}, which does not protect it`);
    }
    if (request.origin === 'user' && before.placement === 'strip' && !before.pinned) {
      fail(`the user's request for a strip tab was refused: ${JSON.stringify(outcome)}`);
    }
    return;
  }
  const { move } = outcome;
  model.moves.push(move);
  if (before.placement !== 'strip' || before.pinned) {
    fail('moved a tab that is Sleeping or pinned (I8)');
  }
  if (move.tabId !== tabId || move.from !== 'strip' || move.to !== 'shelf') {
    fail(`the move says ${JSON.stringify(move)}`);
  }
  if (move.index !== stripIndex) {
    fail(`it was at strip index ${String(stripIndex)}, the move says ${String(move.index)}`);
  }
  if (now.placement !== 'shelf' || manager.sleepingTabs()[0]?.id !== tabId) {
    fail('it is not first in Sleeping');
  }
  if (request.origin === 'automation') {
    if (selectedBefore === tabId) {
      fail('I5: shelved the selected tab');
    }
    if (request.epoch !== undefined && request.epoch !== epochBefore) {
      fail(
        `I5: shelved on a decision from epoch ${String(request.epoch)}, not ${String(epochBefore)}`,
      );
    }
    const blocking = blockingProtection(protections, 'shelve');
    if (blocking !== null) {
      fail(`I5: shelved despite ${blocking.reason}`);
    }
  }
}

/**
 * Starts archiving a tab; the answer arrives when its discard and queue allow. The model records
 * the move and checks the tab's entry in the Archive when it does.
 */
function archiveIssued(real: Real, model: Model, tabId: TabId, request: MoveRequest): void {
  const { manager, world } = real;
  const fail = (message: string): void => {
    world.failures.push(`archive(${tabId}, ${request.origin}): ${message}`);
  };
  const ephemeral = manager.get(tabId).ephemeral;
  const entry: Model['archives'][number] = { tabId, outcome: null, rejected: false };
  model.archives.push(entry);
  manager.archive(tabId, request).then(
    (outcome) => {
      entry.outcome = outcome;
      countPlacement('archive', request, outcome);
      if (outcome.outcome !== 'moved') {
        // I6: an ephemeral tab is refused before anything else (unless it closed first).
        if (
          ephemeral &&
          !(outcome.outcome === 'skipped' && ['wrong-placement', 'closed'].includes(outcome.why))
        ) {
          fail(`an ephemeral tab was not refused as such: ${JSON.stringify(outcome)}`);
        }
        return;
      }
      const { move } = outcome;
      model.moves.push(move);
      world.archiveBalance += 1;
      if (ephemeral) {
        fail('I6: archived an ephemeral tab');
      }
      if (
        move.tabId !== tabId ||
        move.to !== 'archive' ||
        !['strip', 'shelf'].includes(move.from)
      ) {
        fail(`the move says ${JSON.stringify(move)}`);
      }
      if (manager.has(tabId)) {
        fail('it is archived but still a record');
      }
      const archived = manager.archivedTabs().find((tab) => tab.id === tabId);
      if (archived === undefined) {
        fail('it is not in the Archive');
      } else {
        if (archived.reason !== (request.origin === 'user' ? 'manual' : 'auto')) {
          fail(`archived as ${archived.reason}`);
        }
        if (archived.pinned) {
          fail('I8: archived pinned');
        }
      }
    },
    () => {
      entry.rejected = true;
    },
  );
}

/**
 * A user close (`requestClose`) with the answer the user will give if the page objects. The
 * tab's `onClosed` runs once, after the tab is gone; if it is gone before this call returns, it
 * already ran.
 */
function requestCloseIssued(
  real: Real,
  model: Model,
  tabId: TabId,
  answer: LeaveAnswer,
  focus: boolean,
): void {
  const { manager, world } = real;
  const fail = (message: string): void => {
    world.failures.push(`requestClose(${tabId}): ${message}`);
  };
  world.leaveAnswers.set(tabId, answer);
  world.userCloses.add(tabId);
  const entry = { tabId, closedCalls: 0 };
  model.closes.push(entry);
  manager.requestClose(tabId, {
    focus,
    onClosed: () => {
      entry.closedCalls += 1;
      if (manager.has(tabId)) {
        fail('onClosed ran, but the tab is still open');
      }
      if (entry.closedCalls > 1) {
        fail('onClosed ran twice');
      }
    },
  });
  if (!manager.has(tabId) && entry.closedCalls !== 1) {
    fail(`the tab closed at once, and onClosed ran ${String(entry.closedCalls)} times`);
  }
}

type Command = fc.AsyncCommand<Model, Real>;

/** A command acting on the tab at an index; the action runs, then the invariants are checked. */
function command(
  name: string,
  details: string,
  action: (real: Real, model: Model) => void,
): Command {
  return {
    check: () => true,
    async run(model, real) {
      action(real, model);
      await settle();
      checkInvariants(real.world);
    },
    toString: () => `${name}(${details})`,
  };
}

const index = fc.nat({ max: 40 });

const profileArbitrary: fc.Arbitrary<PageProfile> = fc.record({
  probe: fc.constantFrom<PageProfile['probe']>(
    'clean',
    'clean',
    'clean',
    'changed',
    'edited',
    'focused',
    'sensitive',
    'busy',
    'garbage',
    'unresponsive',
  ),
  activated: fc.boolean(),
  unload: fc.constantFrom<PageProfile['unload']>('closes', 'closes', 'objects', 'stuck'),
});

/** Issues a discard as the scheduler would: with the epoch it sees now, or an older one. */
function issueDiscard(
  manager: TabManager,
  model: Model,
  tabId: TabId,
  request: Omit<DiscardRequest, 'epoch'>,
  epoch: 'fresh' | 'stale' | 'none',
): void {
  const current = manager.lifecycleFacts(tabId).epoch;
  const full: DiscardRequest = {
    ...request,
    ...(epoch === 'none' ? {} : { epoch: epoch === 'fresh' ? current : current - 1 }),
  };
  const entry = { tabId, request: full, outcome: null as DiscardOutcome | null, rejected: false };
  model.discards.push(entry);
  manager.discard(tabId, full).then(
    (outcome) => {
      entry.outcome = outcome;
    },
    () => {
      entry.rejected = true;
    },
  );
}

const pageOpener: fc.Arbitrary<Command> = fc
  .record({ url: fc.nat({ max: URLS.length - 1 }), select: fc.boolean() })
  .map(({ url, select }) =>
    command('openPage', `${URLS[url] ?? ''}, ${String(select)}`, ({ manager }) => {
      if (openTabs(manager) >= MAX_TABS) {
        return;
      }
      const id = manager.create({ select });
      manager.navigate(id, URLS[url] ?? 'https://a.example/');
    }),
  );

const sweeper: fc.Arbitrary<Command> = fc
  .record({
    origin: fc.constantFrom<DiscardRequest['origin']>('automation', 'pressure'),
    overrideSoft: fc.boolean(),
  })
  .map(({ origin, overrideSoft }) =>
    command('discardBackground', `${origin}, ${String(overrideSoft)}`, ({ manager }, model) => {
      for (const tab of [...manager.tabs(), ...manager.sleepingTabs()]) {
        if (tab.runtime === 'live' && tab.id !== manager.selectedTabId()) {
          issueDiscard(manager, model, tab.id, { origin, overrideSoft }, 'fresh');
        }
      }
    }),
  );

/**
 * The scheduler's evaluation: the real policy over TabManager's own facts, its discards carried
 * out with the epochs it saw (M3.2). I5 is checked where it matters: in the fake's close, and in
 * the epochs the discards started at.
 */
/** Discards the policy planned across the sequences, by rule: the coverage test checks both. */
const policyDiscards = new Map<string, number>();
/** Shelves and archives the policy planned, by `kind:rule`. */
const policyMoves = new Map<string, number>();

const evaluation: fc.Arbitrary<Command> = fc
  .record({
    preset: fc.constantFrom(...PRESETS),
    pressure: fc.constantFrom<MemoryPressure>('none', 'none', 'moderate', 'critical'),
  })
  .map(({ preset, pressure }) =>
    command('evaluate', `${preset}, ${pressure}`, (real, model) => {
      const { manager, world } = real;
      const actions = planLifecycle({
        tabs: manager.lifecycleTabs(),
        settings: resolveLifecycleSettings({
          preset,
          autoArchive: true,
          freeze: false,
          paused: false,
          overrides: {},
        }),
        clock: {
          wallNow: world.now,
          engagedNow: world.now,
          activeDay: 1 + Math.floor(world.now / (6 * 60 * 60 * 1000)),
        },
        pressure,
      });
      for (const action of actions) {
        if (action.kind === 'shelve' || action.kind === 'archive') {
          // Carried out as the scheduler does (M3.3): automation, with the epoch it saw.
          const planned = `${action.kind}:${action.rule}`;
          policyMoves.set(planned, (policyMoves.get(planned) ?? 0) + 1);
          if (action.tabId === manager.selectedTabId()) {
            world.failures.push(`I5: the policy planned the selected tab ${action.tabId}`);
          }
          const request: MoveRequest = { origin: 'automation', epoch: action.epoch };
          if (action.kind === 'shelve') {
            shelveChecked(real, model, action.tabId, request);
          } else {
            archiveIssued(real, model, action.tabId, request);
          }
          continue;
        }
        if (action.kind !== 'discard') {
          continue;
        }
        policyDiscards.set(action.rule, (policyDiscards.get(action.rule) ?? 0) + 1);
        if (action.tabId === manager.selectedTabId()) {
          world.failures.push(`I5: the policy planned the selected tab ${action.tabId}`);
        }
        const entry = {
          tabId: action.tabId,
          request: {
            origin:
              action.rule === 'pressure-discard' ? ('pressure' as const) : ('automation' as const),
            epoch: action.epoch,
            overrideSoft: action.overrideSoft,
          },
          outcome: null as DiscardOutcome | null,
          rejected: false,
        };
        model.discards.push(entry);
        manager.discard(action.tabId, entry.request).then(
          (outcome) => {
            entry.outcome = outcome;
          },
          () => {
            entry.rejected = true;
          },
        );
      }
    }),
  );

/**
 * A discard, then the user acts on the same tab at a moment the scheduler picks: before the
 * probe answers, while the page is closing, or after (§4.11's races).
 */
const race: fc.Arbitrary<Command> = fc
  .record({
    at: index,
    then: fc.constantFrom(
      'select',
      'select',
      'select',
      'reload',
      'navigate',
      'close',
      'newTabPage',
      'shelve',
      'archive',
      'requestClose',
    ),
    /** How many scheduler hops the user's action waits: later hops land after the probe. */
    hops: fc.integer({ min: 1, max: 4 }),
  })
  .map(({ at, then, hops }) =>
    command('discardThen', `${String(at)}, ${then}, ${String(hops)}`, (real, model) => {
      const { manager, world } = real;
      // A live background tab, if there is one: the only kind a discard acts on.
      const candidates = [...manager.tabs(), ...manager.sleepingTabs()].filter(
        (tab) => tab.runtime === 'live' && tab.id !== manager.selectedTabId(),
      );
      const tabId =
        candidates.length === 0 ? tabAt(manager, at) : candidates[at % candidates.length]?.id;
      if (tabId === undefined) {
        return;
      }
      issueDiscard(manager, model, tabId, { origin: 'automation' }, 'fresh');
      let later = Promise.resolve();
      for (let hop = 0; hop < hops; hop += 1) {
        later = later.then(() => world.scheduler.schedule(Promise.resolve(), `wait ${tabId}`));
      }
      void later.then(() => {
        if (!manager.has(tabId)) {
          return;
        }
        switch (then) {
          case 'select':
            manager.select(tabId);
            break;
          case 'reload':
            manager.reload(tabId);
            break;
          case 'navigate':
            manager.navigate(tabId, 'https://b.example/page');
            break;
          case 'close':
            manager.close(tabId);
            break;
          case 'shelve':
            shelveChecked(real, model, tabId, { origin: 'user' });
            break;
          case 'archive':
            archiveIssued(real, model, tabId, { origin: 'user' });
            break;
          case 'requestClose':
            // Strip or Sleeping: a Sleeping tab whose page objects comes back to the strip to ask
            // (these sequences found it once asked out of sight, breaking I1).
            requestCloseIssued(real, model, tabId, 'leave', true);
            break;
          default:
            manager.showInternal(tabId, 'new-tab');
        }
      });
    }),
  );

const commands: fc.Arbitrary<Command>[] = [
  evaluation,
  evaluation,
  race,
  race,
  pageOpener,
  pageOpener,
  pageOpener,
  sweeper,
  sweeper,
  fc
    .record({ select: fc.boolean(), ephemeral: fc.boolean(), after: fc.option(index) })
    .map(({ select, ephemeral, after }) =>
      command('create', `${String(select)}, ${String(ephemeral)}, ${String(after)}`, (real) => {
        if (openTabs(real.manager) >= MAX_TABS) {
          return;
        }
        const afterTabId = after === null ? undefined : tabAt(real.manager, after);
        const id = real.manager.create({
          select,
          ...(ephemeral && afterTabId === undefined ? { ephemeral: true } : {}),
          ...(afterTabId === undefined ? {} : { afterTabId }),
        });
        if (real.manager.get(id).ephemeral) {
          real.world.ephemeral.add(id);
        }
      }),
    ),
  index.map((at) =>
    command('close', String(at), ({ manager }) => {
      const tabId = tabAt(manager, at);
      if (tabId !== undefined) {
        manager.close(tabId, { focus: at % 2 === 0 });
      }
    }),
  ),
  index.map((at) =>
    command('select', String(at), ({ manager }) => {
      const tabId = tabAt(manager, at);
      if (tabId !== undefined) {
        manager.select(tabId);
      }
    }),
  ),
  fc.tuple(index, fc.nat({ max: URLS.length - 1 })).map(([at, url]) =>
    command('navigate', `${String(at)}, ${URLS[url] ?? ''}`, ({ manager }) => {
      const tabId = tabAt(manager, at);
      if (tabId !== undefined) {
        manager.navigate(tabId, URLS[url] ?? 'https://a.example/');
      }
    }),
  ),
  index.map((at) =>
    command('reload', String(at), ({ manager }) => {
      const tabId = tabAt(manager, at);
      if (tabId !== undefined) {
        manager.reload(tabId);
      }
    }),
  ),
  index.map((at) =>
    command('goBack', String(at), ({ manager }) => {
      const tabId = tabAt(manager, at);
      if (tabId !== undefined) {
        manager.goBack(tabId);
      }
    }),
  ),
  index.map((at) =>
    command('newTabPage', String(at), ({ manager }) => {
      const tabId = tabAt(manager, at);
      if (tabId !== undefined) {
        manager.showInternal(tabId, 'new-tab');
      }
    }),
  ),
  fc
    .record({
      at: index,
      origin: fc.constantFrom<DiscardRequest['origin']>('automation', 'pressure', 'user'),
      epoch: fc.constantFrom('fresh', 'stale', 'none'),
      overrideSoft: fc.boolean(),
    })
    .map(({ at, origin, epoch, overrideSoft }) =>
      command(
        'discard',
        `${String(at)}, ${origin}, ${epoch}, ${String(overrideSoft)}`,
        ({ manager }, model) => {
          const tabId = tabAt(manager, at);
          if (tabId !== undefined) {
            issueDiscard(manager, model, tabId, { origin, overrideSoft }, epoch);
          }
        },
      ),
    ),
  index.map((at) =>
    command('freeze', String(at), ({ manager }) => {
      const tabId = tabAt(manager, at);
      if (tabId !== undefined) {
        void manager.freeze(tabId);
      }
    }),
  ),
  index.map((at) =>
    command('crash', String(at), ({ manager, world }) => {
      const tabId = tabAt(manager, at);
      [...world.alive]
        .filter((runtime) => runtime.tabId === tabId)
        .forEach((r) => {
          r.crash();
        });
    }),
  ),
  index.map((at) =>
    command('closeFromOutside', String(at), ({ manager, world }) => {
      const tabId = tabAt(manager, at);
      [...world.alive]
        .filter((runtime) => runtime.tabId === tabId)
        .forEach((runtime) => {
          runtime.closeFromOutside();
        });
    }),
  ),
  fc.tuple(index, profileArbitrary).map(([at, profile]) =>
    command('setProfile', `${String(at)}, ${JSON.stringify(profile)}`, ({ manager, world }) => {
      const tabId = tabAt(manager, at);
      if (tabId !== undefined) {
        world.profiles.set(tabId, profile);
      }
    }),
  ),
  fc
    .tuple(
      index,
      fc.constantFrom<ProtectionReason | 'none'>(
        'none',
        'unsaved-input',
        'editing',
        'sensitive-page',
        // M3.3: these block shelving or archiving as well (audio and capture, hard; the
        // recent-interaction guard, soft).
        'audio',
        'capture',
        'recent-interaction',
      ),
    )
    .map(([at, reason]) =>
      command('setProtection', `${String(at)}, ${reason}`, ({ manager, world }) => {
        const tabId = tabAt(manager, at);
        if (tabId !== undefined) {
          world.protections.set(tabId, reason === 'none' ? [] : [protectionFor(reason)]);
        }
      }),
    ),
  fc
    .constantFrom<RestoreOutcome>('commits', 'commits', 'fails-load', 'creation-fails')
    .map((outcome) =>
      command('restoresWill', outcome, ({ world }) => {
        world.restoreOutcome = outcome;
      }),
    ),
  fc.boolean().map((fails) =>
    command('freezesWillFail', String(fails), ({ world }) => {
      world.freezeFails = fails;
    }),
  ),
  fc.nat({ max: 60 * 60 * 1000 }).map((ms) =>
    command('advanceClock', String(ms), ({ world }) => {
      world.now += ms;
    }),
  ),
  // Days at a time (the model counts an active day every 6 hours): Sleeping tabs go dormant, so
  // the policy archives them (M3.3).
  fc.integer({ min: 1, max: 5 }).map((days) =>
    command('advanceDays', String(days), ({ world }) => {
      world.now += days * 24 * 60 * 60 * 1000;
    }),
  ),
  fc.constant(
    command('reopenClosed', '', ({ manager }) => {
      if (openTabs(manager) < MAX_TABS) {
        manager.reopenClosed();
      }
    }),
  ),
  fc.tuple(index, fc.boolean()).map(([at, pinned]) =>
    command('setPinned', `${String(at)}, ${String(pinned)}`, ({ manager }) => {
      const tabId = tabAt(manager, at);
      if (tabId !== undefined) {
        manager.setPinned(tabId, pinned);
      }
    }),
  ),
  fc.tuple(index, index).map(([at, to]) =>
    command('move', `${String(at)}, ${String(to)}`, ({ manager }) => {
      // The strip's tabs only: moving a Sleeping tab corrupts the strip (a bug found by
      // tab-manager-placement.test.ts, reported and not fixed here).
      const tabId = stripTabAt(manager, at);
      if (tabId !== undefined) {
        manager.move(tabId, to);
      }
    }),
  ),
  index.map((at) =>
    command('duplicate', String(at), ({ manager }) => {
      const tabId = tabAt(manager, at);
      if (tabId !== undefined && openTabs(manager) < MAX_TABS) {
        manager.duplicate(tabId);
      }
    }),
  ),

  // Placement (M3.3): Sleeping, the Archive, Undo, protecting a tab, and "Leave page?".
  fc
    .record({
      at: index,
      origin: fc.constantFrom<MoveRequest['origin']>('user', 'automation'),
      epoch: fc.constantFrom('fresh', 'fresh', 'stale', 'none'),
    })
    .map(({ at, origin, epoch }) =>
      command('shelve', `${String(at)}, ${origin}, ${epoch}`, (real, model) => {
        const tabId = tabAt(real.manager, at);
        if (tabId !== undefined) {
          shelveChecked(real, model, tabId, moveRequest(real.manager, tabId, origin, epoch));
        }
      }),
    ),
  fc
    .record({
      at: index,
      origin: fc.constantFrom<MoveRequest['origin']>('user', 'automation'),
      epoch: fc.constantFrom('fresh', 'fresh', 'stale', 'none'),
    })
    .map(({ at, origin, epoch }) =>
      command('archive', `${String(at)}, ${origin}, ${epoch}`, (real, model) => {
        const tabId = tabAt(real.manager, at);
        if (tabId !== undefined) {
          archiveIssued(real, model, tabId, moveRequest(real.manager, tabId, origin, epoch));
        }
      }),
    ),
  fc
    .record({ at: index, select: fc.boolean(), place: fc.option(index), focus: fc.boolean() })
    .map(({ at, select, place, focus }) =>
      command(
        'restoreToStrip',
        `${String(at)}, ${String(select)}, ${String(place)}`,
        ({ manager }) => {
          const sleeping = manager.sleepingTabs();
          const tab = sleeping[at % Math.max(sleeping.length, 1)];
          if (tab === undefined) {
            return;
          }
          // Where it should land: at `place` within the unpinned tabs, else right after the
          // selected tab (within them), else at their end.
          const strip = manager.tabs();
          const pinned = strip.filter((candidate) => candidate.pinned).length;
          const selectedIndex = strip.findIndex(
            (candidate) => candidate.id === manager.selectedTabId(),
          );
          const expected =
            place !== null
              ? Math.min(Math.max(place, pinned), strip.length)
              : selectedIndex >= pinned
                ? selectedIndex + 1
                : strip.length;
          manager.restoreToStrip(tab.id, {
            select,
            focus,
            ...(place === null ? {} : { index: place }),
          });
          const after = manager.tabs();
          if (
            manager.get(tab.id).placement !== 'strip' ||
            after.findIndex((t) => t.id === tab.id) !== expected
          ) {
            throw new Error(
              `restoreToStrip(${tab.id}) landed at ${String(after.findIndex((t) => t.id === tab.id))}, expected ${String(expected)}`,
            );
          }
          if (select && manager.selectedTabId() !== tab.id) {
            throw new Error(`restoreToStrip(${tab.id}) did not select it`);
          }
        },
      ),
    ),
  index.map((at) =>
    command('selectSleeping', String(at), ({ manager }) => {
      const sleeping = manager.sleepingTabs();
      const tab = sleeping[at % Math.max(sleeping.length, 1)];
      if (tab === undefined) {
        return;
      }
      manager.select(tab.id, { focus: at % 2 === 0 });
      if (manager.selectedTabId() !== tab.id || manager.get(tab.id).placement !== 'strip') {
        throw new Error(`select(${tab.id}) of a Sleeping tab did not bring it back and select it`);
      }
    }),
  ),
  fc
    .record({
      at: index,
      select: fc.boolean(),
      to: fc.constantFrom<'strip' | 'shelf' | undefined>(undefined, 'strip', 'shelf'),
      place: fc.option(index),
    })
    .map(({ at, select, to, place }) =>
      command(
        'restoreArchived',
        `${String(at)}, ${String(select)}, ${String(to)}, ${String(place)}`,
        ({ manager, world }) => {
          const archived = manager.archivedTabs();
          // One in (count + 1) asks for a tab that isn't archived: it must answer null.
          const entry = archived[at % (archived.length + 1)];
          if (entry === undefined) {
            const live = tabAt(manager, at);
            if (live !== undefined && manager.restoreArchived(live) !== null) {
              throw new Error(`restoreArchived(${live}) brought back a tab that is not archived`);
            }
            return;
          }
          if (openTabs(manager) >= MAX_TABS) {
            return;
          }
          const count = manager.archivedCount();
          const id = manager.restoreArchived(entry.id, {
            select,
            ...(to === undefined ? {} : { to }),
            ...(place === null ? {} : { index: place }),
          });
          // Ids are unique here, so it comes back under its own.
          if (id !== entry.id) {
            throw new Error(`restoreArchived(${entry.id}) answered ${String(id)}`);
          }
          world.archiveBalance -= 1;
          const state = manager.get(id);
          if (state.placement !== (to ?? 'strip') || state.pinned) {
            throw new Error(`${id} came back ${state.placement}, pinned ${String(state.pinned)}`);
          }
          if (
            manager.archivedCount() !== count - 1 ||
            manager.archivedTabs().some((t) => t.id === id)
          ) {
            throw new Error(`${id} is still counted as archived after it came back`);
          }
          if (to !== 'shelf' && select && manager.selectedTabId() !== id) {
            throw new Error(`${id} came back to the strip but was not selected`);
          }
        },
      ),
    ),
  fc.integer({ min: 1, max: 6 }).map((count) =>
    command('undoMoves', String(count), ({ manager, world }, model) => {
      const batch = model.moves.splice(-count);
      const undone = manager.undoMoves(batch);
      // The tabs that came back are a subsequence of the batch, in its order.
      let from = 0;
      for (const move of undone) {
        const found = batch.findIndex(
          (candidate, at) =>
            at >= from &&
            candidate.tabId === move.tabId &&
            candidate.from === move.from &&
            candidate.to === move.to &&
            candidate.index === move.index,
        );
        if (found === -1) {
          throw new Error(`undoMoves reported ${JSON.stringify(move)}, which is not in the batch`);
        }
        from = found + 1;
      }
      // Each tab is where its oldest undone move left it from; later ones only passed through.
      const origin = new Map<TabId, PlacementMove['from']>();
      for (const move of undone) {
        if (!origin.has(move.tabId)) {
          origin.set(move.tabId, move.from);
        }
      }
      for (const [tabId, placement] of origin) {
        if (!manager.has(tabId) || manager.get(tabId).placement !== placement) {
          throw new Error(`${tabId} should be back ${placement} after undoMoves`);
        }
      }
      world.archiveBalance -= undone.filter((move) => move.to === 'archive').length;
    }),
  ),
  fc.tuple(index, fc.boolean()).map(([at, on]) =>
    command('setProtected', `${String(at)}, ${String(on)}`, ({ manager }) => {
      const tabId = tabAt(manager, at);
      if (tabId !== undefined) {
        manager.setProtected(tabId, on);
        if (manager.get(tabId).userProtected !== on) {
          throw new Error(`setProtected(${tabId}, ${String(on)}) did not stick`);
        }
      }
    }),
  ),
  fc
    .record({
      at: index,
      answer: fc.constantFrom<LeaveAnswer>('leave', 'leave', 'stay', 'fail', 'never'),
    })
    .map(({ at, answer }) =>
      command('requestClose', `${String(at)}, ${answer}`, (real, model) => {
        const tabId = tabAt(real.manager, at);
        if (tabId !== undefined) {
          requestCloseIssued(real, model, tabId, answer, at % 2 === 0);
        }
      }),
    ),
  index.map((at) =>
    command('activate', String(at), ({ manager, world }) => {
      // The user touches the page: it may object to a close from now on (until a new document).
      const tabId = tabAt(manager, at);
      [...world.alive]
        .filter((runtime) => runtime.tabId === tabId)
        .forEach((runtime) => {
          runtime.activate();
        });
    }),
  ),
];

/** How the discards of every sequence ended, so the tests can show they reached each path. */
const outcomes = new Map<string, number>();
/** How often each runtime transition happened, likewise. */
const transitionCounts = new Map<string, number>();

function countOutcome(outcome: DiscardOutcome): void {
  const key =
    outcome.outcome === 'discarded'
      ? 'discarded'
      : outcome.outcome === 'skipped'
        ? `skipped:${outcome.why}`
        : `blocked:${outcome.reason}`;
  outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
}

/** Runs a sequence, drains the scheduler, and checks what must hold once everything settled. */
async function runSequence(scheduler: fc.Scheduler, cmds: Iterable<Command>): Promise<World> {
  const setup = setupModel(scheduler);
  const { world, manager } = setup.real;
  await fc.scheduledModelRun(scheduler, () => setup, cmds);
  await scheduler.waitIdle();
  await settle();
  checkInvariants(world, true);
  // Every discard settled, never rejected, and acted only on the epoch its decision saw (I5).
  for (const discard of setup.model.discards) {
    if (discard.rejected) {
      world.failures.push(`discard of ${discard.tabId} rejected`);
    } else if (discard.outcome === null) {
      world.failures.push(`discard of ${discard.tabId} never settled`);
    } else {
      countOutcome(discard.outcome);
    }
    if (discard.outcome === null) {
      continue;
    }
    if (discard.outcome.outcome === 'discarded' && discard.request.epoch !== undefined) {
      const startedAt = discard.request.epoch + 1;
      const started = world.transitions.some(
        (t) => t.tabId === discard.tabId && t.event === 'discard' && t.epoch === startedAt,
      );
      if (!started) {
        world.failures.push(
          `I5: ${discard.tabId} was discarded on a decision from epoch ${String(discard.request.epoch)}`,
        );
      }
    }
  }
  // Every archive settled and never rejected; the Archive's count is what the model kept.
  for (const archive of setup.model.archives) {
    if (archive.rejected) {
      world.failures.push(`archive of ${archive.tabId} rejected`);
    } else if (archive.outcome === null) {
      world.failures.push(`archive of ${archive.tabId} never settled`);
    }
  }
  if (manager.archivedCount() !== world.archiveBalance) {
    world.failures.push(
      `the Archive holds ${String(manager.archivedCount())} tabs, the model counted ${String(world.archiveBalance)}`,
    );
  }
  for (const tab of [...manager.tabs(), ...manager.sleepingTabs()]) {
    if (tab.runtime === 'discarding') {
      world.failures.push(`${tab.id} is still discarding after everything settled`);
    }
    const facts = manager.lifecycleFacts(tab.id);
    if (facts.queued !== 0) {
      world.failures.push(`${tab.id} still has ${String(facts.queued)} operations queued`);
    }
  }
  return world;
}

/** The world of the sequence running now, for the checks after each released task. */
let activeWorld: World | null = null;

function schedulerWithChecks(): fc.Arbitrary<fc.Scheduler> {
  // Every released task is followed by its continuations, then the invariants.
  return fc.scheduler({
    act: async (release) => {
      await release();
      await settle();
      if (activeWorld !== null) {
        checkInvariants(activeWorld);
      }
    },
  });
}

/**
 * Sequences of the fixed-seed coverage run. Placement commands share the pool with the discard
 * ones, so every path (the revive of a tab picked mid-close among them) needs more sequences than
 * the 250 of M3.1 to be reached on any one seed.
 */
const COVERAGE_RUNS = 500;

describe('TabManager model (I1–I8 after every step)', () => {
  /** Short sequences of up to 80 commands; the checks counted across all of them. */
  const shortRuns = async (seed: number | undefined, runs = 250): Promise<number> => {
    let steps = 0;
    await fc.assert(
      fc.asyncProperty(
        schedulerWithChecks(),
        fc.commands(commands, { maxCommands: 80, size: 'large' }),
        async (scheduler, cmds) => {
          const world = await runSequence(scheduler, cmds);
          steps += world.steps;
          expect(world.failures).toEqual([]);
        },
      ),
      { numRuns: runs, ...(seed === undefined ? {} : { seed }) },
    );
    return steps;
  };

  it('reaches every way a discard can end (fixed seed, so the coverage is stable)', async () => {
    outcomes.clear();
    transitionCounts.clear();
    policyDiscards.clear();
    policyMoves.clear();
    placementOutcomes.clear();
    const steps = await shortRuns(20_261_022, COVERAGE_RUNS);
    console.info('discard outcomes', Object.fromEntries([...outcomes].sort()), 'checks', steps);
    console.info('transitions', Object.fromEntries([...transitionCounts].sort()));
    console.info('policy discards', Object.fromEntries([...policyDiscards].sort()));
    console.info('policy moves', Object.fromEntries([...policyMoves].sort()));
    console.info('placement outcomes', Object.fromEntries([...placementOutcomes].sort()));
    // The real policy planned discards under both of its discard rules (M3.2).
    expect(policyDiscards.get('discard-hidden') ?? 0).toBeGreaterThan(0);
    expect(policyDiscards.get('pressure-discard') ?? 0).toBeGreaterThan(0);
    // Every runtime transition of the state machine happened.
    for (const event of [
      'load',
      'ensureLive',
      'ready',
      'creationFailed',
      'freeze',
      'thaw',
      'discard',
      'discarded',
      'discardBlocked',
      'revive',
      'rendererGone',
      'internalPage',
      'gone',
    ]) {
      expect(transitionCounts.get(event) ?? 0, event).toBeGreaterThan(0);
    }
    expect(steps).toBeGreaterThan(10_000);
    for (const path of [
      'discarded',
      'skipped:selected',
      'skipped:not-live',
      'skipped:stale',
      'skipped:cancelled',
      'skipped:closed',
      'blocked:unsaved-input',
      'blocked:page-unsaved-changes',
      'blocked:probe-unanswered',
      'blocked:editing',
      'blocked:sensitive-page',
    ]) {
      expect(outcomes.get(path) ?? 0, path).toBeGreaterThan(0);
    }
    // Placement (M3.3): both origins shelved and archived, and each way a move is refused or
    // stopped was reached, including by the real policy's own plans.
    for (const path of [
      'shelve:user:moved',
      'shelve:user:skipped:pinned',
      'shelve:user:skipped:wrong-placement',
      'shelve:automation:moved',
      'shelve:automation:skipped:selected',
      'shelve:automation:skipped:stale',
      'shelve:automation:skipped:pinned',
      'shelve:automation:blocked:user-protected',
      'archive:user:moved',
      'archive:user:blocked:page-unsaved-changes',
      'archive:automation:moved',
      'archive:automation:skipped:selected',
      'archive:automation:skipped:pinned',
      'archive:automation:skipped:stale',
      'archive:automation:blocked:user-protected',
    ]) {
      expect(placementOutcomes.get(path) ?? 0, path).toBeGreaterThan(0);
    }
    expect(policyMoves.get('shelve:shelve-beyond-cap') ?? 0).toBeGreaterThan(0);
    expect(policyMoves.get('archive:archive-dormant') ?? 0).toBeGreaterThan(0);
  }, 300_000);

  it('holds over short random sequences with reordered completions (a new seed each run)', async () => {
    expect(await shortRuns(undefined)).toBeGreaterThan(10_000);
  }, 300_000);

  it('holds over 10,000-step runs', async () => {
    let longest = 0;
    let commandsRun = 0;
    await fc.assert(
      fc.asyncProperty(
        schedulerWithChecks(),
        // Exactly 10,000 commands, plus every completion they cause.
        fc.array(fc.oneof(...commands), { minLength: 10_000, maxLength: 10_000 }),
        async (scheduler, cmds) => {
          const world = await runSequence(scheduler, cmds);
          commandsRun = Math.max(commandsRun, cmds.length);
          longest = Math.max(longest, world.steps);
          expect(world.failures).toEqual([]);
        },
      ),
      { numRuns: 3 },
    );
    console.info('10,000-command runs: longest run checked the invariants', longest, 'times');
    expect(commandsRun).toBe(10_000);
    expect(longest).toBeGreaterThanOrEqual(10_000);
  }, 600_000);
});
