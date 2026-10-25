import { Effect, Layer, ManagedRuntime, Schema } from 'effect'
import { afterEach, describe, expect, test } from 'vitest'

import { DepositAddressView, SweepReply } from '@hm/api'
import { Chain, ChainError, type FixtureChain, makeFixtureChain } from '@hm/protocol'

import { makeApiHandler } from './app.ts'
import { depositOfWallet, depositWatchTick } from './deposit.ts'
import { sql, write } from './rows.ts'
import type { AppRuntime } from './runtime.ts'
import { createSession } from './store.ts'
import { testServices } from './test/layers.ts'
import { CONTRACT_ID, OWNER_ID, WALLET_ID, seedWallet } from './test/seed.ts'

/**
 * Deposit addresses (docs/spikes/s8-deposit.md): GET creates the wallet's G once, the overview names it, POST sweeps
 * what arrived into the wallet, and the Durable Object's tick sweeps while the watch lasts. The chain is the fixture.
 */

const USDC = 10_000_000n
const ORIGIN = 'https://wallet.test'

const runtimes: Array<AppRuntime> = []
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
})

/** One database and fixture behind both the API handler and direct store calls. */
const world = async (chain?: (fixture: FixtureChain) => Chain['Service']) => {
  const fixture = makeFixtureChain()
  const services =
    chain === undefined
      ? testServices(fixture)
      : Layer.merge(testServices(fixture), Layer.succeed(Chain, chain(fixture)))
  const runtime: AppRuntime = ManagedRuntime.make(services)
  runtimes.push(runtime)
  await runtime.runPromise(seedWallet())
  const token = await runtime.runPromise(createSession(OWNER_ID))
  const api = makeApiHandler(Layer.succeedContext(await runtime.context()))
  const call = async (method: 'GET' | 'POST', path: string, cookie = `hm_owner=${token}`) => {
    const response = await api.handler(new Request(`${ORIGIN}${path}`, { method, headers: { cookie } }))
    return { status: response.status, body: (await response.json()) as unknown }
  }
  return { fixture, runtime, call, dispose: api.dispose }
}

const asView = Schema.decodeUnknownSync(DepositAddressView)
const asSweep = Schema.decodeUnknownSync(SweepReply)
const OverviewWallet = Schema.Struct({
  wallet: Schema.Struct({ deposit_address: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
})

describe('deposit addresses', () => {
  test('GET creates the address once for the signed-in wallet; the overview names it afterwards', async () => {
    const w = await world()
    const before = Schema.decodeUnknownSync(OverviewWallet)((await w.call('GET', '/api/overview')).body)
    expect(before.wallet.deposit_address).toBeNull()

    const first = await w.call('GET', '/api/wallet/deposit-address')
    expect(first.status).toBe(200)
    const view = asView(first.body)
    expect(view).toMatchObject({ recipient: CONTRACT_ID, pending: '0', swept_total: '0', last_sweep_tx: null })
    expect(view.address).toMatch(/^G[A-Z2-7]{55}$/u)
    expect(view.create_tx).not.toBe('')
    expect(Date.parse(view.expires_at)).toBeGreaterThan(Date.now() + 170 * 24 * 3600 * 1000)

    const again = asView((await w.call('GET', '/api/wallet/deposit-address')).body)
    expect(again.address).toBe(view.address)
    expect(w.fixture.callsOf('createDepositAddress')).toHaveLength(1)
    expect(w.fixture.callsOf('createDepositAddress')[0]?.args).toEqual([CONTRACT_ID])

    const after = Schema.decodeUnknownSync(OverviewWallet)((await w.call('GET', '/api/overview')).body)
    expect(after.wallet.deposit_address).toBe(view.address)
    await w.dispose()
  })

  test('signed out: 401, and nothing is created', async () => {
    const w = await world()
    expect((await w.call('GET', '/api/wallet/deposit-address', '')).status).toBe(401)
    expect((await w.call('POST', '/api/wallet/sweep', '')).status).toBe(401)
    expect(w.fixture.callsOf('createDepositAddress')).toHaveLength(0)
    await w.dispose()
  })

  test('POST /api/wallet/sweep moves what arrived into the wallet; an empty address sweeps nothing', async () => {
    const w = await world()
    expect((await w.call('POST', '/api/wallet/sweep')).status).toBe(404)
    const { address } = asView((await w.call('GET', '/api/wallet/deposit-address')).body)
    w.fixture.pay(address, 5n * USDC)
    expect(asView((await w.call('GET', '/api/wallet/deposit-address')).body).pending).toBe(String(5n * USDC))
    const walletBefore = w.fixture.balanceOf(CONTRACT_ID)

    const swept = asSweep((await w.call('POST', '/api/wallet/sweep')).body)
    expect(swept.swept).toBe(String(5n * USDC))
    expect(swept.tx).not.toBeNull()
    expect(swept.deposit).toMatchObject({ pending: '0', swept_total: String(5n * USDC), last_sweep_tx: swept.tx })
    expect(w.fixture.balanceOf(CONTRACT_ID) - walletBefore).toBe(5n * USDC)
    expect(w.fixture.callsOf('sweepDeposit')[0]?.args).toEqual([address, CONTRACT_ID])

    w.fixture.pay(address, 2n * USDC)
    expect(asSweep((await w.call('POST', '/api/wallet/sweep')).body).deposit.swept_total).toBe(String(7n * USDC))
    const empty = asSweep((await w.call('POST', '/api/wallet/sweep')).body)
    expect(empty).toMatchObject({ swept: '0', tx: null })
    await w.dispose()
  })

  test('a failed build answers 503 and the next request builds a new address', async () => {
    const w = await world()
    w.fixture.failNext('createDepositAddress', 'submit_failed')
    expect((await w.call('GET', '/api/wallet/deposit-address')).status).toBe(503)
    expect((await w.runtime.runPromise(depositOfWallet(WALLET_ID)))?.status).toBe('failed')
    const retried = await w.call('GET', '/api/wallet/deposit-address')
    expect(retried.status).toBe(200)
    expect(w.fixture.callsOf('createDepositAddress')).toHaveLength(2)
    await w.dispose()
  })

  test('another request building the address answers 503 busy; a stale claim is taken over', async () => {
    const w = await world()
    const claim = (claimedAt: string) =>
      w.runtime.runPromise(
        write(
          sql(
            `INSERT INTO deposit_addresses (wallet_id, status, claim_token, claimed_at, recipient)
             VALUES (?, 'creating', 'dcl_other', ?, ?)`,
            WALLET_ID,
            claimedAt,
            CONTRACT_ID,
          ),
        ),
      )
    await claim(new Date().toISOString())
    const busy = await w.call('GET', '/api/wallet/deposit-address')
    expect(busy).toMatchObject({ status: 503, body: { error: expect.stringContaining('deposit_address_creating') } })
    expect(w.fixture.callsOf('createDepositAddress')).toHaveLength(0)
    await w.runtime.runPromise(
      write(
        sql('UPDATE deposit_addresses SET claimed_at = ? WHERE wallet_id = ?', '2026-01-01T00:00:00.000Z', WALLET_ID),
      ),
    )
    expect((await w.call('GET', '/api/wallet/deposit-address')).status).toBe(200)
    expect(w.fixture.callsOf('createDepositAddress')).toHaveLength(1)
    await w.dispose()
  })

  test('two requests at once build one address', async () => {
    const w = await world()
    const replies = await Promise.all([
      w.call('GET', '/api/wallet/deposit-address'),
      w.call('GET', '/api/wallet/deposit-address'),
    ])
    expect(w.fixture.callsOf('createDepositAddress')).toHaveLength(1)
    expect(replies.some(reply => reply.status === 200)).toBe(true)
    expect(replies.every(reply => reply.status === 200 || reply.status === 503)).toBe(true)
    await w.dispose()
  })

  test('a network without a deposit router answers 404 deposit_unavailable', async () => {
    const w = await world(fixture => ({
      ...fixture.chain,
      createDepositAddress: () =>
        Effect.fail(new ChainError({ kind: 'declined', message: 'deposit_unavailable: no deposit router on pubnet' })),
    }))
    const reply = await w.call('GET', '/api/wallet/deposit-address')
    expect(reply).toMatchObject({ status: 404, body: { error: expect.stringContaining('deposit_unavailable') } })
    await w.dispose()
  })

  test("the Durable Object's tick sweeps while the watch lasts, then stops", async () => {
    const w = await world()
    const { address } = asView((await w.call('GET', '/api/wallet/deposit-address')).body)
    const row = await w.runtime.runPromise(depositOfWallet(WALLET_ID))
    expect(Date.parse(row?.watch_until ?? '')).toBeGreaterThan(Date.now() + 23 * 3600 * 1000)

    const idle = await w.runtime.runPromise(depositWatchTick(WALLET_ID))
    expect(idle.swept).toBe(0n)
    expect(idle.nextAt).toBeGreaterThan(Date.now())

    w.fixture.pay(address, 3n * USDC)
    expect((await w.runtime.runPromise(depositWatchTick(WALLET_ID))).swept).toBe(3n * USDC)
    expect((await w.runtime.runPromise(depositOfWallet(WALLET_ID)))?.swept_total).toBe(String(3n * USDC))

    await w.runtime.runPromise(
      write(
        sql('UPDATE deposit_addresses SET watch_until = ? WHERE wallet_id = ?', '2026-01-01T00:00:00.000Z', WALLET_ID),
      ),
    )
    w.fixture.pay(address, USDC)
    const calls = w.fixture.callsOf('sweepDeposit').length
    expect(await w.runtime.runPromise(depositWatchTick(WALLET_ID))).toEqual({ nextAt: null, swept: 0n })
    expect(w.fixture.callsOf('sweepDeposit')).toHaveLength(calls)
    expect(await w.runtime.runPromise(depositWatchTick('wal_none'))).toEqual({ nextAt: null, swept: 0n })
    await w.dispose()
  })
})
