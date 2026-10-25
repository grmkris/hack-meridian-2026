import { Effect } from 'effect'
import { HttpApiClient } from 'effect/http-api'
import { Http } from 'foldkit'

import { Api } from '@hm/api'

/** Runs `call` with the typed client for the Worker's API, over the browser's fetch to the same origin. */
export const withApi = <A, E>(call: (client: HttpApiClient.ForApi<typeof Api>) => Effect.Effect<A, E>) =>
  Effect.flatMap(HttpApiClient.make(Api), call).pipe(Effect.provide(Http.layer))
