import { Effect, Option, Redacted } from 'effect'
import { describe, expect, test } from 'vitest'

import { it } from '@effect/vitest'

import { eventChallengeMatches, eventRetryDecision } from './delivery.ts'
import { McpEventError } from './errors.ts'
import { canonicalEventJson, eventBodyBytes, eventCallbackUrl, eventSecret, eventTtlMs } from './policy.ts'
import { openEventSecret, sealEventSecret } from './secrets.ts'
import { signEventWebhook, verifyEventWebhook } from './webhooks.ts'

/** The wire pieces ported from myapps: Standard Webhooks signing, the callback and secret rules, retry, sealing. */

const SECRET = `whsec_${btoa('0123456789abcdef0123456789abcdef')}`
const OTHER = `whsec_${btoa('fedcba9876543210fedcba9876543210')}`
const NOW = 1_793_000_000

const occurrence = {
  eventId: 'payment.received:tx1:wal_a',
  name: 'payment.received',
  timestamp: '2026-10-25T12:00:00.000Z',
  data: { title: 'Received 1.00 USDC', amount: '1.00' },
}

const signed = async (body: string, id: string, secrets = { current: SECRET }, timestamp = NOW) => {
  const bytes = eventBodyBytes(body)
  const headers = await signEventWebhook({ id, subscriptionId: 'sub_1', body: bytes, timestamp, secrets })
  return { bytes, headers: new Headers({ ...headers }) }
}

describe('Standard Webhooks signing', () => {
  test('a signed occurrence verifies with the secret, and the headers are the ones Goblin reads', async () => {
    const { bytes, headers } = await signed(JSON.stringify(occurrence), occurrence.eventId)
    expect(headers.get('webhook-id')).toBe(occurrence.eventId)
    expect(headers.get('webhook-timestamp')).toBe(String(NOW))
    expect(headers.get('x-mcp-subscription-id')).toBe('sub_1')
    expect(headers.get('webhook-signature')).toMatch(/^v1,[A-Za-z0-9+/]{43}=$/u)
    expect(await verifyEventWebhook(bytes, headers, { current: SECRET }, NOW + 10)).toEqual(occurrence)
  })

  test('a wrong secret, a stale timestamp or a changed body is refused', async () => {
    const { bytes, headers } = await signed(JSON.stringify(occurrence), occurrence.eventId)
    await expect(verifyEventWebhook(bytes, headers, { current: OTHER }, NOW)).rejects.toBeInstanceOf(McpEventError)
    await expect(verifyEventWebhook(bytes, headers, { current: SECRET }, NOW + 301)).rejects.toBeInstanceOf(
      McpEventError,
    )
    const changed = eventBodyBytes(JSON.stringify({ ...occurrence, data: { amount: '100.00' } }))
    await expect(verifyEventWebhook(changed, headers, { current: SECRET }, NOW)).rejects.toBeInstanceOf(McpEventError)
  })

  test('during a rotation both secrets sign, and either verifies until the grace ends', async () => {
    const secrets = { current: OTHER, previous: { secret: SECRET, expiresAtMs: (NOW + 60) * 1000 } }
    const { bytes, headers } = await signed(JSON.stringify(occurrence), occurrence.eventId, secrets)
    expect(headers.get('webhook-signature')?.split(' ')).toHaveLength(2)
    await expect(verifyEventWebhook(bytes, headers, { current: SECRET }, NOW)).resolves.toEqual(occurrence)
    await expect(verifyEventWebhook(bytes, headers, { current: OTHER }, NOW)).resolves.toEqual(occurrence)
    const later = await signed(JSON.stringify(occurrence), occurrence.eventId, secrets, NOW + 120)
    expect(later.headers.get('webhook-signature')?.split(' ')).toHaveLength(1)
  })

  test('a control carries a msg_<type>_ id; an occurrence carries its event id', async () => {
    const gap = await signed(JSON.stringify({ type: 'gap', cursor: '0000000000000007' }), 'msg_gap_1')
    expect(await verifyEventWebhook(gap.bytes, gap.headers, { current: SECRET }, NOW)).toEqual({
      type: 'gap',
      cursor: '0000000000000007',
    })
    const wrong = await signed(JSON.stringify({ type: 'gap', cursor: null }), 'msg_terminated_1')
    await expect(verifyEventWebhook(wrong.bytes, wrong.headers, { current: SECRET }, NOW)).rejects.toBeInstanceOf(
      McpEventError,
    )
    const mismatched = await signed(JSON.stringify(occurrence), 'another-id')
    await expect(
      verifyEventWebhook(mismatched.bytes, mismatched.headers, { current: SECRET }, NOW),
    ).rejects.toBeInstanceOf(McpEventError)
  })

  test('a body over 256 KiB is never signed', async () => {
    await expect(signed(`"${'x'.repeat(262_144)}"`, 'big')).rejects.toBeInstanceOf(McpEventError)
  })
})

describe('policy', () => {
  test('callbacks are canonical https URLs to public names, unless the stage is local', () => {
    expect(eventCallbackUrl('https://dev.goblin.surf/hooks/mcp-events/ws/con/tok')).toBe(
      'https://dev.goblin.surf/hooks/mcp-events/ws/con/tok',
    )
    for (const url of [
      'http://dev.goblin.surf/hook',
      'https://localhost/hook',
      'https://10.0.0.1/hook',
      'https://dev.goblin.surf:8443/hook',
      'https://user:pw@dev.goblin.surf/hook',
      'https://dev.goblin.surf/hook#frag',
      'https://DEV.goblin.surf/hook',
      'https://printer.local/hook',
    ])
      expect(() => eventCallbackUrl(url)).toThrow(McpEventError)
    expect(eventCallbackUrl('http://localhost:8787/hook', true)).toBe('http://localhost:8787/hook')
  })

  test('secrets are whsec_ and 24 to 64 bytes of canonical base64', () => {
    expect(eventSecret(SECRET)).toHaveLength(32)
    expect(() => eventSecret(`whsec_${btoa('short')}`)).toThrow(McpEventError)
    expect(() => eventSecret(btoa('0123456789abcdef0123456789abcdef'))).toThrow(McpEventError)
    expect(() => eventSecret('whsec_not base64!')).toThrow(McpEventError)
  })

  test('leases are clamped to 5 minutes – 24 hours, an hour by default; canonical JSON sorts keys', () => {
    expect(eventTtlMs(undefined)).toBe(3_600_000)
    expect(eventTtlMs(1_000)).toBe(300_000)
    expect(eventTtlMs(10 * 86_400_000)).toBe(86_400_000)
    expect(canonicalEventJson({ b: 1, a: { d: [2, 1], c: null } })).toBe('{"a":{"c":null,"d":[2,1]},"b":1}')
  })

  test('retries back off 15 s · 2ⁿ, jittered, and are abandoned after 5 attempts, 15 minutes, 410, 413 or 3xx', () => {
    const at = 1_000_000
    expect(eventRetryDecision({ status: 204, attempts: 1, firstAttemptMs: at, nowMs: at, jitter: 0.5 })).toEqual({
      state: 'accepted',
      atMs: at,
    })
    expect(eventRetryDecision({ status: 503, attempts: 1, firstAttemptMs: at, nowMs: at, jitter: 0.5 })).toEqual({
      state: 'retry',
      atMs: at + 15_000,
      reason: 'http_5xx',
    })
    expect(
      eventRetryDecision({ reason: 'timeout', attempts: 3, firstAttemptMs: at, nowMs: at, jitter: 0 }),
    ).toMatchObject({ state: 'retry', atMs: at + 45_000 })
    expect(eventRetryDecision({ status: 500, attempts: 5, firstAttemptMs: at, nowMs: at, jitter: 0.5 }).state).toBe(
      'abandoned',
    )
    expect(
      eventRetryDecision({ status: 500, attempts: 2, firstAttemptMs: at, nowMs: at + 900_000, jitter: 0.5 }).state,
    ).toBe('abandoned')
    for (const status of [410, 413, 302])
      expect(eventRetryDecision({ status, attempts: 1, firstAttemptMs: at, nowMs: at, jitter: 0.5 }).state).toBe(
        'abandoned',
      )
  })

  test('a challenge matches only its exact echo', () => {
    expect(eventChallengeMatches(eventBodyBytes('{"challenge":"abc"}'), 'abc')).toBe(true)
    expect(eventChallengeMatches(eventBodyBytes('{"challenge":"abd"}'), 'abc')).toBe(false)
    expect(eventChallengeMatches(eventBodyBytes('abc'), 'abc')).toBe(false)
  })
})

describe('sealed webhook secrets', () => {
  const key = Option.some(Redacted.make('a vault key of more than sixteen bytes'))

  it.effect('open what was sealed for the same subscription only', () =>
    Effect.gen(function* () {
      const sealed = yield* sealEventSecret(key, SECRET, 'sub_1')
      expect(sealed).toMatch(/^ev1\./u)
      expect(sealed).not.toContain(SECRET)
      expect(yield* openEventSecret(key, sealed, 'sub_1')).toBe(SECRET)
      expect((yield* Effect.flip(openEventSecret(key, sealed, 'sub_2')))._tag).toBe('McpEventError')
      expect((yield* Effect.flip(openEventSecret(Option.none(), sealed, 'sub_1')))._tag).toBe('McpEventError')
    }),
  )
})
