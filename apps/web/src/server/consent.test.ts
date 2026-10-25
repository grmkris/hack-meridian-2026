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
 * The consent page after Kristjan's 18:20 UTC decision: one number, the allowance. The agent pays on its own until it
 * has spent it; anything past it needs the passkey, with no upper limit. The W1 nod line is gone from the page and the
 * lane rule; the 0006 column stays (additive) and carries the allowance.
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

describe('one number on the consent page: the allowance', () => {
  test('the grant ceremony asks for the allowance and the expiry only, and says what happens past it', () => {
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
    expect(page).not.toContain('data-testid="nod-above"')
    expect(page).not.toContain('nod_above_usdc')
    expect(page).toContain(
      '<strong>Claude</strong> may spend up to <span class="nb"><input class="blank" name="allowance"',
    )
    expect(page).toContain('USDC</span> on its own until <select class="blank" name="lifetime"')
    expect(page).toContain('Larger payments need your passkey, every time.')
    expect(page).toContain('for any amount')
    expect(page).not.toContain('consent-empty-wallet')
  })

  test('an empty wallet is told to add money before the AI app can pay', () => {
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
      0n,
      Date.parse('2026-10-25T17:00:00Z'),
      'wallet.test',
    )
    expect(page).toContain(
      'Your wallet holds 0 USDC; <a href="/" target="_blank" rel="noopener">add money</a> so Claude can pay.',
    )
  })

  test('nodLineOf stores the allowance, whatever an older client sends', () => {
    expect(nodLineOf(undefined, toStroops('5'))).toBe(toStroops('5'))
    expect(nodLineOf('1.00', toStroops('5'))).toBe(toStroops('5'))
    expect(nodLineOf('one', toStroops('0.5'))).toBe(toStroops('0.5'))
  })

  test('POST /oauth/grant/prepare stores the allowance as the line, and the views show no line', async () => {
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
      const ignored = await prepare({ allowance: '5', nod_above_usdc: '1' })
      expect(ignored.status).toBe(200)
      const pending = await runtime.runPromise(pendingGrant(ignored.reply.pending_id ?? '', OWNER_ID))
      if (pending === undefined) throw new Error('the pending grant vanished')
      expect(pending.nod_above).toBe(toStroops('5'))
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
      expect('nod_above_usdc' in toolGrantView(grant, Date.parse('2026-10-25T17:00:00Z'))).toBe(false)
      expect('nod_above_usdc' in apiGrantView(connection, grant)).toBe(false)
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
