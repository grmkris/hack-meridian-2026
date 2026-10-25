import { Effect, Redacted, Ref, Semaphore } from 'effect'

import type { ChainError } from '@hm/protocol'
import { Keypair } from '@stellar/stellar-sdk'

import { isRetryableRejection } from './soroban.ts'

/**
 * One to three funded relayer `G…` accounts. Each serializes on its own sequence number, so this isolate holds one
 * permit per relayer and picks them round-robin; a rejection before apply (`txBadSeq` from another isolate,
 * `txInsufficientBalance` when one ran dry) moves on to the next relayer.
 */
export interface RelayerPool {
  readonly keypairs: ReadonlyArray<Keypair>
  /** Used as the simulation source; any relayer works there. */
  readonly primary: Keypair
  readonly run: <A>(f: (relayer: Keypair) => Effect.Effect<A, ChainError>) => Effect.Effect<A, ChainError>
}

export const makeRelayerPool = (secrets: ReadonlyArray<Redacted.Redacted>) =>
  Effect.gen(function* () {
    const keypairs = secrets.map(s => Keypair.fromSecret(Redacted.value(s)))
    const primary = keypairs[0]
    if (primary === undefined) return yield* Effect.die('no relayer secret configured')
    const locks = yield* Effect.forEach(keypairs, () => Semaphore.make(1))
    const next = yield* Ref.make(0)

    const run = <A>(f: (relayer: Keypair) => Effect.Effect<A, ChainError>): Effect.Effect<A, ChainError> =>
      Effect.gen(function* () {
        const start = yield* Ref.getAndUpdate(next, n => (n + 1) % keypairs.length)
        const attempt = (i: number): Effect.Effect<A, ChainError> => {
          const idx = (start + i) % keypairs.length
          const kp = keypairs[idx] ?? primary
          const lock = locks[idx]
          const once = lock === undefined ? f(kp) : lock.withPermits(1)(f(kp))
          return i + 1 >= keypairs.length + 1
            ? once
            : once.pipe(Effect.catchIf(isRetryableRejection, () => attempt(i + 1)))
        }
        return yield* attempt(0)
      })

    return { keypairs, primary, run } satisfies RelayerPool
  })
