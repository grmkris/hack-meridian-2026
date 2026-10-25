import { describe, expect, it } from 'vitest'

import { Keypair } from '@stellar/stellar-sdk'

import { stellarToml } from './stellar-toml.ts'

describe('GET /.well-known/stellar.toml', () => {
  it('serves the stage SEP-1 file as text/plain to any origin, listing the relayers and the treasury by public key', async () => {
    const relayers = [Keypair.random(), Keypair.random()]
    const treasury = Keypair.random()
    const env = {
      CHAIN: 'testnet',
      STELLAR_NETWORK: 'testnet',
      RELAYER_SECRET: relayers.map(key => key.secret()).join(','),
      TREASURY_SECRET: treasury.secret(),
      VAULT_KEY: 'v'.repeat(64),
      ORIGIN: 'https://testnet.trynod.si',
      ASSETS: {},
    }
    const response = await stellarToml(new Request('https://testnet.trynod.si/.well-known/stellar.toml'), env)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('cache-control')).toBe('public, max-age=300')
    const body = await response.text()
    const accounts = [...relayers, treasury].map(key => key.publicKey())
    expect(body).toContain(`ACCOUNTS=[${accounts.map(account => `"${account}"`).join(', ')}]`)
    expect(body).toContain('NETWORK_PASSPHRASE="Test SDF Network ; September 2015"')
    expect(body).toContain('ORG_URL="https://testnet.trynod.si"')
    for (const key of [...relayers, treasury]) expect(body).not.toContain(key.secret())
  })
})
