import { Effect, ManagedRuntime, Schema } from 'effect'
import { Base64Url } from 'effect/encoding'
import { afterEach, describe, expect, test } from 'vitest'

import { Chain, fixtureAssertion, makeFixtureChain, toStroops, type FixtureChain } from '@hm/protocol'
import { SoftPasskey } from '@hm/stellar/testing'

import { claimLink, claimLinkById } from './claims.ts'
import { activationOf } from './deposit.ts'
import type { ConnectionProps } from './props.ts'
import { ownerRoute } from './routes.ts'
import { insert, sql, write } from './rows.ts'
import type { AppRuntime } from './runtime.ts'
import { createOwnerWallet, createSession, searchContacts } from './store.ts'
import { testServices } from './test/layers.ts'
import { BOB } from './test/seed.ts'
import { paymentApproveUrl, paymentExecute, paymentPrepare, paymentStatus, type ToolContext } from './tools.ts'

/**
 * Claim link v2 (K2, 2026-10-25 18:05 UTC): "1 USDC for Jan" is an intent without a destination; Jan chooses it when
 * opening the link (a new Nod wallet, an existing one, or a Stellar address), and the payment then takes the normal
 * lanes: inside the allowance the AI app's key pays at once, past it the sender's nod. Nod never holds the money.
 */

const ORIGIN = 'https://wallet.test'
const OWNER = 'own_s'
const WALLET = 'wal_s'
const CONNECTION = 'con_s'
const CAROL = 'GCAROLAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

const runtimes: Array<AppRuntime> = []
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
})

/** A deployed sender with 30 USDC and a 5 USDC allowance for "Claude", on one runtime the routes share. */
const world = async (fixture: FixtureChain = makeFixtureChain({ trustlineMissing: [CAROL] })) => {
  const runtime: AppRuntime = ManagedRuntime.make(testServices(fixture))
  runtimes.push(runtime)
  const passkey = await SoftPasskey.create('wallet.test', ORIGIN)
  const ctx = await runtime.runPromise(
    Effect.gen(function* () {
      const chain = yield* Chain
      const { contractId } = yield* chain.deployAccount({
        pubkey: passkey.publicKey65,
        credentialId: passkey.credentialId,
      })
      yield* chain.fundNewWallet(contractId, toStroops('30'))
      const signer = yield* chain.newSigner
      const prepared = yield* chain.prepareInstallGrant(contractId, signer.publicKey, toStroops('5'), 86_400)
      const installed = yield* chain.installGrant(prepared, fixtureAssertion(prepared.challenge))
      const now = '2026-10-25T12:00:00.000Z'
      yield* write(
        insert('owners', { id: OWNER, created_at: now }),
        insert('wallets', {
          id: WALLET,
          owner_id: OWNER,
          name: 'Kristjan',
          contract_id: contractId,
          passkey_credential_id: Base64Url.encode(passkey.credentialId),
          passkey_public_key: Base64Url.encode(passkey.publicKey65),
          network: 'stellar:testnet',
          deploy_tx: null,
          fund_tx: null,
          created_at: now,
        }),
        insert('connections', {
          id: CONNECTION,
          owner_id: OWNER,
          wallet_id: WALLET,
          oauth_client_id: 'https://claude.ai/oauth/claude-code-client-metadata',
          oauth_client_name: 'Claude',
          oauth_client_domain: 'claude.ai',
          oauth_grant_id: CONNECTION,
          status: 'active',
          created_at: now,
          revoked_at: null,
        }),
        insert('spending_grants', {
          id: 'gr_s',
          connection_id: CONNECTION,
          wallet_id: WALLET,
          signer_public_key: signer.address,
          signer_key_ref: signer.signerKeyRef,
          asset: 'USDC',
          total: toStroops('5'),
          nod_above: toStroops('5'),
          spent: 0n,
          reserved: 0n,
          valid_until: '2099-01-01T00:00:00.000Z',
          valid_until_ledger: installed.validUntilLedger,
          rule_id: installed.ruleId,
          rule_status: 'installed',
          pocket_address: signer.address,
          pocket_balance: 0n,
          first_payment_done: false,
          status: 'active',
          install_tx: installed.tx,
          created_at: now,
        }),
      )
      const props: ConnectionProps = {
        owner_id: OWNER,
        wallet_id: WALLET,
        connection_id: CONNECTION,
        client_id: 'https://claude.ai/oauth/claude-code-client-metadata',
        client_name: 'Claude',
        client_domain: 'claude.ai',
        granted_at: now,
        grant: {
          grant_id: 'gr_s',
          allowance: '5.00',
          valid_until: '2099-01-01T00:00:00.000Z',
          rule_id: installed.ruleId,
          signer_public_key: signer.address,
        },
      }
      return { props, origin: ORIGIN } satisfies ToolContext
    }),
  )
  /** Jan's brand-new deposit-first wallet (what the claim page's "Create my wallet" makes), signed in. */
  const newWallet = () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const plan = yield* Chain.use(chain => chain.planAccount)
        const wallet = yield* createOwnerWallet({
          network: 'stellar:testnet',
          name: 'Jan',
          contractId: plan.contractId,
          credentialId: 'cred-jan',
          publicKey: Base64Url.encode(passkey.publicKey65),
          deployTx: null,
          fundTx: null,
          plan,
        })
        return { wallet, token: yield* createSession(wallet.owner_id) }
      }),
    )
  const route = async (method: 'GET' | 'POST', path: string, body?: unknown, cookie = '') => {
    const request = new Request(`${ORIGIN}${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const response = await ownerRoute(runtime, request, path)
    if (response === undefined) throw new Error(`no route for ${path}`)
    return { status: response.status, text: await response.text() }
  }
  return { runtime, ctx, fixture, newWallet, route }
}

const linkFor = (ctx: ToolContext, amount: string, key: string, name = 'Jan') =>
  paymentPrepare(ctx, { recipient: 'new', recipient_name: name, amount, reason: 'lunch', idempotency_key: key })

const Paid = Schema.Struct({ status: Schema.String, payment_status: Schema.String, tx: Schema.NullOr(Schema.String) })

describe('claim link v2', () => {
  test('recipient "new" stores a link and pays nothing; the same key returns it, another request under it fails', async () => {
    const w = await world()
    const made = await w.runtime.runPromise(linkFor(w.ctx, '1', 'jan-1'))
    expect(made.value.payment_id).toMatch(/^cl_[0-9a-f]{32}$/u)
    expect(made.value).toMatchObject({
      status: 'prepared',
      lane: 'autonomous',
      amount: '1.00',
      recipient: { name: 'Jan', address: '', readiness: 'unverified' },
      claim_url: `${ORIGIN}/claim/${made.value.payment_id}`,
      approval_url: null,
      outcome: 'claim_link',
    })
    expect(made.sentence).toContain(`${ORIGIN}/claim/${made.value.payment_id}`)
    expect(w.fixture.callsOf('delegatedTransfer')).toHaveLength(0)
    const again = await w.runtime.runPromise(linkFor(w.ctx, '1', 'jan-1'))
    expect(again.value.payment_id).toBe(made.value.payment_id)
    const conflict = await w.runtime.runPromise(Effect.flip(linkFor(w.ctx, '2', 'jan-1')))
    expect(conflict.message).toContain('different request')
    const nameless = await w.runtime.runPromise(
      Effect.flip(paymentPrepare(w.ctx, { recipient: 'new', amount: '1', idempotency_key: 'x' })),
    )
    expect(nameless.message).toContain('recipient_name')
    const status = await w.runtime.runPromise(paymentStatus(w.ctx, made.value.payment_id))
    expect(status.sentence).toContain('has not opened the claim link yet')
  })

  test('Jan creates a Nod wallet: inside the allowance the AI app pays at once, the wallet deploys, Jan is a contact', async () => {
    const w = await world()
    const made = await w.runtime.runPromise(linkFor(w.ctx, '1', 'jan-2'))
    const page = await w.route('GET', `/claim/${made.value.payment_id}`)
    expect(page.status).toBe(200)
    for (const id of ['claim-new-wallet', 'claim-signin', 'claim-address']) expect(page.text).toContain(id)
    const jan = await w.newWallet()
    const posted = await w.route(
      'POST',
      `/claim/${made.value.payment_id}/destination`,
      { kind: 'wallet', new: true },
      `hm_owner=${jan.token}`,
    )
    expect(posted.status).toBe(200)
    const paid = Schema.decodeUnknownSync(Paid)(JSON.parse(posted.text))
    expect(paid).toMatchObject({ status: 'claimed', payment_status: 'confirmed' })
    expect(paid.tx).not.toBeNull()
    expect(w.fixture.balanceOf(jan.wallet.contract_id)).toBe(toStroops('1'))
    expect(w.fixture.callsOf('delegatedTransfer')[0]?.args[3]).toBe(jan.wallet.contract_id)
    expect((await w.runtime.runPromise(activationOf(jan.wallet.id)))?.status).toBe('active')
    expect(w.fixture.callsOf('deployPlannedAccount')).toHaveLength(1)
    const status = await w.runtime.runPromise(paymentStatus(w.ctx, made.value.payment_id))
    expect(status.value.status).toBe('confirmed')
    expect(status.value.receipt?.tx_hash).toBe(paid.tx)
    expect(status.value.grant_remaining).toBe('4.00')
    const contacts = await w.runtime.runPromise(searchContacts(OWNER, jan.wallet.contract_id))
    expect(contacts.map(contact => contact.display_name)).toEqual(['Jan'])
    const after = await w.route('GET', `/claim/${made.value.payment_id}`)
    expect(after.text).toContain('claim-link-paid')
    // The same choice again pays nothing more; another destination is refused.
    expect(
      (
        await w.route(
          'POST',
          `/claim/${made.value.payment_id}/destination`,
          { kind: 'wallet' },
          `hm_owner=${jan.token}`,
        )
      ).status,
    ).toBe(200)
    expect(
      (await w.route('POST', `/claim/${made.value.payment_id}/destination`, { kind: 'address', address: BOB })).status,
    ).toBe(409)
    expect(w.fixture.callsOf('delegatedTransfer')).toHaveLength(1)
  })

  test('past what is left of the allowance: claimed to an address, the payment waits for the sender’s nod', async () => {
    const w = await world()
    const made = await w.runtime.runPromise(linkFor(w.ctx, '7', 'jan-3'))
    expect(made.value.lane).toBe('owner')
    expect(made.sentence).toContain("after the user's nod")
    const result = await w.runtime.runPromise(claimLink(made.value.payment_id, { kind: 'address', address: BOB }))
    expect(result.intent).toMatchObject({
      status: 'awaiting_approval',
      lane: 'owner',
      approval_reason: 'over_allowance',
    })
    const status = await w.runtime.runPromise(paymentStatus(w.ctx, made.value.payment_id))
    expect(status.value.approval_url).toBe(`${ORIGIN}/approve/${result.intent.id}`)
    expect(status.sentence).toContain(status.value.approval_url ?? 'missing')
    const url = await w.runtime.runPromise(paymentApproveUrl(w.ctx, made.value.payment_id))
    expect(url.value.approval_url).toBe(status.value.approval_url)
    const executed = await w.runtime.runPromise(paymentExecute(w.ctx, made.value.payment_id))
    expect(executed.value.status).toBe('awaiting_approval')
    expect(w.fixture.callsOf('delegatedTransfer')).toHaveLength(0)
    const page = await w.route('GET', `/claim/${made.value.payment_id}`)
    expect(page.text).toContain('Waiting for the sender to approve')
  })

  test('an address without a USDC trustline takes today’s CAP-73 path: owner lane, then the claim page', async () => {
    const w = await world()
    const made = await w.runtime.runPromise(linkFor(w.ctx, '1', 'carol-1', 'Carol'))
    const result = await w.runtime.runPromise(claimLink(made.value.payment_id, { kind: 'address', address: CAROL }))
    expect(result.intent).toMatchObject({
      status: 'awaiting_approval',
      recipient_readiness: 'trustline_required',
      approval_reason: 'recipient_not_ready',
    })
    const status = await w.runtime.runPromise(paymentStatus(w.ctx, made.value.payment_id))
    expect(status.value.claim_url).toBe(`${ORIGIN}/claim/${result.intent.id}`)
  })

  test('a missing account or the sender’s own wallet is refused; an expired link pays nothing', async () => {
    const fixture = makeFixtureChain({ accountsMissing: [CAROL] })
    const w = await world(fixture)
    const made = await w.runtime.runPromise(linkFor(w.ctx, '1', 'jan-4'))
    const missing = await w.route('POST', `/claim/${made.value.payment_id}/destination`, {
      kind: 'address',
      address: CAROL,
    })
    expect(missing.status).toBe(400)
    expect((await w.runtime.runPromise(claimLinkById(made.value.payment_id)))?.status).toBe('open')
    await w.runtime.runPromise(
      write(sql("UPDATE claim_links SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", made.value.payment_id)),
    )
    expect(
      (await w.route('POST', `/claim/${made.value.payment_id}/destination`, { kind: 'address', address: BOB })).status,
    ).toBe(410)
    expect((await w.route('GET', `/claim/${made.value.payment_id}`)).text).toContain('This link expired')
    const status = await w.runtime.runPromise(paymentStatus(w.ctx, made.value.payment_id))
    expect(status.value.status).toBe('expired')
    expect(fixture.callsOf('delegatedTransfer')).toHaveLength(0)
    // Choosing "my Nod wallet" without a session asks for the passkey first.
    expect((await w.route('POST', `/claim/${made.value.payment_id}/destination`, { kind: 'wallet' })).status).toBe(401)
  })
})
