/**
 * S5 paid MCP server: S2's server (spikes/s2/mcp/server.ts) with counters at GET /stats. One tool `paid_quote`
 * wrapped by @x402/mcp `createPaymentWrapper` at $0.10 on stellar:testnet, plus a free `ping`.
 *
 *   bun src/mcp-seller.ts                      # OpenZeppelin Channels on :4052 (default here)
 *   FACILITATOR=hosted bun src/mcp-seller.ts   # x402.org
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { createPaymentWrapper, x402ResourceServer } from '@x402/mcp'
import { ExactStellarScheme } from '@x402/stellar/exact/server'
import { z } from 'zod'

import { MCP_SELLER_PORT, NETWORK, PAY_TO } from './env'
import { facilitatorClient, facilitatorFromEnv, facilitatorStats } from './facilitators'

const MODE = facilitatorFromEnv('oz')
const rs = new x402ResourceServer(facilitatorClient(MODE)).register(NETWORK, new ExactStellarScheme())
await rs.initialize()
const accepts = await rs.buildPaymentRequirements({ scheme: 'exact', network: NETWORK, payTo: PAY_TO, price: '$0.10', maxTimeoutSeconds: 60 })
const stats = { toolCalls: 0, unpaidCalls: 0, paidAttempts: 0, executed: 0, settled: 0 }

const paid = createPaymentWrapper(rs, {
  accepts,
  resource: { url: 'mcp://tool/paid_quote', description: 'S5 paid quote over MCP', mimeType: 'application/json' },
  hooks: {
    onBeforeExecution: () => void stats.executed++,
    onAfterSettlement: ({ settlement }) => {
      stats.settled++
      console.log(`[mcp-seller] settled ${JSON.stringify(settlement)}`)
    },
  },
})

let served = 0
function build() {
  const mcp = new McpServer({ name: 's5-paid-mcp', version: '0.0.0' })
  mcp.registerTool('ping', { description: 'free', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'pong' }] }))
  mcp.registerTool(
    'paid_quote',
    { description: 'A quote for 0.10 USDC (x402, stellar:testnet)', inputSchema: { topic: z.string().optional() } },
    paid(async (args: { topic?: string }) => ({
      content: [{ type: 'text', text: JSON.stringify({ quote: `Ledgers close every ~5s (${args.topic ?? 'general'}).`, served: ++served }) }],
    })) as never,
  )
  return mcp
}

Bun.serve({
  port: MCP_SELLER_PORT,
  idleTimeout: 120,
  async fetch(req) {
    const path = new URL(req.url).pathname
    if (path === '/stats') return Response.json({ mode: MODE, payTo: PAY_TO, ...stats, facilitator: facilitatorStats })
    if (path !== '/mcp') return new Response('not found', { status: 404 })
    if (req.method === 'POST') {
      try {
        const body = (await req.clone().json()) as { method?: string; params?: { name?: string; _meta?: Record<string, unknown> } }
        if (body.method === 'tools/call' && body.params?.name === 'paid_quote') {
          stats.toolCalls++
          if (body.params._meta?.['x402/payment']) stats.paidAttempts++
          else stats.unpaidCalls++
        }
      } catch {}
    }
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await build().connect(transport)
    return transport.handleRequest(req)
  },
})
console.log(`[mcp-seller] ${MODE} facilitator, http://127.0.0.1:${MCP_SELLER_PORT}/mcp payTo ${PAY_TO}`)
