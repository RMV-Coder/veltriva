import { describe, expect, it } from 'vitest';

import type { PermissionRow } from '../../shared/contracts/data-rpc';
import { permissionHandlers } from './permissions';
import { callerFor, useTestDatabase } from './test-database';

const T0 = 1_700_000_000_000;

function decision(overrides: Partial<PermissionRow> = {}): PermissionRow {
  return {
    origin: 'https://example.com',
    permission: 'camera',
    decision: 'allow',
    updatedAt: T0,
    ...overrides,
  };
}

describe('permissions', () => {
  const database = useTestDatabase();
  const caller = () => callerFor(permissionHandlers(database()));
  const listed = (call: ReturnType<typeof caller>) =>
    call('permissions.list', { limit: 10_000 }).decisions;

  describe('permissions.list', () => {
    it('is empty before any decision', () => {
      expect(caller()('permissions.list', { limit: 10 })).toEqual({ decisions: [] });
    });

    it('orders by origin, then by permission', () => {
      const call = caller();
      for (const row of [
        decision({ origin: 'https://b.example', permission: 'camera' }),
        decision({ origin: 'https://a.example', permission: 'microphone' }),
        decision({ origin: 'https://a.example', permission: 'camera' }),
        decision({ origin: 'https://a.example', permission: 'protocol:zoommtg' }),
        decision({ origin: 'http://a.example', permission: 'geolocation' }),
      ]) {
        call('permissions.set', row);
      }

      expect(listed(call).map((row) => `${row.origin} ${row.permission}`)).toEqual([
        'http://a.example geolocation',
        'https://a.example camera',
        'https://a.example microphone',
        'https://a.example protocol:zoommtg',
        'https://b.example camera',
      ]);
    });

    it('returns no more than the limit, keeping the first in order', () => {
      const call = caller();
      for (const permission of ['camera', 'geolocation', 'microphone']) {
        call('permissions.set', decision({ permission }));
      }

      const { decisions } = call('permissions.list', { limit: 2 });

      expect(decisions.map((row) => row.permission)).toEqual(['camera', 'geolocation']);
    });
  });

  describe('permissions.set', () => {
    it('round-trips an allow and a block', () => {
      const call = caller();
      const allow = decision({ permission: 'camera', decision: 'allow', updatedAt: T0 });
      const block = decision({ permission: 'microphone', decision: 'block', updatedAt: T0 + 1 });

      expect(call('permissions.set', allow)).toEqual({});
      call('permissions.set', block);

      expect(listed(call)).toEqual([allow, block]);
    });

    it('keeps an external protocol "always allow" as protocol:<scheme>', () => {
      const call = caller();
      const row = decision({
        origin: 'https://zoom.us',
        permission: 'protocol:zoommtg',
        decision: 'allow',
      });

      call('permissions.set', row);

      expect(listed(call)).toEqual([row]);
    });

    it('updates the decision and time of an existing pair, without adding a row', () => {
      const call = caller();
      call('permissions.set', decision({ decision: 'allow', updatedAt: T0 }));

      call('permissions.set', decision({ decision: 'block', updatedAt: T0 + 5000 }));

      expect(listed(call)).toEqual([decision({ decision: 'block', updatedAt: T0 + 5000 })]);
    });

    it('treats a different origin or permission as a different decision', () => {
      const call = caller();
      call('permissions.set', decision());
      call('permissions.set', decision({ permission: 'microphone', decision: 'block' }));
      call('permissions.set', decision({ origin: 'https://example.com:8443' }));
      call('permissions.set', decision({ origin: 'http://example.com' }));

      expect(listed(call)).toHaveLength(4);
    });
  });

  describe('permissions.delete', () => {
    it('removes one decision and leaves the rest', () => {
      const call = caller();
      call('permissions.set', decision({ permission: 'camera' }));
      call('permissions.set', decision({ permission: 'microphone' }));
      call('permissions.set', decision({ origin: 'https://other.example', permission: 'camera' }));

      const result = call('permissions.delete', {
        origin: 'https://example.com',
        permission: 'camera',
      });

      expect(result).toEqual({ count: 1 });
      expect(listed(call).map((row) => `${row.origin} ${row.permission}`)).toEqual([
        'https://example.com microphone',
        'https://other.example camera',
      ]);
    });

    it('removes every decision of an origin when no permission is given', () => {
      const call = caller();
      call('permissions.set', decision({ permission: 'camera' }));
      call('permissions.set', decision({ permission: 'microphone' }));
      call('permissions.set', decision({ permission: 'protocol:zoommtg' }));
      call('permissions.set', decision({ origin: 'https://example.com:8443' }));
      call('permissions.set', decision({ origin: 'https://other.example' }));

      expect(call('permissions.delete', { origin: 'https://example.com' })).toEqual({ count: 3 });

      expect(listed(call).map((row) => row.origin)).toEqual([
        'https://example.com:8443',
        'https://other.example',
      ]);
    });

    it('counts zero when nothing matches', () => {
      const call = caller();
      call('permissions.set', decision());

      expect(
        call('permissions.delete', { origin: 'https://example.com', permission: 'geolocation' }),
      ).toEqual({ count: 0 });
      expect(call('permissions.delete', { origin: 'https://nowhere.example' })).toEqual({
        count: 0,
      });
      expect(listed(call)).toHaveLength(1);
    });
  });
});
