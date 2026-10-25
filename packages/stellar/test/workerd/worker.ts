import { ConfigProvider, Effect, Layer } from 'effect'

/**
 * workerd smoke for @hm/stellar: `wrangler dev` this file (see test/workerd/README in the a2 reply) with the chain
 * package's secrets as vars, then GET /probe (health) and GET /seller (x402 HTTP + MCP from a pocket).
 */
import { Chain } from '@hm/protocol'

import { stellarLayer, type StellarOps } from '../../src/index.ts'
import { sellerRound, treasuryAddressOf } from './seller-round.ts'

type Env = Record<string, string>

const json = (v: unknown, status = 200) =>
  new Response(
    JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2),
    {
      status,
      headers: { 'content-type': 'application/json' },
    },
  )

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const layer = stellarLayer(globalThis.fetch.bind(globalThis)).pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))),
    )
    const path = new URL(request.url).pathname
    const program: Effect.Effect<unknown, unknown, Chain | StellarOps> =
      path === '/seller'
        ? sellerRound(env['SELLER_URL'] ?? '', treasuryAddressOf(env['TREASURY_SECRET'] ?? ''), 'workerd')
        : Effect.gen(function* () {
            return yield* (yield* Chain).health
          })
    const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(layer)))
    return exit._tag === 'Success' ? json(exit.value) : json({ failure: String(exit.cause) }, 500)
  },
}
