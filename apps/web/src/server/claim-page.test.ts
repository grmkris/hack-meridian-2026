import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { PaymentIntent } from '@hm/protocol'

import { claimPage } from './pages.ts'

const intent = Schema.decodeSync(PaymentIntent)({
  id: 'pi_claim',
  idempotency_key: 'k',
  kind: 'payment',
  wallet_id: 'w_1',
  connection_id: null,
  grant_id: null,
  requester: 'owner',
  reason: null,
  contact_id: null,
  recipient_name: 'Carol',
  recipient_address: 'GCMSW7DAWCWJP42MF553ZRH233LZTXHOTQVQRL5AMYKVLSQYZFHO5ZJG',
  recipient_readiness: 'trustline_required',
  resource: null,
  asset: 'USDC',
  network: 'stellar:pubnet',
  amount: '10000000',
  fee_ceiling_xlm: 1,
  lane: 'owner',
  status: 'approved',
  failure: null,
  expires_at: '2026-10-26T00:00:00.000Z',
  created_at: '2026-10-25T00:00:00.000Z',
  updated_at: '2026-10-25T00:00:00.000Z',
})

/** The JSON the page's script reads as `ctx`. */
const ctxOf = (network: 'Testnet' | 'Mainnet'): unknown => {
  const html = claimPage(
    { nonce: 'n', network, explorerBase: 'https://stellar.expert/explorer/public' },
    { intent, status: 'approved', demo: false, recipientEntryXdr: 'AAAA', receipt: undefined },
  )
  const block = /<script type="application\/json" id="ctx">([\s\S]*?)<\/script>/u.exec(html)?.[1]
  return block === undefined ? undefined : JSON.parse(block)
}

describe('claim page', () => {
  it("asks the browser wallet to sign for the stage's network", () => {
    expect(ctxOf('Mainnet')).toMatchObject({ passphrase: 'Public Global Stellar Network ; September 2015' })
    expect(ctxOf('Testnet')).toMatchObject({ passphrase: 'Test SDF Network ; September 2015' })
  })
})
