// The shape every repository implements: one synchronous function per RPC method, taking the
// method's parsed input. The server (./server.ts) validates before calling, so a handler only
// ever sees input that matched its schema.
import type { z } from 'zod';

import type { DATA_METHODS, DataMethod, DataOutput } from '../shared/contracts/data-rpc';

export type HandlerInput<M extends DataMethod> = z.output<(typeof DATA_METHODS)[M]['input']>;
export type Handler<M extends DataMethod> = (input: HandlerInput<M>) => DataOutput<M>;

/** `db.*` and `maintenance.*` belong to the server itself; everything else to a repository. */
export type RepositoryMethod = Exclude<DataMethod, `db.${string}` | `maintenance.${string}`>;

export type RepositoryHandlers = { readonly [M in RepositoryMethod]: Handler<M> };

/**
 * The methods that change the user's data. One of them succeeding is what makes the next daily
 * backup worth taking. `appRuns.*` is left out on purpose: its heartbeat writes every minute.
 */
export const DATA_WRITES: ReadonlySet<RepositoryMethod> = new Set<RepositoryMethod>([
  'workspaces.ensureDefault',
  'tabs.upsertMany',
  'tabs.deleteMany',
  'appState.set',
  'appState.delete',
  'settings.set',
  'permissions.set',
  'permissions.delete',
  'downloads.upsert',
  'downloads.delete',
  'downloads.clear',
]);
