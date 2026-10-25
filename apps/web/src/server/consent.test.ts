import { Effect, ManagedRuntime, Schema } from 'effect'
import { describe, expect, test, vi } from 'vitest'

import { toStroops, type Wallet } from '@hm/protocol'

import { nodLineOf, prepareGrant } from './oauth.ts'
import { consentGrantPage } from './pages.ts'
import { query, sql } from './rows.ts'
import type { AppRuntime } from './runtime.ts'
import { connectionById, createConnection, createSession, grantOfConnection, pendingGrant } from './store.ts'
import { testServices } from './test/layers.ts'
import { CONTRACT_ID, OWNER_ID, WALLET_ID, seedWallet } from './test/seed.ts'
import { apiGrantView, toolGrantView } from './views.ts'

// oauth.ts loads the OAuth provider, which imports `cloudflare:workers`; prepareGrant needs none of it.
vi.mock('@cloudflare/workers-oauth-provider', () => ({
  AuthorizationError: class extends Error {},
  CimdFetchError: class extends Error {},
  OAuthProvider: class extends Object {},
}))

/**
 * W1, the nod line on the consent page (docs/SPEC.md, decisions 2026-10-25 17:10 UTC): a second field next to the
 * allowance, default 1.00, validated between 0.01 and the allowance, stored with the pending grant and then the grant.
 */

const WALLET: Wallet = {
  id: WALLET_ID,
  owner_id: OWNER_ID,
  name: 'Personal',
  contract_id: CONTRACT_ID,
  passkey_credential_id: 'cred',
  passkey_public_key: 'pub',
  network: 'stellar:testnet',
  created_at: '2026-10-25T12:00:00.000Z',
}

const Reply = Schema.fromJsonString(
  Schema.Struct({ pending_id: Schema.optionalKey(Schema.String), error: Schema.optionalKey(Schema.String) }),
)

describe('the nod line on the consent page', () => {
  test('the grant ceremony shows "Ask me for a nod above … USDC" next to the allowance, default 1.00, and posts it', () => {
    const page = consentGrantPage(
      { nonce: 'n0nce', network: 'Testnet', explorerBase: 'https://stellar.expert/explorer/testnet' },
      {
        handle: 'h1',
        clientName: 'Claude',
        clientDomain: 'claude.ai',
        redirectHost: 'claude.ai',
        redirectIsLoopback: false,
      },
      WALLET,
      toStroops('30'),
      Date.parse('2026-10-25T17:00:00Z'),
      'wallet.test',
    )
    expect(page).toContain('data-testid="allowance" value="5.00"')
    expect(page).toContain('<label>Ask me for a nod above <input name="nod_above" data-testid="nod-above" value="1.00"')
    expect(page).toContain('this amount or more, or anything past the allowance, needs your nod')
    expect(page).toContain('nod_above_usdc:f.nod_above.value')
    expect(page).toContain('At most the allowance')
  })

  test('nodLineOf: default 1.00 (or the allowance when smaller), at least 0.01, at most the allowance', () => {
    expect(nodLineOf(undefined, toStroops('5'))).toBe(toStroops('1'))
    expect(nodLineOf('', toStroops('0.5'))).toBe(toStroops('0.5'))
    expect(nodLineOf('0.01', toStroops('5'))).toBe(toStroops('0.01'))
    expect(nodLineOf('5', toStroops('5'))).toBe(toStroops('5'))
    expect(nodLineOf('5.01', toStroops('5'))).toBeUndefined()
    expect(nodLineOf('0', toStroops('5'))).toBeUndefined()
    expect(nodLineOf('0.001', toStroops('5'))).toBeUndefined()
    expect(nodLineOf('one', toStroops('5'))).toBeUndefined()
  })

  test('POST /oauth/grant/prepare refuses a line above the allowance and stores the line with the pending grant and the grant', async () => {
    const runtime: AppRuntime = ManagedRuntime.make(testServices())
    try {
      await runtime.runPromise(seedWallet())
      const token = await runtime.runPromise(createSession(OWNER_ID))
      const prepare = async (fields: Record<string, string>) => {
        const response = await prepareGrant(
          runtime,
          new Request('https://wallet.test/oauth/grant/prepare', {
            method: 'POST',
            headers: { cookie: `hm_owner=${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ handle: 'h1', lifetime_seconds: 3600, ...fields }),
          }),
        )
        return { status: response.status, reply: Schema.decodeUnknownSync(Reply)(await response.text()) }
      }
      const lineOf = async (id: string | undefined) =>
        (await runtime.runPromise(pendingGrant(id ?? '', OWNER_ID)))?.nod_above

      const above = await prepare({ allowance: '5', nod_above_usdc: '5.01' })
      expect(above.status).toBe(400)
      expect(above.reply.error).toContain('up to the allowance (5.00)')
      expect((await prepare({ allowance: '5', nod_above_usdc: '0' })).status).toBe(400)

      const two = await prepare({ allowance: '5', nod_above_usdc: '2' })
      expect(two.status).toBe(200)
      expect(await lineOf(two.reply.pending_id)).toBe(toStroops('2'))
      expect(await lineOf((await prepare({ allowance: '5', nod_above_usdc: '5' })).reply.pending_id)).toBe(
        toStroops('5'),
      )
      expect(await lineOf((await prepare({ allowance: '5' })).reply.pending_id)).toBe(toStroops('1'))
      expect(await lineOf((await prepare({ allowance: '0.50' })).reply.pending_id)).toBe(toStroops('0.5'))

      const pending = await runtime.runPromise(pendingGrant(two.reply.pending_id ?? '', OWNER_ID))
      if (pending === undefined) throw new Error('the pending grant vanished')
      await runtime.runPromise(
        createConnection({
          connectionId: 'con_w1',
          grantId: 'gr_w1',
          ownerId: OWNER_ID,
          walletId: WALLET_ID,
          clientId: 'https://claude.ai/oauth/claude-code-client-metadata',
          clientName: 'Claude',
          clientDomain: 'claude.ai',
          oauthGrantId: 'con_w1',
          pending,
          ruleId: 7,
          validUntilLedger: 9_999_999,
          installTx: 'tx-install-w1',
          pocketAddress: null,
        }),
      )
      const grant = await runtime.runPromise(grantOfConnection('con_w1'))
      const connection = await runtime.runPromise(connectionById('con_w1'))
      if (grant === undefined || connection === undefined) throw new Error('the grant was not stored')
      expect(grant.nod_above).toBe(toStroops('2'))
      expect(toolGrantView(grant, Date.parse('2026-10-25T17:00:00Z')).nod_above_usdc).toBe('2.00')
      expect(apiGrantView(connection, grant).nod_above_usdc).toBe('2.00')
    } finally {
      await runtime.dispose()
    }
  })

  test('migration 0006: allowances installed before W1 read the default line of 1.00 USDC', async () => {
    const runtime: AppRuntime = ManagedRuntime.make(testServices())
    try {
      const columns = await runtime.runPromise(
        query(sql('PRAGMA table_info(spending_grants)'), row =>
          Effect.succeed({ name: String(row['name']), fallback: row['dflt_value'] }),
        ),
      )
      expect(columns.find(column => column.name === 'nod_above')?.fallback).toBe("'10000000'")
    } finally {
      await runtime.dispose()
    }
  })
})
