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
  })

  test('tools/list starts with the ten tools in their order, each with an object input schema', async () => {
    const result = resultOf(await rpc('tools/list'))
    const tools = Array.isArray(result['tools']) ? result['tools'].filter(Predicate.isObject) : []
    expect(tools.slice(0, 10).map(tool => tool['name'])).toEqual(TEN_TOOLS)
    for (const tool of tools) expect(tool['inputSchema']).toMatchObject({ type: 'object' })
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
  })

  test('an unknown tool is a tool error, not a protocol error', async () => {
    const result = resultOf(await rpc('tools/call', { name: 'nope', arguments: {} }))
    expect(result['isError']).toBe(true)
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
