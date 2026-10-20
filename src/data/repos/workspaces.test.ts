import { describe, expect, it } from 'vitest';

import { callerFor, testId, useTestDatabase } from './test-database';
import { workspaceHandlers } from './workspaces';

describe('workspaces.ensureDefault', () => {
  const database = useTestDatabase();
  const caller = () => callerFor(workspaceHandlers(database()));
  const stored = () =>
    database().prepare('SELECT id, name, created_at, updated_at FROM workspaces ORDER BY id').all();

  it('creates the default workspace with the candidate id on first use', () => {
    const result = caller()('workspaces.ensureDefault', {
      candidateId: testId(1),
      name: 'Main',
      now: 1_700_000_000_123,
    });

    expect(result).toEqual({ id: testId(1), created: true });
    expect(stored()).toEqual([
      { id: testId(1), name: 'Main', created_at: 1_700_000_000_123, updated_at: 1_700_000_000_123 },
    ]);
  });

  it('returns the existing workspace and ignores the candidate afterwards', () => {
    const call = caller();
    call('workspaces.ensureDefault', { candidateId: testId(1), name: 'Main', now: 1000 });

    const again = call('workspaces.ensureDefault', {
      candidateId: testId(2),
      name: 'Other',
      now: 2000,
    });

    expect(again).toEqual({ id: testId(1), created: false });
    expect(stored()).toHaveLength(1);
    expect(stored()[0]).toMatchObject({ name: 'Main', created_at: 1000, updated_at: 1000 });
  });

  it('returns the oldest workspace when there are several', () => {
    const insert = database().prepare(
      'INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    );
    insert.run([testId(5), 'Newer', 3000, 3000]);
    insert.run([testId(9), 'Oldest', 1000, 1000]);
    insert.run([testId(7), 'Middle', 2000, 2000]);

    const result = caller()('workspaces.ensureDefault', {
      candidateId: testId(1),
      name: 'Unused',
      now: 4000,
    });

    expect(result).toEqual({ id: testId(9), created: false });
    expect(stored()).toHaveLength(3);
  });

  it('breaks a creation-time tie by id', () => {
    const insert = database().prepare(
      'INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    );
    insert.run([testId(8), 'B', 1000, 1000]);
    insert.run([testId(3), 'A', 1000, 1000]);

    const result = caller()('workspaces.ensureDefault', {
      candidateId: testId(1),
      name: 'Unused',
      now: 4000,
    });

    expect(result).toEqual({ id: testId(3), created: false });
  });
});
