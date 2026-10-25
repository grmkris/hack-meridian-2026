import { Effect, Exit, Redacted } from 'effect'
import { describe, expect, it } from 'vitest'

import { ChainError } from '@hm/protocol'
import { Keypair } from '@stellar/stellar-sdk'

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

    const [p, addr, blob = ''] = signerKeyRef.split('.')
    const flipped = `${p}.${addr}.${blob.slice(0, -2)}${blob.endsWith('A') ? 'B' : 'A'}${blob.slice(-1)}`
    expect(Exit.isFailure(await Effect.runPromiseExit(v.unseal(flipped)))).toBe(true)

    const swapped = `${p}.${Keypair.random().publicKey()}.${blob}`
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
