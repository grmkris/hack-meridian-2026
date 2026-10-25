import { Effect, Option, Result, Schema } from 'effect'
import { Base64Url } from 'effect/encoding'

/**
 * Passkey checks the Worker does itself: a registration's clientDataJSON (type, challenge, origin) and public key, and
 * an assertion's signature over authenticatorData ‖ sha256(clientDataJSON) with the stored P-256 key. Attestation is
 * not verified (`attestation: "none"`): the wallet trusts the key the browser created, as passkey wallets do.
 */
export class WebAuthnError extends Schema.TaggedError<WebAuthnError>()('WebAuthnError', {
  message: Schema.String,
}) {}

const ClientData = Schema.fromJsonString(
  Schema.Struct({ type: Schema.String, challenge: Schema.String, origin: Schema.String }),
)
const decodeClientData = Schema.decodeUnknownOption(ClientData)

const fail = (message: string) => Effect.fail(new WebAuthnError({ message }))

export const b64urlDecode = (text: string): Effect.Effect<Uint8Array, WebAuthnError> =>
  Result.match(Base64Url.decode(text), {
    onFailure: () => fail('not base64url'),
    onSuccess: bytes => Effect.succeed(bytes),
  })
export const b64url = (bytes: Uint8Array) => Base64Url.encode(bytes)

/** clientDataJSON as the browser sent it: its type, challenge (base64url) and origin. */
export const readClientData = (clientDataJSON: Uint8Array) =>
  Option.match(decodeClientData(new TextDecoder().decode(clientDataJSON)), {
    onNone: () => fail('clientDataJSON is not WebAuthn client data'),
    onSome: data => Effect.succeed(data),
  })

const checkClientData = (
  clientDataJSON: Uint8Array,
  expected: { readonly type: string; readonly challenge: string; readonly origins: ReadonlyArray<string> },
) =>
  Effect.gen(function* () {
    const data = yield* readClientData(clientDataJSON)
    if (data.type !== expected.type) return yield* fail(`expected ${expected.type}, got ${data.type}`)
    if (data.challenge !== expected.challenge) return yield* fail('the passkey signed a different challenge')
    if (!expected.origins.includes(data.origin)) return yield* fail(`unexpected origin ${data.origin}`)
    return data
  })

const sha256 = (bytes: Uint8Array) =>
  Effect.promise(async () => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))

/** 65-byte uncompressed P-256 key, from itself or from a 91-byte SPKI (what `getPublicKey()` returns). */
export const uncompressedKey = (key: Uint8Array): Effect.Effect<Uint8Array, WebAuthnError> =>
  key.length === 65 && key[0] === 4
    ? Effect.succeed(key)
    : key.length === 91 && key[26] === 4
      ? Effect.succeed(key.slice(26))
      : fail('the public key is not an uncompressed P-256 key')

/** Registration: the browser created a passkey for our challenge, on our origin. Returns the 65-byte public key. */
export const verifyRegistration = (input: {
  readonly clientDataJSON: Uint8Array
  readonly publicKey: Uint8Array
  readonly challenge: string
  readonly origins: ReadonlyArray<string>
}) =>
  Effect.gen(function* () {
    yield* checkClientData(input.clientDataJSON, {
      type: 'webauthn.create',
      challenge: input.challenge,
      origins: input.origins,
    })
    return yield* uncompressedKey(input.publicKey)
  })

/** DER ECDSA signature → 64-byte r ‖ s, as WebCrypto verifies it. */
export const derToRaw = (der: Uint8Array): Effect.Effect<Uint8Array, WebAuthnError> => {
  if (der[0] !== 0x30) return fail('signature is not DER')
  let offset = 2
  const parts: Array<Uint8Array> = []
  for (let i = 0; i < 2; i++) {
    if (der[offset] !== 0x02) return fail('signature is not DER')
    const length = der[offset + 1] ?? 0
    let value = der.slice(offset + 2, offset + 2 + length)
    while (value.length > 32 && value[0] === 0) value = value.slice(1)
    if (value.length > 32) return fail('signature integer too long')
    const padded = new Uint8Array(32)
    padded.set(value, 32 - value.length)
    parts.push(padded)
    offset += 2 + length
  }
  const out = new Uint8Array(64)
  out.set(parts[0] ?? new Uint8Array(32), 0)
  out.set(parts[1] ?? new Uint8Array(32), 32)
  return Effect.succeed(out)
}

/**
 * Assertion: the owner's passkey signed `challenge` on our origin and RP. The same check guards sign-in (a random
 * challenge) and every owner action (the challenge is the smart account's auth digest, which binds the invocation).
 */
export const verifyAssertion = (input: {
  readonly publicKey: Uint8Array
  readonly authenticatorData: Uint8Array
  readonly clientDataJSON: Uint8Array
  readonly signature: Uint8Array
  readonly challenge: string
  readonly origins: ReadonlyArray<string>
  readonly rpId: string
}) =>
  Effect.gen(function* () {
    yield* checkClientData(input.clientDataJSON, {
      type: 'webauthn.get',
      challenge: input.challenge,
      origins: input.origins,
    })
    const rpIdHash = yield* sha256(new TextEncoder().encode(input.rpId))
    const authData = input.authenticatorData
    if (authData.length < 37 || !rpIdHash.every((byte, i) => authData[i] === byte))
      return yield* fail(`the passkey belongs to another site than ${input.rpId}`)
    if (((authData[32] ?? 0) & 0x01) === 0) return yield* fail('user presence was not confirmed')
    const clientHash = yield* sha256(input.clientDataJSON)
    const signed = new Uint8Array(authData.length + clientHash.length)
    signed.set(authData, 0)
    signed.set(clientHash, authData.length)
    const raw = yield* derToRaw(input.signature)
    const ok = yield* Effect.tryPromise({
      try: async () => {
        const key = await crypto.subtle.importKey(
          'raw',
          input.publicKey,
          { name: 'ECDSA', namedCurve: 'P-256' },
          false,
          ['verify'],
        )
        return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, raw, signed)
      },
      catch: cause => new WebAuthnError({ message: `could not verify: ${String(cause)}` }),
    })
    if (!ok) return yield* fail('the passkey signature does not verify')
    return undefined
  })
