// M2.2a's acceptance (assessment §8.2): "20 scripted hard kills at random moments all restore
// cleanly". One profile throughout, as a real user's: each round is a launch that changes the
// session without pause and is hard-killed (the whole process tree) at a seeded random moment,
// then a launch that reports what it restored, and quits cleanly.
//
// "Cleanly" is checked exactly. The churn prints every `session.save` it sends and every answer;
// replaying them onto the rows it started from gives each state the database could hold. The
// restored strip, Recently closed and selection must be the state after the last acknowledged
// save, or after the one in flight: a kill may lose the last second, never leave half a save.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeProfile, removeProfile, runScenario, runUntilKilled } from './harness';

const ROUNDS = 20;
/** Kills land this long after the churn starts: 0.3 s to 5.3 s, seeded per round. */
const KILL_MIN_MS = 300;
const KILL_SPAN_MS = 5000;
/** The database lists this many closed tabs at startup (session-load.ts). */
const CLOSED_LOADED = 100;

interface Row {
  readonly id: string;
  readonly url: string;
  readonly pinned: boolean;
  readonly position: number;
  readonly placement: string;
  readonly closedAt: number | null;
}

interface Save {
  readonly tabs: readonly Row[];
  readonly deleteIds: readonly string[];
  readonly documents: readonly { readonly key: string; readonly value: unknown }[];
}

interface DatabaseState {
  readonly rows: ReadonlyMap<string, Row>;
  readonly selectedTabId: string | null;
}

interface Comparable {
  readonly strip: readonly {
    readonly id: string;
    readonly url: string;
    readonly pinned: boolean;
  }[];
  readonly closed: readonly string[];
  readonly selectedTabId: string | null;
}

interface Report {
  readonly ready: {
    readonly previousExit: string;
    readonly checked: string;
    readonly recovery: unknown;
  } | null;
  readonly loaded: {
    readonly strip: readonly { id: string; url: string; pinned: boolean; position: number }[];
    readonly closed: readonly { id: string; url: string }[];
    readonly selectedTabId: string | null;
    readonly safeMode: boolean;
  } | null;
  readonly tabs: readonly { id: string; url: string; runtime: string }[];
  readonly selectedTabId: string | null;
  readonly notices: readonly string[];
}

function apply(state: DatabaseState, save: Save): DatabaseState {
  const rows = new Map(state.rows);
  for (const row of save.tabs) {
    rows.set(row.id, row);
  }
  for (const id of save.deleteIds) {
    rows.delete(id);
  }
  let { selectedTabId } = state;
  for (const { key, value } of save.documents) {
    if (key === 'session') {
      selectedTabId = (value as { selectedTabId: string | null }).selectedTabId;
    }
  }
  return { rows, selectedTabId };
}

function comparable(state: DatabaseState): Comparable {
  const rows = [...state.rows.values()];
  return {
    strip: rows
      .filter((row) => row.placement === 'strip')
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
      .map(({ id, url, pinned }) => ({ id, url, pinned })),
    closed: rows
      .filter((row) => row.placement === 'closed')
      .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0) || b.id.localeCompare(a.id))
      .slice(0, CLOSED_LOADED)
      .map((row) => row.id),
    selectedTabId: state.selectedTabId,
  };
}

let server: ReturnType<typeof createServer>;
let base = '';
let profile = '';

beforeAll(async () => {
  server = createServer((request, response) => {
    const page = /\/churn\/(\d+)/.exec(request.url ?? '')?.[1] ?? '0';
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>Churn ${page}</title><p>Page ${page}</p>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  profile = makeProfile();
});

afterAll(async () => {
  removeProfile(profile);
  await new Promise<void>((resolve) => server.close(() => { resolve(); }));
});

describe('session restore after hard kills', () => {
  it(
    `restores the last saved session cleanly after each of ${String(ROUNDS)} kills at random moments`,
    async () => {
      const outcomes: string[] = [];
      for (let round = 1; round <= ROUNDS; round += 1) {
        const killAfterMs = KILL_MIN_MS + ((round * 7919) % KILL_SPAN_MS);
        const { events, killedAfterMs } = await runUntilKilled('session-churn', {
          userDataDir: profile,
          killAfterMs,
          startEvent: 'churn-started',
          env: { VELTRIVA_CHURN_BASE: base, VELTRIVA_CHURN_SEED: String(round) },
        });

        // Every state the database could hold at the kill: the starting rows, then each save.
        const start = events.find(
          (event) => (event as { event?: string }).event === 'churn-started',
        ) as { rows: Row[]; selectedTabId: string | null };
        let state: DatabaseState = {
          rows: new Map(start.rows.map((row) => [row.id, row])),
          selectedTabId: start.selectedTabId,
        };
        const states = [state];
        let acknowledged = 0;
        for (const event of events as { event?: string; save?: number; input?: Save }[]) {
          if (event.event === 'saving' && event.input !== undefined) {
            state = apply(state, event.input);
            states.push(state);
          } else if (event.event === 'saved' && event.save !== undefined) {
            acknowledged = event.save;
          }
        }
        const allowed = [states[acknowledged], states[acknowledged + 1]].flatMap((candidate) =>
          candidate === undefined ? [] : [comparable(candidate)],
        );

        const { result } = await runScenario<Report>('report-session', { userDataDir: profile });
        const context = `round ${String(round)} (seed ${String(round)}, killed ${String(killedAfterMs)} ms in, ${String(states.length - 1)} saves sent, ${String(acknowledged)} acknowledged)`;
        expect(result.ready, context).toMatchObject({
          previousExit: 'crash',
          checked: 'quick',
          recovery: null,
        });
        const loaded = result.loaded;
        expect(loaded, context).not.toBeNull();
        if (loaded === null) {
          return;
        }
        expect(loaded.safeMode, context).toBe(false);
        const restored: Comparable = {
          strip: [...loaded.strip]
            .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
            .map(({ id, url, pinned }) => ({ id, url, pinned })),
          closed: loaded.closed.map((row) => row.id),
          selectedTabId: loaded.selectedTabId,
        };
        expect(allowed, context).toContainEqual(restored);

        // And the app did what restore promises: the strip is back, only the selected tab loads.
        expect(
          result.tabs.map((tab) => tab.id),
          context,
        ).toEqual(
          restored.strip.length === 0
            ? result.tabs.map((tab) => tab.id) // An empty strip comes back as one new tab.
            : [...restored.strip]
                .sort((a, b) => Number(b.pinned) - Number(a.pinned))
                .map((tab) => tab.id),
        );
        const live = result.tabs.filter((tab) => tab.runtime !== 'unloaded');
        expect(
          live.map((tab) => tab.id),
          context,
        ).toEqual(live.length === 0 ? [] : [result.selectedTabId]);
        if (restored.strip.length > 0) {
          expect(result.notices, context).toContain('session-recovered');
        }
        outcomes.push(
          `${context}: ${String(restored.strip.length)} tabs, ${String(restored.closed.length)} closed`,
        );
      }
      console.info(outcomes.join('\n'));
    },
    ROUNDS * 60_000,
  );
});
