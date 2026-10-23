import { describe, expect, it } from 'vitest';

import { buildDiagnosticsExport, DIAGNOSTICS_EXPORT_VERSION } from './diagnostics-export';
import type { DiagnosticsInput } from './diagnostics-export';
import { MAX_PRESSURE_CHANGES, PressureHistory } from '../lifecycle/pressure-history';

const INPUT: DiagnosticsInput = {
  exportedAt: Date.UTC(2026, 9, 23, 12),
  app: { version: '0.0.0', electron: '45.0.0' },
  settings: { preset: 'balanced', searchEngine: 'DuckDuckGo' },
  regret: { since: 1, moves: 4, moveRegrets: 1, unloads: 10, unloadRegrets: 2, events: [] },
  automation: { last24h: { discard: 3 } },
  pressure: { level: 'none', history: [] },
  memory: { totalMb: 8000, availableMb: 600 },
  tabs: [
    {
      placement: 'strip',
      runtime: 'live',
      privateKb: 120_000,
      sharedWith: 1,
      address: 'https://secret.example/inbox',
    },
    { placement: 'shelf', runtime: 'unloaded', privateKb: null, sharedWith: 0, address: '' },
  ],
  database: { sizeBytes: 1_000_000, walBytes: 0, lastBackupAt: null },
};

describe('buildDiagnosticsExport (M5.3)', () => {
  it('holds no address by default: nothing the user browsed leaves the machine', () => {
    const exported = buildDiagnosticsExport(INPUT, { includeAddresses: false });

    expect(exported).toMatchObject({
      version: DIAGNOSTICS_EXPORT_VERSION,
      exportedAt: '2026-10-23T12:00:00.000Z',
      includesAddresses: false,
    });
    expect(exported.tabs).toEqual([
      { placement: 'strip', runtime: 'live', privateKb: 120_000, sharedWith: 1 },
      { placement: 'shelf', runtime: 'unloaded', privateKb: null, sharedWith: 0 },
    ]);
    expect(JSON.stringify(exported)).not.toContain('secret.example');
  });

  it("adds each tab's address when the user opts in, and says so", () => {
    const exported = buildDiagnosticsExport(INPUT, { includeAddresses: true });

    expect(exported.includesAddresses).toBe(true);
    expect(JSON.stringify(exported)).toContain('https://secret.example/inbox');
  });
});

describe('PressureHistory (M5.3)', () => {
  it('records each change of level, newest first, and ignores a repeat', () => {
    let now = 1000;
    const history = new PressureHistory(() => now);
    history.record('moderate');
    now = 2000;
    history.record('moderate');
    now = 3000;
    history.record('critical');

    expect(history.changes()).toEqual([
      { at: 3000, level: 'critical' },
      { at: 1000, level: 'moderate' },
    ]);
  });

  it(`keeps the newest ${String(MAX_PRESSURE_CHANGES)}`, () => {
    let now = 0;
    const history = new PressureHistory(() => (now += 1));
    for (let n = 0; n < MAX_PRESSURE_CHANGES + 10; n += 1) {
      history.record(n % 2 === 0 ? 'moderate' : 'none');
    }

    expect(history.changes()).toHaveLength(MAX_PRESSURE_CHANGES);
    expect(history.changes()[0]?.at).toBe(MAX_PRESSURE_CHANGES + 10);
  });
});
