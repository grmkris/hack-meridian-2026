import { Predicate } from 'effect'

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import type { ToolRunResult } from './mcp-tools.ts'

/**
 * The 2026-07-28 lane of /mcp: stateless JSON-RPC without `initialize`, answered here directly because SDK 1.32.2
 * rejects that protocol version (its transport 400s an unknown `mcp-protocol-version`). Every request carries its version
 * and client capabilities in `params._meta`; every result carries `resultType`. Shape after agent-jobs' modern lane
 * (agent-jobs/apps/api/src/mcp.ts) and the 2026-07-28 changelog.
 *
 * Multi round-trip requests (MRTR): a tool result that needs the owner's nod (it carries an `approval_url`) becomes an
 * `input_required` URL elicitation when the client declared `elicitation.url`. The client opens the approval page, the
 * owner approves with the passkey, and the client retries the same call with `requestState`; the tool runs again with
 * the same arguments (the same idempotency key), so the retry returns the settled payment, or asks again while the
 * payment still waits.
 */

export const MODERN_VERSION = '2026-07-28'
const VERSION_KEY = 'io.modelcontextprotocol/protocolVersion'
const CLIENT_CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities'
const SERVER_INFO_KEY = 'io.modelcontextprotocol/serverInfo'
const SERVER_INFO = { name: 'Nod', version: '0.1.0' }

/** What the lane serves; mcp.ts passes the same tools, resources and events the legacy lane registers. */
export interface ModernDeps {
  readonly listTools: () => ReadonlyArray<unknown>
  readonly runTool: (name: string, args: unknown) => Promise<ToolRunResult>
  readonly listResources: () => { readonly resources: ReadonlyArray<unknown> }
  readonly readResource: (uri: string) => Promise<{ readonly contents: ReadonlyArray<unknown> }>
  readonly events: (method: string, params: unknown) => Promise<Record<string, unknown>>
  readonly capabilities: Record<string, unknown>
  readonly instructions: string
}

/** A protocol error for the JSON-RPC `error` member: thrown by deps (events, resources) and by this lane. */
export interface ProtocolErrorShape {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

export const protocolError = (code: number, message: string, data?: unknown): Error & ProtocolErrorShape =>
  Object.assign(new Error(message), { code, ...(data === undefined ? {} : { data }) })

const asProtocolError = (error: unknown): ProtocolErrorShape | undefined =>
  Predicate.hasProperty(error, 'code') && typeof error.code === 'number' && error instanceof Error
    ? { code: error.code, message: error.message, ...('data' in error ? { data: error.data } : {}) }
    : undefined

const objectOr = (value: unknown): Record<string, unknown> =>
  Predicate.isObject(value) && !Array.isArray(value) ? { ...value } : {}

const metaOf = (body: Record<string, unknown>) => objectOr(objectOr(body['params'])['_meta'])

/**
 * Whether a parsed /mcp body belongs to this lane: `server/discover`, a `_meta` protocol version, or the 2026-07-28
 * version header. Everything else (initialize-era clients) stays on the SDK lane.
 */
export const isModernRequest = (request: Request, body: unknown): boolean => {
  if (!Predicate.isObject(body) || Array.isArray(body)) return false
  const message = objectOr(body)
  if (message['method'] === 'server/discover') return true
  if (typeof metaOf(message)[VERSION_KEY] === 'string') return true
  return request.headers.get('mcp-protocol-version') === MODERN_VERSION
}

const json = (payload: unknown, status = 200) =>
  Response.json(payload, { status, headers: { 'cache-control': 'no-store' } })

/** Does this tool value need the owner's nod: a payment waiting for approval, with the link to give the owner? */
const pendingApproval = (value: unknown): { readonly paymentId: string; readonly url: string } | undefined => {
  const record = objectOr(value)
  const url = record['approval_url']
  const paymentId = record['payment_id']
  const status = record['status']
  if (typeof url !== 'string' || typeof paymentId !== 'string') return undefined
  return status === 'awaiting_approval' || status === 'requires_approval' ? { paymentId, url } : undefined
}

const sentenceOf = (result: CallToolResult) => {
  const first = result.content[0]
  return first !== undefined && first.type === 'text' ? first.text : 'Approve this payment with your passkey on Nod.'
}

const declinedResult = (url: string): CallToolResult => ({
  isError: true,
  content: [
    {
      type: 'text',
      text: `The user did not approve the payment. It still waits for their nod at ${url} until it expires.`,
    },
  ],
})

type Answer = { readonly result: Record<string, unknown> } | { readonly error: ProtocolErrorShape }

/** tools/call, with the nod as a URL elicitation when the client can show one. */
const callTool = async (deps: ModernDeps, params: Record<string, unknown>, meta: Record<string, unknown>) => {
  const name = params['name']
  if (typeof name !== 'string') return { error: { code: -32602, message: 'tools/call needs a tool name' } }
  const ran = await deps.runTool(name, params['arguments'] ?? {})
  const pending = ran.result.isError === true ? undefined : pendingApproval(ran.value)
  const requestState = params['requestState']
  if (requestState !== undefined) {
    const paymentId = objectOr(ran.value)['payment_id']
    if (requestState !== paymentId)
      return { error: { code: -32602, message: 'requestState does not belong to this call' } }
    const action = objectOr(objectOr(params['inputResponses'])['approval'])['action']
    if (pending !== undefined && (action === 'decline' || action === 'cancel'))
      return { result: { ...declinedResult(pending.url) } }
  }
  const elicitation = objectOr(objectOr(meta[CLIENT_CAPABILITIES_KEY])['elicitation'])
  if (pending === undefined || !Predicate.isObject(elicitation['url'])) return { result: { ...ran.result } }
  return {
    result: {
      resultType: 'input_required',
      inputRequests: {
        approval: {
          method: 'elicitation/create',
          params: { mode: 'url', message: sentenceOf(ran.result), url: pending.url },
        },
      },
      requestState: pending.paymentId,
    },
  }
}

const answer = async (
  deps: ModernDeps,
  method: string,
  params: Record<string, unknown>,
  meta: Record<string, unknown>,
): Promise<Answer> => {
  const listed = { ttlMs: 0, cacheScope: 'private' }
  switch (method) {
    case 'server/discover':
      return {
        result: {
          supportedVersions: [MODERN_VERSION],
          capabilities: deps.capabilities,
          instructions: deps.instructions,
          ...listed,
        },
      }
    case 'tools/list':
      return { result: { tools: deps.listTools(), ...listed } }
    case 'tools/call':
      return callTool(deps, params, meta)
    case 'resources/list':
      return { result: { ...deps.listResources(), ...listed } }
    case 'resources/templates/list':
      return { result: { resourceTemplates: [], ...listed } }
    case 'resources/read': {
      const uri = params['uri']
      if (typeof uri !== 'string') return { error: { code: -32602, message: 'resources/read needs a uri' } }
      return { result: { ...(await deps.readResource(uri)), ...listed } }
    }
    default:
      if (method.startsWith('events/')) return { result: await deps.events(method, params) }
      return { error: { code: -32601, message: `Method not found: ${method}` } }
  }
}

/** Serve one 2026-07-28 JSON-RPC message (mcp.ts routes it here after isModernRequest). */
export const serveModern = async (request: Request, body: unknown, deps: ModernDeps): Promise<Response> => {
  const message = objectOr(body)
  const id = message['id']
  // A notification has no id; a client's JSON-RPC response has an id but no method. Neither gets an answer.
  if (id === undefined || id === null || message['method'] === undefined) return new Response(null, { status: 202 })
  const method = message['method']
  const rpcError = (error: ProtocolErrorShape, status = 200) =>
    json({ jsonrpc: '2.0', id, error: { ...error } }, status)
  if (typeof method !== 'string') return rpcError({ code: -32600, message: 'Invalid request' }, 400)
  const params = objectOr(message['params'])
  const meta = metaOf(message)
  const version = meta[VERSION_KEY]
  const nameHeader = method === 'resources/read' ? params['uri'] : params['name']
  const expected: ReadonlyArray<readonly [string, unknown]> = [
    ['mcp-protocol-version', version],
    ['mcp-method', method],
    ...(method === 'tools/call' || method === 'resources/read' || method === 'prompts/get'
      ? [['mcp-name', nameHeader] as const]
      : []),
  ]
  if (expected.some(([header, value]) => request.headers.has(header) && request.headers.get(header) !== value))
    return rpcError({ code: -32020, message: 'An MCP header does not match the request body' }, 400)
  if (typeof version === 'string' && version !== MODERN_VERSION)
    return rpcError(
      { code: -32022, message: 'Unsupported protocol version', data: { supportedVersions: [MODERN_VERSION] } },
      400,
    )
  try {
    const answered = await answer(deps, method, params, meta)
    if ('error' in answered) return rpcError(answered.error)
    const resultType = answered.result['resultType'] ?? 'complete'
    return json({
      jsonrpc: '2.0',
      id,
      result: { ...answered.result, resultType, _meta: { [SERVER_INFO_KEY]: SERVER_INFO } },
    })
  } catch (error) {
    const known = asProtocolError(error)
    if (known !== undefined) return rpcError(known)
    return rpcError({ code: -32603, message: `${method} failed unexpectedly; retry the request` })
  }
}
