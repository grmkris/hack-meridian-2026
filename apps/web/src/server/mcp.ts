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
    "The Nod wallet's USDC balance and network, the allowance this AI app may spend on its own (left and expiry), payments waiting for the user's nod, and recent receipts. The wallet balance and the allowance are different numbers: only the allowance can be spent without asking the user.",
    WalletOverviewInput,
    { readOnlyHint: true, openWorldHint: false },
    ctx => walletOverview(ctx),
  ),
  spec(
    'contacts_search',
    'Search contacts',
    "Find the user's saved contacts by name, alias or address. Each destination says whether it can receive USDC now (usdc_ready), needs the recipient to accept a claim link first (trustline_required), does not exist (account_missing), and whether it was paid before.",
    ContactsSearchInput,
    { readOnlyHint: true, openWorldHint: false },
    (ctx, args) => contactsSearch(ctx, args.query),
  ),
  spec(
    'payment_prepare',
    'Prepare a payment',
    "Freeze a USDC payment to a contact or address into an intent. Inside this AI app's allowance it comes back ready (call payment_execute next); anything bigger needs the user's nod: status awaiting_approval with an approval_url the user opens and approves with their passkey. Never pays by itself. Repeat with the same idempotency_key to get the same intent.",
    PaymentPrepareInput,
    { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    (ctx, args) => paymentPrepare(ctx, args),
  ),
  spec(
    'payment_execute',
    'Execute a payment',
    "Pay a prepared intent from this AI app's allowance (the limit is enforced by the user's Stellar account; Nod pays the network fee). Intents that need the user's nod are refused and their approval_url returned instead. Returns the confirmed receipt; a repeat never pays twice.",
    PaymentExecuteInput,
    { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    (ctx, args) => paymentExecute(ctx, args.payment_id),
  ),
  spec(
    'payment_approve_url',
    'Approval link',
    'The link the user opens to approve an intent that needs their nod (passkey). Opening it has no side effect.',
    PaymentApproveUrlInput,
    { readOnlyHint: true, openWorldHint: false },
    (ctx, args) => paymentApproveUrl(ctx, args.payment_id),
  ),
  spec(
    'payment_status',
    'Payment status',
    'The state of a payment intent (prepared, awaiting_approval, submitted, confirmed, failed, expired) and its receipt once confirmed on Stellar. Never triggers a payment; poll it after the user approves.',
    PaymentStatusInput,
    { readOnlyHint: true, openWorldHint: false },
    (ctx, args) => paymentStatus(ctx, args.payment_id),
  ),
  spec(
    'paid_resource_fetch',
    'Fetch a paid resource (x402)',
    "GET a URL. If it answers 402 (x402) with a Stellar USDC price that fits this AI app's allowance, pay it without asking the user and return the content with the receipt; otherwise return requires_approval (the user's nod) or refused. Same idempotency_key = never pays twice.",
    PaidResourceFetchInput,
    { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    (ctx, args) => paidResourceFetch(ctx, args),
  ),
  spec(
    'paid_mcp_call',
    'Call a paid MCP tool (x402)',
    "Call a tool on another MCP server that charges over x402, paying from this AI app's allowance like paid_resource_fetch.",
    PaidMcpCallInput,
    { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    (ctx, args) => paidMcpCall(ctx, args),
  ),
  spec(
    'connection_grant_create',
    'Ask for an allowance',
    "Return the link where the user sets or renews this AI app's allowance. Never grants anything itself.",
    ConnectionGrantCreateInput,
    { readOnlyHint: true, openWorldHint: false },
    (ctx, args) => connectionGrantCreate(ctx, args.idempotency_key),
  ),
  spec(
    'connection_grant_revoke',
    'Revoke this connection',
    "Stop this AI app's allowance now (Nod refuses to pay for it from here on) and return its unspent USDC to the wallet; the user removes the allowance from their Stellar account with their passkey at the returned link.",
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
    { name: 'Nod', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions:
        "Nod: the user's Stellar USDC wallet with an allowance for you. Small stuff, it just pays; big stuff needs the user's nod. Payments inside the allowance go through on their own; anything bigger returns an approval_url that you must show the user verbatim, then poll payment_status. Always pass a fresh idempotency_key per intended payment and reuse it on retries. Always mention the network (testnet) when you talk about money.",
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
