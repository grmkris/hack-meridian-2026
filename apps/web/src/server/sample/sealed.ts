import { Effect, Result, Schema } from 'effect'
import { Base64Url } from 'effect/encoding'

/**
 * The demo owner's passkey at rest: AES-256-GCM under a key HKDF-derived from the stage's VAULT_KEY (the secret that
 * already seals the connection keys, with its own salt and info so the two uses never share a key). Stored in D1 as
 * `hms1.<base64url(iv ‖ ciphertext)>`; decrypted only inside the sample run, only to sign.
 */
export class SealError extends Schema.TaggedError<SealError>()('SealError', { message: Schema.String }) {}

const PREFIX = 'hms1'
const IV_BYTES = 12
const AAD = new TextEncoder().encode('nod sample demo owner passkey')

const keyOf = (secret: string) =>
  Effect.tryPromise({
    try: async () => {
      const raw = new TextEncoder().encode(secret)
      if (raw.length < 16) throw new RangeError('the vault key is shorter than 16 bytes')
      const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey'])
      return crypto.subtle.deriveKey(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: new TextEncoder().encode('hm/sample/demo-owner'),
          info: new TextEncoder().encode('aes-256-gcm v1'),
        },
        base,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      )
    },
    catch: cause => new SealError({ message: cause instanceof Error ? cause.message : 'cannot derive the key' }),
  })

export const seal = (secret: string, plaintext: string) =>
  Effect.gen(function* () {
    const key = yield* keyOf(secret)
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
    const sealed = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, new TextEncoder().encode(plaintext)),
      catch: () => new SealError({ message: 'cannot seal' }),
    })
    const blob = new Uint8Array(IV_BYTES + sealed.byteLength)
    blob.set(iv, 0)
    blob.set(new Uint8Array(sealed), IV_BYTES)
    return `${PREFIX}.${Base64Url.encode(blob)}`
  })

export const unseal = (secret: string, text: string) =>
  Effect.gen(function* () {
    const [prefix, body, ...rest] = text.split('.')
    if (prefix !== PREFIX || body === undefined || rest.length > 0)
      return yield* new SealError({ message: 'not a sealed demo owner' })
    const blob = yield* Result.match(Base64Url.decode(body), {
      onFailure: () => Effect.fail(new SealError({ message: 'not base64url' })),
      onSuccess: bytes => Effect.succeed(bytes),
    })
    const key = yield* keyOf(secret)
    const plain = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: blob.slice(0, IV_BYTES), additionalData: AAD },
          key,
          blob.slice(IV_BYTES),
        ),
      catch: () => new SealError({ message: 'cannot unseal the demo owner (wrong VAULT_KEY or a tampered row)' }),
    })
    return new TextDecoder().decode(plain)
  })
