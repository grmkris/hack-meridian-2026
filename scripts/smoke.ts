import { Option, Schema } from 'effect'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * HTTP acceptance of a running stage: the app shell, a client route, health, the counter read through Soroban RPC, an
 * unknown API path, the owner API's session gate, and what an MCP client meets first: /mcp refusing an anonymous call
 * with a pointer to its OAuth metadata, that metadata, and the authorization server's endpoints (DCR, PKCE S256). It
 * holds no token, so it cannot call tools/list. Writes a receipt to .local/smoke-<stage>.json and exits 1 if any
 * check fails.
 *
 *   bun scripts/smoke.ts local      against bun run dev (http://localhost:18960)
 *   bun scripts/smoke.ts testnet    against the deployed Worker; HM_URL overrides the origin
 */
const ROOT = resolve(import.meta.dir, '..')
const ORIGINS: Record<string, string> = {
  local: 'http://localhost:18960',
  testnet: 'https://testnet.trynod.si',
}
const stage = process.argv[2] ?? 'local'
const origin = process.env['HM_URL'] ?? ORIGINS[stage]
if (origin === undefined) throw new Error(`no origin for stage ${stage}; set HM_URL`)
const deployment = Schema.decodeUnknownSync(
  Schema.Struct({ contracts: Schema.Struct({ counter: Schema.Struct({ id: Schema.String }) }) }),
)(JSON.parse(readFileSync(join(ROOT, 'contracts/deployments/testnet.json'), 'utf8')))

interface Check {
  readonly name: string
  readonly ok: boolean
  readonly status: number
  readonly ms: number
  readonly detail: string
}

const check = async (
  name: string,
  path: string,
  judge: (response: Response, body: string) => string | undefined,
  init: RequestInit = {},
): Promise<Check> => {
  const started = performance.now()
  try {
    const response = await fetch(new URL(path, origin), {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    })
    const body = await response.text()
    const problem = judge(response, body)
    return {
      name,
      ok: problem === undefined,
      status: response.status,
      ms: Math.round(performance.now() - started),
      detail: problem ?? 'ok',
    }
  } catch (error) {
    return { name, ok: false, status: 0, ms: Math.round(performance.now() - started), detail: String(error) }
  }
}

const JsonObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const json = (body: string): Record<string, unknown> =>
  Option.getOrElse(Schema.decodeUnknownOption(JsonObject)(body), () => ({}))

const html = (response: Response, body: string) =>
  response.status !== 200
    ? `status ${response.status}`
    : body.includes('<div id="root">')
      ? undefined
      : 'no app root in the page'

const MCP_INITIALIZE: RequestInit = {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } },
  }),
}

const RESOURCE_METADATA = /resource_metadata="([^"]+)"/u
const AUTHORIZATION_ENDPOINTS = ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']

/** /mcp → its resource metadata → its authorization server, each step judged on what the previous one named. */
const oauthDiscovery = async (): Promise<ReadonlyArray<Check>> => {
  const found: { resourceMetadata?: string; issuer?: string } = {}
  const refused = await check(
    'MCP refuses an anonymous client and names its metadata',
    '/mcp',
    response => {
      if (response.status !== 401) return `status ${response.status}`
      const pointer = RESOURCE_METADATA.exec(response.headers.get('www-authenticate') ?? '')?.[1]
      if (pointer === undefined) return 'no resource_metadata in WWW-Authenticate'
      found.resourceMetadata = pointer
      return undefined
    },
    MCP_INITIALIZE,
  )
  const resource = await check(
    'protected-resource metadata',
    found.resourceMetadata ?? '/.well-known/oauth-protected-resource',
    (response, body) => {
      const document = json(body)
      const servers = document['authorization_servers']
      if (response.status !== 200) return `status ${response.status}`
      if (!Array.isArray(servers) || typeof servers[0] !== 'string') return 'no authorization_servers'
      found.issuer = servers[0]
      return undefined
    },
  )
  const server = await check(
    'authorization-server metadata (DCR, PKCE S256)',
    new URL('/.well-known/oauth-authorization-server', found.issuer ?? origin).href,
    (response, body) => {
      const document = json(body)
      if (response.status !== 200) return `status ${response.status}`
      const missing = AUTHORIZATION_ENDPOINTS.filter(field => typeof document[field] !== 'string')
      if (missing.length > 0) return `missing ${missing.join(', ')}`
      const methods = document['code_challenge_methods_supported']
      return Array.isArray(methods) && methods.includes('S256') ? undefined : 'S256 is not offered'
    },
  )
  return [refused, resource, server]
}

const checks = await Promise.all([
  check('app shell', '/', html),
  check('client route falls back to the app', '/a/client/route', html),
  check('health', '/api/health', (response, body) => {
    const health = json(body)
    if (response.status !== 200) return `status ${response.status}`
    if (health['ok'] !== true) return 'ok is not true'
    return health['stage'] === stage ? undefined : `stage is ${String(health['stage'])}, expected ${stage}`
  }),
  check('counter reads the contract', '/api/counter', (response, body) => {
    const reading = json(body)
    if (response.status !== 200) return `status ${response.status}: ${body.slice(0, 200)}`
    if (reading['contractId'] !== deployment.contracts.counter.id) return `contract ${String(reading['contractId'])}`
    return Number.isInteger(reading['count']) ? undefined : `count is ${String(reading['count'])}`
  }),
  check('unknown API path is a 404', '/api/no-such-endpoint', response =>
    response.status === 404 ? undefined : `status ${response.status}`,
  ),
  check('owner API needs a passkey session', '/api/session', response =>
    response.status === 401 ? undefined : `status ${response.status}`,
  ),
]).then(async first => [...first, ...(await oauthDiscovery())])

for (const { name, ok, status, ms, detail } of checks)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (${status}, ${ms} ms)${ok ? '' : `: ${detail}`}`)
const health = json(await (await fetch(new URL('/api/health', origin)).catch(() => new Response('{}'))).text())
const receipt = { stage, origin, at: new Date().toISOString(), release: health['release'] ?? null, checks }
mkdirSync(join(ROOT, '.local'), { recursive: true })
writeFileSync(join(ROOT, `.local/smoke-${stage}.json`), `${JSON.stringify(receipt, null, 2)}\n`)
console.log(`receipt: .local/smoke-${stage}.json`)
process.exit(checks.every(result => result.ok) ? 0 : 1)
