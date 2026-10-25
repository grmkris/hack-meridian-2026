import { z } from 'zod'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import type { PaymentRequirements } from '@x402/core/types'
import {
  PAYMENT_IDENTIFIER,
  declarePaymentIdentifierExtension,
  extractPaymentIdentifier,
} from '@x402/extensions/payment-identifier'
import { createPaymentWrapper, extractPaymentFromMeta, type x402ResourceServer } from '@x402/mcp'

import { marketBrief } from './brief.ts'
import { MAX_TIMEOUT_SECONDS, PRICE_STROOPS, fingerprint, type Env, type Settings } from './config.ts'
import { ensureReady } from './ready.ts'

const TOOL = 'market_brief'

type Paid = ReturnType<ReturnType<typeof createPaymentWrapper>>
let paidTool: Paid | undefined

/** The x402-wrapped handler, built once per isolate after the facilitators' `/supported` answered (src/ready.ts). */
async function paid(rs: x402ResourceServer, s: Settings): Promise<Paid> {
  if (paidTool !== undefined) return paidTool
  await ensureReady(rs)
  const accepts: Array<PaymentRequirements> = await rs.buildPaymentRequirements({
    scheme: 'exact',
    network: s.network,
    payTo: s.payTo,
    price: { amount: PRICE_STROOPS, asset: s.usdcSac },
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
  })
  paidTool = createPaymentWrapper(rs, {
    accepts,
    resource: {
      url: `mcp://tool/${TOOL}`,
      description: `Stellar ${s.stellar} market brief, 0.10 USDC per call`,
      mimeType: 'application/json',
    },
    extensions: { [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(false) },
  })(async (args: { topic?: string | undefined }, context) => {
    const payload = extractPaymentFromMeta({
      name: TOOL,
      arguments: args,
      ...(context.meta ? { _meta: context.meta } : {}),
    })
    const brief = await marketBrief(s, {
      via: 'mcp',
      paymentId: payload ? extractPaymentIdentifier(payload) : null,
      ...(args.topic !== undefined ? { topic: args.topic } : {}),
    })
    return { content: [{ type: 'text' as const, text: JSON.stringify(brief, null, 2) }], structuredContent: brief }
  })
  return paidTool
}

/** Payment-id dedup for the tool, the same contract as the HTTP route (src/dedup.ts). */
async function callTool(
  rs: x402ResourceServer,
  env: Env,
  s: Settings,
  args: { topic?: string | undefined },
  meta: Record<string, unknown> | undefined,
) {
  const handler = await paid(rs, s)
  const extra = meta ? { _meta: meta } : {}
  const payload = extractPaymentFromMeta({ name: TOOL, arguments: args, ...extra })
  const id = payload ? extractPaymentIdentifier(payload) : null
  if (payload === null || id === null) return handler(args, extra)
  const a = payload.accepted
  const fp = fingerprint(['mcp', TOOL, a.scheme, a.network, a.asset, a.amount, a.payTo])
  const ids = env.PAYMENT_IDS.get(env.PAYMENT_IDS.idFromName(id))
  const claim = await ids.claim(fp)
  if (claim.kind === 'hit') {
    const cached = CallToolResultSchema.parse(JSON.parse(claim.response.body))
    return { ...cached, _meta: { ...cached['_meta'], 'x-payment-cache': 'hit' } }
  }
  if (claim.kind !== 'proceed')
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: `payment id ${id}: ${claim.kind === 'conflict' ? 'used for other terms' : 'in progress, retry'}`,
        },
      ],
    }
  try {
    const result = await handler(args, extra)
    if (result.isError !== true && result['_meta']?.['x402/payment-response'] !== undefined)
      await ids.complete(fp, { status: 200, body: JSON.stringify(result), headers: {} })
    else await ids.release(fp)
    return result
  } catch (error) {
    await ids.release(fp)
    throw error
  }
}

/** Stateless Streamable HTTP: one server and transport per POST, JSON responses, no session id. */
export async function handleMcp(request: Request, env: Env, s: Settings, rs: x402ResourceServer): Promise<Response> {
  const server = new McpServer({ name: 'hm26-seller', version: '0.1.0' })
  server.registerTool(
    TOOL,
    {
      title: 'Market brief (paid, 0.10 USDC)',
      description: `A short Stellar ${s.stellar} market brief (XLM/USDC on the DEX, latest ledger). Costs 0.10 USDC per call over x402 on ${s.network}.`,
      inputSchema: { topic: z.string().max(80).optional().describe('Optional focus, e.g. "XLM/USDC"') },
    },
    async (args, extra) => callTool(rs, env, s, args, extra['_meta']),
  )
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true }) // no sessionIdGenerator: stateless
  await server.connect(transport)
  return transport.handleRequest(request)
}
