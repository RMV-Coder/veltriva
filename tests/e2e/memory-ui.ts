// What the M2.2b specs share (history.spec.ts, stored-decisions.spec.ts, download-history.spec.ts):
// reading the memory (pages, visits, favicons) and the stored decisions through the `dataCall`
// hook, as main reads them, and the little that decoding a stored PNG takes.
//
// The memory is written behind the page: a commit is reported to the data worker a moment later,
// and a title only once it has been stable for 2 s. A spec therefore never reads a row once and
// trusts it: it polls (`expectVisits`, `expect.poll`) or waits for the row it needs.
import type { ElectronApplication } from '@playwright/test';

import type { PageRow, PermissionRow } from '../../src/shared/contracts/data-rpc';
import { expect } from './expect';
import { dataValue } from './session-ui';
import { SLOW_TIMEOUT_MS } from './shell-ui';

export { expect } from './expect';
export { test } from './session-ui';

export type Transition =
  'link' | 'typed' | 'reload' | 'back_forward' | 'redirect' | 'restore' | 'generated' | 'other';

export interface VisitEntry {
  readonly id: number;
  readonly pageId: number;
  /** The page's `url` column: what the memory shows, with secrets cut. */
  readonly url: string;
  readonly transition: Transition;
  readonly tabId: string | null;
}

export interface Memory {
  /** Most recently visited first, as `history.pages` returns them. */
  readonly pages: readonly PageRow[];
  /** Every visit, oldest first. */
  readonly visits: readonly VisitEntry[];
}

/** The pages and visits as the database holds them right now. */
export async function readMemory(app: ElectronApplication): Promise<Memory> {
  const { pages } = await dataValue<{ pages: PageRow[] }>(app, 'history.pages', { limit: 1000 });
  const visits: VisitEntry[] = [];
  for (const page of pages) {
    const { visits: ofPage } = await dataValue<{
      visits: { id: number; transition: Transition; tabId: string | null }[];
    }>(app, 'history.visits', { pageId: page.id, limit: 1000 });
    for (const visit of ofPage) {
      visits.push({
        id: visit.id,
        pageId: page.id,
        url: page.url,
        transition: visit.transition,
        tabId: visit.tabId,
      });
    }
  }
  visits.sort((a, b) => a.id - b.id);
  return { pages, visits };
}

/** `[url, transition]` of every visit, oldest first. */
export async function visitList(app: ElectronApplication): Promise<[string, Transition][]> {
  return (await readMemory(app)).visits.map((visit) => [visit.url, visit.transition]);
}

/** Waits until the memory holds exactly these visits, oldest first. */
export async function expectVisits(
  app: ElectronApplication,
  expected: readonly (readonly [string, Transition])[],
  message = 'the memory should hold these visits',
): Promise<void> {
  await expect
    .poll(() => visitList(app), { message, timeout: SLOW_TIMEOUT_MS })
    .toEqual(expected.map(([url, transition]) => [url, transition]));
}

/** The page whose `url` column is `url`, once there is one. */
export async function waitForPageRow(app: ElectronApplication, url: string): Promise<PageRow> {
  const seen: { page: PageRow | undefined } = { page: undefined };
  await expect
    .poll(
      async () => {
        seen.page = (await readMemory(app)).pages.find((page) => page.url === url);
        return seen.page !== undefined;
      },
      { message: `the memory should hold a page for ${url}`, timeout: SLOW_TIMEOUT_MS },
    )
    .toBe(true);
  if (seen.page === undefined) {
    throw new Error('unreachable: the poll passed with no page');
  }
  return seen.page;
}

/** The title stored for the page whose `url` column is `url`: null if there is no such page. */
export async function storedTitle(app: ElectronApplication, url: string): Promise<string | null> {
  return (await readMemory(app)).pages.find((page) => page.url === url)?.title ?? null;
}

/**
 * Waits until a page has an icon (`pages.favicon_id`), and returns the page. What the icon's row
 * holds is read from the file after the app quit: see history.spec.ts.
 */
export async function waitForFavicon(
  app: ElectronApplication,
  url: string,
): Promise<{ page: PageRow }> {
  const seen: { page: PageRow | undefined } = { page: undefined };
  await expect
    .poll(
      async () => {
        seen.page = (await readMemory(app)).pages.find((page) => page.url === url);
        return seen.page?.faviconId ?? null;
      },
      { message: `the page ${url} should get a favicon`, timeout: SLOW_TIMEOUT_MS },
    )
    .not.toBeNull();
  if (seen.page === undefined) {
    throw new Error('unreachable: the poll passed with no page');
  }
  return { page: seen.page };
}

/** The stored permission decisions (`permission_decisions`), sorted for comparison. */
export async function storedPermissions(
  app: ElectronApplication,
): Promise<Pick<PermissionRow, 'origin' | 'permission' | 'decision'>[]> {
  const { decisions } = await dataValue<{ decisions: PermissionRow[] }>(app, 'permissions.list', {
    limit: 1000,
  });
  return decisions
    .map(({ origin, permission, decision }) => ({ origin, permission, decision }))
    .sort((a, b) => `${a.origin} ${a.permission}`.localeCompare(`${b.origin} ${b.permission}`));
}
