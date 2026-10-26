import { Effect, ManagedRuntime, Predicate } from 'effect'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { Chain, makeFixtureChain, toStroops } from '@hm/protocol'

import { serveMcp } from './mcp.ts'
import type { ConnectionProps } from './props.ts'
import { insert, write } from './rows.ts'
import type { AppRuntime } from './runtime.ts'
import { testServices } from './test/layers.ts'
import type { ToolContext } from './tools.ts'

/**
 * /mcp as JSON-RPC over HTTP, through serveMcp (what the OAuth provider calls once the bearer is checked), on the fixture
 * chain and SQLite. These pin the wire: what every host sees, lane by lane.
 */

const ORIGIN = 'https://wallet.test'
const NOW = '2026-10-25T12:00:00.000Z'
const AUTH = { token: 'token', clientId: 'https://claude.ai/oauth/claude-code-client-metadata', scopes: ['wallet'] }

/** A deployed, funded fixture wallet with one connection and a 5 USDC grant, as the consent page leaves it. */
const world = Effect.gen(function* () {
  const chain = yield* Chain
  const { contractId } = yield* chain.deployAccount({ pubkey: new Uint8Array(65), credentialId: new Uint8Array(16) })
  yield* chain.fundNewWallet(contractId, toStroops('30'))
  const signer = yield* chain.newSigner
  yield* write(
    insert('owners', { id: 'own_m', created_at: NOW }),
    insert('wallets', {
      id: 'wal_m',
      owner_id: 'own_m',
      name: 'Personal',
      contract_id: contractId,
      passkey_credential_id: 'cred',
      passkey_public_key: 'pub',
      network: 'stellar:testnet',
      deploy_tx: null,
      fund_tx: null,
      created_at: NOW,
    }),
    insert('connections', {
      id: 'con_m',
      owner_id: 'own_m',
      wallet_id: 'wal_m',
      oauth_client_id: AUTH.clientId,
      oauth_client_name: 'Claude Code',
      oauth_client_domain: 'claude.ai',
      oauth_grant_id: 'con_m',
      status: 'active',
      created_at: NOW,
      revoked_at: null,
    }),
    insert('spending_grants', {
      id: 'gr_m',
      connection_id: 'con_m',
      wallet_id: 'wal_m',
      signer_public_key: signer.address,
      signer_key_ref: signer.signerKeyRef,
      asset: 'USDC',
      total: toStroops('5'),
      spent: 0n,
      reserved: 0n,
      valid_until: '2099-01-01T00:00:00.000Z',
      valid_until_ledger: 9_999_999,
      rule_id: 1,
      rule_status: 'installed',
      pocket_address: signer.address,
      pocket_balance: 0n,
      first_payment_done: false,
      status: 'active',
      install_tx: 'tx-install',
      created_at: NOW,
    }),
  )
  const props: ConnectionProps = {
    owner_id: 'own_m',
    wallet_id: 'wal_m',
    connection_id: 'con_m',
    client_id: AUTH.clientId,
    client_name: 'Claude Code',
    client_domain: 'claude.ai',
    granted_at: NOW,
    grant: {
      grant_id: 'gr_m',
      allowance: '5.00',
      valid_until: '2099-01-01T00:00:00.000Z',
      rule_id: 1,
      signer_public_key: signer.address,
    },
  }
  const ctx: ToolContext = { props, origin: ORIGIN }
  return ctx
})

let runtime: AppRuntime
let ctx: ToolContext

beforeEach(async () => {
  runtime = ManagedRuntime.make(testServices(makeFixtureChain()))
  ctx = await runtime.runPromise(world)
})
afterEach(() => runtime.dispose())

const post = (body: string, headers: Record<string, string> = {}) =>
  serveMcp(
    runtime,
    new Request(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body,
    }),
    ctx,
    AUTH,
  )

/** One JSON-RPC call; the parsed response body. */
const rpc = async (method: string, params: Record<string, unknown> = {}) => {
  const response = await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }))
  expect(response.status).toBe(200)
  const json: unknown = await response.json()
  if (!Predicate.isObject(json)) throw new Error('not a JSON-RPC response')
  return json
}

const resultOf = (json: Record<string, unknown>) => {
  if (!Predicate.isObject(json['result'])) throw new Error(`no result: ${JSON.stringify(json)}`)
  return json['result']
}

const INITIALIZE = {
  protocolVersion: '2025-11-25',
  capabilities: {},
  clientInfo: { name: 'test', version: '1.0.0' },
}

const TEN_TOOLS = [
  'wallet_overview',
  'contacts_search',
  'payment_prepare',
  'payment_execute',
  'payment_approve_url',
  'payment_status',
  'paid_resource_fetch',
  'paid_mcp_call',
  'connection_grant_create',
  'connection_grant_revoke',
]

const APPENDED_TOOLS = [
  'nod_home',
  'request_create',
  'requests_list',
  'request_pay',
  'request_decline',
  'contact_add',
  'contact_update',
  'contact_remove',
  'wallet_deposit_address',
  'payments_list',
  'connection_grant_update',
  'wallet_topup_quote',
  'wallet_topup_status',
  'get_guide',
  'recipient_scan',
  'recipient_read',
]

const CARD_TOOLS = [
  'wallet_overview',
  'payment_prepare',
  'paid_resource_fetch',
  'paid_mcp_call',
  'connection_grant_create',
  'connection_grant_revoke',
  'request_create',
  'requests_list',
  'request_pay',
]

describe('the legacy lane (protocol revisions up to 2025-11-25)', () => {
  test('initialize names Nod, offers tools and carries the instructions', async () => {
    const result = resultOf(await rpc('initialize', INITIALIZE))
    expect(result['protocolVersion']).toBe('2025-11-25')
    expect(result['serverInfo']).toMatchObject({
      name: 'Nod',
      version: '0.1.0',
      title: 'Nod',
      icons: [{ src: `${ORIGIN}/favicon.svg`, mimeType: 'image/svg+xml' }],
    })
    expect(result['capabilities']).toMatchObject({ tools: {} })
    expect(String(result['instructions'])).toContain('approval_url')
    // Hosts keep the first paragraph: at most 512 characters, then "More:" bullets, under 2000 in all.
    const text = String(result['instructions'])
    expect(text.split('\n')[0]?.length).toBeLessThanOrEqual(512)
    expect(text).toContain('\nMore:\n- ')
    expect(text.length).toBeLessThan(2000)
  })

  test('tools/list keeps the ten tools in their order, then nod_home and the request tools, each with an object input schema', async () => {
    const result = resultOf(await rpc('tools/list'))
    const tools = Array.isArray(result['tools']) ? result['tools'].filter(Predicate.isObject) : []
    expect(tools.slice(0, 10).map(tool => tool['name'])).toEqual(TEN_TOOLS)
    expect(tools.slice(10).map(tool => tool['name'])).toEqual(APPENDED_TOOLS)
    for (const tool of tools) expect(tool['inputSchema']).toMatchObject({ type: 'object' })
  })

  test('tools that render a card carry its ui:// resource under every key hosts read; polled tools carry none', async () => {
    const result = resultOf(await rpc('tools/list'))
    const tools = Array.isArray(result['tools']) ? result['tools'].filter(Predicate.isObject) : []
    const metaOf = (name: string) => tools.find(tool => tool['name'] === name)?.['_meta']
    for (const name of CARD_TOOLS)
      expect(metaOf(name)).toMatchObject({
        ui: { resourceUri: 'ui://nod/card/v1' },
        'ui/resourceUri': 'ui://nod/card/v1',
        'openai/outputTemplate': 'ui://nod/card/v1',
      })
    for (const name of [
      'contacts_search',
      'payment_execute',
      'payment_approve_url',
      'payment_status',
      'request_decline',
    ])
      expect(metaOf(name)).toBeUndefined()
    expect(metaOf('nod_home')).toEqual({
      ui: { resourceUri: 'ui://nod/home/v1', visibility: ['app'] },
      'ui/resourceUri': 'ui://nod/home/v1',
      'openai/outputTemplate': 'ui://nod/home/v1',
      'openai/ui': { entrypoints: [{ type: 'global' }] },
    })
  })

  test('nod_home takes an empty object and answers with the wallet overview', async () => {
    const home = resultOf(await rpc('tools/call', { name: 'nod_home', arguments: {} }))
    const overview = resultOf(await rpc('tools/call', { name: 'wallet_overview', arguments: {} }))
    expect(home['isError']).toBeUndefined()
    expect(home['structuredContent']).toEqual(overview['structuredContent'])
  })

  test('tools/call answers with the sentence, the JSON and structuredContent', async () => {
    const result = resultOf(await rpc('tools/call', { name: 'wallet_overview', arguments: {} }))
    const content = Array.isArray(result['content']) ? result['content'].filter(Predicate.isObject) : []
    expect(content).toHaveLength(2)
    expect(content[0]).toMatchObject({ type: 'text' })
    expect(String(content[0]?.['text'])).toContain('30.00 USDC')
    const structured = result['structuredContent']
    expect(Predicate.isObject(structured) && structured['grant_remaining']).toBe('5.00')
    expect(JSON.parse(String(content[1]?.['text']))).toEqual(structured)
    expect(content[0]?.['annotations']).toBeUndefined()
    expect(content[1]?.['annotations']).toEqual({ audience: ['assistant'] })
  })

  test('an unknown tool is a tool error, not a protocol error', async () => {
    const result = resultOf(await rpc('tools/call', { name: 'nope', arguments: {} }))
    expect(result['isError']).toBe(true)
  })
})

const EMPTY_CSP = { connectDomains: [], resourceDomains: [], frameDomains: [] }

describe('MCP Apps resources (the cards)', () => {
  test('initialize offers resources', async () => {
    const result = resultOf(await rpc('initialize', INITIALIZE))
    expect(result['capabilities']).toMatchObject({ tools: {}, resources: {} })
  })

  test('resources/list names the card and the home view, both with an empty CSP', async () => {
    const result = resultOf(await rpc('resources/list'))
    // The skill's files follow them (skill.test.ts).
    const resources = (Array.isArray(result['resources']) ? result['resources'].filter(Predicate.isObject) : []).filter(
      resource => String(resource['uri']).startsWith('ui://'),
    )
    expect(resources.map(resource => resource['uri'])).toEqual([
      'ui://nod/card/v1',
      'ui://nod/home/v1',
      'ui://nod/recipient-scan/v1',
    ])
    for (const resource of resources) {
      expect(resource['mimeType']).toBe('text/html;profile=mcp-app')
      expect(resource['_meta']).toMatchObject({ ui: { csp: EMPTY_CSP, prefersBorder: true } })
    }
    expect(resources[1]?.['_meta']).toMatchObject({
      'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'], preferredDisplayMode: 'fullscreen' },
    })
  })

  test('resources/read serves the sealed card with its view, and repeats the CSP on the content item', async () => {
    for (const [uri, view] of [
      ['ui://nod/card/v1', 'card'],
      ['ui://nod/home/v1', 'home'],
      ['ui://nod/recipient-scan/v1', 'scan'],
    ] as const) {
      const result = resultOf(await rpc('resources/read', { uri }))
      const contents = Array.isArray(result['contents']) ? result['contents'].filter(Predicate.isObject) : []
      expect(contents).toHaveLength(1)
      const item = contents[0]
      expect(item).toMatchObject({ uri, mimeType: 'text/html;profile=mcp-app', _meta: { ui: { csp: EMPTY_CSP } } })
      const html = String(item?.['text'])
      expect(html).toContain(`<meta name="nod-view" content="${view}">`)
      expect(html).toMatch(/<meta name="nod-card-inputs" content="[0-9a-f]{64}">/u)
      expect(html).toContain("connect-src 'none'")
    }
  })

  test('an unknown resource is an invalid-params error; there are no resource templates', async () => {
    const unknown = await rpc('resources/read', { uri: 'ui://nod/nope/v1' })
    expect(unknown['error']).toMatchObject({ code: -32602 })
    expect(resultOf(await rpc('resources/templates/list'))).toEqual({ resourceTemplates: [] })
  })
})

describe('the HTTP edge', () => {
  test('GET is 405', async () => {
    const response = await serveMcp(runtime, new Request(`${ORIGIN}/mcp`), ctx, AUTH)
    expect(response.status).toBe(405)
  })

  test('a body that is not JSON is a JSON-RPC parse error', async () => {
    const response = await post('{not json')
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: -32700 } })
  })

  test('a body over the cap is refused before it is parsed', async () => {
    const response = await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', pad: 'x'.repeat(1_100_000) }))
    expect(response.status).toBe(413)
  })
})
