import { Hono } from 'hono'

import {
  PAYMENT_IDENTIFIER,
  declarePaymentIdentifierExtension,
  paymentIdentifierResourceServerExtension,
} from '@x402/extensions/payment-identifier'
import { paymentMiddleware, x402ResourceServer } from '@x402/hono'
import { ExactStellarScheme } from '@x402/stellar/exact/server'

import { marketBrief } from './brief.ts'
import {
  MAX_TIMEOUT_SECONDS,
  PRICE_DISPLAY,
  PRICE_STROOPS,
  settings as resolve,
  type AppEnv,
  type Env,
  type Settings,
} from './config.ts'
import { paymentIdDedup } from './dedup.ts'
import { FallbackFacilitator } from './facilitator.ts'
import { handleMcp } from './mcp.ts'
import { ensureReady } from './ready.ts'

export { PaymentIds } from './payment-ids.ts'

const SOURCE = 'https://github.com/grmkris/hack-meridian-2026/tree/main/apps/seller'

/**
 * hm26-seller: the demo's x402 seller. `GET /api/market-brief` costs 0.10 USDC over HTTP x402; the same brief is the
 * paid MCP tool `market_brief` on `POST /mcp`. Both dedup by x402 `payment-identifier` in a Durable Object, settle
 * through the configured facilitators (testnet: x402.org, then OpenZeppelin Channels), and pay `PAY_TO`. The network,
 * asset, payTo and facilitators come from the deployment's vars (src/config.ts presets, `STELLAR_NETWORK`).
 */
function build(s: Settings): Hono<AppEnv> {
  const rs = new x402ResourceServer(new FallbackFacilitator(s))
    .register(s.network, new ExactStellarScheme())
    .registerExtension(paymentIdentifierResourceServerExtension)
  const info = {
    name: 'hm26-seller',
    network: s.network,
    asset: { code: 'USDC', sac: s.usdcSac, issuer: s.usdcIssuer },
    price: { display: PRICE_DISPLAY, stroops: PRICE_STROOPS },
    pay_to: s.payTo,
    facilitators: s.facilitators.map(f => ({ name: f.name, url: f.url })),
    endpoints: { http: 'GET /api/market-brief', mcp: 'POST /mcp → tool market_brief' },
    extensions: [PAYMENT_IDENTIFIER],
    explorer: `${s.explorer}/account/${s.payTo}`,
    source: SOURCE,
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
              price: { amount: PRICE_STROOPS, asset: s.usdcSac },
              network: s.network,
              payTo: s.payTo,
              maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
            },
          ],
          description: `Stellar ${s.stellar} market brief (demo x402 seller for Nod)`,
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
  app.get('/api/market-brief', async c => c.json(await marketBrief(s, { via: 'http', paymentId: c.get('paymentId') })))
  app.post('/mcp', c => handleMcp(c.req.raw, c.env, s, rs))
  app.on(['GET', 'DELETE'], '/mcp', c => c.text('Method Not Allowed', 405, { allow: 'POST' }))
  return app
}

/** A deployment whose vars do not resolve serves its problems and refuses every paid route (503). */
function misconfigured(problems: ReadonlyArray<string>): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const body = { name: 'hm26-seller', ok: false, error: 'seller_misconfigured', problems, source: SOURCE }
  app.get('/', c => c.json(body, 503))
  app.all('*', c => c.json(body, 503))
  return app
}

let built: { readonly key: string; readonly app: Hono<AppEnv> } | undefined
const appFor = (env: Env) => {
  const key = JSON.stringify([
    env.STELLAR_NETWORK,
    env.PAY_TO,
    env.USDC_SAC,
    env.FACILITATOR,
    env.FACILITATOR_URL,
    env.OZ_FACILITATOR_URL,
    env.OZ_FACILITATOR_KEY !== undefined,
  ])
  if (built?.key !== key) {
    const resolved = resolve(env)
    built = { key, app: resolved.ok ? build(resolved.value) : misconfigured(resolved.problems) }
  }
  return built.app
}

export default {
  fetch: (request, env, ctx) => appFor(env).fetch(request, env, ctx),
} satisfies ExportedHandler<Env>
