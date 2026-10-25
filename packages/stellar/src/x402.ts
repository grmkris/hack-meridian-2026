import { Cause, Effect, Exit, Schema } from 'effect'

import { ChainError, Receipt, type X402Quote, type X402QuoteHook } from '@hm/protocol'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker'
import { hash, type Keypair } from '@stellar/stellar-sdk'
import { appendPaymentIdentifierToExtensions, isValidPaymentId } from '@x402/extensions/payment-identifier'
import { wrapFetchWithPayment, x402Client, x402HTTPClient } from '@x402/fetch'
import { wrapMCPClientWithPayment } from '@x402/mcp'
import { createEd25519Signer } from '@x402/stellar'
import { ExactStellarScheme } from '@x402/stellar/exact/client'

import { toBuffer, toHex, utf8 } from './bytes.ts'
import { messageOf } from './errors.ts'
import type { NetworkParams } from './network.ts'
import type { Soroban, TxOutcome } from './soroban.ts'

/**
 * x402 from the pocket G(K) (spike S2): the stock `@x402/stellar` client signs as K's classic account; a hosted
 * facilitator settles and pays the fee. Before anything is signed, the quote hook runs: it is where the wallet
 * service checks the grant, reserves, and pulls the shortfall from the smart account into the pocket. A receipt is
 * returned only for a settlement the facilitator reports as `success` and RPC shows as confirmed.
 */

/** x402 payment ids are 16–128 chars of `[A-Za-z0-9_-]`; anything else maps to a stable id derived from it. */
export const normalizePaymentId = (id: string): string =>
  isValidPaymentId(id) ? id : `pay_${toHex(new Uint8Array(hash(toBuffer(utf8(id))))).slice(0, 40)}`

/** 7-decimal stroops → a `$` money string for spend controls ("$0.1"). */
export const stroopsToUsd = (stroops: bigint): string => {
  const whole = stroops / 10_000_000n
  const frac = (stroops % 10_000_000n).toString().padStart(7, '0').replace(/0+$/u, '')
  return `$${whole.toString()}${frac === '' ? '' : `.${frac}`}`
}

interface Requirements {
  readonly scheme: string
  readonly network: string
  readonly asset: string
  readonly amount: string
  readonly payTo: string
  readonly maxTimeoutSeconds: number
}

export const quoteOf = (r: Requirements, resource: string): X402Quote => ({
  scheme: r.scheme,
  network: r.network,
  asset: r.asset,
  amountStroops: BigInt(r.amount),
  payTo: r.payTo,
  resource,
  maxTimeoutSeconds: r.maxTimeoutSeconds,
})

type Caip2 = `${string}:${string}`
const isCaip2 = (s: string): s is Caip2 => /^[a-z0-9-]+:[a-zA-Z0-9-]+$/u.test(s)
const caip2 = (s: string): Caip2 => {
  if (!isCaip2(s)) throw new RangeError(`not a CAIP-2 network id: ${s}`)
  return s
}

/** What a seller's option is checked against: this network's CAIP-2 id and its USDC SAC. */
export interface X402Target {
  readonly x402Network: string
  readonly usdcSac: string
}

export const x402TargetOf = (n: NetworkParams): X402Target => ({
  x402Network: n.x402Network,
  usdcSac: n.contracts.usdcSac,
})

/** Our acceptance rule for a seller's option: exact scheme, our network, Circle USDC, within the cap. */
export const acceptable = (r: Requirements, maxAmountStroops: bigint, target: X402Target): string | undefined =>
  r.scheme !== 'exact'
    ? `scheme ${r.scheme} is not supported`
    : r.network !== target.x402Network
      ? `network ${r.network} is not ${target.x402Network}`
      : r.asset !== target.usdcSac
        ? `asset ${r.asset} is not USDC (${target.usdcSac})`
        : !/^\d+$/u.test(r.amount)
          ? `amount ${r.amount} is not an integer`
          : BigInt(r.amount) > maxAmountStroops
            ? `price ${r.amount} is above the cap ${maxAmountStroops}`
            : undefined

const declined = (message: string) => new ChainError({ kind: 'declined', message })

interface Attempt {
  quote: X402Quote | undefined
  failure: ChainError | undefined
  /** The pocket pull's receipt, when the quote hook returns one (S5's two-hash x402 receipt). */
  pull: Receipt | undefined
}

const isReceipt = Schema.is(Receipt)

/**
 * A stock x402 client for the pocket key, with: only our network and asset, the per-payment cap, the quote hook
 * before signing, and `payment-identifier = paymentId` when the seller declares the extension.
 */
const buildClient = (
  pocket: Keypair,
  target: X402Target,
  rpcUrl: string,
  maxAmountStroops: bigint,
  paymentId: string,
  resource: string,
  runQuote: (quote: X402Quote) => Promise<Exit.Exit<unknown, ChainError>>,
  attempt: Attempt,
) => {
  const network = caip2(target.x402Network)
  const scheme = new ExactStellarScheme(createEd25519Signer(pocket.secret(), network), { url: rpcUrl })
  const client = new x402Client()
    .register(network, scheme)
    .registerPolicy((_version, reqs) => reqs.filter(r => acceptable(r, maxAmountStroops, target) === undefined))
  client.setSpendControls({ maxAmountPerPayment: stroopsToUsd(maxAmountStroops) })
  client.onBeforePaymentCreation(async ctx => {
    const r = ctx.selectedRequirements
    const quote = quoteOf(r, ctx.paymentRequired.resource?.url ?? resource)
    attempt.quote = quote
    const refused = acceptable(r, maxAmountStroops, target)
    if (refused !== undefined) {
      attempt.failure = declined(refused)
      return { abort: true, reason: refused }
    }
    const exit = await runQuote(quote)
    if (Exit.isFailure(exit)) {
      const err = Cause.squash(exit.cause)
      attempt.failure = Schema.is(ChainError)(err) ? err : declined(messageOf(err))
      return { abort: true, reason: attempt.failure.message }
    }
    if (isReceipt(exit.value)) attempt.pull = exit.value
    if (ctx.paymentRequired.extensions !== undefined)
      appendPaymentIdentifierToExtensions(ctx.paymentRequired.extensions, normalizePaymentId(paymentId))
    return undefined
  })
  return client
}

export interface X402Deps {
  readonly soroban: Soroban
  readonly target: X402Target
  readonly rpcUrl: string
  readonly fetch: typeof globalThis.fetch
  readonly receipt: (o: TxOutcome) => Receipt
}

interface SettleResponseLike {
  readonly success: boolean
  readonly transaction?: string | undefined
  readonly errorReason?: string | undefined
}

/** Confirm a facilitator settlement onchain and turn it into a receipt (fee payer = the facilitator's account). */
const settled = (deps: X402Deps, settle: SettleResponseLike | undefined) =>
  Effect.gen(function* () {
    if (settle === undefined)
      return yield* new ChainError({ kind: 'submit_failed', message: 'paid request returned no settlement response' })
    if (!settle.success || settle.transaction === undefined || settle.transaction === '')
      return yield* new ChainError({
        kind: 'submit_failed',
        message: `facilitator did not settle: ${settle.errorReason ?? 'unknown reason'}`,
        ...(settle.transaction ? { tx: settle.transaction } : {}),
      })
    return deps.receipt(yield* deps.soroban.getTransaction(settle.transaction))
  })

const failureFrom = (attempt: Attempt, label: string) => (e: unknown) =>
  attempt.failure ?? new ChainError({ kind: 'unknown', message: `${label}: ${messageOf(e)}` })

export const payX402 = (
  deps: X402Deps,
  pocket: Keypair,
  url: string,
  maxAmountStroops: bigint,
  paymentId: string,
  onQuote: X402QuoteHook,
) =>
  Effect.gen(function* () {
    const context = yield* Effect.context()
    const attempt: Attempt = { quote: undefined, failure: undefined, pull: undefined }
    const client = buildClient(
      pocket,
      deps.target,
      deps.rpcUrl,
      maxAmountStroops,
      paymentId,
      url,
      q => Effect.runPromiseExitWith(context)(onQuote(q)),
      attempt,
    )
    const pay = wrapFetchWithPayment(deps.fetch, client)
    const body = yield* Effect.tryPromise({
      try: () => pay(url, { method: 'GET' }),
      catch: failureFrom(attempt, 'x402 fetch'),
    })
    if (attempt.failure !== undefined) return yield* attempt.failure
    if (attempt.quote === undefined) return { body, settlement: null, quote: null, pull: null }
    const header = body.headers.get('PAYMENT-RESPONSE') ?? body.headers.get('X-PAYMENT-RESPONSE')
    if (header === null)
      return yield* new ChainError({
        kind: 'submit_failed',
        message: `seller answered ${body.status} without a settlement (payment not accepted)`,
      })
    const settle = yield* Effect.try({
      try: () => new x402HTTPClient(client).getPaymentSettleResponse(h => body.headers.get(h)),
      catch: e => new ChainError({ kind: 'unknown', message: `unreadable PAYMENT-RESPONSE: ${messageOf(e)}` }),
    })
    const settlement = yield* settled(deps, settle)
    return { body, settlement, quote: attempt.quote, pull: attempt.pull ?? null }
  })

/** The MCP SDK's default validator is Ajv, whose code generation workerd refuses; this one is workerd-safe. */
const toolOutputValidator = new CfWorkerJsonSchemaValidator()

const ToolArgs = Schema.Record(Schema.String, Schema.Unknown)

export const payX402Mcp = (
  deps: X402Deps,
  pocket: Keypair,
  mcpUrl: string,
  tool: string,
  args: unknown,
  maxAmountStroops: bigint,
  paymentId: string,
  onQuote: X402QuoteHook,
) =>
  Effect.gen(function* () {
    const toolArgs = yield* Schema.decodeUnknownEffect(ToolArgs)(args).pipe(
      Effect.mapError(() => new ChainError({ kind: 'unknown', message: 'MCP tool arguments must be a JSON object' })),
    )
    const context = yield* Effect.context()
    const attempt: Attempt = { quote: undefined, failure: undefined, pull: undefined }
    const client = buildClient(
      pocket,
      deps.target,
      deps.rpcUrl,
      maxAmountStroops,
      paymentId,
      `mcp://tool/${tool}`,
      q => Effect.runPromiseExitWith(context)(onQuote(q)),
      attempt,
    )
    const paying = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const mcp = new Client(
            { name: 'stellarmcpwallet', version: '0.1.0' },
            { jsonSchemaValidator: toolOutputValidator },
          )
          const wrapped = wrapMCPClientWithPayment(mcp, client, {
            autoPayment: true,
            onPaymentRequested: ({ paymentRequired }) =>
              paymentRequired.accepts.some(r => acceptable(r, maxAmountStroops, deps.target) === undefined),
          })
          await wrapped.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { fetch: deps.fetch }))
          return wrapped
        },
        catch: e => new ChainError({ kind: 'unknown', message: `MCP connect ${mcpUrl}: ${messageOf(e)}` }),
      }),
      c => Effect.promise(() => c.close().catch(() => undefined)),
    )
    const result = yield* Effect.tryPromise({
      try: () => paying.callTool(tool, toolArgs),
      catch: e =>
        attempt.failure ??
        (/denied/iu.test(messageOf(e))
          ? declined(`payment request denied: no acceptable option within ${maxAmountStroops} stroops`)
          : new ChainError({ kind: 'unknown', message: `MCP tools/call ${tool}: ${messageOf(e)}` })),
    })
    if (attempt.failure !== undefined) return yield* attempt.failure
    const content = { content: result.content, isError: result.isError ?? false }
    if (!result.paymentMade) return { result: content, settlement: null, quote: attempt.quote ?? null, pull: null }
    const settlement = yield* settled(deps, result.paymentResponse)
    return { result: content, settlement, quote: attempt.quote ?? null, pull: attempt.pull ?? null }
  }).pipe(Effect.scoped)

/** Probe a facilitator's `/supported` for our CAIP-2 network (startup and health). */
export const probeFacilitator = (
  fetchImpl: typeof globalThis.fetch,
  url: string,
  x402Network: string,
  bearer?: string,
) =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetchImpl(`${url.replace(/\/$/u, '')}/supported`, {
        headers: bearer === undefined ? {} : { Authorization: `Bearer ${bearer}` },
      })
      if (!res.ok) return { url, ok: false, supportsNetwork: false, status: res.status }
      const text = await res.text()
      return { url, ok: true, supportsNetwork: text.includes(x402Network), status: res.status }
    },
    catch: () => ({ url, ok: false, supportsNetwork: false, status: 0 }),
  }).pipe(Effect.catch(e => Effect.succeed(e)))
