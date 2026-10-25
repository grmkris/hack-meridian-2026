import { Layer, ManagedRuntime, Option } from 'effect'
import { afterEach, describe, expect, test } from 'vitest'

import { makeFixtureChain } from '@hm/protocol'

import type { NetworkShape } from './network.ts'
import type { ConnectionProps } from './props.ts'
import { claimNotice, DEMO_SIGNED, DEMO_SIGNS, ownerRoute } from './routes.ts'
import type { AppRuntime } from './runtime.ts'
import { testNetwork, testServices } from './test/layers.ts'
import { OWNER_ID, SIGNER, WALLET_ID, seedWallet } from './test/seed.ts'
import { paymentPrepare, type ToolContext } from './tools.ts'
import { WalletSettings } from './wallet-settings.ts'

/**
 * The claim page says plainly when Nod's own demo key signs for the recipient (mainnet's Carol with DEMO_CLAIM_SIGNER,
 * testnet's demo contact): before the approval, and on the receipt after; anyone else's claim page never says it (K5).
 */

const ORIGIN = 'https://wallet.test'
const CAROL = 'GCAROLAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const STRANGER = 'GSTRANGERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const PUBNET: NetworkShape = { ...testNetwork, name: 'pubnet', caip: 'stellar:pubnet', label: 'Mainnet' }

const runtimes: Array<AppRuntime> = []
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
})

const world = async (demoClaimSigner: boolean) => {
  const settings = Layer.succeed(WalletSettings, {
    stage: 'test',
    chain: 'fixture',
    rpId: Option.some('wallet.test'),
    origin: Option.some(ORIGIN),
    welcomeUsdc: 0n,
    demoContacts: [{ name: 'Carol', address: CAROL, trustline_required: true }],
    demoClaimSigner,
  })
  const fixture = makeFixtureChain({ trustlineMissing: [CAROL, STRANGER] })
  const runtime: AppRuntime = ManagedRuntime.make(Layer.merge(testServices(fixture, undefined, PUBNET), settings))
  runtimes.push(runtime)
  await runtime.runPromise(seedWallet())
  const props: ConnectionProps = {
    owner_id: OWNER_ID,
    wallet_id: WALLET_ID,
    connection_id: 'con_a',
    client_id: 'https://claude.ai/oauth/claude-code-client-metadata',
    client_name: 'Claude Code',
    client_domain: 'claude.ai',
    granted_at: '2026-10-25T12:00:00.000Z',
    grant: {
      grant_id: 'gr_a',
      allowance: '5.00',
      valid_until: '2099-01-01T00:00:00.000Z',
      rule_id: 1,
      signer_public_key: SIGNER,
    },
  }
  const ctx: ToolContext = { props, origin: ORIGIN }
  const claimPageOf = async (recipient: string, key: string) => {
    const prepared = await runtime.runPromise(paymentPrepare(ctx, { recipient, amount: '1', idempotency_key: key }))
    expect(prepared.value.status).toBe('awaiting_approval')
    const path = `/claim/${prepared.value.payment_id}`
    const response = await ownerRoute(runtime, new Request(`${ORIGIN}${path}`), path)
    if (response === undefined) throw new Error(`no route for ${path}`)
    expect(response.status).toBe(200)
    return response.text()
  }
  return { claimPageOf }
}

describe("the claim page names Nod's demo signer", () => {
  test('mainnet with DEMO_CLAIM_SIGNER: the demo contact’s page says Nod’s key signs, a stranger’s does not', async () => {
    const w = await world(true)
    const carol = await w.claimPageOf(CAROL, 'carol-1')
    expect(carol).toContain('approves the payment.')
    expect(carol).toContain('demo contact: Nod&#39;s demo key signs the acceptance on the server')
    const stranger = await w.claimPageOf(STRANGER, 'stranger-1')
    expect(stranger).not.toContain('demo key')
  })

  test('mainnet without DEMO_CLAIM_SIGNER: no demo line, the recipient signs', async () => {
    const w = await world(false)
    expect(await w.claimPageOf(CAROL, 'carol-2')).not.toContain('demo key')
  })

  test('the notice: before approval and after the receipt; the accept button carries its own line', () => {
    const waiting = 'This opens once the wallet owner approves the payment.'
    expect(claimNotice({ waiting, demo: true, accepted: false, acceptable: false })).toBe(`${waiting} ${DEMO_SIGNS}`)
    expect(claimNotice({ waiting: undefined, demo: true, accepted: true, acceptable: false })).toBe(DEMO_SIGNED)
    expect(claimNotice({ waiting: undefined, demo: true, accepted: false, acceptable: true })).toBeUndefined()
    expect(claimNotice({ waiting, demo: false, accepted: false, acceptable: false })).toBe(waiting)
    expect(claimNotice({ waiting: undefined, demo: false, accepted: true, acceptable: false })).toBeUndefined()
  })
})
