import { Effect, Layer } from 'effect'

import { Db } from './db.ts'
import { Network } from './network.ts'
import { logFailure } from './observe/log.ts'
import { backfillNetwork } from './store.ts'

/**
 * The Db with the wallet and contact rows moved to the stage's network (store.ts backfillNetwork) once per isolate,
 * just before its first query. Not at layer build: the API handler (HttpRouter.toWebHandler) builds this layer in the
 * Worker's global scope, where D1 I/O is not allowed, so a backfill there failed quietly on every deploy since 9fc080f
 * (under `alchemy dev` the module loads inside a request, which hid it). A failed backfill is logged, never fatal.
 */
export const backfilledDb = Layer.effect(
  Db,
  Effect.gen(function* () {
    const db = yield* Db
    const network = yield* Network
    const once = yield* Effect.cached(
      backfillNetwork(network.caip).pipe(
        Effect.provideService(Db, db),
        Effect.catch(error => logFailure('warn', 'network.backfill_failed', error)),
      ),
    )
    return {
      all: statement => Effect.andThen(once, db.all(statement)),
      batch: statements => Effect.andThen(once, db.batch(statements)),
    }
  }),
)
