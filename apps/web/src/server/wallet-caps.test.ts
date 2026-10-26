import { ConfigProvider, Effect, Layer, Schema } from 'effect'
import { Base64Url } from 'effect/encoding'
import { afterEach, describe, expect, test } from 'vitest'

import { SoftPasskey } from '@hm/stellar/testing'

import { makeApiHandler } from './app.ts'
import { consentSignInPage } from './pages.ts'
import { testServices } from './test/layers.ts'
import {
  admitCreation,
  type CreateLimits,
  type CreationLog,
  memoryWalletCaps,
  visitorOf,
  WalletCaps,
} from './wallet-caps.ts'

/**
 * Open signup on mainnet with creation caps (Kristjan, 2026-10-25 evening): at most 3 wallets per visitor (a hash of
 * cf-connecting-ip) and 30 in all per hour, on both creation paths (the SPA and the consent page both go through
 * POST /api/wallets/options and POST /api/wallets), answered with 429 `{ error: 'too_many_wallets', retry_after_s }`.
 */

const LIMITS: CreateLimits = { perVisitorHour: 3, perHour: 30 }
const T0 = Date.parse('2026-10-25T19:00:00Z')
const MINUTE = 60_000

const fill = (count: number, visitor: (i: number) => string, from = T0): CreationLog =>
  Array.from({ length: count }, (_, i) => ({ at: from + i * MINUTE, visitor: visitor(i) }))

describe('admitCreation', () => {
  test('a visitor gets 3 wallets an hour; the 4th waits until the first is an hour old, others still get theirs', () => {
    const log = fill(3, () => 'a')
    const now = T0 + 10 * MINUTE
    expect(admitCreation(log, now, 'a', LIMITS).admission).toEqual({
      ok: false,
      scope: 'visitor',
      retryAfterS: 50 * 60,
    })
    expect(admitCreation(log, now, 'b', LIMITS).admission).toEqual({ ok: true })
    expect(admitCreation(log, T0 + 60 * MINUTE, 'a', LIMITS).admission).toEqual({ ok: true })
  })

  test('30 wallets an hour in all, whoever asks; the log keeps only the last hour', () => {
    const log = fill(30, i => `v${i}`)
    const now = T0 + 40 * MINUTE
    expect(admitCreation(log, now, 'new', LIMITS).admission).toEqual({
      ok: false,
      scope: 'global',
      retryAfterS: 20 * 60,
    })
    const later = admitCreation(log, T0 + 61 * MINUTE, 'new', LIMITS)
    expect(later.admission).toEqual({ ok: true })
    expect(later.log).toHaveLength(29)
  })

  test('a refusal records nothing; a cap of 0 closes creation for the hour', () => {
    const log = fill(3, () => 'a')
    expect(admitCreation(log, T0 + MINUTE * 5, 'a', LIMITS).log).toEqual(log)
    expect(admitCreation([], T0, 'a', { perVisitorHour: 0, perHour: 30 }).admission).toEqual({
      ok: false,
      scope: 'visitor',
      retryAfterS: 3600,
    })
  })
})

const handlers: Array<ReturnType<typeof makeApiHandler>> = []
afterEach(async () => {
  await Promise.all(handlers.splice(0).map(api => api.dispose()))
})

const Options = Schema.Struct({ challenge: Schema.String })
const Refusal = Schema.Struct({ error: Schema.Literal('too_many_wallets'), retry_after_s: Schema.Int })

const post = (api: ReturnType<typeof makeApiHandler>, ip: string, path: string, body: unknown) =>
  api.handler(
    new Request(`https://wallet.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
      body: JSON.stringify(body),
    }),
  )

/** POST /api/wallets with a software passkey over the challenge `options` answered (the fixture chain deploys). */
const createWith = async (api: ReturnType<typeof makeApiHandler>, ip: string, options: Response) => {
  const { challenge } = Schema.decodeUnknownSync(Options)(await options.json())
  const passkey = await SoftPasskey.create('wallet.test', 'https://wallet.test')
  const clientData = { type: 'webauthn.create', challenge, origin: 'https://wallet.test', crossOrigin: false }
  return post(api, ip, '/api/wallets', {
    name: 'Personal',
    credential_id: Base64Url.encode(passkey.credentialId),
    public_key: Base64Url.encode(passkey.publicKey65),
    client_data_json: Base64Url.encode(new TextEncoder().encode(JSON.stringify(clientData))),
    attestation_object: '',
  })
}

/** The SPA's and the consent page's two calls, from `ip`. */
const createFrom = async (api: ReturnType<typeof makeApiHandler>, ip: string) => {
  const options = await post(api, ip, '/api/wallets/options', { name: 'Personal' })
  return options.status === 200 ? createWith(api, ip, options) : options
}

describe('POST /api/wallets under the caps', () => {
  test.each([undefined, 'false'])('disabled caps (%s) allow registration despite an exhausted store', async enabled => {
    let calls = 0
    const caps = await Effect.runPromise(
      WalletCaps.pipe(
        Effect.provide(
          WalletCaps.fromStore(async () => {
            calls += 1
            return { ok: false, scope: 'global', retryAfterS: 3600 }
          }).pipe(
            Layer.provide(
              ConfigProvider.layer(
                ConfigProvider.fromEnvRecord({
                  ...(enabled === undefined ? {} : { WALLET_CREATE_LIMITS_ENABLED: enabled }),
                  WALLET_CREATE_PER_VISITOR_HOUR: '0',
                  WALLET_CREATE_PER_HOUR: '0',
                }),
              ),
            ),
          ),
        ),
      ),
    )
    const api = makeApiHandler(testServices(undefined, undefined, undefined, caps))
    handlers.push(api)
    for (const _ of [1, 2, 3, 4]) expect((await createFrom(api, '198.51.100.7')).status).toBe(200)
    expect(calls).toBe(0)
  })

  test('explicitly enabled caps still enforce the store decision', async () => {
    const caps = await Effect.runPromise(
      WalletCaps.pipe(
        Effect.provide(
          WalletCaps.fromStore(async () => ({ ok: false, scope: 'visitor', retryAfterS: 180 })).pipe(
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ WALLET_CREATE_LIMITS_ENABLED: 'true' }))),
          ),
        ),
      ),
    )
    expect(await Effect.runPromise(Effect.flip(caps.check('visitor')))).toMatchObject({ retryAfterS: 180 })
    expect(await Effect.runPromise(Effect.flip(caps.take('visitor')))).toMatchObject({ retryAfterS: 180 })
  })

  test('per visitor: three wallets from one address, then 429 too_many_wallets before the passkey prompt', async () => {
    const api = makeApiHandler(testServices())
    handlers.push(api)
    for (const _ of [1, 2, 3]) expect((await createFrom(api, '198.51.100.7')).status).toBe(200)
    const refused = await createFrom(api, '198.51.100.7')
    expect(refused.status).toBe(429)
    const body = Schema.decodeUnknownSync(Refusal)(await refused.json())
    expect(body.retry_after_s).toBeGreaterThan(3500)
    expect(body.retry_after_s).toBeLessThanOrEqual(3600)
    expect((await createFrom(api, '203.0.113.9')).status).toBe(200)
  })

  test('in all: the hourly total refuses a new visitor too, and the slot is taken right before the deploy', async () => {
    const caps = memoryWalletCaps({ perVisitorHour: 3, perHour: 4 })
    const api = makeApiHandler(testServices(undefined, undefined, undefined, caps))
    handlers.push(api)
    for (const ip of ['192.0.2.1', '192.0.2.1', '192.0.2.2']) expect((await createFrom(api, ip)).status).toBe(200)
    // A fourth visitor gets options while one slot is left; someone else takes it first, so the create itself refuses.
    const options = await post(api, '192.0.2.4', '/api/wallets/options', { name: 'Personal' })
    expect(options.status).toBe(200)
    await Effect.runPromise(caps.take(await Effect.runPromise(visitorOf('192.0.2.3'))))
    const refused = await createWith(api, '192.0.2.4', options)
    expect(refused.status).toBe(429)
    expect(Schema.decodeUnknownSync(Refusal)(await refused.json()).error).toBe('too_many_wallets')
    const fresh = await createFrom(api, '192.0.2.5')
    expect(fresh.status).toBe(429)
  })
})

test('the consent page turns too_many_wallets into a plain sentence', () => {
  const page = consentSignInPage(
    { nonce: 'n0nce', network: 'Mainnet', explorerBase: 'https://stellar.expert/explorer/public' },
    {
      handle: 'h1',
      clientName: 'Claude',
      clientDomain: 'claude.ai',
      redirectHost: 'claude.ai',
      redirectIsLoopback: false,
    },
    false,
  )
  expect(page).toContain("j.error==='too_many_wallets'?tooManyWallets(j.retry_after_s)")
  expect(page).toContain('Nod opens only a few new wallets each hour. Try again in ')
  expect(page).not.toContain('Invite code')
})
