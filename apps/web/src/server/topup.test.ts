import { Effect, Layer, ManagedRuntime, Schema } from 'effect'
import { afterEach, describe, expect, test } from 'vitest'

import { TopupChain, TopupQuoteView } from '@hm/api'
import { makeFixtureChain, toStroops } from '@hm/protocol'

import { makeApiHandler } from './app.ts'
import { depositOfWallet } from './deposit.ts'
import type { NetworkShape } from './network.ts'
import type { ConnectionProps } from './props.ts'
import { query, sql, write } from './rows.ts'
import type { AppRuntime } from './runtime.ts'
import { createSession } from './store.ts'
import { testNetwork, testServices } from './test/layers.ts'
import { CONTRACT_ID, OWNER_ID, seedWallet, WALLET_ID } from './test/seed.ts'
import { type ToolContext, walletOverview } from './tools.ts'
import { walletTopupQuote, walletTopupStatus } from './topup-tools.ts'
import { OneClick, type OneClickShape, type OneClickToken, TopupError, topupTick } from './topup.ts'

/**
 * Top-ups from another chain (topup.ts) against a fixture 1Click: the quote pays the wallet's deposit address, the
 * status follows 1Click and the sweep, every state journals its topup event, and anything 1Click or the network
 * cannot do answers topup_unavailable (503), never a 500.
 */

const ORIGIN = 'https://wallet.test'
const USDC = 10_000_000n
const BASE_USDC = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near'
const TOKENS: ReadonlyArray<OneClickToken> = [
  { assetId: BASE_USDC, decimals: 6, blockchain: 'base', symbol: 'USDC', price: 1, contractAddress: '0x8335' },
  { assetId: 'nep141:base.omft.near', decimals: 18, blockchain: 'base', symbol: 'ETH', price: 4000 },
  {
    assetId: 'nep141:base-0xkaito.omft.near',
    decimals: 18,
    blockchain: 'base',
    symbol: 'KAITO',
    contractAddress: '0x98d0',
  },
  { assetId: 'nep141:sol-5ce3.omft.near', decimals: 6, blockchain: 'sol', symbol: 'USDC', contractAddress: 'EPjF' },
  { assetId: 'nep141:sol.omft.near', decimals: 9, blockchain: 'sol', symbol: 'SOL' },
  {
    assetId: 'nep245:v2_1.omni.hot.tg:1100_usdc',
    decimals: 7,
    blockchain: 'stellar',
    symbol: 'USDC',
    contractAddress: 'GA5Z',
  },
]
const PUBNET: NetworkShape = { ...testNetwork, name: 'pubnet', caip: 'stellar:pubnet', label: 'Mainnet' }

/** A scripted 1Click: what it was asked, and the status each deposit address reports. */
const fixtureOneClick = () => {
  const quotes: Array<{ originAsset: string; amount: string; refundTo: string; recipient: string; dry: boolean }> = []
  const statuses = new Map<string, string>()
  const client: OneClickShape = {
    tokens: Effect.succeed(TOKENS),
    quote: request =>
      Effect.suspend(() => {
        quotes.push(request)
        const depositAddress = `0xdeposit${quotes.length}`
        statuses.set(depositAddress, 'PENDING_DEPOSIT')
        return Effect.succeed({
          quote: {
            depositAddress,
            amountIn: request.amount,
            amountInFormatted: '5.0',
            amountOut: '49820419',
            amountOutFormatted: '4.9820419',
            deadline: request.deadline,
            timeEstimate: 50,
          },
        })
      }),
    status: depositAddress => Effect.succeed({ status: statuses.get(depositAddress) ?? 'PENDING_DEPOSIT' }),
  }
  return {
    client,
    quotes,
    set: (address: string, status: string) => statuses.set(address, status),
  }
}

const runtimes: Array<AppRuntime> = []
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
})

const world = async (network = PUBNET, failing = false) => {
  const fixture = makeFixtureChain()
  const oneClick = fixtureOneClick()
  const client: OneClickShape = failing
    ? {
        ...oneClick.client,
        quote: () => Effect.fail(new TopupError({ reason: 'topup_unavailable', message: 'NEAR Intents: HTTP 503' })),
      }
    : oneClick.client
  const runtime: AppRuntime = ManagedRuntime.make(
    Layer.merge(testServices(fixture, undefined, network), Layer.succeed(OneClick, client)),
  )
  runtimes.push(runtime)
  await runtime.runPromise(seedWallet({ total: 5n * USDC, connectionId: 'con_a' }))
  const token = await runtime.runPromise(createSession(OWNER_ID))
  const api = makeApiHandler(Layer.succeedContext(await runtime.context()))
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const response = await api.handler(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: { cookie: `hm_owner=${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
    return { status: response.status, body: (await response.json()) as unknown }
  }
  const events = () =>
    runtime.runPromise(
      query(sql('SELECT name FROM event_journal WHERE wallet_id = ? ORDER BY seq', WALLET_ID), row =>
        Effect.succeed(String(row['name'])),
      ),
    )
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
      signer_public_key: 'G',
    },
  }
  const ctx: ToolContext = { props, origin: ORIGIN }
  return { runtime, fixture, oneClick, call, events, ctx, dispose: () => api.dispose() }
}

const asView = Schema.decodeUnknownSync(TopupQuoteView)

describe('top-ups from another chain (NEAR Intents)', () => {
  test('a testnet stage answers topup_unavailable (no 1Click testnet), never a 500', async () => {
    const w = await world(testNetwork)
    const assets = await w.call('GET', '/api/topup/assets')
    expect(assets.status).toBe(503)
    expect(JSON.stringify(assets.body)).toContain('topup_unavailable')
    const quote = await w.call('POST', '/api/wallet/topup/quote', {
      origin_asset: BASE_USDC,
      amount: '5',
      refund_to: '0x',
    })
    expect(quote.status).toBe(503)
    expect(w.oneClick.quotes).toHaveLength(0)
    await w.dispose()
  })

  test('assets: stablecoins and native coins grouped by chain, Stellar left out', async () => {
    const w = await world()
    const assets = await w.call('GET', '/api/topup/assets')
    expect(assets.status).toBe(200)
    const chains = Schema.decodeUnknownSync(Schema.Array(TopupChain))(assets.body)
    expect(chains.map(chain => chain.chain)).toEqual(['base', 'sol'])
    expect(chains[0]?.assets.map(asset => asset.symbol)).toEqual(['USDC', 'ETH'])
    await w.dispose()
  })

  test('quote → pending (pays the deposit G), processing, arrived after the sweep; each state is an event', async () => {
    const w = await world()
    const made = await w.call('POST', '/api/wallet/topup/quote', {
      origin_asset: BASE_USDC,
      amount: '5',
      refund_to: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01',
    })
    expect(made.status).toBe(200)
    const view = asView(made.body)
    expect(view).toMatchObject({
      pay_to: '0xdeposit1',
      amount_in: '5.0',
      amount_out: '4.9820419',
      origin_chain: 'base',
      asset: 'USDC',
      status: 'pending',
    })
    const deposit = await w.runtime.runPromise(depositOfWallet(WALLET_ID))
    expect(w.oneClick.quotes[0]).toMatchObject({
      originAsset: BASE_USDC,
      amount: '5000000',
      refundTo: '0xabcdef0123456789abcdef0123456789abcdef01',
      recipient: deposit?.address,
      dry: false,
    })
    expect(await w.events()).toEqual(['topup.pending'])

    w.oneClick.set('0xdeposit1', 'PROCESSING')
    expect(asView((await w.call('GET', `/api/wallet/topup/${view.id}`)).body).status).toBe('processing')
    expect(await w.events()).toEqual(['topup.pending', 'topup.detected'])

    // 1Click pays the deposit G; SUCCESS makes the status call sweep it in at once.
    w.fixture.pay(deposit?.address ?? '', toStroops('4.9820419'))
    w.oneClick.set('0xdeposit1', 'SUCCESS')
    const arrived = asView((await w.call('GET', `/api/wallet/topup/${view.id}`)).body)
    expect(arrived.status).toBe('arrived')
    expect(arrived.sweep_tx).toMatch(/^[0-9a-f]{64}$/u)
    expect(w.fixture.balanceOf(CONTRACT_ID)).toBeGreaterThanOrEqual(toStroops('4.9820419'))
    expect(await w.events()).toEqual(['topup.pending', 'topup.detected', 'topup.arrived'])
    await w.dispose()
  })

  test('the Durable Object tick moves open top-ups; a deadline with no deposit expires', async () => {
    const w = await world()
    const view = asView(
      (
        await w.call('POST', '/api/wallet/topup/quote', {
          origin_asset: 'nep141:sol.omft.near',
          amount: '0.05',
          refund_to: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
        })
      ).body,
    )
    expect(view).toMatchObject({ origin_chain: 'sol', asset: 'SOL' })
    expect(w.oneClick.quotes[0]?.amount).toBe('50000000')
    await w.runtime.runPromise(
      write(sql("UPDATE topups SET deadline = '2020-01-01T00:00:00.000Z' WHERE id = ?", view.id)),
    )
    const net = { caip: 'stellar:pubnet', explorerBase: 'https://stellar.expert/explorer/public' }
    expect(await w.runtime.runPromise(topupTick(WALLET_ID, false, net))).toBe(true)
    expect(asView((await w.call('GET', `/api/wallet/topup/${view.id}`)).body).status).toBe('expired')
    expect(await w.events()).toEqual(['topup.pending', 'topup.expired'])
    await w.dispose()
  })

  test('bad requests are 400; 1Click down is 503 topup_unavailable; an unknown id is 404', async () => {
    const w = await world()
    expect(
      (await w.call('POST', '/api/wallet/topup/quote', { origin_asset: 'nep141:nope', amount: '5', refund_to: '0x' }))
        .status,
    ).toBe(400)
    expect(
      (
        await w.call('POST', '/api/wallet/topup/quote', {
          origin_asset: BASE_USDC,
          amount: '5.1234567',
          refund_to: '0xabcdef0123456789abcdef0123456789abcdef01',
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await w.call('POST', '/api/wallet/topup/quote', {
          origin_asset: BASE_USDC,
          amount: '5',
          refund_to: 'not-an-address',
        })
      ).status,
    ).toBe(400)
    expect((await w.call('GET', '/api/wallet/topup/tp_missing')).status).toBe(404)
    await w.dispose()
    const down = await world(PUBNET, true)
    const refused = await down.call('POST', '/api/wallet/topup/quote', {
      origin_asset: BASE_USDC,
      amount: '5',
      refund_to: '0xabcdef0123456789abcdef0123456789abcdef01',
    })
    expect(refused.status).toBe(503)
    expect(JSON.stringify(refused.body)).toContain('topup_unavailable')
    await down.dispose()
  })

  test('MCP: wallet_topup_quote says what to send where; wallet_topup_status follows it; low_balance on the overview', async () => {
    const w = await world()
    const quoted = await w.runtime.runPromise(
      walletTopupQuote(w.ctx, {
        origin_chain: 'base',
        asset: 'USDC',
        amount: '5',
        refund_address: '0xabcdef0123456789abcdef0123456789abcdef01',
        idempotency_key: 'top-1',
      }),
    )
    expect(quoted.sentence).toMatch(
      /^Send 5\.0 USDC on Base to 0xdeposit1 within (29|30) minutes; it arrives as about 4\.9820419 USDC in your Nod wallet\./u,
    )
    expect(quoted.value).toMatchObject({ status: 'pending', add_money_url: `${ORIGIN}/` })
    const again = await w.runtime.runPromise(
      walletTopupQuote(w.ctx, {
        origin_chain: 'base',
        asset: 'USDC',
        amount: '5',
        refund_address: '0xabcdef0123456789abcdef0123456789abcdef01',
        idempotency_key: 'top-1',
      }),
    )
    expect(again.value.id).toBe(quoted.value.id)
    expect(w.oneClick.quotes).toHaveLength(1)
    const status = await w.runtime.runPromise(walletTopupStatus(w.ctx, quoted.value.id))
    expect(status.sentence).toContain('Waiting for 5.0 USDC on Base')
    const wrong = await w.runtime.runPromise(
      Effect.flip(
        walletTopupQuote(w.ctx, {
          origin_chain: 'solana',
          asset: 'ETH',
          amount: '1',
          refund_address: 'x',
          idempotency_key: 'top-2',
        }),
      ),
    )
    expect(wrong.message).toContain('cannot top the wallet up')
    // The fixture wallet holds nothing; the allowance has 5 left: low.
    const overview = await w.runtime.runPromise(walletOverview(w.ctx))
    expect(overview.value.low_balance).toBe(true)
    expect(overview.sentence).toContain('wallet_topup_quote')
    await w.dispose()
  })
})
