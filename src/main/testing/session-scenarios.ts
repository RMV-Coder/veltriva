// M2.2a's acceptance (assessment §8.2): "20 scripted hard kills at random moments all restore
// cleanly". Test builds only, run by tests/lifecycle/hard-kill.test.ts through the lifecycle
// runner (./lifecycle-scenarios.ts):
//   - `session-churn` changes the session without pause (open, navigate, close, reopen, select,
//     move, pin) and prints every `session.save` the session store sends, and its answer, until
//     the test kills the process tree at a random moment;
//   - `report-session` prints what the next launch read from the database, and what it did.
// The test then checks the restored state is exactly the one after the last acknowledged save,
// or after the one in flight: a hard kill may lose the last second, never leave half a save.
import type { DataClient } from '../persistence/data-client';
import type { StartupSession } from '../session/session-startup';
import type { TabManager } from '../tabs/tab-manager';
import type { AppNotices } from '../notices/app-notices';

/** Where the test's local server is, and the seed of this run's choices. */
export const CHURN_BASE_ENV = 'VELTRIVA_CHURN_BASE';
export const CHURN_SEED_ENV = 'VELTRIVA_CHURN_SEED';
const EVENT_PREFIX = 'VELTRIVA_LIFECYCLE_EVENT ';

export interface SessionScenarioContext {
  readonly tabs: TabManager;
  readonly data: DataClient;
  readonly notices: AppNotices;
  readonly startup: StartupSession | null;
}

function print(event: unknown): void {
  process.stdout.write(`${EVENT_PREFIX}${JSON.stringify(event)}\n`);
}

/** A small seeded generator (mulberry32), so a failing run can be replayed by its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function sessionChurn({
  tabs,
  data,
  startup,
}: SessionScenarioContext): Promise<never> {
  const base = process.env[CHURN_BASE_ENV] ?? '';
  const next = random(Number(process.env[CHURN_SEED_ENV] ?? '1'));
  const pick = <T>(items: readonly T[]): T | undefined => items[Math.floor(next() * items.length)];

  // Every save the session store sends goes through here first: printed when sent and when the
  // database has answered, with its whole input, so the test can rebuild what was written.
  const call = data.call.bind(data);
  let saves = 0;
  data.call = async (method: never, input: never, options?: never) => {
    if ((method as string) !== 'session.save') {
      return call(method, input, options);
    }
    const save = (saves += 1);
    print({ event: 'saving', save, input });
    const result = await call(method, input, options);
    print({ event: 'saved', save });
    return result;
  };
  // What this launch read: the starting point the test replays the saves onto.
  print({
    event: 'churn-started',
    rows: startup?.loaded.rows ?? [],
    selectedTabId: startup?.loaded.selectedTabId ?? null,
  });

  let page = 0;
  const url = (): string => `${base}/churn/${String((page += 1))}`;
  for (;;) {
    const ids = tabs.tabs().map((tab) => tab.id);
    const roll = next();
    try {
      if (roll < 0.25 || ids.length < 2) {
        const id = tabs.create();
        tabs.navigate(id, url(), { focus: false });
      } else if (roll < 0.45) {
        const id = tabs.selectedTabId();
        if (id !== null) {
          tabs.navigate(id, url(), { focus: false });
        }
      } else if (roll < 0.6) {
        const id = pick(ids);
        if (id !== undefined) {
          tabs.close(id, { focus: false });
        }
      } else if (roll < 0.7) {
        tabs.reopenClosed();
      } else if (roll < 0.82) {
        const id = pick(ids);
        if (id !== undefined) {
          tabs.select(id, { focus: false });
        }
      } else if (roll < 0.92) {
        const id = pick(ids);
        if (id !== undefined) {
          tabs.move(id, Math.floor(next() * ids.length));
        }
      } else {
        const id = pick(ids);
        if (id !== undefined) {
          tabs.setPinned(id, !tabs.get(id).pinned);
        }
      }
    } catch {
      // A tab closed under a pending choice: just make the next one.
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 40 + Math.floor(next() * 120));
    });
  }
}

export async function reportSession({
  tabs,
  data,
  notices,
  startup,
}: SessionScenarioContext): Promise<unknown> {
  const ready = await data.ready.catch(() => null);
  // What the selected tab did with its restore: give it a moment to start.
  await new Promise((resolve) => {
    setTimeout(resolve, 500);
  });
  return {
    ready,
    loaded:
      startup === null
        ? null
        : {
            strip: startup.loaded.rows
              .filter((row) => row.placement === 'strip')
              .map((row) => ({
                id: row.id,
                url: row.url,
                pinned: row.pinned,
                position: row.position,
              })),
            closed: startup.loaded.rows
              .filter((row) => row.placement === 'closed')
              .map((row) => ({ id: row.id, url: row.url })),
            selectedTabId: startup.loaded.selectedTabId,
            safeMode: startup.safeMode,
          },
    tabs: tabs.tabs().map((tab) => ({ id: tab.id, url: tab.url, runtime: tab.runtime })),
    selectedTabId: tabs.selectedTabId(),
    notices: notices.list().map((notice) => notice.kind),
  };
}
