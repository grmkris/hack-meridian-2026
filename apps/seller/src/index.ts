import { Hono } from 'hono'

import {
  PAYMENT_IDENTIFIER,
  declarePaymentIdentifierExtension,
  paymentIdentifierResourceServerExtension,
} from '@x402/extensions/payment-identifier'
import { paymentMiddleware, x402ResourceServer } from '@x402/hono'
import { ExactStellarScheme } from '@x402/stellar/exact/server'

import { marketBrief } from './brief.ts'
import { MAX_TIMEOUT_SECONDS, NETWORK, PRICE, PRICE_STROOPS, USDC_SAC, type AppEnv, type Env } from './config.ts'
import { paymentIdDedup } from './dedup.ts'
import { FallbackFacilitator, facilitatorOrder } from './facilitator.ts'
import { handleMcp } from './mcp.ts'
import { ensureReady } from './ready.ts'

export { PaymentIds } from './payment-ids.ts'

/**
 * hm26-seller: the demo's x402 seller on stellar:testnet. `GET /api/market-brief` costs 0.10 USDC over HTTP x402; the
 * same brief is the paid MCP tool `market_brief` on `POST /mcp`. Both dedup by x402 `payment-identifier` in a Durable
 * Object, settle through x402.org with OpenZeppelin Channels as the fallback, and pay `PAY_TO`.
 */
function build(env: Env): Hono<AppEnv> {
  const rs = new x402ResourceServer(new FallbackFacilitator(env))
    .register(NETWORK, new ExactStellarScheme())
    .registerExtension(paymentIdentifierResourceServerExtension)
  const info = {
    name: 'hm26-seller',
    network: NETWORK,
    asset: { code: 'USDC', sac: USDC_SAC },
    price: { usd: PRICE, stroops: PRICE_STROOPS },
    pay_to: env.PAY_TO,
    facilitators: facilitatorOrder(env),
    endpoints: { http: 'GET /api/market-brief', mcp: 'POST /mcp → tool market_brief' },
    extensions: [PAYMENT_IDENTIFIER],
    source: 'https://github.com/grmkris/hack-meridian-2026/tree/main/apps/seller',
  }
  const app = new Hono<AppEnv>()
  app.get('/', c => c.json(info))
  app.get('/health', c => c.json({ ok: true, ...info }))
  app.use('/api/*', async (_c, next) => {
    await ensureReady(rs)
    await next()
  })
  app.use('/api/*', paymentIdDedup)
  app.use(
    '/api/*',
    paymentMiddleware(
      {
        'GET /api/market-brief': {
          accepts: [
            {
              scheme: 'exact',
              price: PRICE,
              network: NETWORK,
              payTo: env.PAY_TO,
              maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
            },
          ],
          description: 'Stellar testnet market brief (stellarmcpwallet demo seller)',
          mimeType: 'application/json',
          extensions: { [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(false) },
        },
      },
      rs,
      undefined,
      undefined,
      false, // initialized per request by ensureReady, never from a promise another request started
    ),
  )
  app.get('/api/market-brief', async c => c.json(await marketBrief({ via: 'http', paymentId: c.get('paymentId') })))
  app.post('/mcp', c => handleMcp(c.req.raw, env, rs))
  app.on(['GET', 'DELETE'], '/mcp', c => c.text('Method Not Allowed', 405, { allow: 'POST' }))
  return app
}

let built: { readonly key: string; readonly app: Hono<AppEnv> } | undefined
const appFor = (env: Env) => {
  const key = JSON.stringify([env.PAY_TO, env.FACILITATOR ?? '', env.OZ_FACILITATOR_KEY !== undefined])
  if (built?.key !== key) built = { key, app: build(env) }
  return built.app
}

export default {
  fetch: (request, env, ctx) => appFor(env).fetch(request, env, ctx),
} satisfies ExportedHandler<Env>
