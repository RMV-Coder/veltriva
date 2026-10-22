// Sleeping, the Archive, protection and Undo from the shell's side (M3.3): each helper sends the
// command the sidebar sends, through `window.veltriva`, so the specs go through the real IPC
// contract and main's checks. What the database holds is read through the data worker.
import type { ElectronApplication, Page } from '@playwright/test';

import type { TabRow } from '../../src/shared/contracts/data-rpc';
import type { ActivityEntry, TabId } from './hooks';
import type { PageGlobal } from './page-globals';
import { dataValue, WORKSPACE_CANDIDATE } from './session-ui';

type Result<Value> =
  { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly code: string };

function unwrap<Value>(result: Result<Value>, what: string): Value {
  if (!result.ok) {
    throw new Error(`${what} failed: ${result.code}`);
  }
  return result.value;
}

/** Moves a strip tab to Sleeping, as the tab menu's "Move to Sleeping" does. */
export async function shelveTab(shell: Page, tabId: TabId): Promise<boolean> {
  const result = await shell.evaluate(
    (id) => (globalThis as PageGlobal).veltriva.tabs.shelve({ tabId: id }),
    tabId,
  );
  return unwrap(result, 'tabs.shelve').moved;
}

/** Archives a tab, as "Archive tab" does. Resolves once main has decided. */
export async function archiveTab(shell: Page, tabId: TabId): Promise<boolean> {
  const result = await shell.evaluate(
    (id) => (globalThis as PageGlobal).veltriva.tabs.archive({ tabId: id }),
    tabId,
  );
  return unwrap(result, 'tabs.archive').moved;
}

/** Brings a tab back from Sleeping or the Archive; resolves with its id (maybe a new one). */
export async function restoreTab(shell: Page, tabId: TabId): Promise<TabId> {
  const result = await shell.evaluate(
    (id) => (globalThis as PageGlobal).veltriva.tabs.restore({ tabId: id }),
    tabId,
  );
  return unwrap(result, 'tabs.restore').tabId;
}

export async function setProtected(shell: Page, tabId: TabId, on: boolean): Promise<void> {
  const result = await shell.evaluate(
    (args) =>
      (globalThis as PageGlobal).veltriva.tabs.setProtected({
        tabId: args.id,
        protected: args.on,
      }),
    { id: tabId, on },
  );
  unwrap(result, 'tabs.setProtected');
}

/** Undoes a batch, as the toast's Undo button does; resolves with how many tabs went back. */
export async function undoBatch(shell: Page, batchId: string): Promise<number> {
  const result = await shell.evaluate(
    (id) => (globalThis as PageGlobal).veltriva.lifecycle.undo({ batchId: id }),
    batchId,
  );
  return unwrap(result, 'lifecycle.undo').undone;
}

/** The activity log as the shell reads it, newest first. */
export async function shellActivity(shell: Page): Promise<ActivityEntry[]> {
  const result = await shell.evaluate(() =>
    (globalThis as PageGlobal).veltriva.lifecycle.activity(),
  );
  return unwrap(result, 'lifecycle.activity').entries;
}

/** Sleeping and the Archive as the database holds them. */
export interface SavedPlacement {
  /** Sleeping rows, by position. */
  readonly shelf: readonly TabRow[];
  /** Archived rows, newest first. */
  readonly archived: readonly TabRow[];
  readonly archivedCount: number;
}

export async function readSavedPlacement(app: ElectronApplication): Promise<SavedPlacement> {
  const { id: workspaceId } = await dataValue<{ id: string }>(app, 'workspaces.ensureDefault', {
    candidateId: WORKSPACE_CANDIDATE,
    name: 'Default',
    now: Date.now(),
  });
  const [shelf, archived, count] = await Promise.all([
    dataValue<{ tabs: TabRow[] }>(app, 'tabs.list', {
      workspaceId,
      placement: 'shelf',
      limit: 1000,
    }),
    dataValue<{ tabs: TabRow[] }>(app, 'tabs.listArchived', { workspaceId, limit: 1000 }),
    dataValue<{ count: number }>(app, 'tabs.countArchived', { workspaceId }),
  ]);
  return { shelf: shelf.tabs, archived: archived.tabs, archivedCount: count.count };
}
