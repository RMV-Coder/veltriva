import { describe, expect, it } from 'vitest';

import { appRunHandlers } from './app-runs';
import { callerFor, useTestDatabase } from './test-database';

const T0 = 1_700_000_000_000;

describe('appRuns', () => {
  const database = useTestDatabase();
  const caller = () => callerFor(appRunHandlers(database()));
  const recent = (call: ReturnType<typeof caller>) => call('appRuns.recent', { limit: 100 }).runs;

  describe('appRuns.start', () => {
    it('records the run with its first heartbeat at the start time', () => {
      const call = caller();

      expect(call('appRuns.start', { startedAt: T0, appVersion: '0.1.0' })).toEqual({ id: 1 });

      expect(recent(call)).toEqual([
        {
          id: 1,
          startedAt: T0,
          lastHeartbeatAt: T0,
          endedAt: null,
          exitKind: null,
          appVersion: '0.1.0',
        },
      ]);
    });

    it('gives every run its own increasing id', () => {
      const call = caller();

      const ids = [T0, T0 + 1, T0 + 2].map(
        (startedAt) => call('appRuns.start', { startedAt, appVersion: '0.1.0' }).id,
      );

      expect(ids).toEqual([1, 2, 3]);
    });
  });

  describe('appRuns.heartbeat', () => {
    it('moves the heartbeat forward on an open run', () => {
      const call = caller();
      const { id } = call('appRuns.start', { startedAt: T0, appVersion: '0.1.0' });

      expect(call('appRuns.heartbeat', { id, at: T0 + 60_000 })).toEqual({ count: 1 });

      expect(recent(call)[0]).toMatchObject({ startedAt: T0, lastHeartbeatAt: T0 + 60_000 });
    });

    it('never moves the heartbeat backwards', () => {
      const call = caller();
      const { id } = call('appRuns.start', { startedAt: T0, appVersion: '0.1.0' });
      call('appRuns.heartbeat', { id, at: T0 + 60_000 });

      expect(call('appRuns.heartbeat', { id, at: T0 + 1000 })).toEqual({ count: 1 });

      expect(recent(call)[0]?.lastHeartbeatAt).toBe(T0 + 60_000);
    });

    it('leaves an ended run alone', () => {
      const call = caller();
      const { id } = call('appRuns.start', { startedAt: T0, appVersion: '0.1.0' });
      call('appRuns.end', { id, at: T0 + 5000, exitKind: 'clean' });

      expect(call('appRuns.heartbeat', { id, at: T0 + 90_000 })).toEqual({ count: 0 });

      expect(recent(call)[0]?.lastHeartbeatAt).toBe(T0 + 5000);
    });

    it('changes nothing for a run that does not exist, or for the other runs', () => {
      const call = caller();
      const first = call('appRuns.start', { startedAt: T0, appVersion: '0.1.0' });
      call('appRuns.start', { startedAt: T0 + 1, appVersion: '0.1.0' });

      expect(call('appRuns.heartbeat', { id: 99, at: T0 + 100 })).toEqual({ count: 0 });
      call('appRuns.heartbeat', { id: first.id, at: T0 + 100 });

      expect(recent(call).map((run) => run.lastHeartbeatAt)).toEqual([T0 + 1, T0 + 100]);
    });
  });

  describe('appRuns.end', () => {
    it('closes an open run with its exit kind', () => {
      const call = caller();
      const { id } = call('appRuns.start', { startedAt: T0, appVersion: '0.1.0' });

      expect(call('appRuns.end', { id, at: T0 + 5000, exitKind: 'clean' })).toEqual({ count: 1 });

      expect(recent(call)[0]).toEqual({
        id,
        startedAt: T0,
        lastHeartbeatAt: T0 + 5000,
        endedAt: T0 + 5000,
        exitKind: 'clean',
        appVersion: '0.1.0',
      });
    });

    it('records a crash the same way', () => {
      const call = caller();
      const { id } = call('appRuns.start', { startedAt: T0, appVersion: '0.1.0' });

      call('appRuns.end', { id, at: T0 + 10, exitKind: 'crash' });

      expect(recent(call)[0]).toMatchObject({ endedAt: T0 + 10, exitKind: 'crash' });
    });

    it('keeps a later heartbeat when the end time is earlier', () => {
      const call = caller();
      const { id } = call('appRuns.start', { startedAt: T0, appVersion: '0.1.0' });
      call('appRuns.heartbeat', { id, at: T0 + 60_000 });

      call('appRuns.end', { id, at: T0 + 30_000, exitKind: 'clean' });

      expect(recent(call)[0]).toMatchObject({ lastHeartbeatAt: T0 + 60_000, endedAt: T0 + 30_000 });
    });

    it('ends a run only once', () => {
      const call = caller();
      const { id } = call('appRuns.start', { startedAt: T0, appVersion: '0.1.0' });
      call('appRuns.end', { id, at: T0 + 100, exitKind: 'clean' });

      expect(call('appRuns.end', { id, at: T0 + 200, exitKind: 'crash' })).toEqual({ count: 0 });

      expect(recent(call)[0]).toMatchObject({ endedAt: T0 + 100, exitKind: 'clean' });
    });

    it('changes nothing for a run that does not exist', () => {
      const call = caller();
      call('appRuns.start', { startedAt: T0, appVersion: '0.1.0' });

      expect(call('appRuns.end', { id: 99, at: T0 + 1, exitKind: 'clean' })).toEqual({ count: 0 });

      expect(recent(call)[0]?.endedAt).toBeNull();
    });
  });

  describe('appRuns.recent', () => {
    it('is empty before the first run', () => {
      expect(caller()('appRuns.recent', { limit: 10 })).toEqual({ runs: [] });
    });

    it('lists the newest run first', () => {
      const call = caller();
      for (const [offset, appVersion] of [
        [0, '0.1.0'],
        [1, '0.1.1'],
        [2, '0.2.0'],
      ] as const) {
        call('appRuns.start', { startedAt: T0 + offset, appVersion });
      }

      expect(recent(call).map((run) => [run.id, run.appVersion])).toEqual([
        [3, '0.2.0'],
        [2, '0.1.1'],
        [1, '0.1.0'],
      ]);
    });

    it('returns no more than the limit, keeping the newest', () => {
      const call = caller();
      for (let n = 0; n < 5; n += 1) {
        call('appRuns.start', { startedAt: T0 + n, appVersion: '0.1.0' });
      }

      const { runs } = call('appRuns.recent', { limit: 2 });

      expect(runs.map((run) => run.id)).toEqual([5, 4]);
    });
  });
});
