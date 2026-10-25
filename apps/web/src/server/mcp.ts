import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { eventsCapabilities, handleEventsRequest, registerEvents } from './events/rpc.ts'
import { appsCapabilities, listResources, readResource, registerApps } from './mcp-apps.ts'
import { isModernRequest, type ModernDeps, serveModern } from './mcp-modern.ts'
import { callTool, listTools, runTool } from './mcp-tools.ts'
import type { AppRuntime } from './runtime.ts'
import type { ToolContext } from './tools.ts'

/**
 * /mcp: stateless Streamable HTTP behind the OAuth provider (a valid bearer is already checked), a fresh server and
 * transport per POST, JSON responses, no sessions, GET → 405. The body is read and parsed here once, so the request can
 * be routed before the SDK sees it; the SDK then gets it as `parsedBody` and skips its own size check and parse error,
 * which this file does instead.
 */

export interface McpAuth {
  readonly token: string
  readonly clientId: string
  readonly scopes: Array<string>
  readonly expiresAt?: number
}

const INSTRUCTIONS =
  "Nod: the user's Stellar USDC wallet with an allowance for you. Small stuff, it just pays; big stuff needs the user's nod. Payments inside the allowance go through on their own; anything bigger returns an approval_url that you must show the user verbatim, then poll payment_status. Always pass a fresh idempotency_key per intended payment and reuse it on retries. Always mention the network (testnet) when you talk about money."

/** Who answers: the name hosts show, and the icon they fall back to for Nod's entrypoints (sidebar, pinned apps). */
export const serverInfo = (origin: string) => ({
  name: 'Nod',
  version: '0.1.0',
  title: 'Nod',
  websiteUrl: origin,
  icons: [{ src: `${origin}/favicon.svg`, mimeType: 'image/svg+xml', sizes: ['any'] }],
})

/** The largest JSON-RPC body /mcp reads; tool arguments are small. */
export const MAX_BODY_BYTES = 1_048_576

const rpcError = (status: number, code: number, message: string) =>
  Response.json({ jsonrpc: '2.0', id: null, error: { code, message } }, { status })

/** The body as JSON, or the error response the SDK would have sent. */
const readBody = async (request: Request): Promise<{ readonly body: unknown } | { readonly error: Response }> => {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > MAX_BODY_BYTES) return { error: rpcError(413, -32600, 'Request body too large') }
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES)
    return { error: rpcError(413, -32600, 'Request body too large') }
  try {
    return { body: JSON.parse(text) }
  } catch {
    return { error: rpcError(400, -32700, 'Parse error: Invalid JSON') }
  }
}

/** The protocol revisions up to 2025-11-25, through the SDK's low-level Server. */
const serveLegacy = async (runtime: AppRuntime, request: Request, body: unknown, ctx: ToolContext, auth: McpAuth) => {
  const server = new Server(serverInfo(ctx.origin), {
    capabilities: { tools: {}, ...appsCapabilities, ...eventsCapabilities },
    instructions: INSTRUCTIONS,
  })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools() }))
  server.setRequestHandler(CallToolRequestSchema, async call =>
    callTool(runtime, ctx, call.params.name, call.params.arguments),
  )
  registerApps(server, runtime, ctx)
  registerEvents(server, runtime, ctx)
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
  await server.connect(transport)
  return transport.handleRequest(request, {
    parsedBody: body,
    authInfo: {
      token: auth.token,
      clientId: auth.clientId,
      scopes: auth.scopes,
      ...(auth.expiresAt === undefined ? {} : { expiresAt: auth.expiresAt }),
    },
  })
}

/** The same tools, resources and events for the 2026-07-28 lane (mcp-modern.ts), which answers without the SDK. */
const modernDeps = (runtime: AppRuntime, ctx: ToolContext): ModernDeps => ({
  listTools,
  runTool: (name, args) => runTool(runtime, ctx, name, args),
  listResources,
  readResource,
  events: (method, params) => handleEventsRequest(runtime, ctx, method, params),
  capabilities: { tools: {}, ...appsCapabilities, ...eventsCapabilities },
  instructions: INSTRUCTIONS,
  serverInfo: serverInfo(ctx.origin),
})

/** Serve one MCP POST for a connection: 2026-07-28 messages on their own lane, everything else through the SDK. */
export const serveMcp = async (runtime: AppRuntime, request: Request, ctx: ToolContext, auth: McpAuth) => {
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } })
  const read = await readBody(request)
  if ('error' in read) return read.error
  if (isModernRequest(request, read.body)) return serveModern(request, read.body, modernDeps(runtime, ctx))
  return serveLegacy(runtime, request, read.body, ctx, auth)
}
