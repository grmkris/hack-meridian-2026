import { Effect, ManagedRuntime, Predicate, Schema } from 'effect'
import { Base64Url } from 'effect/encoding'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { Chain, fixtureAssertion, makeFixtureChain, toStroops, type WebAuthnAssertion } from '@hm/protocol'
import { SoftPasskey } from '@hm/stellar/testing'

import { serveMcp } from './mcp.ts'
import type { ConnectionProps } from './props.ts'
import { ownerRoute } from './routes.ts'
import { insert, write } from './rows.ts'
import type { AppRuntime } from './runtime.ts'
import { createContact, createSession } from './store.ts'
import { testServices } from './test/layers.ts'
import { BOB } from './test/seed.ts'
import type { ToolContext } from './tools.ts'

/**
 * Both MCP lanes through serveMcp on the fixture chain: the 2026-07-28 lane serves the same tools, resources and events
 * as the SDK lane, and the nod becomes a URL elicitation that the passkey on the approval page answers.
 */

const ORIGIN = 'https://wallet.test'
const NOW = '2026-10-25T12:00:00.000Z'
const VERSION = '2026-07-28'
const AUTH = { token: 'token', clientId: 'https://claude.ai/oauth/claude-code-client-metadata', scopes: ['wallet'] }

const world = (passkey: SoftPasskey) =>
  Effect.gen(function* () {
    const chain = yield* Chain
    const { contractId } = yield* chain.deployAccount({
      pubkey: passkey.publicKey65,
      credentialId: passkey.credentialId,
    })
    yield* chain.fundNewWallet(contractId, toStroops('30'))
    const signer = yield* chain.newSigner
    const prepared = yield* chain.prepareInstallGrant(contractId, signer.publicKey, toStroops('5'), 86_400)
    const installed = yield* chain.installGrant(prepared, fixtureAssertion(prepared.challenge))
    yield* write(
      insert('owners', { id: 'own_l', created_at: NOW }),
      insert('wallets', {
        id: 'wal_l',
        owner_id: 'own_l',
        name: 'Personal',
        contract_id: contractId,
        passkey_credential_id: Base64Url.encode(passkey.credentialId),
        passkey_public_key: Base64Url.encode(passkey.publicKey65),
        network: 'stellar:testnet',
        deploy_tx: null,
        fund_tx: null,
        created_at: NOW,
      }),
      insert('connections', {
        id: 'con_l',
        owner_id: 'own_l',
        wallet_id: 'wal_l',
        oauth_client_id: AUTH.clientId,
        oauth_client_name: 'Claude Code',
        oauth_client_domain: 'claude.ai',
        oauth_grant_id: 'con_l',
        status: 'active',
        created_at: NOW,
        revoked_at: null,
      }),
      insert('spending_grants', {
        id: 'gr_l',
        connection_id: 'con_l',
        wallet_id: 'wal_l',
        signer_public_key: signer.address,
        signer_key_ref: signer.signerKeyRef,
        asset: 'USDC',
        total: toStroops('5'),
        spent: 0n,
        reserved: 0n,
        valid_until: '2099-01-01T00:00:00.000Z',
        valid_until_ledger: installed.validUntilLedger,
        rule_id: installed.ruleId,
        rule_status: 'installed',
        pocket_address: signer.address,
        pocket_balance: 0n,
        first_payment_done: false,
        status: 'active',
        install_tx: installed.tx,
        created_at: NOW,
      }),
    )
    yield* createContact({
      ownerId: 'own_l',
      displayName: 'Bob',
      aliases: [],
      address: BOB,
      memo: null,
      readiness: 'usdc_ready',
    })
    const props: ConnectionProps = {
      owner_id: 'own_l',
      wallet_id: 'wal_l',
      connection_id: 'con_l',
      client_id: AUTH.clientId,
      client_name: 'Claude Code',
      client_domain: 'claude.ai',
      granted_at: NOW,
      grant: {
        grant_id: 'gr_l',
        allowance: '5.00',
        valid_until: '2099-01-01T00:00:00.000Z',
        rule_id: installed.ruleId,
        signer_public_key: signer.address,
      },
    }
    const ctx: ToolContext = { props, origin: ORIGIN }
    return ctx
  })

let runtime: AppRuntime
let ctx: ToolContext
let passkey: SoftPasskey

beforeEach(async () => {
  runtime = ManagedRuntime.make(testServices(makeFixtureChain()))
  passkey = await SoftPasskey.create('wallet.test', ORIGIN)
  ctx = await runtime.runPromise(world(passkey))
})
afterEach(() => runtime.dispose())

const objectOf = (value: unknown): Record<string, unknown> => (Predicate.isObject(value) ? { ...value } : {})

/** One JSON-RPC message through serveMcp; the parsed body. */
const send = async (body: Record<string, unknown>, headers: Record<string, string> = {}) => {
  const response = await serveMcp(
    runtime,
    new Request(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
    }),
    ctx,
    AUTH,
  )
  return { status: response.status, json: objectOf(await response.json()) }
}

const meta = (capabilities: Record<string, unknown> = {}) => ({
  'io.modelcontextprotocol/protocolVersion': VERSION,
  'io.modelcontextprotocol/clientCapabilities': capabilities,
})

const modern = async (method: string, params: Record<string, unknown> = {}, capabilities = {}) =>
  objectOf((await send({ method, params: { ...params, _meta: meta(capabilities) } })).json['result'])

const legacy = async (method: string, params: Record<string, unknown> = {}) =>
  objectOf((await send({ method, params })).json['result'])

const namesOf = (list: unknown) => (Array.isArray(list) ? list.map(item => objectOf(item)['name']) : [])

const assertionBody = (assertion: WebAuthnAssertion) =>
  JSON.stringify({
    assertion: {
      credential_id: Base64Url.encode(passkey.credentialId),
      client_data_json: Base64Url.encode(assertion.clientDataJSON),
      authenticator_data: Base64Url.encode(assertion.authenticatorData),
      signature: Base64Url.encode(assertion.signature),
    },
  })

/** The owner approves on the approval page with the passkey (what Nod's page does in the browser). */
const approve = async (url: string) => {
  const token = await runtime.runPromise(createSession('own_l'))
  const path = new URL(url).pathname
  const call = async (to: string, payload: string) => {
    const response = await ownerRoute(
      runtime,
      new Request(`${ORIGIN}${to}`, {
        method: 'POST',
        headers: { cookie: `hm_owner=${token}`, 'content-type': 'application/json' },
        body: payload,
      }),
      to,
    )
    if (response === undefined) throw new Error(`no route for ${to}`)
    return { status: response.status, text: await response.text() }
  }
  const prepared = await call(`${path}/prepare`, '{}')
  const { challenge } = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ challenge: Schema.String })))(
    prepared.text,
  )
  const approved = await call(path, assertionBody(await passkey.assertChallenge(challenge)))
  expect(approved.status).toBe(200)
}

describe('the 2026-07-28 lane through /mcp', () => {
  test('server/discover offers tools, resources and events with the server in _meta', async () => {
    const result = await modern('server/discover')
    expect(result).toMatchObject({
      resultType: 'complete',
      supportedVersions: [VERSION],
      capabilities: { tools: {}, resources: {}, events: {}, extensions: { 'io.modelcontextprotocol/events': {} } },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'Nod', title: 'Nod' } },
    })
  })

  test('it lists the same tools as the SDK lane, and the same events', async () => {
    expect(namesOf((await modern('tools/list'))['tools'])).toEqual(namesOf((await legacy('tools/list'))['tools']))
    const events = (await modern('events/list'))['events']
    expect(namesOf(events)).toEqual(namesOf((await legacy('events/list'))['events']))
    expect(namesOf(events)).toContain('payment.received')
  })

  test('a header that disagrees with the body is refused before anything runs', async () => {
    const response = await send(
      { method: 'tools/list', params: { _meta: meta() } },
      { 'mcp-protocol-version': VERSION, 'mcp-method': 'tools/call' },
    )
    expect(response.status).toBe(400)
    expect(response.json).toMatchObject({ error: { code: -32020 } })
  })

  test('the nod as a URL elicitation: input_required, the passkey approves, the retry returns the receipt', async () => {
    const args = { recipient: 'Bob', amount: '20', reason: 'dinner', idempotency_key: 'dinner-mrtr' }
    const url = { elicitation: { url: {} } }
    const first = await modern('tools/call', { name: 'payment_prepare', arguments: args }, url)
    expect(first['resultType']).toBe('input_required')
    const request = objectOf(objectOf(first['inputRequests'])['approval'])
    const params = objectOf(request['params'])
    expect(params).toMatchObject({ mode: 'url' })
    expect(String(params['url'])).toMatch(/\/approve\/pi_/u)
    const state = first['requestState']
    const retry = { requestState: state, inputResponses: { approval: { action: 'accept' } } }
    expect(
      (await modern('tools/call', { name: 'payment_prepare', arguments: args, ...retry }, url))['resultType'],
    ).toBe('input_required')
    await approve(String(params['url']))
    const settled = await modern('tools/call', { name: 'payment_prepare', arguments: args, ...retry }, url)
    expect(settled['resultType']).toBe('complete')
    expect(settled['structuredContent']).toMatchObject({ payment_id: state, status: 'confirmed', lane: 'owner' })
  })
})
