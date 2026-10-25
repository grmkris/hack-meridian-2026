import { Effect, Layer, Match, Option, Predicate } from 'effect'
import { HttpApiClient } from 'effect/http-api'
import { Http } from 'foldkit'

import { Api } from '@hm/api'

import { Backend, BackendFailed, type BackendError, InviteRequired, SignedOut } from './backend'

const UNREACHABLE = 'Nod did not answer. Check your connection and try again.'
/** The Worker's 400 sentence when this network needs an invite code to create a wallet. */
const INVITE_REQUIRED = 'invite_required'
const UNREADABLE = 'Nod answered in a way this page cannot read. Reload it.'

const sentenceOf = (error: object): string =>
  Predicate.hasProperty(error, 'error') && Predicate.isString(error.error) ? error.error : UNREACHABLE

/** The Worker's 429 `too_many_wallets` as a sentence: when the next wallet can be created. */
export const tooManyWalletsSentence = (error: object): string => {
  const seconds =
    Predicate.hasProperty(error, 'retry_after_s') && Predicate.isNumber(error.retry_after_s)
      ? error.retry_after_s
      : 3600
  const minutes = Math.max(1, Math.ceil(seconds / 60))
  return `Nod opens only a few new wallets each hour. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
}

const toBackendError = (error: { readonly _tag: string }): BackendError =>
  Match.value(error._tag).pipe(
    Match.withReturnType<BackendError>(),
    Match.when('Unauthorized', () => new SignedOut()),
    Match.when('BadRequest', () =>
      sentenceOf(error) === INVITE_REQUIRED ? new InviteRequired() : new BackendFailed({ error: sentenceOf(error) }),
    ),
    Match.whenOr('NotFound', 'Unavailable', () => new BackendFailed({ error: sentenceOf(error) })),
    Match.when('TooManyWallets', () => new BackendFailed({ error: tooManyWalletsSentence(error) })),
    Match.when('SchemaError', () => new BackendFailed({ error: UNREADABLE })),
    Match.orElse(() => new BackendFailed({ error: UNREACHABLE })),
  )

const call = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  Effect.mapError(effect, toBackendError)

export const httpBackend = Layer.effect(
  Backend,
  Effect.gen(function* () {
    const client = yield* HttpApiClient.make(Api)
    return Backend.of({
      session: call(Effect.map(client.session.current(), reply => reply.wallet)),
      registrationOptions: (name, maybeInviteCode) =>
        call(
          client.session.registrationOptions({
            payload: Option.match(maybeInviteCode, {
              onNone: () => ({ name }),
              onSome: inviteCode => ({ name, invite_code: inviteCode }),
            }),
          }),
        ),
      createWallet: registration =>
        call(Effect.map(client.session.createWallet({ payload: registration }), reply => reply.wallet)),
      assertionOptions: call(client.session.assertionOptions()),
      signIn: assertion => call(Effect.map(client.session.signIn({ payload: assertion }), reply => reply.wallet)),
      signOut: call(Effect.asVoid(client.session.signOut())),
      overview: call(client.wallet.overview()),
      connections: call(client.wallet.connections()),
      revokeConnection: id => call(client.wallet.revokeConnection({ params: { id } })),
      contacts: call(client.wallet.contacts()),
      addContact: contact => call(client.wallet.createContact({ payload: contact })),
      receipts: call(client.wallet.receipts()),
      depositAddress: call(client.wallet.depositAddress()),
    })
  }),
).pipe(Layer.provide(Http.layer))
