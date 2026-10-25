import { Effect, Layer, ManagedRuntime, Predicate } from 'effect'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { makeFixtureChain, toStroops } from '@hm/protocol'

import { Ledger, type NewIntent } from '../ledger.ts'
import { serveMcp } from '../mcp.ts'
import type { ConnectionProps } from '../props.ts'
import { first, sql, write } from '../rows.ts'
import type { AppRuntime } from '../runtime.ts'
import { testServices } from '../test/layers.ts'
import { BOB, OWNER_ID, seedWallet, SIGNER, WALLET_ID } from '../test/seed.ts'
import type { ToolContext } from '../tools.ts'
import { EventEgress } from './delivery.ts'
import type { EventEnvelope } from './schemas.ts'
import { verifyEventWebhook } from './webhooks.ts'

/**
 * events/* through /mcp (serveMcp, the legacy lane) on SQLite and the fixture chain, with a fake subscriber standing
 * in for Goblin's webhook: it checks every signature with the ported verifier and echoes verification challenges.
 */

const ORIGIN = 'https://wallet.test'
const HOOK = 'https://hooks.example.com/mcp-events/ws/con/token'
const SECRET = `whsec_${btoa('0123456789abcdef0123456789abcdef')}`
const AUTH = { token: 'token', clientId: 'https://claude.ai/oauth/claude-code-client-metadata', scopes: ['wallet'] }

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

/** The fake subscriber: what it received (verified), and how it answers. */
interface Subscriber {
  received: Array<{ readonly envelope: EventEnvelope; readonly headers: Headers }>
  answer: 'echo' | 'wrong' | 500
}
let subscriber: Subscriber

const fakeFetch = async (url: string, init: RequestInit): Promise<Response> => {
  expect(url).toBe(HOOK)
  expect(init.redirect).toBe('manual')
  const headers = new Headers(init.headers)
  const body = new Uint8Array(await new Response(init.body).arrayBuffer())
  const envelope = await verifyEventWebhook(body, headers, { current: SECRET }, Math.floor(Date.now() / 1000))
  subscriber.received.push({ envelope, headers })
  if (subscriber.answer === 500) return new Response('down', { status: 500 })
  if ('type' in envelope && envelope.type === 'verification')
    return Response.json({ challenge: subscriber.answer === 'echo' ? envelope.challenge : 'nope' })
  return new Response(null, { status: 204 })
}

let runtime: AppRuntime

beforeEach(async () => {
  subscriber = { received: [], answer: 'echo' }
  runtime = ManagedRuntime.make(
    Layer.merge(testServices(makeFixtureChain()), Layer.succeed(EventEgress, { fetch: fakeFetch })),
  )
  await runtime.runPromise(seedWallet())
})
afterEach(() => runtime.dispose())

const rpc = async (method: string, params: Record<string, unknown> = {}) => {
  const response = await serveMcp(
    runtime,
    new Request(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
    ctx,
    AUTH,
  )
  expect(response.status).toBe(200)
  const json: unknown = await response.json()
  if (!Predicate.isObject(json)) throw new Error('not a JSON-RPC response')
  return json
}
const resultOf = async (method: string, params: Record<string, unknown> = {}) => {
  const json = await rpc(method, params)
  if (!Predicate.isObject(json['result'])) throw new Error(`no result: ${JSON.stringify(json)}`)
  return json['result']
}
const errorOf = async (method: string, params: Record<string, unknown> = {}) => {
  const json = await rpc(method, params)
  if (!Predicate.isObject(json['error'])) throw new Error(`no error: ${JSON.stringify(json)}`)
  return json['error']
}

const intent = (key: string, amount: string): NewIntent => ({
  scope: 'con_a',
  idempotencyKey: key,
  fingerprint: `payment|BOB|${amount}`,
  kind: 'payment',
  connectionId: 'con_a',
  grantId: 'gr_a',
  requester: 'Claude Code',
  reason: 'the AI wrote this, never in an event',
  contactId: null,
  recipientName: 'Bob',
  recipientAddress: BOB,
  recipientReadiness: 'usdc_ready',
  resource: null,
  amount: toStroops(amount),
  forceOwner: false,
  claim: false,
  operationKind: 'transfer',
  pocketBalance: null,
})

/** An over-allowance payment: the ledger journals approval.needed. */
const needNod = (key: string, amount = '25') =>
  runtime.runPromise(Ledger.use(ledger => ledger.prepareIntent(WALLET_ID, intent(key, amount))))

const events = (result: Record<string, unknown>) =>
  Array.isArray(result['events']) ? result['events'].filter(Predicate.isObject) : []

const subscribeParams = (extra: Record<string, unknown> = {}) => ({
  name: 'approval.needed',
  arguments: {},
  delivery: { mode: 'webhook', url: HOOK, secret: SECRET },
  cursor: null,
  ttlMs: 3_600_000,
  maxAgeMs: 7 * 86_400_000,
  ...extra,
})

describe('events on the legacy lane', () => {
  test('initialize declares events and the io.modelcontextprotocol/events extension', async () => {
    const result = await resultOf('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    })
    expect(result['capabilities']).toMatchObject({
      tools: {},
      events: {},
      extensions: { 'io.modelcontextprotocol/events': {} },
    })
  })

  test('events/list offers ten events (the six, then the topup family), each by webhook and poll, with object schemas', async () => {
    const list = events(await resultOf('events/list'))
    expect(list.map(event => event['name'])).toEqual([
      'payment.received',
      'payment.settled',
      'approval.needed',
      'request.received',
      'request.answered',
      'allowance.changed',
      'topup.pending',
      'topup.detected',
      'topup.arrived',
      'topup.expired',
    ])
    for (const event of list) {
      expect(event['delivery']).toEqual(['webhook', 'poll'])
      expect(event['inputSchema']).toMatchObject({ type: 'object', additionalProperties: false })
      expect(event['payloadSchema']).toMatchObject({ type: 'object' })
    }
  })

  test('other unknown methods stay -32601; events/stream is unsupported (-32014)', async () => {
    expect(await errorOf('nope/nothing')).toMatchObject({ code: -32601 })
    expect(await errorOf('events/stream', { name: 'approval.needed', arguments: {} })).toMatchObject({
      code: -32014,
    })
  })

  test('events/poll: a null cursor is the head; then pages of the wallet events, Nod links on this origin', async () => {
    const start = await resultOf('events/poll', { name: 'approval.needed', arguments: {}, cursor: null })
    expect(start).toMatchObject({ events: [], truncated: false, hasMore: false, nextPollMs: 10_000 })
    expect(start['cursor']).toMatch(/^\d{16}$/u)
    const a = await needNod('a')
    const b = await needNod('b', '30')
    const page1 = await resultOf('events/poll', {
      name: 'approval.needed',
      arguments: {},
      cursor: start['cursor'],
      maxEvents: 1,
    })
    expect(page1).toMatchObject({ hasMore: true, nextPollMs: 0, truncated: false })
    expect(events(page1)).toHaveLength(1)
    expect(events(page1)[0]).toMatchObject({
      eventId: `approval.needed:${a.intent.id}`,
      name: 'approval.needed',
      data: {
        title: 'Needs your nod: 25.00 USDC to Bob',
        url: `${ORIGIN}/approve/${a.intent.id}`,
        network: 'stellar:testnet',
        payment_id: a.intent.id,
        amount: '25.00',
        asset: 'USDC',
        counterparty: { address: BOB, contact_name: 'Bob' },
      },
    })
    expect(JSON.stringify(page1)).not.toContain('the AI wrote this')
    const page2 = await resultOf('events/poll', { name: 'approval.needed', arguments: {}, cursor: page1['cursor'] })
    expect(events(page2).map(event => event['eventId'])).toEqual([`approval.needed:${b.intent.id}`])
    expect(page2).toMatchObject({ hasMore: false })
    const empty = await resultOf('events/poll', { name: 'approval.needed', arguments: {}, cursor: page2['cursor'] })
    expect(events(empty)).toEqual([])
    expect(empty['cursor']).toBe(page2['cursor'])
  })

  test('events/poll filters by arguments and refuses bad ones', async () => {
    const start = await resultOf('events/poll', { name: 'payment.settled', arguments: {}, cursor: null })
    expect(
      await errorOf('events/poll', { name: 'payment.settled', arguments: { nope: 1 }, cursor: start['cursor'] }),
    ).toMatchObject({ code: -32602 })
    expect(await errorOf('events/poll', { name: 'no.such', arguments: {}, cursor: null })).toMatchObject({
      code: -32011,
    })
    expect(
      await errorOf('events/poll', { name: 'approval.needed', arguments: {}, cursor: '9999999999999999' }),
    ).toMatchObject({ code: -32602 })
  })

  test('events/subscribe proves the endpoint in the request, and a refresh keeps the id and the cursor', async () => {
    const result = await resultOf('events/subscribe', subscribeParams())
    expect(String(result['id'])).toMatch(/^sub_[0-9a-f]{64}$/u)
    expect(result['cursor']).toMatch(/^\d{16}$/u)
    expect(result['truncated']).toBe(false)
    const refreshBefore = Date.parse(String(result['refreshBefore']))
    expect(refreshBefore).toBeGreaterThan(Date.now() + 3_500_000)
    expect(refreshBefore).toBeLessThanOrEqual(Date.now() + 86_400_000)
    expect(subscriber.received).toHaveLength(1)
    const verification = subscriber.received[0]
    expect(verification?.envelope).toMatchObject({ type: 'verification' })
    expect(verification?.headers.get('webhook-id')).toMatch(/^msg_verification_/u)
    expect(verification?.headers.get('x-mcp-subscription-id')).toBe(result['id'])
    const row = await runtime.runPromise(
      first(sql('SELECT state, sealed_secret FROM event_subscriptions WHERE id = ?', String(result['id'])), saved =>
        Effect.succeed({ state: String(saved['state']), sealed: String(saved['sealed_secret']) }),
      ),
    )
    expect(row?.state).toBe('active')
    expect(row?.sealed).not.toContain(SECRET.slice(6))

    await needNod('later')
    const again = await resultOf('events/subscribe', subscribeParams({ ttlMs: 999_999_999 }))
    expect(again['id']).toBe(result['id'])
    expect(again['cursor']).toBe(result['cursor'])
    expect(Date.parse(String(again['refreshBefore']))).toBeLessThanOrEqual(Date.now() + 86_400_000)
  })

  test('an endpoint that does not echo the challenge is a callback error, and the subscription stays pending', async () => {
    subscriber.answer = 'wrong'
    expect(await errorOf('events/subscribe', subscribeParams())).toMatchObject({
      code: -32015,
      data: { reason: 'challenge_failed' },
    })
    subscriber.answer = 500
    expect(await errorOf('events/subscribe', subscribeParams())).toMatchObject({
      code: -32015,
      data: { reason: 'http_5xx' },
    })
    const states = await runtime.runPromise(
      first(sql('SELECT state FROM event_subscriptions'), row => Effect.succeed(String(row['state']))),
    )
    expect(states).toBe('pending')
  })

  test('a callback that is not public https is refused before anything is sent', async () => {
    expect(
      await errorOf('events/subscribe', {
        ...subscribeParams(),
        delivery: { mode: 'webhook', url: 'http://hooks.example.com/x', secret: SECRET },
      }),
    ).toMatchObject({ code: -32602 })
    expect(
      await errorOf('events/subscribe', {
        ...subscribeParams(),
        delivery: { mode: 'webhook', url: HOOK, secret: 'whsec_short' },
      }),
    ).toMatchObject({ code: -32602 })
    expect(subscriber.received).toEqual([])
  })

  test('events/unsubscribe ends it by selector and URL, and answers {} again', async () => {
    const result = await resultOf('events/subscribe', subscribeParams())
    const params = { name: 'approval.needed', arguments: {}, delivery: { mode: 'webhook', url: HOOK } }
    expect(await resultOf('events/unsubscribe', params)).toEqual({})
    expect(await resultOf('events/unsubscribe', params)).toEqual({})
    const state = await runtime.runPromise(
      first(sql('SELECT state FROM event_subscriptions WHERE id = ?', String(result['id'])), row =>
        Effect.succeed(String(row['state'])),
      ),
    )
    expect(state).toBe('terminated')
  })

  test('a revoked connection is refused (-32012)', async () => {
    await runtime.runPromise(write(sql("UPDATE connections SET status = 'revoked' WHERE id = 'con_a'")))
    expect(await errorOf('events/list')).toMatchObject({ code: -32012 })
    expect(await errorOf('events/poll', { name: 'approval.needed', arguments: {}, cursor: null })).toMatchObject({
      code: -32012,
    })
    expect(await errorOf('events/subscribe', subscribeParams())).toMatchObject({ code: -32012 })
  })
})
