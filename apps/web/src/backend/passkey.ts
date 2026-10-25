import { Context, Effect, Layer, Result, Schema } from 'effect'
import { Base64Url } from 'effect/encoding'

import type { Assertion, AssertionOptions, RegistrationOptions } from './backend'

/** The passkey prompt was dismissed, timed out or is not available on this device. */
export class PasskeyFailed extends Schema.TaggedError<PasskeyFailed>()('PasskeyFailed', { error: Schema.String }) {}

/** A new passkey, as the Worker needs it to deploy the smart account: all fields base64url. */
export interface CreatedPasskey {
  readonly credential_id: string
  /** 65-byte uncompressed P-256 public key (0x04 ‖ X ‖ Y), the smart account's admin signer. */
  readonly public_key: string
  readonly client_data_json: string
  readonly attestation_object: string
}

/** The browser's WebAuthn ceremonies. `live` uses the platform authenticator; `fixture` answers instantly. */
export class Passkey extends Context.Service<
  Passkey,
  {
    readonly create: (options: RegistrationOptions) => Effect.Effect<CreatedPasskey, PasskeyFailed>
    readonly assert: (options: AssertionOptions) => Effect.Effect<Assertion, PasskeyFailed>
  }
>()('hm/Passkey') {}

/** ES256 (P-256), the curve the smart account's WebAuthn verifier checks. */
const ES256 = -7
/** A P-256 SubjectPublicKeyInfo ends with the 65-byte uncompressed point. */
const UNCOMPRESSED_POINT = 65

const bytes = (buffer: ArrayBuffer): Uint8Array => new Uint8Array(buffer)
const encode = (buffer: ArrayBuffer): string => Base64Url.encode(bytes(buffer))
const decode = (text: string) =>
  Result.match(Base64Url.decode(text), {
    onFailure: () => Effect.fail(new PasskeyFailed({ error: 'The Worker sent a malformed passkey challenge.' })),
    onSuccess: value => Effect.succeed(new Uint8Array(value)),
  })

const dismissed = (cause: unknown) =>
  new PasskeyFailed({
    error:
      cause instanceof DOMException && cause.name === 'NotAllowedError'
        ? 'The passkey prompt was closed before it finished. Try again.'
        : 'This browser could not use a passkey here.',
  })

const isPublicKeyCredential = (value: Credential | null): value is PublicKeyCredential =>
  value !== null && value.type === 'public-key'

const live = Passkey.of({
  create: options =>
    Effect.gen(function* () {
      const challenge = yield* decode(options.challenge)
      const userId = yield* decode(options.user_id)
      const credential = yield* Effect.tryPromise({
        try: () =>
          navigator.credentials.create({
            publicKey: {
              challenge,
              rp: { id: options.rp_id, name: options.rp_name },
              user: { id: userId, name: options.user_name, displayName: options.user_name },
              pubKeyCredParams: [{ type: 'public-key', alg: ES256 }],
              authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
              attestation: 'none',
              timeout: 120_000,
            },
          }),
        catch: dismissed,
      })
      if (!isPublicKeyCredential(credential) || !(credential.response instanceof AuthenticatorAttestationResponse)) {
        return yield* new PasskeyFailed({ error: 'The browser returned no passkey.' })
      }
      const spki = credential.response.getPublicKey()
      if (spki === null || spki.byteLength < UNCOMPRESSED_POINT) {
        return yield* new PasskeyFailed({ error: 'This passkey does not use the P-256 curve the wallet needs.' })
      }
      return {
        credential_id: encode(credential.rawId),
        public_key: Base64Url.encode(bytes(spki).slice(-UNCOMPRESSED_POINT)),
        client_data_json: encode(credential.response.clientDataJSON),
        attestation_object: encode(credential.response.attestationObject),
      }
    }),
  assert: options =>
    Effect.gen(function* () {
      const challenge = yield* decode(options.challenge)
      const allowCredentials = yield* Effect.forEach(options.allow_credentials, id =>
        Effect.map(decode(id), decoded => ({ type: 'public-key' as const, id: decoded })),
      )
      const credential = yield* Effect.tryPromise({
        try: () =>
          navigator.credentials.get({
            publicKey: { challenge, rpId: options.rp_id, allowCredentials, userVerification: 'required' },
          }),
        catch: dismissed,
      })
      if (!isPublicKeyCredential(credential) || !(credential.response instanceof AuthenticatorAssertionResponse)) {
        return yield* new PasskeyFailed({ error: 'The browser returned no passkey.' })
      }
      return {
        credential_id: encode(credential.rawId),
        client_data_json: encode(credential.response.clientDataJSON),
        authenticator_data: encode(credential.response.authenticatorData),
        signature: encode(credential.response.signature),
      }
    }),
})

export const livePasskey = Layer.succeed(Passkey, live)

/** For fixtures and headless screenshots, where no authenticator exists. */
export const fixturePasskey = Layer.succeed(
  Passkey,
  Passkey.of({
    create: () =>
      Effect.succeed({
        credential_id: 'Zml4dHVyZS1jcmVkZW50aWFs',
        public_key: Base64Url.encode(new Uint8Array(UNCOMPRESSED_POINT).fill(4, 0, 1)),
        client_data_json: 'e30',
        attestation_object: 'o2NmbXRkbm9uZQ',
      }),
    assert: () =>
      Effect.succeed({
        credential_id: 'Zml4dHVyZS1jcmVkZW50aWFs',
        client_data_json: 'e30',
        authenticator_data: 'AA',
        signature: 'AA',
      }),
  }),
)
