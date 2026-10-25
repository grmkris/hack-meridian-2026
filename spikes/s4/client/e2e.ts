import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright-core'

/**
 * Headless proof of the full OAuth + MCP round trip against the deployed Worker, using the same SDK and provider
 * shape as Goblin (`@modelcontextprotocol/client` 2.3.1, an OAuthClientProvider doing DCR + PKCE with a loopback
 * redirect, as goblin/apps/cli/src/oauth.ts). The consent and approval pages are driven with playwright-core.
 *
 *   bun client/e2e.ts [base-url]      (DEV_PASSWORD from spikes/s4/.dev.vars)
 *
 * Writes evidence/e2e.json (every HTTP request + status; codes and tokens redacted) and evidence/*.png.
 */
import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client'

const ROOT = join(import.meta.dir, '..')
const EVIDENCE = join(ROOT, 'evidence')
mkdirSync(EVIDENCE, { recursive: true })
const BASE = (process.argv[2] ?? 'https://hm26-s4-mcp.kristjan-grm11775.workers.dev').replace(/\/$/u, '')
const MCP_URL = new URL(`${BASE}/mcp`)
const PASSWORD = /^DEV_PASSWORD=(.+)$/mu.exec(readFileSync(join(ROOT, '.dev.vars'), 'utf8'))?.[1]?.trim()
if (!PASSWORD) throw new Error('DEV_PASSWORD missing from .dev.vars')

// ---------------------------------------------------------------- evidence log (no secrets)
interface Entry {
  t: string
  step: string
  via: 'sdk' | 'browser' | 'raw'
  method: string
  url: string
  status: number
  note?: string
}
const log: Entry[] = []
let step = 'start'
const started = Date.now()
const redact = (url: string) =>
  url.replace(/([?&](code|code_challenge|state|refresh_token|access_token)=)[^&]+/gu, '$1<redacted>')
const record = (via: Entry['via'], method: string, url: string, status: number, note?: string) => {
  const entry: Entry = {
    t: `+${((Date.now() - started) / 1000).toFixed(2)}s`,
    step,
    via,
    method,
    url: redact(url),
    status,
  }
  if (note !== undefined) entry.note = note
  log.push(entry)
  console.log(
    `${entry.t.padStart(8)}  ${via.padEnd(7)} ${method.padEnd(6)} ${status}  ${entry.url}${note ? `  (${note})` : ''}`,
  )
}
const say = (text: string) => {
  step = text
  console.log(`\n== ${text}`)
}

/** Every request the SDK makes (discovery, DCR, token, MCP) goes through this fetch. */
const sdkFetch = async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init)
  const response = await fetch(request)
  let note: string | undefined
  if (request.url.endsWith('/mcp') && request.method === 'POST' && init?.body && typeof init.body === 'string') {
    const body = JSON.parse(init.body) as { method?: string; params?: { name?: string } }
    note = body.method === 'tools/call' ? `tools/call ${body.params?.name}` : body.method
  }
  if (response.status === 401)
    note = `${note ?? ''} www-authenticate: ${response.headers.get('www-authenticate') ?? '-'}`.trim()
  record('sdk', request.method, request.url, response.status, note)
  return response
}

// ---------------------------------------------------------------- OAuth client provider (Goblin CLI shape, in memory)
class MemoryAuthProvider implements OAuthClientProvider {
  client: StoredOAuthClientInformation | undefined
  #tokens: StoredOAuthTokens | undefined
  #verifier: string | undefined
  #state: string | undefined
  #discovery: OAuthDiscoveryState | undefined
  authorizationUrl: URL | undefined
  constructor(
    readonly redirectUrl: string,
    readonly name: string,
  ) {}
  saveDiscoveryState(state: OAuthDiscoveryState) {
    this.#discovery = state
  }
  discoveryState() {
    return this.#discovery
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.name,
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'wallet offline_access',
    }
  }
  get expectedState() {
    return this.#state
  }
  state() {
    this.#state = crypto.randomUUID()
    return this.#state
  }
  clientInformation() {
    return this.client
  }
  saveClientInformation(info: StoredOAuthClientInformation) {
    this.client = info
  }
  tokens() {
    return this.#tokens
  }
  saveTokens(tokens: StoredOAuthTokens) {
    this.#tokens = tokens
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url
  }
  saveCodeVerifier(verifier: string) {
    this.#verifier = verifier
  }
  codeVerifier() {
    if (this.#verifier === undefined) throw new Error('no verifier')
    return this.#verifier
  }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'all' || scope === 'client') this.client = undefined
    if (scope === 'all' || scope === 'client' || scope === 'tokens') this.#tokens = undefined
    if (scope === 'all' || scope === 'verifier') this.#verifier = undefined
  }
}

// ---------------------------------------------------------------- loopback callback listener
let callback = Promise.withResolvers<URLSearchParams>()
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname !== '/callback') return new Response('Not found', { status: 404 })
    callback.resolve(url.searchParams)
    return new Response('<!doctype html><p>Signed in. You can close this tab.</p>', {
      headers: { 'content-type': 'text/html' },
    })
  },
})
const redirect = `http://127.0.0.1:${server.port}/callback`

// ---------------------------------------------------------------- helpers
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext()
const page = await context.newPage()
page.on('response', response => {
  const request = response.request()
  if (request.resourceType() === 'document') record('browser', request.method(), response.url(), response.status())
})
page.on('requestfailed', request => {
  if (request.resourceType() === 'document')
    record('browser', request.method(), request.url(), 0, request.failure()?.errorText)
})
const shot = (page: Page, name: string) => page.screenshot({ path: join(EVIDENCE, `${name}.png`), fullPage: true })

const results: Record<string, unknown> = {}
const structured = (result: unknown) =>
  (result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {}
const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`)
  console.log(`   ✓ ${message}`)
}

async function raw(method: string, url: string, init: RequestInit = {}, note?: string) {
  const response = await fetch(url, { ...init, method })
  record('raw', method, url, response.status, note)
  return response
}

/** connect → UnauthorizedError (after discovery + DCR) → consent page in the browser → callback → finishAuth. */
async function authorize(
  provider: MemoryAuthProvider,
  allowance: string,
  negatives: boolean,
): Promise<URLSearchParams> {
  say(`connect (${provider.name}): SDK does discovery + DCR, then asks for authorization`)
  callback = Promise.withResolvers<URLSearchParams>()
  const client = new Client({ name: 'goblin-cli-s4', version: '0.0.1' })
  let unauthorized = false
  try {
    await client.connect(new StreamableHTTPClientTransport(MCP_URL, { authProvider: provider, fetch: sdkFetch }))
  } catch (error) {
    unauthorized = error instanceof UnauthorizedError
    if (!unauthorized) throw error
  }
  assert(unauthorized, 'first connect throws UnauthorizedError')
  assert(provider.client?.client_id, `DCR issued client_id ${provider.client?.client_id}`)
  assert(provider.authorizationUrl, 'SDK produced an authorization URL')
  const authUrl = provider.authorizationUrl!
  results[`authorization_url_params:${provider.name}`] = Object.fromEntries(
    [...authUrl.searchParams.entries()].map(([k, v]) => [
      k,
      ['state', 'code_challenge'].includes(k) ? '<redacted>' : v,
    ]),
  )

  say(
    `consent page (${provider.name}, allowance ${allowance})${negatives ? ': wrong password first (negative), then Allow' : ''}`,
  )
  await page.goto(authUrl.href)
  const consentText = await page.locator('body').innerText()
  assert(consentText.includes(provider.name), 'consent shows the client name')
  assert(consentText.includes('127.0.0.1'), 'consent shows the redirect host')
  assert(consentText.includes('an app on your computer'), 'consent warns about a loopback redirect')
  if (negatives) {
    await shot(page, 'consent')
    await page.fill('input[name=password]', 'wrong-password')
    await page.click('button[value=approve]')
    assert((await page.locator('h1').innerText()).includes('Wrong password'), 'wrong password refused')
    await page.goto(authUrl.href)
  }
  await page.fill('input[name=password]', PASSWORD!)
  await page.fill('input[name=allowance]', allowance)
  const navigation = page.click('button[value=approve]')
  const params = await callback.promise
  await navigation.catch(() => undefined)
  assert(params.get('state') === provider.expectedState, 'callback state matches')
  assert(params.get('code'), 'callback carries a code')
  assert(params.get('iss') === BASE, `callback carries iss=${params.get('iss')} (RFC 9207)`)

  say(`finishAuth (${provider.name}): code + PKCE verifier → tokens`)
  await new StreamableHTTPClientTransport(MCP_URL, { authProvider: provider, fetch: sdkFetch }).finishAuth(params)
  assert(provider.tokens()?.access_token, 'access token issued')
  assert(provider.tokens()?.refresh_token, 'refresh token issued')
  return params
}

try {
  say('negative: /mcp without a token, with a bogus token')
  const mcpBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  const mcpHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  const noToken = await raw('POST', MCP_URL.href, { headers: mcpHeaders, body: mcpBody }, 'no Authorization header')
  assert(noToken.status === 401, '401 without token')
  assert(
    noToken.headers.get('www-authenticate')?.includes('resource_metadata='),
    'WWW-Authenticate names resource_metadata',
  )
  const bogus = await raw(
    'POST',
    MCP_URL.href,
    { headers: { ...mcpHeaders, authorization: 'Bearer nope:nope:nope' }, body: mcpBody },
    'bogus bearer',
  )
  assert(bogus.status === 401, '401 with a bogus token')
  results.negative_bogus_www_authenticate = bogus.headers.get('www-authenticate')

  const provider = new MemoryAuthProvider(redirect, 'goblin CLI (s4 e2e)')
  const params = await authorize(provider, '5.00', true)
  const tokens = provider.tokens()!
  results.token_response = { token_type: tokens.token_type, expires_in: tokens.expires_in, scope: tokens.scope }

  say('connect #2 with tokens: initialize, tools/list')
  const connected = new Client({ name: 'goblin-cli-s4', version: '0.0.1' })
  await connected.connect(new StreamableHTTPClientTransport(MCP_URL, { authProvider: provider, fetch: sdkFetch }))
  const tools = await connected.listTools()
  results.tools = tools.tools.map(tool => tool.name)
  assert(
    ['wallet_overview', 'payment_prepare', 'payment_status'].every(
      name => results.tools instanceof Array && (results.tools as string[]).includes(name),
    ),
    `tools/list → ${(results.tools as string[]).join(', ')}`,
  )

  say('wallet_overview')
  const overview = structured(await connected.callTool({ name: 'wallet_overview', arguments: {} }))
  results.wallet_overview = overview
  assert((overview.balance as { amount: string }).amount === '50.00', 'balance 50.00 USDC')
  assert((overview.allowance as { remaining: string }).remaining === '5.00', 'allowance 5.00 remaining (from consent)')

  say('payment_prepare 100 USDC to Bob (owner lane), twice with the same idempotency key')
  const prepareArgs = {
    recipient: 'Bob GBOBDEMO…',
    amount: '100',
    asset: 'USDC',
    reason: 'dinner',
    idempotency_key: `dinner-${Date.now()}`,
  }
  const preparedResult = await connected.callTool({ name: 'payment_prepare', arguments: prepareArgs })
  const prepared = structured(preparedResult)
  results.payment_prepare = prepared
  results.payment_prepare_text = (preparedResult.content as { type: string; text: string }[])[0]?.text
  assert(prepared.status === 'requires_approval', 'status requires_approval')
  assert(typeof prepared.approval_url === 'string', `approval_url ${prepared.approval_url}`)
  const again = structured(await connected.callTool({ name: 'payment_prepare', arguments: prepareArgs }))
  assert(again.payment_id === prepared.payment_id, 'same idempotency key → same payment_id')
  const paymentId = prepared.payment_id as string

  say('payment_status before approval; preview the approval page (no side effect)')
  let status = structured(await connected.callTool({ name: 'payment_status', arguments: { payment_id: paymentId } }))
  assert(status.status === 'awaiting_approval', 'awaiting_approval')
  const approvalPage = await context.newPage()
  approvalPage.on('response', response => {
    const request = response.request()
    if (request.resourceType() === 'document') record('browser', request.method(), response.url(), response.status())
  })
  await approvalPage.goto(prepared.approval_url as string)
  await shot(approvalPage, 'approval-before')
  const approvalText = await approvalPage.locator('body').innerText()
  assert(
    approvalText.includes('100 USDC') && approvalText.includes('Bob GBOBDEMO'),
    'approval page shows amount and recipient',
  )
  assert(approvalText.includes('goblin CLI (s4 e2e)'), 'approval page shows the requesting connection')
  status = structured(await connected.callTool({ name: 'payment_status', arguments: { payment_id: paymentId } }))
  assert(status.status === 'awaiting_approval', 'still awaiting_approval after opening the page')

  say('approve: wrong password (negative), then Approve')
  await approvalPage.fill('input[name=password]', 'wrong-password')
  await approvalPage.click('#approve')
  assert(
    (await approvalPage.locator('.err').innerText()).includes('Wrong password'),
    'wrong password refused on approval',
  )
  status = structured(await connected.callTool({ name: 'payment_status', arguments: { payment_id: paymentId } }))
  assert(status.status === 'awaiting_approval', 'still awaiting_approval after a wrong password')
  await approvalPage.fill('input[name=password]', PASSWORD)
  await approvalPage.click('#approve')
  await shot(approvalPage, 'approval-after')

  say('poll payment_status → confirmed')
  const polls: string[] = []
  for (let i = 0; i < 20; i++) {
    status = structured(await connected.callTool({ name: 'payment_status', arguments: { payment_id: paymentId } }))
    polls.push(status.status as string)
    if (status.status === 'confirmed') break
    await Bun.sleep(750)
  }
  results.payment_status_polls = polls
  results.payment_status_final = status
  assert(status.status === 'confirmed', `confirmed after ${polls.length} polls (${polls.join(' → ')})`)

  say('refresh token: new access token, same connection (props survive refresh)')
  const refreshed = await raw(
    'POST',
    `${BASE}/oauth/token`,
    {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token!,
        client_id: provider.client!.client_id,
      }),
    },
    'refresh_token grant',
  )
  assert(refreshed.status === 200, 'refresh → 200')
  const newTokens = (await refreshed.json()) as StoredOAuthTokens
  assert(newTokens.access_token !== tokens.access_token, 'new access token differs')
  provider.saveTokens(newTokens)
  const afterRefresh = new Client({ name: 'goblin-cli-s4', version: '0.0.1' })
  await afterRefresh.connect(new StreamableHTTPClientTransport(MCP_URL, { authProvider: provider, fetch: sdkFetch }))
  const overview2 = structured(await afterRefresh.callTool({ name: 'wallet_overview', arguments: {} }))
  const connectionId = (overview.connection as { id: string }).id
  assert(
    (overview2.connection as { id: string }).id === connectionId,
    `same connection_id ${connectionId} after refresh`,
  )
  const oldToken = await raw(
    'POST',
    MCP_URL.href,
    { headers: { ...mcpHeaders, authorization: `Bearer ${tokens.access_token}` }, body: mcpBody },
    'old access token after refresh',
  )
  results.old_access_token_after_refresh = oldToken.status

  say('revoke (RFC 7009) the access token → /mcp refuses it')
  const revoke = await raw(
    'POST',
    `${BASE}/oauth/token`,
    {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: newTokens.access_token,
        token_type_hint: 'access_token',
        client_id: provider.client!.client_id,
      }),
    },
    'revocation',
  )
  assert(revoke.status === 200, 'revocation → 200')
  const afterRevoke = await raw(
    'POST',
    MCP_URL.href,
    { headers: { ...mcpHeaders, authorization: `Bearer ${newTokens.access_token}` }, body: mcpBody },
    'revoked access token',
  )
  assert(afterRevoke.status === 401, 'revoked token → 401')

  say('after RFC 7009 on the access token: does its refresh token still work?')
  const refreshAfterRevoke = await raw(
    'POST',
    `${BASE}/oauth/token`,
    {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: newTokens.refresh_token!,
        client_id: provider.client!.client_id,
      }),
    },
    'refresh after the access token was revoked',
  )
  results.refresh_after_access_token_revocation = refreshAfterRevoke.status
  console.log(`   · refresh after RFC 7009 access-token revocation → ${refreshAfterRevoke.status}`)

  say('second connection (another DCR client): own connection_id and allowance, cannot see the first one’s payment')
  const providerB = new MemoryAuthProvider(redirect, 'Claude-like client (s4 e2e)')
  const paramsB = await authorize(providerB, '2.50', false)
  const clientB = new Client({ name: 'second-client-s4', version: '0.0.1' })
  await clientB.connect(new StreamableHTTPClientTransport(MCP_URL, { authProvider: providerB, fetch: sdkFetch }))
  const overviewB = structured(await clientB.callTool({ name: 'wallet_overview', arguments: {} }))
  results.wallet_overview_b = overviewB
  assert((overviewB.connection as { id: string }).id !== connectionId, 'B has its own connection_id')
  assert((overviewB.allowance as { total: string }).total === '2.50', 'B allowance 2.50 (its own consent)')
  const crossLook = await clientB.callTool({ name: 'payment_status', arguments: { payment_id: paymentId } })
  assert(crossLook.isError === true, 'B cannot read A’s payment (isError)')

  say('negative: replay B’s authorization code → 400 and the grant is revoked')
  const tokensB = providerB.tokens()!
  const replay = await raw(
    'POST',
    `${BASE}/oauth/token`,
    {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: paramsB.get('code')!,
        redirect_uri: redirect,
        client_id: providerB.client!.client_id,
        code_verifier: providerB.codeVerifier(),
      }),
    },
    'code replay',
  )
  results.code_replay = { status: replay.status, body: await replay.json() }
  assert(replay.status === 400, 'replayed code refused')
  const afterReplay = await raw(
    'POST',
    MCP_URL.href,
    { headers: { ...mcpHeaders, authorization: `Bearer ${tokensB.access_token}` }, body: mcpBody },
    'B access token after code replay',
  )
  assert(afterReplay.status === 401, 'B’s access token revoked by the replay (RFC 6749 §4.1.2)')
  const refreshB = await raw(
    'POST',
    `${BASE}/oauth/token`,
    {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokensB.refresh_token!,
        client_id: providerB.client!.client_id,
      }),
    },
    'B refresh after code replay',
  )
  assert(refreshB.status === 400, 'B’s refresh token dead too')

  say('negative: wrong PKCE verifier (third client)')
  const providerC = new MemoryAuthProvider(redirect, 'PKCE negative (s4 e2e)')
  callback = Promise.withResolvers<URLSearchParams>()
  try {
    await new Client({ name: 'c', version: '0' }).connect(
      new StreamableHTTPClientTransport(MCP_URL, { authProvider: providerC, fetch: sdkFetch }),
    )
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error
  }
  await page.goto(providerC.authorizationUrl!.href)
  await page.fill('input[name=password]', PASSWORD!)
  const navC = page.click('button[value=approve]')
  const paramsC = await callback.promise
  await navC.catch(() => undefined)
  const badVerifier = await raw(
    'POST',
    `${BASE}/oauth/token`,
    {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: paramsC.get('code')!,
        redirect_uri: redirect,
        client_id: providerC.client!.client_id,
        code_verifier: 'x'.repeat(64),
      }),
    },
    'wrong code_verifier',
  )
  results.wrong_verifier = { status: badVerifier.status, body: await badVerifier.json() }
  assert(badVerifier.status === 400, 'wrong PKCE verifier refused')

  say('owner revokes a connection on /connections → all of its tokens die (demo step 9)')
  const providerD = new MemoryAuthProvider(redirect, 'Revoke target (s4 e2e)')
  await authorize(providerD, '1.00', false)
  const clientD = new Client({ name: 'revoke-target-s4', version: '0.0.1' })
  await clientD.connect(new StreamableHTTPClientTransport(MCP_URL, { authProvider: providerD, fetch: sdkFetch }))
  const overviewD = structured(await clientD.callTool({ name: 'wallet_overview', arguments: {} }))
  const connectionD = (overviewD.connection as { id: string }).id
  const tokensD = providerD.tokens()!
  await page.goto(`${BASE}/connections`)
  const listed = await page.locator('body').innerText()
  assert(listed.includes('Revoke target (s4 e2e)'), 'connection D listed on /connections')
  const formD = page.locator(`form:has(button[data-connection="${connectionD}"])`)
  await formD.locator('input[name=password]').fill(PASSWORD!)
  await formD.locator('button').click()
  await shot(page, 'connections-revoked')
  assert((await page.locator('body').innerText()).includes('Revoked Revoke target'), 'owner revoke confirmed')
  const deadAccess = await raw(
    'POST',
    MCP_URL.href,
    { headers: { ...mcpHeaders, authorization: `Bearer ${tokensD.access_token}` }, body: mcpBody },
    'D access token after owner revoke',
  )
  assert(deadAccess.status === 401, 'D access token → 401 after owner revoke')
  const deadRefresh = await raw(
    'POST',
    `${BASE}/oauth/token`,
    {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokensD.refresh_token!,
        client_id: providerD.client!.client_id,
      }),
    },
    'D refresh after owner revoke',
  )
  assert(deadRefresh.status === 400, 'D refresh token → 400 after owner revoke')

  results.verdict = 'PASS'
  console.log('\nPASS')
} catch (error) {
  results.verdict = 'FAIL'
  results.error = error instanceof Error ? error.message : String(error)
  console.error('\nFAIL', error)
  await shot(page, 'failure').catch(() => undefined)
  process.exitCode = 1
} finally {
  writeFileSync(
    join(EVIDENCE, 'e2e.json'),
    `${JSON.stringify({ base: BASE, at: new Date().toISOString(), results, requests: log }, null, 2)}\n`,
  )
  await browser.close()
  server.stop(true)
}
