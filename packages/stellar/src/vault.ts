import { Context, Effect, Layer, Redacted } from 'effect'

import { ChainError } from '@hm/protocol'
import { Keypair, StrKey } from '@stellar/stellar-sdk'

import { concatBytes, fromBase64Url, toBase64Url, toBuffer, utf8 } from './bytes.ts'
import { ChainConfig } from './config.ts'

/**
 * Connection keys at rest. A key ref is self-describing and safe to store in D1:
 * `hmk1.<G address>.<base64url(iv ‖ AES-GCM(seed))>`, with the address as additional data so a blob cannot be moved
 * to another address. The AES-256 key is HKDF-SHA256 of `VAULT_KEY`. Seeds are decrypted only inside this package,
 * only to sign.
 */
const PREFIX = 'hmk1'
const IV_BYTES = 12

export interface VaultCore {
  readonly generate: Effect.Effect<{ signerKeyRef: string; publicKey: Uint8Array; address: string }, ChainError>
  /** The `G…` address in a ref, without decrypting. */
  readonly address: (signerKeyRef: string) => Effect.Effect<string, ChainError>
  /** Decrypt to a keypair. Package-internal: never hand the result to a caller. */
  readonly unseal: (signerKeyRef: string) => Effect.Effect<Keypair, ChainError>
}

const vaultError = (message: string) => new ChainError({ kind: 'unknown', message: `key vault: ${message}` })

export const deriveVaultKey = (vaultKey: Redacted.Redacted): Effect.Effect<CryptoKey, ChainError> =>
  Effect.tryPromise({
    try: async () => {
      const raw = utf8(Redacted.value(vaultKey))
      if (raw.length < 16) throw new RangeError('VAULT_KEY is shorter than 16 bytes')
      const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey'])
      return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: utf8('hm/stellar/key-vault'), info: utf8('aes-256-gcm v1') },
        base,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      )
    },
    catch: e => vaultError(e instanceof Error ? e.message : 'cannot derive the vault key'),
  })

const parseRef = (ref: string): { address: string; blob: Uint8Array<ArrayBuffer> } | undefined => {
  const [prefix, address, blob, ...rest] = ref.split('.')
  if (prefix !== PREFIX || address === undefined || blob === undefined || rest.length > 0) return undefined
  if (!StrKey.isValidEd25519PublicKey(address)) return undefined
  try {
    return { address, blob: fromBase64Url(blob) }
  } catch {
    return undefined
  }
}

const refAddress = (ref: string): Effect.Effect<string, ChainError> => {
  const parsed = parseRef(ref)
  return parsed === undefined ? Effect.fail(vaultError('malformed signer key ref')) : Effect.succeed(parsed.address)
}

export const makeVaultCore = (key: CryptoKey): VaultCore => {
  const seal = (kp: Keypair) =>
    Effect.tryPromise({
      try: async () => {
        const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
        const ct = await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv, additionalData: utf8(kp.publicKey()) },
          key,
          new Uint8Array(kp.rawSecretKey()),
        )
        return `${PREFIX}.${kp.publicKey()}.${toBase64Url(concatBytes(iv, new Uint8Array(ct)))}`
      },
      catch: () => vaultError('cannot seal a key'),
    })

  const unseal = (ref: string) =>
    Effect.gen(function* () {
      const parsed = parseRef(ref)
      if (parsed === undefined) return yield* vaultError('malformed signer key ref')
      const { address: g, blob } = parsed
      const seed = yield* Effect.tryPromise({
        try: () =>
          crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: blob.subarray(0, IV_BYTES), additionalData: utf8(g) },
            key,
            blob.subarray(IV_BYTES),
          ),
        catch: () => vaultError('cannot decrypt the signer key (wrong VAULT_KEY or a tampered ref)'),
      })
      const kp = Keypair.fromRawEd25519Seed(toBuffer(new Uint8Array(seed)))
      if (kp.publicKey() !== g) return yield* vaultError('decrypted key does not match its address')
      return kp
    })

  const generate = Effect.gen(function* () {
    const kp = Keypair.fromRawEd25519Seed(toBuffer(crypto.getRandomValues(new Uint8Array(32))))
    const signerKeyRef = yield* seal(kp)
    return { signerKeyRef, publicKey: new Uint8Array(kp.rawPublicKey()), address: kp.publicKey() }
  })

  return { generate, address: refAddress, unseal }
}

/**
 * The vault as a service for the wallet service: create keys and sign with them by ref. The secret never leaves this
 * package; the service exposes no way to read it.
 */
export class KeyVault extends Context.Service<
  KeyVault,
  {
    readonly generate: VaultCore['generate']
    readonly address: VaultCore['address']
    /** Ed25519 signature over `message` by the key behind `signerKeyRef`. */
    readonly sign: (signerKeyRef: string, message: Uint8Array) => Effect.Effect<Uint8Array, ChainError>
  }
>()('hm/stellar/KeyVault') {
  static readonly layer = Layer.effect(
    KeyVault,
    Effect.gen(function* () {
      const config = yield* ChainConfig
      const core = makeVaultCore(yield* deriveVaultKey(config.vaultKey))
      return KeyVault.of({
        generate: core.generate,
        address: core.address,
        sign: (ref, message) => Effect.map(core.unseal(ref), kp => new Uint8Array(kp.sign(toBuffer(message)))),
      })
    }),
  )
}
