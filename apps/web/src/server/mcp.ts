import { Effect, Predicate, Schema } from 'effect'

import {
  ConnectionGrantCreateInput,
  ConnectionGrantRevokeInput,
  ContactsSearchInput,
  PaidMcpCallInput,
  PaidResourceFetchInput,
  PaymentApproveUrlInput,
  PaymentExecuteInput,
  PaymentPrepareInput,
  PaymentStatusInput,
  type ToolName,
  WalletOverviewInput,
} from '@hm/protocol'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import type { DbError } from './db.ts'
import type { LedgerError } from './ledger.ts'
import type { AppRuntime, AppServices } from './runtime.ts'
import {
  asToolError,
  connectionGrantCreate,
  connectionGrantRevoke,
  contactsSearch,
  paidMcpCall,
  paidResourceFetch,
  paymentApproveUrl,
  paymentExecute,
  paymentPrepare,
  paymentStatus,
  type ToolContext,
  ToolError,
  type ToolResult,
  walletOverview,
} from './tools.ts'

/**
 * /mcp: stateless Streamable HTTP behind the OAuth provider (a valid bearer is already checked), a fresh server and
 * transport per POST, JSON responses, no sessions, GET → 405. Tool inputs are the protocol's Effect Schemas, listed
 * as JSON Schema and decoded on every call.
 */

type ToolRun = Effect.Effect<ToolResult<unknown>, ToolError | DbError | LedgerError, AppServices>

interface ToolSpec {
  readonly name: ToolName
  readonly title: string
  readonly description: string
  readonly input: Schema.Constraint & { readonly DecodingServices: never }
  readonly annotations: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
  /** Runs with input already decoded by `input`. */
  readonly run: (ctx: ToolContext, args: unknown) => ToolRun
}

const spec = <S extends Schema.Constraint & { readonly DecodingServices: never }>(
  name: ToolName,
  title: string,
  description: string,
  input: S,
  annotations: ToolSpec['annotations'],
  run: (ctx: ToolContext, args: S['Type']) => ToolRun,
): ToolSpec => ({
  name,
  title,
  description,
  input,
  annotations,
  // callTool decodes `args` with this same `input` schema before calling run.
  run: (ctx, args) => run(ctx, args),
})

const TOOLS = [
  spec(
    'wallet_overview',
    'Wallet overview',
    "The wallet's USDC balance, this connection's spending allowance (remaining and expiry), payments waiting for the owner, and recent receipts. The wallet balance and the allowance are different numbers: only the allowance can be spent without the owner.",
    WalletOverviewInput,
    { readOnlyHint: true, openWorldHint: false },
    ctx => walletOverview(ctx),
  ),
  spec(
    'contacts_search',
    'Search contacts',
    "Find the owner's saved contacts by name, alias or address. Each destination says whether it can receive USDC now (usdc_ready), needs the recipient to accept first (trustline_required), does not exist (account_missing), and whether it was paid before.",
    ContactsSearchInput,
    { readOnlyHint: true, openWorldHint: false },
    (ctx, args) => contactsSearch(ctx, args.query),
  ),
  spec(
    'payment_prepare',
    'Prepare a payment',
    'Freeze a USDC payment to a contact or address into an intent with a quote: lane autonomous (inside the allowance: call payment_execute next) or owner (status awaiting_approval with an approval_url the user must open and approve with their passkey). Never pays by itself. Repeat with the same idempotency_key to get the same intent.',
    PaymentPrepareInput,
    { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    (ctx, args) => paymentPrepare(ctx, args),
  ),
  spec(
    'payment_execute',
    'Execute a payment',
    "Pay a prepared intent in the autonomous lane with this connection's key, within its onchain allowance. Refuses owner-lane intents and returns their approval_url instead. Returns the confirmed receipt; a repeat never pays twice.",
    PaymentExecuteInput,
    { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    (ctx, args) => paymentExecute(ctx, args.payment_id),
  ),
  spec(
    'payment_approve_url',
    'Approval link',
    'The link the wallet owner opens to approve an intent that needs their passkey. Opening it has no side effect.',
    PaymentApproveUrlInput,
    { readOnlyHint: true, openWorldHint: false },
    (ctx, args) => paymentApproveUrl(ctx, args.payment_id),
  ),
  spec(
    'payment_status',
    'Payment status',
    'The state of a payment intent (prepared, awaiting_approval, submitted, confirmed, failed, expired) and its receipt once confirmed onchain. Never triggers a payment; poll it after the owner approves.',
    PaymentStatusInput,
    { readOnlyHint: true, openWorldHint: false },
    (ctx, args) => paymentStatus(ctx, args.payment_id),
  ),
  spec(
    'paid_resource_fetch',
    'Fetch a paid resource (x402)',
    'GET a URL. If it answers 402 with a Stellar testnet USDC price that fits the allowance, pay it from this connection (no owner prompt) and return the content with the receipt; otherwise return requires_approval or refused. Same idempotency_key = never pays twice.',
    PaidResourceFetchInput,
    { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    (ctx, args) => paidResourceFetch(ctx, args),
  ),
  spec(
    'paid_mcp_call',
    'Call a paid MCP tool (x402)',
    "Call a tool on another MCP server that charges over x402, paying from this connection's allowance like paid_resource_fetch.",
    PaidMcpCallInput,
    { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    (ctx, args) => paidMcpCall(ctx, args),
  ),
  spec(
    'connection_grant_create',
    'Ask for an allowance',
    "Return the link where the owner creates or renews this connection's allowance. Never grants anything itself.",
    ConnectionGrantCreateInput,
    { readOnlyHint: true, openWorldHint: false },
    (ctx, args) => connectionGrantCreate(ctx, args.idempotency_key),
  ),
  spec(
    'connection_grant_revoke',
    'Revoke this connection',
    "Stop this connection's allowance immediately (the service refuses to sign from now on) and sweep its pocket back to the wallet; removing the onchain rule needs the owner's passkey at the returned link.",
    ConnectionGrantRevokeInput,
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    (ctx, args) => connectionGrantRevoke(ctx, args.idempotency_key),
  ),
]

/** JSON Schema of a tool input, as MCP lists it. */
const inputJsonSchema = (input: Schema.Constraint) => {
  const document = Schema.toJsonSchemaDocument(input)
  return { ...document.schema, type: 'object' as const }
}

const errorResult = (message: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text: message }] })

const resultOf = (result: ToolResult<unknown>): CallToolResult => ({
  content: [
    { type: 'text', text: result.sentence },
    { type: 'text', text: JSON.stringify(result.value, null, 2) },
  ],
  structuredContent: Predicate.isObject(result.value) ? { ...result.value } : { value: result.value },
})

export const callTool = (
  runtime: AppRuntime,
  ctx: ToolContext,
  name: string,
  args: unknown,
): Promise<CallToolResult> => {
  const tool = TOOLS.find(candidate => candidate.name === name)
  if (tool === undefined) return Promise.resolve(errorResult(`Unknown tool ${name}.`))
  const program = Schema.decodeUnknownEffect(tool.input)(args ?? {}).pipe(
    Effect.mapError(error => new ToolError({ message: `Invalid arguments for ${name}: ${error.message}` })),
    Effect.flatMap(decoded => tool.run(ctx, decoded)),
  )
  return runtime.runPromise(
    asToolError(program).pipe(
      Effect.map(resultOf),
      Effect.catchTag('ToolError', error => Effect.succeed(errorResult(error.message))),
      Effect.catchCause(cause =>
        Effect.as(
          Effect.logError('tool failed', name, cause),
          errorResult(`${name} failed unexpectedly; retry with the same idempotency key.`),
        ),
      ),
    ),
  )
}

export const listTools = () =>
  TOOLS.map(tool => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: inputJsonSchema(tool.input),
    annotations: { title: tool.title, ...tool.annotations },
  }))

/** Serve one MCP POST for a connection. */
export const serveMcp = async (
  runtime: AppRuntime,
  request: Request,
  ctx: ToolContext,
  auth: { token: string; clientId: string; scopes: Array<string>; expiresAt?: number },
) => {
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } })
  const server = new Server(
    { name: 'stellarmcpwallet', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'A Stellar testnet USDC wallet with a spending allowance for this connection. Payments inside the allowance go through on their own; anything bigger returns an approval_url that you must show the user verbatim, then poll payment_status. Always pass a fresh idempotency_key per intended payment and reuse it on retries.',
    },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools() }))
  server.setRequestHandler(CallToolRequestSchema, async call =>
    callTool(runtime, ctx, call.params.name, call.params.arguments),
  )
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
  await server.connect(transport)
  return transport.handleRequest(request, {
    authInfo: {
      token: auth.token,
      clientId: auth.clientId,
      scopes: auth.scopes,
      ...(auth.expiresAt === undefined ? {} : { expiresAt: auth.expiresAt }),
    },
  })
}
