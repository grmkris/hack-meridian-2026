import { Effect, Exit, Redacted } from 'effect'
import { describe, expect, it } from 'vitest'

import { ChainError } from '@hm/protocol'
import { Keypair } from '@stellar/stellar-sdk'

import { fromBase64Url, toBase64Url } from '../src/bytes.ts'
import { deriveVaultKey, makeVaultCore } from '../src/vault.ts'

const vault = (secret: string) => Effect.runPromise(Effect.map(deriveVaultKey(Redacted.make(secret)), makeVaultCore))

describe('key vault (AES-256-GCM under HKDF(VAULT_KEY))', () => {
  it('generates a key ref that unseals to the same address and signs', async () => {
    const v = await vault('test-vault-key-0123456789abcdef')
    const { signerKeyRef, address, publicKey } = await Effect.runPromise(v.generate)
    expect(signerKeyRef.startsWith(`hmk1.${address}.`)).toBe(true)
    expect(publicKey).toHaveLength(32)
    const kp = await Effect.runPromise(v.unseal(signerKeyRef))
    expect(kp.publicKey()).toBe(address)
    expect(signerKeyRef).not.toContain(kp.secret())
    expect(await Effect.runPromise(v.address(signerKeyRef))).toBe(address)
  })

  it('refuses another vault key, a tampered blob and a swapped address', async () => {
    const v = await vault('test-vault-key-0123456789abcdef')
    const other = await vault('another-vault-key-0123456789abcd')
    const { signerKeyRef } = await Effect.runPromise(v.generate)
    const wrongKey = await Effect.runPromiseExit(other.unseal(signerKeyRef))
    expect(Exit.isFailure(wrongKey)).toBe(true)

    // Flip one bit of the last byte (inside the GCM tag) on the decoded bytes, so the tamper always changes the ref.
    // (Rewriting a base64url character left it unchanged whenever that character already had the new value, ~1/64.)
    const [p, addr, blob = ''] = signerKeyRef.split('.')
    const bytes = fromBase64Url(blob)
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0x01
    const flipped = `${p}.${addr}.${toBase64Url(bytes)}`
    expect(flipped).not.toBe(signerKeyRef)
    expect(Exit.isFailure(await Effect.runPromiseExit(v.unseal(flipped)))).toBe(true)

    // A fixed other address (never the generated one), so the additional-data check is what fails.
    const other32 = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey()
    expect(other32).not.toBe(addr)
    const swapped = `${p}.${other32}.${blob}`
    const exit = await Effect.runPromiseExit(v.unseal(swapped))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(String(Exit.isFailure(exit) ? exit.cause : '')).toContain('decrypt')
    expect(Exit.isFailure(await Effect.runPromiseExit(v.unseal('nonsense')))).toBe(true)
  })

  it('refuses a short VAULT_KEY', async () => {
    const exit = await Effect.runPromiseExit(deriveVaultKey(Redacted.make('short')))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(ChainError).toBeDefined()
  })
})
