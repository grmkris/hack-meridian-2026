import { z } from 'zod'

import type { OAuthResourceContext } from '@cloudflare/workers-oauth-provider'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import type { ConnectionProps, Env } from './env.ts'
import { ledger, statusOf, type PaymentIntent } from './payments.ts'

/** The grant the owner set on the consent page, from the OAuth grant's props (nothing spent in the spike). */
function grantView(props: ConnectionProps) {
  const { grant } = props
  return {
    grant_id: grant.grant_id,
    asset: grant.asset,
    total: grant.allowance,
    spent: '0.00',
    remaining: grant.allowance,
    valid_until: grant.valid_until,
    status: Date.parse(grant.valid_until) > Date.now() ? 'active' : 'expired',
  }
}

/** A plain sentence first (hosts that do not render structuredContent still show it), then the JSON. */
const json = (value: unknown, sentence?: string): CallToolResult => ({
  content: [
    ...(sentence !== undefined ? [{ type: 'text' as const, text: sentence }] : []),
    { type: 'text', text: JSON.stringify(value, null, 2) },
  ],
  structuredContent: value as Record<string, unknown>,
})

function paymentView(intent: PaymentIntent, origin: string, props: ConnectionProps) {
  const status = statusOf(intent)
  return {
    payment_id: intent.payment_id,
    status,
    amount: intent.amount,
    asset: intent.asset,
    recipient: intent.recipient,
    network: intent.network,
    lane: intent.lane,
    expires_at: intent.expires_at,
    ...(status === 'awaiting_approval' ? { approval_url: `${origin}/approve/${intent.payment_id}` } : {}),
    ...(status === 'confirmed' ? { receipt: intent.receipt } : {}),
    grant_remaining: props.grant.allowance,
  }
}

function buildServer(env: Env, props: ConnectionProps, origin: string): McpServer {
  const server = new McpServer({ name: 'stellarmcpwallet-s4', version: '0.0.1' })
  const payments = ledger(env.PAYMENTS)

  server.registerTool(
    'wallet_overview',
    {
      title: 'Wallet overview',
      description:
        'Wallet balance, this connection’s spending allowance (remaining and expiry) and pending approvals. The wallet balance and the allowance are different numbers.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      json({
        wallet: {
          id: props.wallet_id,
          name: props.wallet_name,
          network: 'stellar:testnet',
          contract_id: 'C…(fixture)',
        },
        balance: { asset: 'USDC', amount: '50.00' },
        allowance: grantView(props),
        pending_approvals: await payments.pending(props.connection_id),
        connection: { id: props.connection_id, client_name: props.client_name },
      }),
  )

  server.registerTool(
    'payment_prepare',
    {
      title: 'Prepare a payment',
      description:
        'Freeze a payment intent. In this spike every payment goes to the owner lane and returns status requires_approval with an approval_url: show the URL to the user, then poll payment_status.',
      inputSchema: {
        recipient: z.string().min(1).describe('Contact name or Stellar address (G…, C…, M…)'),
        amount: z
          .string()
          .regex(/^\d+(\.\d{1,7})?$/u)
          .describe('Decimal amount, e.g. "100" or "2.50"'),
        asset: z.literal('USDC').default('USDC'),
        reason: z
          .string()
          .max(280)
          .optional()
          .describe('Why the agent is paying; shown to the owner as the agent’s claim'),
        idempotency_key: z.string().max(128).optional(),
      },
    },
    async args => {
      const intent = await payments.prepare({
        connection_id: props.connection_id,
        requester: props.client_name,
        recipient: args.recipient,
        amount: args.amount,
        asset: 'USDC',
        network: 'stellar:testnet',
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
        ...(args.idempotency_key !== undefined ? { idempotency_key: args.idempotency_key } : {}),
      })
      const view = paymentView(intent, origin, props)
      const sentence =
        view.approval_url !== undefined
          ? `This payment of ${intent.amount} ${intent.asset} to ${intent.recipient} needs the wallet owner's approval. Ask the user to open ${view.approval_url} and approve it, then call payment_status with payment_id ${intent.payment_id}.`
          : `Payment ${intent.payment_id} is ${view.status}.`
      return json(
        { ...view, status: view.status === 'awaiting_approval' ? 'requires_approval' : view.status },
        sentence,
      )
    },
  )

  server.registerTool(
    'payment_status',
    {
      title: 'Payment status',
      description:
        'State of a payment intent: awaiting_approval, submitted, confirmed (with receipt) or expired. Never triggers a payment.',
      inputSchema: { payment_id: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ payment_id }) => {
      const intent = await payments.get(payment_id)
      if (intent === undefined || intent.connection_id !== props.connection_id)
        return { isError: true, content: [{ type: 'text', text: `Unknown payment ${payment_id}` }] }
      const view = paymentView(intent, origin, props)
      const sentence =
        view.status === 'awaiting_approval'
          ? `Still waiting for the owner to approve at ${view.approval_url}.`
          : view.status === 'confirmed'
            ? `Confirmed. Receipt ${intent.receipt?.tx_hash}.`
            : `Payment ${intent.payment_id} is ${view.status}.`
      return json(view, sentence)
    },
  )
  return server
}

/**
 * The MCP endpoint, reached only with a valid bearer token (OAuthProvider answers 401 + WWW-Authenticate otherwise).
 * Stateless Streamable HTTP: a fresh server and transport per POST, JSON responses, no session id, no GET stream.
 */
export const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: OAuthResourceContext<ConnectionProps>): Promise<Response> {
    if (request.method !== 'POST')
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } })
    const origin = new URL(request.url).origin
    const server = buildServer(env, ctx.props, origin)
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    await server.connect(transport)
    return transport.handleRequest(request, {
      authInfo: {
        token: ctx.auth.token,
        clientId: ctx.auth.clientId ?? ctx.props.client_id,
        scopes: ctx.auth.scope,
        ...(ctx.auth.expiresAt !== undefined ? { expiresAt: ctx.auth.expiresAt } : {}),
        extra: { connection_id: ctx.props.connection_id },
      },
    })
  },
}
