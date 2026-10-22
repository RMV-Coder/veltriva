// Model-based tests of TabManager's lifecycle (ADR-0008 item 2, assessment §4.5, §9.2): random
// sequences of user actions, discards, freezes, crashes and outside closes run against fake
// runtimes whose answers (probes, closes, restores, loads, timers) fast-check's scheduler releases
// in random order. Invariants I1–I8 are checked after every command and every released task.
//
// The fakes follow the Electron runtime's contract (./tab-runtime.ts): a discard's close settles
// as `closed` and reports `gone`; `destroy()` settles pending closes without `gone`; `restore()`
// only on a fresh, attached runtime (S2); nothing is reported after the runtime is gone.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { DiscardOutcome, DiscardRequest, Timers } from '../../core/lifecycle/discard';
import { planLifecycle, PRESETS, resolveLifecycleSettings } from '../../core/lifecycle/policy';
import type { MemoryPressure } from '../../core/lifecycle/policy';
import type { CloseMode } from '../../core/lifecycle/probe';
import { blockingProtection, protectionFor } from '../../core/lifecycle/protections';
import type { Protection } from '../../core/lifecycle/protections';
import type { NavigationSnapshot } from '../../core/lifecycle/snapshot';
import type { TabHistory } from '../../core/session/history';
import { TabManager } from './tab-manager';
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
    this.#checkI5();
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
  const tabs = manager.tabs();
  const ids = new Set(tabs.map((tab) => tab.id));
  if (ids.size !== tabs.length) {
    fail('duplicate tab ids');
  }
  const firstUnpinned = tabs.findIndex((tab) => !tab.pinned);
  if (firstUnpinned !== -1 && tabs.slice(firstUnpinned).some((tab) => tab.pinned)) {
    fail('a pinned tab after an unpinned one');
  }
  // I1
  const selected = manager.selectedTabId();
  if (tabs.length > 0 && (selected === null || !ids.has(selected))) {
    fail(`I1: ${String(selected)} is not one of the tabs`);
  }
  if (tabs.length === 0 && selected !== null) {
    fail('I1: a selection with no tabs');
  }
  for (const tab of tabs) {
    // Placement is always the strip until M3.3; read as a string, so the checks stay real.
    const placement: string = tab.placement;
    if (tab.id === selected && placement !== 'strip') {
      fail(`I1: the selected tab ${tab.id} is not in the strip`);
    }
    // I8
    if (tab.pinned && placement !== 'strip') {
      fail(`I8: pinned ${tab.id} outside the strip`);
    }
  }
  // I2
  if (selected !== null && ids.has(selected)) {
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
  for (const [tabId, runtimes] of alive) {
    if (!ids.has(tabId)) {
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
  for (const tab of manager.sessionTabs()) {
    if (world.ephemeral.has(tab.id)) {
      fail(`I6: ephemeral ${tab.id} reached the session`);
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
  });
  world.manager = manager;
  activeWorld = world;
  manager.create();
  return { model: { discards: [] }, real: { world, manager } };
}

/** Opening stops here, so long runs keep a strip of realistic size and checks stay cheap. */
const MAX_TABS = 40;

/** The tab at `index` (modulo the strip), or undefined for an empty strip. */
function tabAt(manager: TabManager, index: number): TabId | undefined {
  const tabs = manager.tabs();
  return tabs.length === 0 ? undefined : tabs[index % tabs.length]?.id;
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
      if (manager.tabs().length >= MAX_TABS) {
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
      for (const tab of manager.tabs()) {
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

const evaluation: fc.Arbitrary<Command> = fc
  .record({
    preset: fc.constantFrom(...PRESETS),
    pressure: fc.constantFrom<MemoryPressure>('none', 'none', 'moderate', 'critical'),
  })
  .map(({ preset, pressure }) =>
    command('evaluate', `${preset}, ${pressure}`, ({ manager, world }, model) => {
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
    then: fc.constantFrom('select', 'reload', 'navigate', 'close', 'newTabPage'),
    /** How many scheduler hops the user's action waits: later hops land after the probe. */
    hops: fc.integer({ min: 1, max: 4 }),
  })
  .map(({ at, then, hops }) =>
    command('discardThen', `${String(at)}, ${then}, ${String(hops)}`, (real, model) => {
      const { manager, world } = real;
      // A live background tab, if there is one: the only kind a discard acts on.
      const candidates = manager
        .tabs()
        .filter((tab) => tab.runtime === 'live' && tab.id !== manager.selectedTabId());
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
        if (real.manager.tabs().length >= MAX_TABS) {
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
    .tuple(index, fc.constantFrom('none', 'unsaved-input', 'editing', 'sensitive-page'))
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
  fc.constant(
    command('reopenClosed', '', ({ manager }) => {
      if (manager.tabs().length < MAX_TABS) {
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
      const tabId = tabAt(manager, at);
      if (tabId !== undefined) {
        manager.move(tabId, to);
      }
    }),
  ),
  index.map((at) =>
    command('duplicate', String(at), ({ manager }) => {
      const tabId = tabAt(manager, at);
      if (tabId !== undefined && manager.tabs().length < MAX_TABS) {
        manager.duplicate(tabId);
      }
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
  for (const tab of manager.tabs()) {
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

describe('TabManager model (I1–I8 after every step)', () => {
  /** Short sequences: 250 runs of up to 80 commands; the checks counted across all of them. */
  const shortRuns = async (seed: number | undefined): Promise<number> => {
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
      { numRuns: 250, ...(seed === undefined ? {} : { seed }) },
    );
    return steps;
  };

  it('reaches every way a discard can end (fixed seed, so the coverage is stable)', async () => {
    outcomes.clear();
    transitionCounts.clear();
    policyDiscards.clear();
    const steps = await shortRuns(20_261_022);
    console.info('discard outcomes', Object.fromEntries([...outcomes].sort()), 'checks', steps);
    console.info('transitions', Object.fromEntries([...transitionCounts].sort()));
    console.info('policy discards', Object.fromEntries([...policyDiscards].sort()));
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
