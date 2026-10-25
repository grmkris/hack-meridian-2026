import { Effect, ManagedRuntime } from 'effect'
import { Base64Url } from 'effect/encoding'
import { afterEach } from 'vitest'

import { Chain, fixtureAssertion, makeFixtureChain, toStroops, type FixtureChain } from '@hm/protocol'
import { SoftPasskey } from '@hm/stellar/testing'

import type { ConnectionProps } from '../props.ts'
import { ownerRoute } from '../routes.ts'
import { insert, write } from '../rows.ts'
import type { AppRuntime } from '../runtime.ts'
import { createOwnerWallet, createSession } from '../store.ts'
import type { ToolContext } from '../tools.ts'
import { testServices } from './layers.ts'

/**
 * A sender for the claim-link and contact-tool tests: a deployed fixture wallet with 30 USDC, a 5 USDC allowance for
 * "Claude", a signed-in owner session, the owner routes on the same runtime, and Jan's deposit-first wallet on demand.
 */

export const ORIGIN = 'https://wallet.test'
export const OWNER = 'own_s'
export const WALLET = 'wal_s'
export const CONNECTION = 'con_5e4de4aa5e4de4aa5e4de4aa5e4de4aa'
export const CAROL = 'GCAROLAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

const runtimes: Array<AppRuntime> = []
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
})

/** A deployed sender with 30 USDC and a 5 USDC allowance for "Claude", on one runtime the routes share. */
export const senderWorld = async (fixture: FixtureChain = makeFixtureChain({ trustlineMissing: [CAROL] })) => {
  const runtime: AppRuntime = ManagedRuntime.make(testServices(fixture))
  runtimes.push(runtime)
  const passkey = await SoftPasskey.create('wallet.test', ORIGIN)
  const { ctx, contractId } = await runtime.runPromise(
    Effect.gen(function* () {
      const chain = yield* Chain
      const { contractId: deployed } = yield* chain.deployAccount({
        pubkey: passkey.publicKey65,
        credentialId: passkey.credentialId,
      })
      yield* chain.fundNewWallet(deployed, toStroops('30'))
      const signer = yield* chain.newSigner
      const prepared = yield* chain.prepareInstallGrant(deployed, signer.publicKey, toStroops('5'), 86_400)
      const installed = yield* chain.installGrant(prepared, fixtureAssertion(prepared.challenge))
      const now = '2026-10-25T12:00:00.000Z'
      yield* write(
        insert('owners', { id: OWNER, created_at: now }),
        insert('wallets', {
          id: WALLET,
          owner_id: OWNER,
          name: 'Kristjan',
          contract_id: deployed,
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
      return { ctx: { props, origin: ORIGIN } satisfies ToolContext, contractId: deployed }
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
    const response = await ownerRoute(runtime, request, new URL(request.url).pathname)
    if (response === undefined) throw new Error(`no route for ${path}`)
    return { status: response.status, text: await response.text() }
  }
  const token = await runtime.runPromise(createSession(OWNER))
  return { runtime, ctx, contractId, fixture, passkey, token, newWallet, route }
}
