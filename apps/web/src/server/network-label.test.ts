import { Effect, ManagedRuntime, Predicate } from 'effect'
import { afterEach, describe, expect, test } from 'vitest'

import { makeFixtureChain } from '@hm/protocol'

import { serveMcp } from './mcp.ts'
import type { NetworkShape } from './network.ts'
import type { ConnectionProps } from './props.ts'
import type { AppRuntime } from './runtime.ts'
import { testNetwork, testServices } from './test/layers.ts'
import { OWNER_ID, SIGNER, WALLET_ID, seedWallet } from './test/seed.ts'
import { paymentPrepare, type ToolContext } from './tools.ts'

/**
 * What the AI app reads names the stage's network: the MCP instructions, the card and home resource descriptions on
 * both lanes, and the "does not exist yet" refusal say Stellar Mainnet on a pubnet stage and Stellar Testnet on
 * testnet, never a hardcoded "testnet" (K5).
 */

const ORIGIN = 'https://wallet.test'
const MISSING = 'GMISSINGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const AUTH = { token: 'token', clientId: 'https://claude.ai/oauth/claude-code-client-metadata', scopes: ['wallet'] }
const PUBNET: NetworkShape = {
  ...testNetwork,
  name: 'pubnet',
  caip: 'stellar:pubnet',
  label: 'Mainnet',
  explorerBase: 'https://stellar.expert/explorer/public',
}

const runtimes: Array<AppRuntime> = []
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
})

const world = async (network: NetworkShape) => {
  const runtime: AppRuntime = ManagedRuntime.make(
    testServices(makeFixtureChain({ accountsMissing: [MISSING] }), undefined, network),
  )
  runtimes.push(runtime)
  await runtime.runPromise(seedWallet())
  const props: ConnectionProps = {
    owner_id: OWNER_ID,
    wallet_id: WALLET_ID,
    connection_id: 'con_a',
    client_id: AUTH.clientId,
    client_name: 'Claude Code',
    client_domain: 'claude.ai',
    granted_at: '2026-10-25T12:00:00.000Z',
    grant: {
      grant_id: 'gr_a',
      allowance: '5.00',
      valid_until: '2099-01-01T00:00:00.000Z',
      rule_id: 1,
      signer_public_key: SIGNER,
    },
  }
  const ctx: ToolContext = { props, origin: ORIGIN }
  const rpc = async (method: string, params: Record<string, unknown>, headers: Record<string, string> = {}) => {
    const response = await serveMcp(
      runtime,
      new Request(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }),
      ctx,
      AUTH,
    )
    const json: unknown = await response.json()
    if (!Predicate.isObject(json) || !Predicate.isObject(json['result'])) throw new Error(JSON.stringify(json))
    return json['result']
  }
  return { runtime, ctx, rpc }
}

const INITIALIZE = { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } }

/** The MCP Apps resources' descriptions (the skill's files beside them name no network). */
const descriptions = (result: Record<string, unknown>) =>
  (Array.isArray(result['resources']) ? result['resources'] : [])
    .filter(Predicate.isObject)
    .filter(resource => String(resource['uri']).startsWith('ui://'))
    .map(resource => String(resource['description']))

describe('the network label follows the stage', () => {
  test('pubnet: instructions and both resource descriptions say Stellar Mainnet, never testnet', async () => {
    const w = await world(PUBNET)
    const init = await w.rpc('initialize', INITIALIZE)
    expect(String(init['instructions'])).toContain('(Stellar Mainnet)')
    expect(String(init['instructions']).toLowerCase()).not.toContain('testnet')
    const listed = descriptions(await w.rpc('resources/list', {}))
    expect(listed).toHaveLength(2)
    for (const description of listed) {
      expect(description).toContain('Stellar Mainnet.')
      expect(description.toLowerCase()).not.toContain('testnet')
    }
  })

  test('testnet: the same texts say Stellar Testnet', async () => {
    const w = await world(testNetwork)
    expect(String((await w.rpc('initialize', INITIALIZE))['instructions'])).toContain('(Stellar Testnet)')
    for (const description of descriptions(await w.rpc('resources/list', {})))
      expect(description).toContain('Stellar Testnet.')
  })

  test('pubnet: a recipient that does not exist yet is refused on Stellar Mainnet', async () => {
    const w = await world(PUBNET)
    const refused = await w.runtime.runPromise(
      Effect.flip(paymentPrepare(w.ctx, { recipient: MISSING, amount: '1', idempotency_key: 'missing-1' })),
    )
    expect(refused.message).toBe(`${MISSING} does not exist on Stellar Mainnet yet, so it cannot receive USDC.`)
  })
})
