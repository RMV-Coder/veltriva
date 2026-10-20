// The shape every repository implements: one synchronous function per RPC method, taking the
// method's parsed input. The server (./server.ts) validates before calling, so a handler only
// ever sees input that matched its schema.
import type { z } from 'zod';

import type { DATA_METHODS, DataMethod, DataOutput } from '../shared/contracts/data-rpc';

export type HandlerInput<M extends DataMethod> = z.output<(typeof DATA_METHODS)[M]['input']>;
export type Handler<M extends DataMethod> = (input: HandlerInput<M>) => DataOutput<M>;

/** `db.*` belongs to the server itself; everything else to a repository. */
export type RepositoryMethod = Exclude<DataMethod, `db.${string}`>;

export type RepositoryHandlers = { readonly [M in RepositoryMethod]: Handler<M> };
