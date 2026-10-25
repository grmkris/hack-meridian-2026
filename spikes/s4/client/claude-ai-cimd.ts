import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
/**
 * claude.ai web's OAuth leg, replayed: its published CIMD client id and redirect URI, PKCE S256, `resource`.
 * Proves our server accepts claude.ai's identity (consent shows "Published by claude.ai", tokens go to claude.ai);
 * the redirect to claude.ai is intercepted in the browser and the code exchanged here, as Claude's backend would.
 *
 *   bun client/claude-ai-cimd.ts [base-url]
 */
import { chromium } from 'playwright-core'

const ROOT = join(import.meta.dir, '..')
const BASE = (process.argv[2] ?? 'https://hm26-s4-mcp.kristjan-grm11775.workers.dev').replace(/\/$/u, '')
const CLIENT_ID = 'https://claude.ai/oauth/mcp-oauth-client-metadata'
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback'
const PASSWORD = /^DEV_PASSWORD=(.+)$/mu.exec(readFileSync(join(ROOT, '.dev.vars'), 'utf8'))?.[1]?.trim()
if (!PASSWORD) throw new Error('DEV_PASSWORD missing')

const lines: string[] = []
const say = (line: string) => {
  lines.push(line)
  console.log(line)
}
const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString('base64url')
const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
const state = crypto.randomUUID()
const authorize = new URL(`${BASE}/authorize`)
for (const [k, v] of Object.entries({
  response_type: 'code',
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT,
  code_challenge: challenge,
  code_challenge_method: 'S256',
  state,
  scope: 'wallet offline_access',
  resource: `${BASE}/mcp`,
}))
  authorize.searchParams.set(k, v)

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext()
const page = await context.newPage()
const opened = await page.goto(authorize.href)
say(`GET /authorize (client_id=${CLIENT_ID}) → ${opened?.status()}`)
const text = await page.locator('body').innerText()
say(`consent h1: ${await page.locator('h1').innerText()}`)
say(
  `consent says "Published by claude.ai": ${text.includes('Published by claude.ai')}; tokens to claude.ai: ${text.includes('Access will be sent to claude.ai')}`,
)
await page.screenshot({ path: join(ROOT, 'evidence', 'claude-ai-consent.png'), fullPage: true })
// Submit the form outside the browser with the browser's consent cookie, so the code is never delivered to claude.ai.
const handle = await page.inputValue('input[name=handle]')
const cookie = (await context.cookies(BASE)).map(c => `${c.name}=${c.value}`).join('; ')
await browser.close()
const approve = await fetch(`${BASE}/authorize`, {
  method: 'POST',
  redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin: BASE },
  body: new URLSearchParams({
    handle,
    password: PASSWORD,
    decision: 'approve',
    allowance: '5.00',
    wallet: 'wal_personal',
  }),
})
const location = approve.headers.get('location')
if (location === null) throw new Error(`consent POST → ${approve.status} without Location`)
const callback = new URL(location)
say(
  `POST /authorize → ${approve.status} Location ${callback.origin}${callback.pathname} (state matches: ${callback.searchParams.get('state') === state}, iss=${callback.searchParams.get('iss')})`,
)

const token = await fetch(`${BASE}/oauth/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code: callback.searchParams.get('code')!,
    redirect_uri: REDIRECT,
    client_id: CLIENT_ID,
    code_verifier: verifier,
    resource: `${BASE}/mcp`,
  }),
})
const tokens = (await token.json()) as {
  access_token?: string
  token_type?: string
  scope?: string
  expires_in?: number
  resource?: string
}
say(
  `POST /oauth/token (public client, no secret) → ${token.status} token_type=${tokens.token_type} scope=${tokens.scope} expires_in=${tokens.expires_in}`,
)

const headers = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  authorization: `Bearer ${tokens.access_token}`,
}
const init = await fetch(`${BASE}/mcp`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai-replay', version: '0' } },
  }),
})
const initBody = (await init.json()) as { result?: { protocolVersion?: string; serverInfo?: unknown } }
say(`POST /mcp initialize → ${init.status} protocolVersion=${initBody.result?.protocolVersion}`)
const call = await fetch(`${BASE}/mcp`, {
  method: 'POST',
  headers: { ...headers, 'mcp-protocol-version': '2025-06-18' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'wallet_overview', arguments: {} },
  }),
})
const result = (await call.json()) as { result?: { structuredContent?: { connection?: { client_name?: string } } } }
say(
  `POST /mcp tools/call wallet_overview → ${call.status} connection.client_name=${result.result?.structuredContent?.connection?.client_name}`,
)
writeFileSync(join(ROOT, 'evidence', 'claude-ai-cimd.log'), `${lines.join('\n')}\n`)
