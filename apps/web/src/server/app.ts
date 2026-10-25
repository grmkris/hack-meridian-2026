import { Effect, Layer } from 'effect'
import { HttpRouter, HttpServer } from 'effect/http'
import { HttpApiBuilder } from 'effect/http-api'

import { Api } from '@hm/api'

import { Counter } from './counter.ts'
import { Settings } from './settings.ts'

const SystemHandlers = HttpApiBuilder.group(
  Api,
  'system',
  Effect.fn(function* (handlers) {
    const settings = yield* Settings
    return handlers.handle('health', () =>
      Effect.succeed({
        ok: true as const,
        stage: settings.stage,
        release: settings.release,
        network: settings.network,
      }),
    )
  }),
)

const CounterHandlers = HttpApiBuilder.group(
  Api,
  'counter',
  Effect.fn(function* (handlers) {
    const counter = yield* Counter
    return handlers.handle('read', () => counter.read)
  }),
)

/**
 * The typed API as a fetch handler over the given services. Build it once per isolate. Services that fail to build
 * (a missing setting) answer every request with a 500 and log why.
 */
export const makeApiHandler = <E>(services: Layer.Layer<Settings | Counter, E>) =>
  HttpRouter.toWebHandler(
    HttpApiBuilder.layer(Api).pipe(
      Layer.provide([SystemHandlers, CounterHandlers]),
      Layer.provide(services),
      Layer.provide(HttpServer.layerServices),
    ),
  )

/** The deployed services: settings from the Worker's bindings and the counter on Soroban RPC. */
export const liveServices = (bindings: object) =>
  Counter.layer.pipe(Layer.provideMerge(Settings.fromBindings(bindings)))
