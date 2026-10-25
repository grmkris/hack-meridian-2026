import { Effect, Match, Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

import type { BackendError, PasskeyFailed } from './backend'

export const Problem = defineTaggedUnion({
  SignedOut: {},
  Failed: { error: Schema.String },
})
export type Problem = typeof Problem.Type

export const toProblem = (error: BackendError | PasskeyFailed): Problem =>
  Match.value(error).pipe(
    Match.tagsExhaustive({
      SignedOut: () => Problem.SignedOut(),
      BackendFailed: ({ error: sentence }) => Problem.Failed({ error: sentence }),
      InviteRequired: () => Problem.Failed({ error: 'Creating a wallet here needs an invite code.' }),
      PasskeyFailed: ({ error: sentence }) => Problem.Failed({ error: sentence }),
    }),
  )

export const recoverProblem =
  <B>(onProblem: (problem: Problem) => B) =>
  <A, R>(effect: Effect.Effect<A, BackendError | PasskeyFailed, R>): Effect.Effect<A | B, never, R> =>
    effect.pipe(Effect.catch(error => Effect.succeed(onProblem(toProblem(error)))))
