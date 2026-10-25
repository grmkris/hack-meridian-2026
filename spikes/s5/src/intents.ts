/**
 * `paid_resource_fetch` / `paid_mcp_call` in miniature: an in-memory intent store keyed by idempotency key, a grant
 * check, the pull from the smart account into the pocket, and the stock @x402 client paying from the pocket.
 *
 * Sequence (the order the build must keep):
 *   1. intent lookup by idempotency key: replay → return the stored intent/receipt, do nothing else
 *   2. request → 402 (seller) → terms parsed by the stock client
 *   3. onBeforePaymentCreation (our hook): validate network/asset/scheme; float = USDC already in G(K);
 *      pull = policy(exact | shortfall | chunk); precheck float + remaining ≥ price else → requires_approval;
 *      K pulls from C into G(K) under the rule (enforce simulation refuses over-limit with #3221 → requires_approval)
 *   4. stock ExactStellarScheme signs as G(K); retry; facilitator verifies + settles (fees sponsored)
 *   5. receipt only when the settle response says success; intent → confirmed
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { appendPaymentIdentifierToExtensions } from '@x402/extensions/payment-identifier'
import { x402Client, x402HTTPClient, wrapFetchWithPayment } from '@x402/fetch'
import { wrapMCPClientWithPayment } from '@x402/mcp'
import { createEd25519Signer } from '@x402/stellar'
import { ExactStellarScheme } from '@x402/stellar/exact/client'
import type { Keypair } from '@stellar/stellar-sdk'

import { NETWORK, ms, usdc } from './env'
import { pocketUsdc, policy, pull } from './pocket'
import { InvokeError, RPC_URL, USDC_SAC } from './signer'
import type { TxReport } from './signer'

export type PullPolicy = 'exact' | 'shortfall' | { chunk: bigint }
export type IntentState = 'prepared' | 'pulling' | 'paying' | 'confirmed' | 'failed' | 'requires_approval'

export interface Intent {
  id: string
  idempotencyKey: string
  fingerprint: string
  transport: 'http' | 'mcp'
  target: string
  state: IntentState
  price?: string
  payTo?: string
  floatBefore?: string
  pullAmount?: string
  pull?: { hash: string; ledger?: number; feeCharged?: string; declaredFee: string; resourceFee: string; timings: Record<string, number>; explorer: string }
  settlement?: { success: boolean; transaction?: string; payer?: string; network?: string; errorReason?: string }
  content?: string
  error?: string
  /** ms since the intent started */
  timings: Record<string, number>
}

export const counters = { calls: 0, replays: 0, pulls: 0, pullRefusals: 0, routedToOwner: 0, paymentsSigned: 0, settlements: 0, sellerRequests: 0 }

export class IntentStore {
  private readonly byKey = new Map<string, Intent>()
  private n = 0
  get(key: string) {
    return this.byKey.get(key)
  }
  create(key: string, fingerprint: string, transport: Intent['transport'], target: string): Intent {
    const intent: Intent = {
      id: `int_${Date.now().toString(36)}_${(++this.n).toString().padStart(4, '0')}_${crypto.randomUUID().slice(0, 8)}`,
      idempotencyKey: key,
      fingerprint,
      transport,
      target,
      state: 'prepared',
      timings: {},
    }
    this.byKey.set(key, intent)
    return intent
  }
  all() {
    return [...this.byKey.values()]
  }
}

export interface FetchOpts {
  conn: Keypair
  pull: PullPolicy
  /** service-side grant check before any pull (default true); false = rely on the onchain policy alone */
  precheck?: boolean
  /** per-payment belt for the stock client */
  maxAmountPerPayment?: string
}

class Abort extends Error {}

/** Builds the stock client for G(K) with our grant hook. */
function clientFor(intent: Intent, opts: FetchOpts, t0: number) {
  const scheme = new ExactStellarScheme(createEd25519Signer(opts.conn.secret(), NETWORK), { url: RPC_URL })
  const client = new x402Client().register('stellar:*', scheme)
  client.setSpendControls({ maxAmountPerPayment: opts.maxAmountPerPayment ?? '$1.00' })
  client.onBeforePaymentCreation(async ({ paymentRequired, selectedRequirements: r }) => {
    intent.timings.termsParsed = ms(t0)
    if (r.network !== NETWORK || r.asset !== USDC_SAC || r.scheme !== 'exact') {
      intent.state = 'failed'
      intent.error = `unsupported terms ${r.scheme}/${r.network}/${r.asset}`
      return { abort: true, reason: intent.error }
    }
    const price = BigInt(r.amount)
    intent.price = r.amount
    intent.payTo = r.payTo
    const float = await pocketUsdc(opts.conn)
    intent.floatBefore = float.toString()
    const shortfall = opts.pull === 'exact' ? price : price > float ? price - float : 0n
    let amount = shortfall > 0n ? (typeof opts.pull === 'object' && opts.pull.chunk > shortfall ? opts.pull.chunk : shortfall) : 0n
    if (opts.precheck !== false) {
      const p = await policy()
      intent.timings.precheck = ms(t0)
      if (float + p.remaining < price || (opts.pull === 'exact' && p.remaining < price)) {
        counters.routedToOwner++
        intent.state = 'requires_approval'
        intent.error = `grant check: price ${usdc(price)} > float ${usdc(float)} + remaining ${usdc(p.remaining)}; routed to the owner lane, nothing signed`
        return { abort: true, reason: intent.error }
      }
      if (amount > p.remaining) amount = shortfall // a chunk never exceeds what is left of the grant
    }
    intent.pullAmount = amount.toString()
    if (amount > 0n) {
      intent.state = 'pulling'
      try {
        const rep: TxReport = await pull(opts.conn, amount, `pull ${usdc(amount)} for ${intent.id}`)
        counters.pulls++
        intent.pull = { hash: rep.hash, ledger: rep.ledger, feeCharged: rep.feeCharged, declaredFee: rep.maxFee, resourceFee: rep.resourceFee, timings: rep.timings, explorer: rep.explorer }
      } catch (e) {
        counters.pullRefusals++
        const code = e instanceof InvokeError ? (e.contractError ?? e.detail.slice(0, 160)) : (e as Error).message
        intent.state = code.includes('#3221') ? 'requires_approval' : 'failed'
        intent.error = `pull refused at ${e instanceof InvokeError ? e.stage : '?'}: ${code}`
        return { abort: true, reason: intent.error }
      }
      intent.timings.pulled = ms(t0)
    }
    intent.state = 'paying'
    if (paymentRequired.extensions) appendPaymentIdentifierToExtensions(paymentRequired.extensions, intent.id)
  })
  client.onAfterPaymentCreation(async () => {
    counters.paymentsSigned++
    intent.timings.signed = ms(t0)
  })
  return client
}

function begin(store: IntentStore, key: string, fp: string, transport: Intent['transport'], target: string) {
  counters.calls++
  const existing = store.get(key)
  if (existing) {
    if (existing.fingerprint !== fp) throw new Abort(`idempotency key ${key} reused for a different request`)
    counters.replays++
    return { replayed: true as const, intent: existing }
  }
  return { replayed: false as const, intent: store.create(key, fp, transport, target) }
}

/** paid_resource_fetch(url, idempotency_key) */
export async function paidResourceFetch(store: IntentStore, url: string, idempotencyKey: string, opts: FetchOpts) {
  const b = begin(store, idempotencyKey, JSON.stringify(['GET', url]), 'http', url)
  if (b.replayed) return b
  const intent = b.intent
  const t0 = performance.now()
  const timedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    counters.sellerRequests++
    const req = new Request(input as RequestInfo, init)
    const paid = req.headers.has('payment-signature')
    const res = await fetch(req)
    intent.timings[paid ? 'paidResponse' : 'firstResponse'] = ms(t0)
    return res
  }) as typeof fetch
  const client = clientFor(intent, opts, t0)
  try {
    const res = await wrapFetchWithPayment(timedFetch, client)(url)
    intent.content = (await res.text()).slice(0, 300)
    if (res.headers.get('payment-response')) {
      const s = new x402HTTPClient(client).getPaymentSettleResponse(h => res.headers.get(h))
      intent.settlement = { success: s.success, transaction: s.transaction, payer: s.payer, network: s.network, errorReason: s.errorReason }
    }
    if (res.status === 200 && intent.settlement?.success) {
      intent.state = 'confirmed'
      counters.settlements++
    } else {
      intent.state = 'failed'
      intent.error ??= `seller answered ${res.status}`
    }
  } catch (e) {
    if (intent.state !== 'requires_approval' && intent.state !== 'failed') intent.state = 'failed'
    intent.error ??= (e as Error).message
  }
  intent.timings.total = ms(t0)
  return { replayed: false as const, intent }
}

/** paid_mcp_call(server, tool, args, idempotency_key) over @x402/mcp */
export async function paidMcpCall(store: IntentStore, mcpUrl: string, tool: string, args: Record<string, unknown>, idempotencyKey: string, opts: FetchOpts) {
  const b = begin(store, idempotencyKey, JSON.stringify(['MCP', mcpUrl, tool, args]), 'mcp', `${mcpUrl}#${tool}`)
  if (b.replayed) return b
  const intent = b.intent
  const t0 = performance.now()
  const client = clientFor(intent, opts, t0)
  const mcp = new Client({ name: 's5-wallet', version: '0.0.0' })
  const paying = wrapMCPClientWithPayment(mcp, client, { autoPayment: true, onPaymentRequested: () => true })
  try {
    await paying.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)))
    intent.timings.connected = ms(t0)
    const r = await paying.callTool(tool, args)
    intent.content = JSON.stringify(r.content).slice(0, 300)
    const s = r.paymentResponse
    if (s) intent.settlement = { success: s.success, transaction: s.transaction, payer: s.payer, network: s.network, errorReason: s.errorReason }
    if (!r.isError && s?.success) {
      intent.state = 'confirmed'
      counters.settlements++
    } else {
      intent.state = 'failed'
      intent.error ??= `tool result isError=${r.isError}`
    }
  } catch (e) {
    if (intent.state !== 'requires_approval' && intent.state !== 'failed') intent.state = 'failed'
    intent.error ??= (e as Error).message
  } finally {
    await paying.close().catch(() => {})
  }
  intent.timings.total = ms(t0)
  return { replayed: false as const, intent }
}
