import { Effect, Layer, ManagedRuntime, Schema } from 'effect'
import { Base64Url } from 'effect/encoding'
import { afterEach, describe, expect, test } from 'vitest'

import { DepositAddressView, SweepReply } from '@hm/api'
import { type FixtureChain, makeFixtureChain } from '@hm/protocol'
import { SoftPasskey } from '@hm/stellar/testing'

import { makeApiHandler } from './app.ts'
import { activateWallet, activationOf } from './deposit.ts'
import { walletById } from './store.ts'
import { testNetwork, testServices } from './test/layers.ts'

/**
 * Deposit-first signup (K2, 2026-10-25 18:00 UTC): the passkey is created and the deposit address shown at once; the
 * smart account deploys when the first USDC arrives (or before an AI app's first allowance). Until then the relayer
 * has paid for nothing but the deposit address's sponsored reserves: no deploy, no welcome USDC.
 */

const USDC = 10_000_000n
const ORIGIN = 'https://wallet.test'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(dispose => dispose()))
})

const Created = Schema.Struct({ wallet: Schema.Struct({ id: Schema.String, contract_id: Schema.String }) })
const OverviewOf = Schema.Struct({
  wallet: Schema.Struct({
    contract_id: Schema.String,
    deploy_tx: Schema.optionalKey(Schema.NullOr(Schema.String)),
    fund_tx: Schema.optionalKey(Schema.NullOr(Schema.String)),
    deposit_address: Schema.optionalKey(Schema.NullOr(Schema.String)),
    account_status: Schema.optionalKey(Schema.Literals(['awaiting_deposit', 'active'])),
  }),
  balances: Schema.Struct({ usdc: Schema.String }),
})

/** The SPA's signup against fake services: options, a software passkey over the challenge, POST /api/wallets. */
const signup = async (fixture: FixtureChain, body: Record<string, unknown> = {}, network = testNetwork) => {
  const runtime = ManagedRuntime.make(testServices(fixture, undefined, network))
  const api = makeApiHandler(Layer.succeedContext(await runtime.context()))
  cleanups.push(
    () => api.dispose(),
    () => runtime.dispose(),
  )
  const post = (path: string, json: unknown, cookie = '') =>
    api.handler(
      new Request(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(json),
      }),
    )
  const options = Schema.decodeUnknownSync(Schema.Struct({ challenge: Schema.String }))(
    await (await post('/api/wallets/options', { name: 'Jan' })).json(),
  )
  const passkey = await SoftPasskey.create('wallet.test', ORIGIN)
  const clientData = { type: 'webauthn.create', challenge: options.challenge, origin: ORIGIN, crossOrigin: false }
  const response = await post('/api/wallets', {
    name: 'Jan',
    credential_id: Base64Url.encode(passkey.credentialId),
    public_key: Base64Url.encode(passkey.publicKey65),
    client_data_json: Base64Url.encode(new TextEncoder().encode(JSON.stringify(clientData))),
    attestation_object: '',
    ...body,
  })
  expect(response.status).toBe(200)
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  const created = Schema.decodeUnknownSync(Created)(await response.json())
  const call = async (method: 'GET' | 'POST', path: string) => {
    const reply = await api.handler(new Request(`${ORIGIN}${path}`, { method, headers: { cookie } }))
    return { status: reply.status, body: (await reply.json()) as unknown }
  }
  const overview = async () => Schema.decodeUnknownSync(OverviewOf)((await call('GET', '/api/overview')).body)
  return { runtime, call, overview, wallet: created.wallet }
}

describe('deposit-first signup', () => {
  test('testnet without asking: deployed and funded at once, as the judge path expects', async () => {
    const fixture = makeFixtureChain()
    const s = await signup(fixture)
    expect(fixture.callsOf('deployAccount')).toHaveLength(1)
    expect(fixture.callsOf('fundNewWallet')).toHaveLength(1)
    expect(fixture.callsOf('planAccount')).toHaveLength(0)
    const overview = await s.overview()
    expect(overview.wallet.account_status).toBe('active')
    expect(overview.balances.usdc).toBe(String(10n * USDC))
  })

  test('asked for: nothing deployed or funded; the deposit address at once; the first USDC deploys and lands', async () => {
    const fixture = makeFixtureChain()
    const s = await signup(fixture, { deposit_first: true })
    expect(fixture.callsOf('planAccount')).toHaveLength(1)
    expect(fixture.callsOf('deployAccount')).toHaveLength(0)
    expect(fixture.callsOf('fundNewWallet')).toHaveLength(0)
    expect(fixture.callsOf('deployPlannedAccount')).toHaveLength(0)

    const before = await s.overview()
    expect(before.wallet).toMatchObject({ account_status: 'awaiting_deposit', deploy_tx: null, fund_tx: null })
    expect(before.balances.usdc).toBe('0')

    const shown = await s.call('GET', '/api/wallet/deposit-address')
    expect(shown.status).toBe(200)
    const deposit = Schema.decodeUnknownSync(DepositAddressView)(shown.body)
    expect(deposit.recipient).toBe(s.wallet.contract_id)
    // Still nothing deployed: the relayer has paid the deposit address's sponsored reserves and nothing else.
    expect(fixture.callsOf('deployPlannedAccount')).toHaveLength(0)

    fixture.pay(deposit.address, 3n * USDC)
    const swept = Schema.decodeUnknownSync(SweepReply)((await s.call('POST', '/api/wallet/sweep')).body)
    expect(swept.swept).toBe(String(3n * USDC))
    expect(fixture.callsOf('deployPlannedAccount')).toHaveLength(1)

    const after = await s.overview()
    expect(after.wallet.account_status).toBe('active')
    expect(after.wallet.deploy_tx).toMatch(/^[0-9a-f]{64}$/u)
    expect(after.balances.usdc).toBe(String(3n * USDC))
    // Later deposits only sweep; the account is never deployed twice.
    fixture.pay(deposit.address, USDC)
    await s.call('POST', '/api/wallet/sweep')
    await s.overview()
    expect(fixture.callsOf('deployPlannedAccount')).toHaveLength(1)
  })

  test('mainnet (no welcome USDC) is deposit-first by default; USDC sent straight to the planned C deploys it too', async () => {
    const fixture = makeFixtureChain()
    const s = await signup(
      fixture,
      {},
      { ...testNetwork, name: 'pubnet', caip: 'stellar:pubnet', welcomeFunding: false },
    )
    expect(fixture.callsOf('deployAccount')).toHaveLength(0)
    expect((await s.overview()).wallet.account_status).toBe('awaiting_deposit')
    fixture.pay(s.wallet.contract_id, 2n * USDC)
    const after = await s.overview()
    expect(after.wallet.account_status).toBe('active')
    expect(after.balances.usdc).toBe(String(2n * USDC))
    expect(fixture.callsOf('deployPlannedAccount')).toHaveLength(1)
  })

  test('a network without a deposit router keeps deploying at signup', async () => {
    const fixture = makeFixtureChain()
    const services = { ...fixture, chain: { ...fixture.chain, depositsAvailable: false } }
    await signup(services, {}, { ...testNetwork, welcomeFunding: false })
    expect(fixture.callsOf('deployAccount')).toHaveLength(1)
    expect(fixture.callsOf('planAccount')).toHaveLength(0)
  })

  test('activation runs once: an allowance before any USDC deploys it, a second call submits nothing', async () => {
    const fixture = makeFixtureChain()
    const s = await signup(fixture, { deposit_first: true })
    // The allowance path (oauth.ts prepareGrant) runs activateWallet(wallet, 'allowance') before the rule install.
    const result = await s.runtime.runPromise(
      Effect.gen(function* () {
        const wallet = yield* walletById(s.wallet.id)
        if (wallet === undefined) return yield* Effect.die('no wallet')
        const first = yield* activateWallet(wallet, 'allowance')
        const second = yield* activateWallet(wallet, 'allowance')
        return { first, second, row: yield* activationOf(wallet.id) }
      }),
    )
    expect(result.first.activated).toBe(true)
    expect(result.second).toEqual({ tx: null, activated: false })
    expect(result.row).toMatchObject({ status: 'active', trigger: 'allowance', deploy_tx: result.first.tx })
    expect(fixture.callsOf('deployPlannedAccount')).toHaveLength(1)
    expect((await s.overview()).wallet.account_status).toBe('active')
  })

  test('a failed deploy leaves the wallet waiting; the next attempt deploys', async () => {
    const fixture = makeFixtureChain()
    const s = await signup(fixture, { deposit_first: true })
    fixture.pay(s.wallet.contract_id, USDC)
    fixture.failNext('deployPlannedAccount', 'submit_failed')
    expect((await s.overview()).wallet.account_status).toBe('awaiting_deposit')
    expect((await s.runtime.runPromise(activationOf(s.wallet.id)))?.status).toBe('failed')
    expect((await s.overview()).wallet.account_status).toBe('active')
    expect(fixture.callsOf('deployPlannedAccount')).toHaveLength(2)
  })
})
