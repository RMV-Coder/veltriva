import { describe, expect, it } from 'vitest';

import { commandSchemas } from '../../shared/contracts/schemas';
import type { WorkspaceSnapshot } from '../../shared/contracts/schemas';
import type { TabState } from './tab-manager';
import { createWorkspaceProjector, projectTab } from './workspace-projector';

const ID = '01a13cdb-cc00-7000-8000-000000000001';

const base: TabState = {
  id: ID,
  pinned: false,
  placement: 'strip',
  runtime: 'live',
  page: { kind: 'web' },
  url: 'https://user:pw@example.com/a',
  title: 'Example',
  favicon: null,
  loading: false,
  canGoBack: true,
  canGoForward: false,
};

describe('projectTab', () => {
  it('shows the address rebuilt from the URL, never page text', () => {
    expect(projectTab(base).address).toEqual({
      text: 'https://example.com/a',
      security: 'secure',
      hadCredentials: true,
    });
  });

  it('gives a new-tab page an empty address', () => {
    expect(
      projectTab({ ...base, url: '', page: { kind: 'internal', name: 'new-tab' } }),
    ).toMatchObject({
      address: { text: '', security: 'neutral', hadCredentials: false },
      page: { kind: 'internal', name: 'new-tab' },
    });
  });

  it('passes error details through for error pages', () => {
    expect(
      projectTab({
        ...base,
        page: {
          kind: 'internal',
          name: 'network-error',
          error: { code: -105, name: 'ERR_NAME_NOT_RESOLVED' },
        },
      }).page,
    ).toEqual({
      kind: 'internal',
      name: 'network-error',
      error: { code: -105, name: 'ERR_NAME_NOT_RESOLVED' },
    });
  });

  it('produces snapshots that satisfy the contract', () => {
    const snapshot: WorkspaceSnapshot = { version: 1, selectedTabId: ID, tabs: [projectTab(base)] };
    expect(commandSchemas['workspace.getSnapshot'].output.safeParse(snapshot).success).toBe(true);
  });
});

describe('WorkspaceProjector', () => {
  function setup() {
    const timers: (() => void)[] = [];
    const published: WorkspaceSnapshot[] = [];
    let tabs: TabState[] = [base];
    const projector = createWorkspaceProjector({
      tabs: () => tabs,
      selectedTabId: () => tabs[0]?.id ?? null,
      publish: (snapshot) => published.push(snapshot),
      schedule: (callback) => timers.push(callback),
      cancel: () => {
        timers.length = 0;
      },
    });
    const flush = (): void => {
      for (const timer of timers.splice(0)) {
        timer();
      }
    };
    return {
      projector,
      published,
      flush,
      timers,
      setTabs: (next: TabState[]) => {
        tabs = next;
      },
    };
  }

  it('coalesces a burst of changes into one snapshot', () => {
    const { projector, published, flush, timers } = setup();
    for (let i = 0; i < 50; i += 1) {
      projector.markDirty();
    }
    expect(timers).toHaveLength(1);
    flush();
    expect(published).toHaveLength(1);
  });

  it('publishes the latest state with increasing versions', () => {
    const { projector, published, flush, setTabs } = setup();
    projector.markDirty();
    flush();
    setTabs([{ ...base, title: 'Changed' }]);
    projector.markDirty();
    flush();
    expect(published.map((snapshot) => snapshot.version)).toEqual([1, 2]);
    expect(published[1]?.tabs[0]?.title).toBe('Changed');
    expect(projector.snapshot().version).toBe(3);
  });

  it('drops a pending snapshot when disposed', () => {
    const { projector, published, flush } = setup();
    projector.markDirty();
    projector.dispose();
    flush();
    expect(published).toHaveLength(0);
  });

  it('schedules nothing once disposed, though the tabs keep changing as they close', () => {
    const { projector, published, flush, timers } = setup();
    projector.dispose();
    projector.markDirty();
    expect(timers).toHaveLength(0);
    flush();
    expect(published).toHaveLength(0);
  });
});
