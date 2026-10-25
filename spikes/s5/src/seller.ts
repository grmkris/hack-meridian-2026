/**
 * S5 HTTP seller: S2's Hono seller (spikes/s2/seller/index.ts) with request and facilitator counters at GET /stats.
 *   GET /paid/quote   $0.10   (purchases A, chunking, idempotency)
 *   GET /paid/report  $1.00   (budget exhaustion: price above pocket float + remaining allowance)
 *
 *   bun src/seller.ts                    # x402.org facilitator on :4051
 *   FACILITATOR=oz HTTP_SELLER_PORT=4053 bun src/seller.ts
 *
 * Payment-identifier cache as in S2 (the @x402/hono 2.28.0 middleware has none): same id + same fingerprint → cached
 * 200 + PAYMENT-RESPONSE without calling the facilitator; same id, different fingerprint → 409.
 */
import { decodePaymentSignatureHeader } from '@x402/core/http'
import {
  PAYMENT_IDENTIFIER,
  declarePaymentIdentifierExtension,
  extractPaymentIdentifier,
  paymentIdentifierResourceServerExtension,
} from '@x402/extensions/payment-identifier'
import { paymentMiddleware, x402ResourceServer } from '@x402/hono'
import { ExactStellarScheme } from '@x402/stellar/exact/server'
import { Hono } from 'hono'

import { HTTP_SELLER_PORT, NETWORK, PAY_TO } from './env'
import { facilitatorClient, facilitatorFromEnv, facilitatorStats } from './facilitators'

const MODE = facilitatorFromEnv('hosted')
const resourceServer = new x402ResourceServer(facilitatorClient(MODE))
  .register(NETWORK, new ExactStellarScheme())
  .registerExtension(paymentIdentifierResourceServerExtension)

type Cached = { fingerprint: string; status: number; body: string; headers: Record<string, string> }
const cache = new Map<string, Cached>()
const stats = { requests: 0, unpaid402: 0, paidAttempts: 0, served: 0, cacheHits: 0 }
const fingerprint = (method: string, path: string, a: { scheme: string; network: string; asset: string; amount: string; payTo: string }) =>
  JSON.stringify([a.scheme, a.network, a.asset, a.amount, a.payTo, method, path])

const app = new Hono()
app.get('/stats', c => c.json({ mode: MODE, payTo: PAY_TO, ...stats, facilitator: facilitatorStats, cached: cache.size }))

app.use('/paid/*', async (c, next) => {
  stats.requests++
  const header = c.req.header('payment-signature') ?? c.req.header('x-payment')
  if (!header) {
    await next()
    if (c.res.status === 402) stats.unpaid402++
    return
  }
  stats.paidAttempts++
  let id: string | null = null
  let fp = ''
  try {
    const payload = decodePaymentSignatureHeader(header)
    id = extractPaymentIdentifier(payload)
    fp = fingerprint(c.req.method, c.req.path, payload.accepted)
  } catch {
    return next()
  }
  if (id) {
    const hit = cache.get(id)
    if (hit && hit.fingerprint !== fp) return c.json({ error: 'payment_identifier_conflict', id }, 409)
    if (hit) {
      stats.cacheHits++
      console.log(`[seller] payment-identifier ${id}: cache hit, no verify/settle`)
      return new Response(hit.body, { status: hit.status, headers: { ...hit.headers, 'x-s5-cache': 'hit' } })
    }
  }
  await next()
  const receipt = c.res.headers.get('payment-response')
  if (c.res.status === 200 && receipt && id) {
    const body = await c.res.clone().text()
    const headers: Record<string, string> = {}
    c.res.headers.forEach((v, k) => (headers[k] = v))
    cache.set(id, { fingerprint: fp, status: 200, body, headers })
  }
})

const route = (description: string, price: string) => ({
  accepts: [{ scheme: 'exact' as const, price, network: NETWORK, payTo: PAY_TO, maxTimeoutSeconds: 60 }],
  description,
  mimeType: 'application/json',
  extensions: { [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(false) },
})
app.use(
  paymentMiddleware(
    { 'GET /paid/quote': route('S5 paid quote', '$0.10'), 'GET /paid/report': route('S5 paid report', '$1.00') },
    resourceServer,
  ),
)
app.get('/paid/quote', c => c.json({ quote: 'Ledgers close every ~5s.', served: ++stats.served, at: new Date().toISOString() }))
app.get('/paid/report', c => c.json({ report: 'A dollar of insight.', served: ++stats.served, at: new Date().toISOString() }))

console.log(`[seller] ${MODE} facilitator, payTo ${PAY_TO}, http://127.0.0.1:${HTTP_SELLER_PORT}/paid/{quote,report}`)
export default { port: HTTP_SELLER_PORT, fetch: app.fetch, idleTimeout: 120 }
