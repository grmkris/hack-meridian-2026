import { Context, Effect, Layer, Option } from 'effect'

import { ChainUnavailable, type CounterReading, NotDeployed } from '@hm/api'
import { Client } from '@hm/counter-client'

import { Settings } from './settings.ts'

/** Reads the counter contract on the stage's network. */
export class Counter extends Context.Service<
  Counter,
  { readonly read: Effect.Effect<CounterReading, NotDeployed | ChainUnavailable> }
>()('hm/Counter') {
  /** Through Soroban RPC: a simulated `count()` call, which needs no account or signature. */
  static readonly layer = Layer.effect(
    Counter,
    Effect.gen(function* () {
      const settings = yield* Settings
      const read = Option.match(settings.counterContractId, {
        onNone: () =>
          Effect.fail(new NotDeployed({ error: `No counter contract is configured on ${settings.stage}.` })),
        onSome: contractId => {
          const client = new Client({
            contractId,
            networkPassphrase: settings.networkPassphrase,
            rpcUrl: settings.rpcUrl,
          })
          return Effect.tryPromise({
            try: () => client.count(),
            catch: cause => new ChainUnavailable({ error: `Soroban RPC did not answer: ${String(cause)}` }),
          }).pipe(
            Effect.timeoutOrElse({
              duration: '8 seconds',
              orElse: () => Effect.fail(new ChainUnavailable({ error: 'Soroban RPC took longer than 8 seconds.' })),
            }),
            Effect.map(transaction => ({ contractId, network: settings.network, count: transaction.result })),
            Effect.tapError(error => Effect.logWarning('counter read failed', error.error)),
            Effect.withSpan('Counter.read'),
          )
        },
      })
      return { read }
    }),
  )
}
