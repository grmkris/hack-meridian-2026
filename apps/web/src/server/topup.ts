import { Clock, Context, DateTime, Duration, Effect, Schema } from 'effect'

import { Chain, fromStroops, type Wallet } from '@hm/protocol'
import { PRESETS } from '@hm/stellar'

import { randomId } from './clock.ts'
import { DbError } from './db.ts'
import { depositOfWallet, ensureDepositAddress, sweepDeposit, watchDeposit } from './deposit.ts'
import { topupArrived, topupDetected, topupExpired, topupPending, type TopupFacts } from './events/emit.ts'
import { journalStatement } from './events/journal.ts'
import { Network } from './network.ts'
import { first, insert, query, sql, write } from './rows.ts'
import { WalletSettings } from './wallet-settings.ts'

/**
 * Top up a Nod wallet from another chain through NEAR Intents' 1Click API (docs/NEAR-INTENTS.md, Flow A). 1Click pays
 * out on Stellar only to a classic G… that exists and holds the USDC trustline, which is exactly the wallet's deposit
 * address (deposit.ts): quote with recipient = that G, the person pays the origin-chain address 1Click returns, 1Click
 * swaps and pays the G, the deposit router sweeps it into the wallet. One quote per row in `topups` (0012); its status
 * follows 1Click's (GET /v0/status) and our own sweep, polled by the wallet's Durable Object, which journals the topup
 * event family. There is no 1Click testnet: real quotes run on Stellar mainnet only; the local stage stands 1Click in
 * with a simulator so the whole machinery can be watched. Every failure is `topup_unavailable`, never a 500.
 */

export const ONECLICK_URL = 'https://1click.chaindefuser.com'
/** 1Click sits behind Cloudflare, which refuses non-browser agents (error 1010). */
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
/** Circle USDC on Stellar, as 1Click names it. */
export const STELLAR_USDC = 'nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu'
const TIMEOUT = Duration.seconds(10)
/** A quote waits for solvers (`quoteWaitingTimeMs` 2 s) on top of the round trip; measured 6.5 s on 25 Oct. */
const QUOTE_TIMEOUT = Duration.seconds(15)
const TOKENS_TTL_MS = 10 * 60 * 1000
export const TOPUP_DEADLINE = Duration.minutes(30)

export class TopupError extends Schema.TaggedError<TopupError>()('TopupError', {
  reason: Schema.Literals(['topup_unavailable', 'bad_request', 'not_found']),
  message: Schema.String,
}) {}

const unavailable = (message: string) => new TopupError({ reason: 'topup_unavailable', message })
const badRequest = (message: string) => new TopupError({ reason: 'bad_request', message })

// 1Click's wire shapes (only the fields Nod reads; the rest is ignored)

export const OneClickToken = Schema.Struct({
  assetId: Schema.String,
  decimals: Schema.Finite,
  blockchain: Schema.String,
  symbol: Schema.String,
  price: Schema.optional(Schema.Finite),
  contractAddress: Schema.optional(Schema.String),
})
export type OneClickToken = typeof OneClickToken.Type

export const OneClickQuote = Schema.Struct({
  quote: Schema.Struct({
    depositAddress: Schema.optional(Schema.String),
    amountIn: Schema.String,
    amountInFormatted: Schema.String,
    amountOut: Schema.String,
    amountOutFormatted: Schema.String,
    minAmountOut: Schema.optional(Schema.String),
    deadline: Schema.optional(Schema.String),
    timeEstimate: Schema.optional(Schema.Finite),
  }),
})
export type OneClickQuote = typeof OneClickQuote.Type

export const OneClickStatus = Schema.Struct({
  status: Schema.String,
  updatedAt: Schema.optional(Schema.String),
})
export type OneClickStatus = typeof OneClickStatus.Type

export interface QuoteRequest {
  readonly originAsset: string
  /** In the origin asset's base units. */
  readonly amount: string
  readonly refundTo: string
  /** The Stellar G… 1Click pays (the wallet's deposit address). */
  readonly recipient: string
  readonly deadline: string
  readonly dry: boolean
}

export interface OneClickShape {
  readonly tokens: Effect.Effect<ReadonlyArray<OneClickToken>, TopupError>
  readonly quote: (request: QuoteRequest) => Effect.Effect<OneClickQuote, TopupError>
  readonly status: (depositAddress: string) => Effect.Effect<OneClickStatus, TopupError>
}

const call = <S extends Schema.Constraint & { readonly DecodingServices: never }>(
  fetchImpl: typeof globalThis.fetch,
  schema: S,
  path: string,
  init: RequestInit,
  timeout: Duration.Duration,
) =>
  Effect.tryPromise({
    try: async signal => {
      const response = await fetchImpl(`${ONECLICK_URL}${path}`, {
        ...init,
        signal,
        headers: { 'user-agent': USER_AGENT, accept: 'application/json', 'content-type': 'application/json' },
      })
      const body: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        const message =
          typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string'
            ? body.message
            : `HTTP ${response.status}`
        throw new Error(message)
      }
      return body
    },
    catch: error => unavailable(`NEAR Intents: ${error instanceof Error ? error.message : String(error)}`),
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => Effect.fail(unavailable('NEAR Intents did not answer in time')),
    }),
    Effect.flatMap(body =>
      Schema.decodeUnknownEffect(schema)(body).pipe(
        Effect.mapError(() => unavailable('NEAR Intents answered something Nod cannot read')),
      ),
    ),
  )

/** The hosted 1Click API (no key): one client, a browser User-Agent, 10 s (quotes 15 s), the token list cached 10 min. */
export const makeLiveOneClick = (fetchImpl: typeof globalThis.fetch): OneClickShape => {
  // One cache per client, i.e. per isolate (the default client lives as long as the module).
  let tokenCache: { readonly at: number; readonly tokens: ReadonlyArray<OneClickToken> } | undefined
  return {
    tokens: Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const cached = tokenCache
      if (cached !== undefined && now - cached.at < TOKENS_TTL_MS) return cached.tokens
      const tokens = yield* call(fetchImpl, Schema.Array(OneClickToken), '/v0/tokens', { method: 'GET' }, TIMEOUT)
      tokenCache = { at: now, tokens }
      return tokens
    }),
    quote: request =>
      call(
        fetchImpl,
        OneClickQuote,
        '/v0/quote',
        {
          method: 'POST',
          body: JSON.stringify({
            dry: request.dry,
            swapType: 'EXACT_INPUT',
            slippageTolerance: 100,
            originAsset: request.originAsset,
            depositType: 'ORIGIN_CHAIN',
            destinationAsset: STELLAR_USDC,
            amount: request.amount,
            refundTo: request.refundTo,
            refundType: 'ORIGIN_CHAIN',
            recipient: request.recipient,
            recipientType: 'DESTINATION_CHAIN',
            deadline: request.deadline,
            quoteWaitingTimeMs: 2000,
            referral: 'nod',
          }),
        },
        QUOTE_TIMEOUT,
      ),
    status: depositAddress =>
      call(
        fetchImpl,
        OneClickStatus,
        `/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`,
        { method: 'GET' },
        TIMEOUT,
      ),
  }
}

const liveOneClick = makeLiveOneClick((input, init) => globalThis.fetch(input, init))

/** 1Click as the service sees it: the live API unless a test (or the local stage) provides another. */
export const OneClick = Context.Reference<OneClickShape>('hm/OneClick', { defaultValue: () => liveOneClick })

/**
 * The local stage's stand-in (no 1Click testnet exists): the real token list, quotes priced from it with 1Click's
 * ~0.36 % fee, an origin-chain "address" that says what it is, PENDING_DEPOSIT for 20 s then PROCESSING. The money
 * side is real: USDC paid to the wallet's deposit address on testnet is swept, and the top-up then reads arrived.
 */
export const localOneClick: OneClickShape = {
  tokens: liveOneClick.tokens,
  quote: request =>
    Effect.gen(function* () {
      const tokens = yield* liveOneClick.tokens
      const token = tokens.find(candidate => candidate.assetId === request.originAsset)
      const units = Number(request.amount) / 10 ** (token?.decimals ?? 6)
      const out = Math.max(0, units * (token?.price ?? 1) * 0.9964)
      return {
        quote: {
          depositAddress: `local-1click-simulator-${yield* Clock.currentTimeMillis}`,
          amountIn: request.amount,
          amountInFormatted: String(units),
          amountOut: String(Math.round(out * 1e7)),
          amountOutFormatted: out.toFixed(7),
          deadline: request.deadline,
          timeEstimate: 50,
        },
      }
    }),
  status: depositAddress =>
    Effect.map(Clock.currentTimeMillis, now => {
      const created = Number(depositAddress.split('-').at(-1))
      return { status: Number.isFinite(created) && now - created < 20_000 ? 'PENDING_DEPOSIT' : 'PROCESSING' }
    }),
}

// Assets

/** Stablecoins and each chain's native coin, grouped by chain (GET /api/topup/assets). Stellar itself is left out. */
export const assetsByChain = (tokens: ReadonlyArray<OneClickToken>) => {
  const wanted = tokens.filter(
    token =>
      token.blockchain !== 'stellar' &&
      (['USDC', 'USDT'].includes(token.symbol) || token.contractAddress === undefined || token.contractAddress === ''),
  )
  const chains = [...new Set(wanted.map(token => token.blockchain))].toSorted()
  return chains.map(chain => ({
    chain,
    assets: wanted
      .filter(token => token.blockchain === chain)
      .map(token => ({ id: token.assetId, symbol: token.symbol, decimals: token.decimals })),
  }))
}

/** The MCP tools' short list (the card offers the same): chain name → 1Click blockchain, and the native coin. */
export const TOOL_CHAINS = {
  base: { blockchain: 'base', native: 'ETH' },
  solana: { blockchain: 'sol', native: 'SOL' },
  ethereum: { blockchain: 'eth', native: 'ETH' },
  arbitrum: { blockchain: 'arb', native: 'ETH' },
  polygon: { blockchain: 'pol', native: 'POL' },
} as const
export type ToolChain = keyof typeof TOOL_CHAINS

/** USDC on the chain, or its native coin (ETH, SOL, POL); undefined when 1Click does not list it. */
export const assetFor = (tokens: ReadonlyArray<OneClickToken>, chain: ToolChain, symbol: string) => {
  const { blockchain, native } = TOOL_CHAINS[chain]
  return symbol === 'USDC'
    ? tokens.find(token => token.blockchain === blockchain && token.symbol === 'USDC')
    : symbol === native
      ? tokens.find(
          token =>
            token.blockchain === blockchain &&
            token.symbol === native &&
            (token.contractAddress === undefined || token.contractAddress === ''),
        )
      : undefined
}

// Quotes

const TopupRow = Schema.Struct({
  id: Schema.String,
  wallet_id: Schema.String,
  connection_id: Schema.NullOr(Schema.String),
  origin_chain: Schema.String,
  origin_asset: Schema.String,
  asset: Schema.String,
  amount_in: Schema.String,
  amount_out: Schema.String,
  refund_to: Schema.String,
  pay_to: Schema.String,
  deposit_address: Schema.String,
  deadline: Schema.String,
  status: Schema.Literals(['pending', 'processing', 'arrived', 'failed', 'expired']),
  oneclick_status: Schema.NullOr(Schema.String),
  swept_baseline: Schema.String,
  sweep_tx: Schema.NullOr(Schema.String),
  arrived_amount: Schema.NullOr(Schema.String),
  created_at: Schema.String,
})
export type TopupRow = typeof TopupRow.Type

const toTopup = (row: Record<string, unknown>) =>
  Schema.decodeUnknownEffect(TopupRow)(row).pipe(
    Effect.mapError(error => new DbError({ operation: 'decode topups', message: String(error) })),
  )

const COLUMNS = `id, wallet_id, connection_id, origin_chain, origin_asset, asset, amount_in, amount_out, refund_to, pay_to,
  deposit_address, deadline, status, oneclick_status, swept_baseline, sweep_tx, arrived_amount, created_at`

export const topupById = (id: string) => first(sql(`SELECT ${COLUMNS} FROM topups WHERE id = ?`, id), toTopup)

/** What the card, /api and the tools show (TopupQuoteView). A pending top-up past its deadline reads expired. */
export const topupView = (row: TopupRow, nowMs: number) => ({
  id: row.id,
  pay_to: row.pay_to,
  amount_in: row.amount_in,
  amount_out: row.amount_out,
  origin_chain: row.origin_chain,
  asset: row.asset,
  deadline: row.deadline,
  status: row.status === 'pending' && Date.parse(row.deadline) <= nowMs ? ('expired' as const) : row.status,
  sweep_tx: row.sweep_tx,
})
export type TopupView = ReturnType<typeof topupView>

/** Quotes run on Stellar mainnet (1Click has no testnet) with a deposit router; the local stage uses the stand-in. */
const openClient = Effect.gen(function* () {
  const chain = yield* Chain
  if (!chain.depositsAvailable)
    return yield* unavailable('topup_unavailable: this network has no deposit addresses yet')
  const settings = yield* WalletSettings
  if (settings.stage === 'local') return localOneClick
  if ((yield* Network).name !== 'pubnet')
    return yield* unavailable(
      'topup_unavailable: top-ups from other chains run on Stellar mainnet; NEAR Intents has no testnet',
    )
  return yield* OneClick
})

/** The token list where quotes can run (topup_unavailable elsewhere). */
export const topupTokens = Effect.flatMap(openClient, client => client.tokens)

/** GET /api/topup/assets: what can top a wallet up here, grouped by chain (only where quotes can run). */
export const topupAssets = Effect.map(topupTokens, assetsByChain)

const DECIMAL = /^\d{1,18}(?:\.\d{1,18})?$/u

/** "5.25" with `decimals` → base units ("5250000" for 6), refusing more fraction digits than the asset has. */
export const toBaseUnits = (amount: string, decimals: number) => {
  if (!DECIMAL.test(amount.trim())) return undefined
  const [whole = '0', fraction = ''] = amount.trim().split('.')
  if (fraction.length > decimals) return undefined
  const units =
    BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0')
  return units > 0n ? units.toString() : undefined
}

const EVM_CHAINS = new Set([
  'eth',
  'base',
  'arb',
  'pol',
  'bsc',
  'op',
  'avax',
  'gnosis',
  'bera',
  'monad',
  'scroll',
  'abs',
])

/** 1Click takes EVM addresses in lowercase only; Solana and the rest as given (format-checked loosely here). */
export const refundAddressFor = (blockchain: string, address: string) => {
  const trimmed = address.trim()
  if (EVM_CHAINS.has(blockchain) || /^0x[0-9a-fA-F]{40}$/u.test(trimmed))
    return /^0x[0-9a-fA-F]{40}$/u.test(trimmed) ? trimmed.toLowerCase() : undefined
  if (blockchain === 'sol') return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(trimmed) ? trimmed : undefined
  return trimmed.length > 0 && trimmed.length <= 128 ? trimmed : undefined
}

const facts = (row: TopupRow, network: string, occurredAt: string): TopupFacts => ({
  walletId: row.wallet_id,
  network,
  topupId: row.id,
  originChain: row.origin_chain,
  asset: row.asset,
  amountIn: row.amount_in,
  amountOut: row.amount_out,
  deadline: row.deadline,
  payTo: row.pay_to,
  occurredAt,
})

export interface NewTopup {
  readonly originAsset: string
  readonly amount: string
  readonly refundTo: string
  readonly connectionId?: string | null
  readonly idempotencyKey?: string | null
}

/**
 * A quote: the wallet's deposit address (created on first use, ~15 s), 1Click quoted to pay it, the row and its
 * topup.pending event in one batch, and the deposit watcher armed so the sweep lands within a minute of arrival.
 */
export const createTopup = (wallet: Wallet, input: NewTopup) =>
  Effect.gen(function* () {
    if ((input.idempotencyKey ?? null) !== null) {
      const again = yield* first(
        sql(
          `SELECT ${COLUMNS} FROM topups WHERE wallet_id = ? AND connection_id IS ? AND idempotency_key = ?`,
          wallet.id,
          input.connectionId ?? null,
          input.idempotencyKey ?? null,
        ),
        toTopup,
      )
      if (again !== undefined) return again
    }
    const client = yield* openClient
    const tokens = yield* client.tokens
    const token = tokens.find(candidate => candidate.assetId === input.originAsset)
    if (token === undefined || token.blockchain === 'stellar')
      return yield* badRequest('That asset cannot top a Nod wallet up (GET /api/topup/assets lists those that can).')
    const units = toBaseUnits(input.amount, token.decimals)
    if (units === undefined)
      return yield* badRequest(
        `The amount must be a positive ${token.symbol} amount with at most ${token.decimals} decimals.`,
      )
    const refundTo = refundAddressFor(token.blockchain, input.refundTo)
    if (refundTo === undefined)
      return yield* badRequest(
        `The refund address must be an address on ${token.blockchain} (where a failed swap returns the money).`,
      )
    const deposit = yield* ensureDepositAddress(wallet).pipe(
      Effect.catchTag('DepositError', error => Effect.fail(unavailable(`topup_unavailable: ${error.message}`))),
    )
    const now = yield* DateTime.now
    const deadline = DateTime.formatIso(DateTime.addDuration(now, TOPUP_DEADLINE))
    const quoted = yield* client.quote({
      originAsset: token.assetId,
      amount: units,
      refundTo,
      recipient: deposit.address,
      deadline,
      dry: false,
    })
    const payTo = quoted.quote.depositAddress
    if (payTo === undefined) return yield* unavailable('topup_unavailable: NEAR Intents gave no deposit address')
    const id = yield* randomId('tp')
    const at = DateTime.formatIso(now)
    const row: TopupRow = {
      id,
      wallet_id: wallet.id,
      connection_id: input.connectionId ?? null,
      origin_chain: token.blockchain,
      origin_asset: token.assetId,
      asset: token.symbol,
      amount_in: quoted.quote.amountInFormatted,
      amount_out: quoted.quote.amountOutFormatted,
      refund_to: refundTo,
      pay_to: payTo,
      deposit_address: deposit.address,
      deadline: quoted.quote.deadline ?? deadline,
      status: 'pending',
      oneclick_status: 'PENDING_DEPOSIT',
      swept_baseline: deposit.swept_total,
      sweep_tx: null,
      arrived_amount: null,
      created_at: at,
    }
    const network = yield* Network
    yield* write(
      insert('topups', {
        ...row,
        idempotency_key: input.idempotencyKey ?? null,
        quote: JSON.stringify(quoted),
        updated_at: at,
      }),
      journalStatement(topupPending(facts(row, network.caip, at))),
    )
    yield* watchDeposit(wallet.id)
    return row
  })

/** The network facts the events carry (the Worker has them from Network; the Durable Object from its bindings). */
export interface TopupNet {
  readonly caip: string
  readonly explorerBase: string
}

/** The Durable Object's network, from STELLAR_NETWORK as the chain package reads it (pubnet, else testnet). */
export const topupNetOf = (stellarNetwork: string | undefined): TopupNet => {
  const name = stellarNetwork === 'pubnet' ? 'pubnet' : 'testnet'
  return { caip: `stellar:${name}`, explorerBase: PRESETS[name].explorerBase }
}

const ONECLICK_FAILED = new Set(['REFUNDED', 'FAILED', 'INCOMPLETE_DEPOSIT'])
const ONECLICK_MOVING = new Set(['KNOWN_DEPOSIT_TX', 'PROCESSING', 'SUCCESS'])

/**
 * Where a top-up stands now, and its event when it moved: arrived once the deposit address swept more than when it
 * was quoted (sweeping first when 1Click says SUCCESS); processing while 1Click works; failed when 1Click refunded;
 * expired when the deadline passed with no deposit. Terminal top-ups are returned as they are. `local` picks the stand-in.
 */
export const refreshTopup = (row: TopupRow, local: boolean, network: TopupNet) =>
  Effect.gen(function* () {
    if (row.status === 'arrived' || row.status === 'failed' || row.status === 'expired') return row
    const client = local ? localOneClick : yield* OneClick
    const said = yield* client.status(row.pay_to).pipe(Effect.option)
    const oneclick = said._tag === 'Some' ? said.value.status : row.oneclick_status
    let deposit = yield* depositOfWallet(row.wallet_id)
    if (oneclick === 'SUCCESS' && deposit?.status === 'active' && deposit.address !== null)
      yield* sweepDeposit({ ...deposit, status: 'active', address: deposit.address }).pipe(Effect.ignore)
    deposit = yield* depositOfWallet(row.wallet_id)
    const now = yield* DateTime.now
    const at = DateTime.formatIso(now)
    const grew = deposit === undefined ? 0n : BigInt(deposit.swept_total) - BigInt(row.swept_baseline)
    if (grew > 0n && deposit !== undefined) {
      const wallet = yield* first(sql('SELECT contract_id FROM wallets WHERE id = ?', row.wallet_id), r =>
        Effect.succeed(String(r['contract_id'])),
      )
      const balance =
        wallet === undefined
          ? null
          : yield* Chain.use(chain => chain.balances(wallet)).pipe(
              Effect.map(b => b.usdc),
              Effect.orElseSucceed(() => null),
            )
      const tx = deposit.last_sweep_tx ?? ''
      yield* write(
        sql(
          `UPDATE topups SET status = 'arrived', oneclick_status = ?, sweep_tx = ?, arrived_amount = ?, updated_at = ?
             WHERE id = ? AND status IN ('pending', 'processing')`,
          oneclick ?? null,
          tx,
          fromStroops(grew),
          at,
          row.id,
        ),
        journalStatement(
          topupArrived({
            walletId: row.wallet_id,
            network: network.caip,
            topupId: row.id,
            amount: grew,
            tx,
            explorer: `${network.explorerBase}/tx/${tx}`,
            balance,
            occurredAt: at,
          }),
        ),
      )
    } else if (oneclick !== null && ONECLICK_FAILED.has(oneclick)) {
      yield* write(
        sql(
          `UPDATE topups SET status = 'failed', oneclick_status = ?, updated_at = ? WHERE id = ?`,
          oneclick,
          at,
          row.id,
        ),
      )
    } else if (oneclick !== null && ONECLICK_MOVING.has(oneclick)) {
      yield* write(
        sql(
          `UPDATE topups SET status = 'processing', oneclick_status = ?, updated_at = ? WHERE id = ?`,
          oneclick,
          at,
          row.id,
        ),
        journalStatement(topupDetected(facts(row, network.caip, at))),
      )
    } else if (Date.parse(row.deadline) <= DateTime.toEpochMillis(now)) {
      yield* write(
        sql(
          `UPDATE topups SET status = 'expired', oneclick_status = ?, updated_at = ? WHERE id = ?`,
          oneclick ?? null,
          at,
          row.id,
        ),
        journalStatement(topupExpired(facts(row, network.caip, at))),
      )
    }
    return (yield* topupById(row.id)) ?? row
  })

/** GET /api/wallet/topup/:id and wallet_topup_status: the wallet's own top-up, refreshed, the watcher poked. */
export const topupStatusOf = (wallet: Wallet, id: string) =>
  Effect.gen(function* () {
    const row = yield* topupById(id)
    if (row === undefined || row.wallet_id !== wallet.id)
      return yield* new TopupError({ reason: 'not_found', message: `No top-up ${id} for this wallet.` })
    const settings = yield* WalletSettings
    const network = yield* Network
    const fresh = yield* refreshTopup(row, settings.stage === 'local', network)
    if (fresh.status === 'pending' || fresh.status === 'processing') yield* watchDeposit(wallet.id)
    return fresh
  })

/**
 * The wallet's Durable Object turn (the same alarm that sweeps): every open top-up refreshed, so 1Click's progress and
 * the sweep become events. True when something moved (the caller delivers the journal now). Never fails.
 */
export const topupTick = (walletId: string, local: boolean, network: TopupNet) =>
  Effect.gen(function* () {
    const open = yield* query(
      sql(
        `SELECT ${COLUMNS} FROM topups WHERE wallet_id = ? AND status IN ('pending', 'processing') ORDER BY created_at DESC LIMIT 5`,
        walletId,
      ),
      toTopup,
    )
    let moved = false
    for (const row of open) {
      const fresh = yield* refreshTopup(row, local, network)
      if (fresh.status !== row.status) moved = true
    }
    return moved
  }).pipe(Effect.orElseSucceed(() => false))
