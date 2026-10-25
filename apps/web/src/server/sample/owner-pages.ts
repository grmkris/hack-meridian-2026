import { Effect, Option, Schema } from 'effect'
import { Base64Url } from 'effect/encoding'

import type { SoftPasskey } from '@hm/stellar/testing'

import { SESSION_COOKIE } from '../owner.ts'
import { ownerRoute } from '../routes.ts'
import type { AppRuntime } from '../runtime.ts'
import type { Site } from '../wallet-settings.ts'

/**
 * The demo owner on the owner pages: the same handlers a phone reaches at /approve/<intent>, /claim/<intent> and
 * /approve/revoke/<connection> (routes.ts), called in-process with the demo owner's session cookie and the soft
 * passkey's answers. No HTTP to ourselves: `ownerRoute` is the function the Worker's fetch handler calls.
 */
export class OwnerPageError extends Schema.TaggedError<OwnerPageError>()('OwnerPageError', {
  message: Schema.String,
}) {}

export interface DemoOwner {
  readonly runtime: AppRuntime
  readonly site: Site
  /** The demo owner's session token (the `hm_owner` cookie). */
  readonly token: string
  readonly passkey: SoftPasskey
}

const ErrorReply = Schema.Struct({ error: Schema.String })
const Challenge = Schema.Struct({ challenge: Schema.String })
const Done = Schema.Struct({ done: Schema.Literal(true) })
export const StatusReply = Schema.Struct({
  status: Schema.String,
  failure: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
export const RemovalReply = Schema.Struct({
  rule_status: Schema.String,
  tx: Schema.NullOr(Schema.String),
  explorer_url: Schema.optionalKey(Schema.String),
})

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return { error: text }
  }
}

/** POST a JSON body to an owner page handler, as the page's script does; a 4xx/5xx is the handler's error message. */
const post = (owner: DemoOwner, path: string, body: unknown, query = '') =>
  Effect.tryPromise({
    try: async () => {
      const request = new Request(`${owner.site.origin}${path}${query}`, {
        method: 'POST',
        headers: {
          cookie: `${SESSION_COOKIE}=${encodeURIComponent(owner.token)}`,
          'content-type': 'application/json',
          origin: owner.site.origin,
        },
        body: JSON.stringify(body),
      })
      const response = await ownerRoute(owner.runtime, request, path)
      if (response === undefined) return { status: 404, json: { error: `no owner page at ${path}` } }
      return { status: response.status, json: parse(await response.text()) }
    },
    catch: cause => new OwnerPageError({ message: `${path}: ${String(cause)}` }),
  }).pipe(
    Effect.flatMap(({ status, json }) =>
      status >= 400
        ? Effect.fail(
            new OwnerPageError({
              message: Option.match(Schema.decodeUnknownOption(ErrorReply)(json), {
                onNone: () => `${path} answered ${status}`,
                onSome: reply => reply.error,
              }),
            }),
          )
        : Effect.succeed(json),
    ),
  )

const decode =
  <S extends Schema.Constraint & { readonly DecodingServices: never }>(schema: S, path: string) =>
  (json: unknown) =>
    Schema.decodeUnknownEffect(schema)(json).pipe(
      Effect.mapError(() => new OwnerPageError({ message: `${path} answered something unexpected` })),
    )

/** The soft passkey's answer to a server challenge, base64url, exactly as `navigator.credentials.get` gives the page. */
export const passkeyAnswer = (passkey: SoftPasskey, challenge: string) =>
  Effect.tryPromise({
    try: async () => {
      const assertion = await passkey.assertChallenge(challenge)
      return {
        credential_id: Base64Url.encode(passkey.credentialId),
        client_data_json: Base64Url.encode(assertion.clientDataJSON),
        authenticator_data: Base64Url.encode(assertion.authenticatorData),
        signature: Base64Url.encode(assertion.signature),
      }
    },
    catch: cause => new OwnerPageError({ message: `the demo passkey could not sign: ${String(cause)}` }),
  })

/** /approve/<intent>: Approve (the chain prepares this exact payment) → passkey → POST. The demo owner nods. */
export const nod = (owner: DemoOwner, intentId: string) =>
  Effect.gen(function* () {
    const path = `/approve/${intentId}`
    const prepared = yield* post(owner, `${path}/prepare`, {}).pipe(Effect.flatMap(decode(Challenge, path)))
    const assertion = yield* passkeyAnswer(owner.passkey, prepared.challenge)
    return yield* post(owner, path, { assertion }).pipe(Effect.flatMap(decode(StatusReply, path)))
  })

/** /claim/<intent>?demo=1: on testnet the seeded demo recipient's key (held by Nod) signs Carol's `trust` entry. */
export const acceptClaimAsDemoRecipient = (owner: DemoOwner, intentId: string) => {
  const path = `/claim/${intentId}`
  return post(owner, path, { signed_entry: null }, '?demo=1').pipe(Effect.flatMap(decode(StatusReply, path)))
}

/** /approve/revoke/<connection>: the passkey removes the allowance's rule from the Stellar account. */
export const removeRule = (owner: DemoOwner, connectionId: string) =>
  Effect.gen(function* () {
    const path = `/approve/revoke/${connectionId}`
    const prepared = yield* post(owner, `${path}/prepare`, {})
    if (Option.isSome(Schema.decodeUnknownOption(Done)(prepared)))
      return { rule_status: 'removed', tx: null } satisfies typeof RemovalReply.Type
    const { challenge } = yield* decode(Challenge, path)(prepared)
    const assertion = yield* passkeyAnswer(owner.passkey, challenge)
    return yield* post(owner, path, { assertion }).pipe(Effect.flatMap(decode(RemovalReply, path)))
  })
