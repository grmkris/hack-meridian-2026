import { AuthorizationError, CimdFetchError, OAuthProvider } from '@cloudflare/workers-oauth-provider'

import type { ConnectionProps, Env } from './env.ts'
import { durableKv } from './kv-shim.ts'
import { mcpHandler } from './mcp.ts'
import { approvalPage, type ConnectionRow, connectionsPage, consentPage, escape, html, messagePage } from './pages.ts'
import { ledger, statusOf } from './payments.ts'
import { probe } from './probe.ts'

export { Payments } from './payments.ts'
export { OAuthStore } from './kv-shim.ts'

const SCOPES = ['wallet', 'offline_access']
const OWNER_ID = 'dev-owner'
const WALLET_ID = 'wal_personal'

async function passwordOk(env: Env, given: FormDataEntryValue | null): Promise<boolean> {
  if (typeof given !== 'string' || !env.DEV_PASSWORD) return false
  const enc = new TextEncoder()
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(env.DEV_PASSWORD)),
  ])
  return crypto.subtle.timingSafeEqual(a, b)
}

function allowanceFrom(value: FormDataEntryValue | null): string {
  const text = typeof value === 'string' ? value.trim() : ''
  return /^\d{1,6}(\.\d{1,2})?$/u.test(text) ? Number(text).toFixed(2) : '5.00'
}

function expiryFrom(value: FormDataEntryValue | null): string {
  const at = typeof value === 'string' ? Date.parse(value) : Number.NaN
  const max = Date.now() + 30 * 86400_000
  return Number.isFinite(at) && at > Date.now() && at <= max
    ? new Date(at).toISOString()
    : new Date(Date.now() + 86400_000).toISOString()
}

/** GET shows consent; POST checks the owner sign-in, then approves or denies. */
async function authorize(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER
  try {
    if (request.method === 'GET') {
      const authRequest = await oauth.parseAuthRequest(request)
      const details = await oauth.describeConsent(authRequest)
      const consent = await oauth.beginConsent(authRequest)
      return html(consentPage(details, consent.handle), { headers: consent.headers })
    }
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
    const form = await request.formData()
    const handle = String(form.get('handle') ?? '')
    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(request, handle)
      denied.headers.set('Location', denied.redirectTo)
      return new Response(null, { status: 302, headers: denied.headers })
    }
    if (!(await passwordOk(env, form.get('password')))) {
      // The handle is not consumed yet: going Back to the consent page and retrying still works.
      return html(messagePage('Wrong password', 'Go back and try again.'), { status: 401 })
    }
    // Peek at the stored request to pick scopes, then consume the handle.
    const approved = await oauth.approveConsent(request, handle)
    const granted = approved.request.scope.filter(s => SCOPES.includes(s))
    const scope = granted.includes('wallet') ? granted : ['wallet', ...granted]
    const client = await oauth.lookupClient(approved.request.clientId)
    const connectionId = crypto.randomUUID()
    const props: ConnectionProps = {
      owner_id: OWNER_ID,
      wallet_id: WALLET_ID,
      wallet_name: 'Personal',
      connection_id: connectionId,
      client_id: approved.request.clientId,
      client_name: client?.clientName ?? approved.request.clientId,
      granted_at: new Date().toISOString(),
      grant: {
        grant_id: `gr_${connectionId.slice(0, 8)}`,
        asset: 'USDC',
        allowance: allowanceFrom(form.get('allowance')),
        valid_until: expiryFrom(form.get('valid_until')),
        signer_key_id: `sk_${connectionId.slice(9, 13)}${connectionId.slice(14, 18)}`,
      },
    }
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: OWNER_ID,
      // metadata is stored in clear (props are encrypted with the token): just enough to list and revoke connections.
      metadata: {
        connection_id: props.connection_id,
        client_name: props.client_name,
        grant_id: props.grant.grant_id,
        allowance: props.grant.allowance,
        valid_until: props.grant.valid_until,
      },
      scope,
      props,
      revokeExistingGrants: false,
    })
    approved.headers.set('Location', redirectTo)
    return new Response(null, { status: 302, headers: approved.headers })
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302)
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      const message = error instanceof AuthorizationError ? error.description : 'This app could not be verified.'
      return html(messagePage('Cannot authorize', message ?? 'invalid request'), { status: 400 })
    }
    throw error
  }
}

async function approve(request: Request, env: Env, paymentId: string): Promise<Response> {
  const payments = ledger(env.PAYMENTS)
  const intent = await payments.get(paymentId)
  if (intent === undefined) return html(messagePage('Not found', `No payment ${paymentId}`), { status: 404 })
  if (request.method === 'GET') return html(approvalPage(intent, statusOf(intent)))
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
  const form = await request.formData()
  if (!(await passwordOk(env, form.get('password'))))
    return html(approvalPage(intent, statusOf(intent), 'Wrong password.'), { status: 401 })
  const result = await payments.approve(paymentId)
  if ('error' in result) return html(messagePage('Cannot approve', result.error), { status: 409 })
  return html(approvalPage(result, statusOf(result)))
}

async function connectionRows(env: Env): Promise<(ConnectionRow & { oauth_grant_id: string })[]> {
  const rows: (ConnectionRow & { oauth_grant_id: string })[] = []
  let cursor: string | undefined
  do {
    const page = await env.OAUTH_PROVIDER.listUserGrants(OWNER_ID, cursor === undefined ? {} : { cursor })
    for (const grant of page.items) {
      const meta = (grant.metadata ?? {}) as Partial<ConnectionRow>
      rows.push({
        oauth_grant_id: grant.id,
        grant_id: meta.grant_id ?? '?',
        connection_id: meta.connection_id ?? grant.id,
        client_name: meta.client_name ?? grant.clientId,
        allowance: meta.allowance ?? '?',
        valid_until: meta.valid_until ?? '?',
        created_at: new Date(grant.createdAt * 1000).toISOString(),
      })
    }
    cursor = page.cursor
  } while (cursor !== undefined)
  return rows
}

/** Owner site stand-in: list connections; revoking one revokes its OAuth grant, so every token it holds dies. */
async function connections(request: Request, env: Env, path: string): Promise<Response> {
  if (path === '/connections' && request.method === 'GET') return html(connectionsPage(await connectionRows(env)))
  if (path === '/connections/revoke' && request.method === 'POST') {
    const form = await request.formData()
    if (!(await passwordOk(env, form.get('password'))))
      return html(messagePage('Wrong password', 'Go back and try again.'), { status: 401 })
    const target = String(form.get('connection_id') ?? '')
    const row = (await connectionRows(env)).find(r => r.connection_id === target)
    if (row === undefined) return html(messagePage('Not found', `No connection ${target}`), { status: 404 })
    await env.OAUTH_PROVIDER.revokeGrant(row.oauth_grant_id, OWNER_ID)
    return html(
      connectionsPage(await connectionRows(env), `Revoked ${row.client_name} (connection ${target.slice(0, 8)}).`),
    )
  }
  return new Response('Method Not Allowed', { status: 405 })
}

const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/authorize') return authorize(request, env)
    const approval = /^\/approve\/(pi_[0-9a-f]{24})$/u.exec(url.pathname)
    if (approval) return approve(request, env, approval[1]!)
    if (url.pathname === '/connections' || url.pathname === '/connections/revoke')
      return connections(request, env, url.pathname)
    if (url.pathname === '/api/probe') return probe(url)
    if (url.pathname === '/api/health') return Response.json({ ok: true, worker: 'hm26-s4-mcp' })
    if (url.pathname === '/')
      return html(
        messagePage(
          'stellarmcpwallet · S4 spike',
          `Remote MCP server at ${url.origin}/mcp (OAuth 2.1: DCR + PKCE + CIMD).`,
        ).replace(escape(`${url.origin}/mcp`), `<code>${escape(url.origin)}/mcp</code>`),
      )
    return new Response('Not Found', { status: 404 })
  },
}

/** One provider per origin: the resource and issuer are the URL the client actually used (workers.dev, tunnel or localhost). */
const providers = new Map<string, OAuthProvider<Env>>()
function providerFor(origin: string): OAuthProvider<Env> {
  let provider = providers.get(origin)
  if (provider === undefined) {
    provider = new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler: mcpHandler as never,
      defaultHandler,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/oauth/token',
      clientRegistrationEndpoint: '/oauth/register',
      scopesSupported: SCOPES,
      requiredScopes: ['wallet'],
      resourceMetadata: {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        bearer_methods_supported: ['header'],
        resource_name: 'stellarmcpwallet (S4 spike)',
      },
      clientIdMetadataDocumentEnabled: true,
      accessTokenTTL: 3600,
    })
    providers.set(origin, provider)
  }
  return provider
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // OAUTH_KV is a Durable Object-backed shim (see kv-shim.ts): the deploy token has no Workers KV permission.
    const withKv: Env = { ...env, OAUTH_KV: durableKv(env.OAUTH_STORE) }
    return providerFor(new URL(request.url).origin).fetch(request, withKv, ctx)
  },
} satisfies ExportedHandler<Env>
