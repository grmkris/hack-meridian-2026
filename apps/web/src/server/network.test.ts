import { ConfigProvider, Effect, Layer, Schema } from 'effect'
import { describe, expect, test } from 'vitest'

import { it } from '@effect/vitest'

import { makeApiHandler } from './app.ts'
import { inviteRequired, inviteRequiredFrom, Network, type NetworkShape, transferFeeCeiling } from './network.ts'
import { testNetwork, testServices } from './test/layers.ts'

const xlm = (stroops: bigint) => Number(stroops) / 1e7
const at = (factor: number | null) => ({ ...testNetwork, rentFactor: Effect.succeed(factor) })

it.effect('fee ceilings follow the rent factor upward, never below the configured ones, and stay capped', () =>
  Effect.gen(function* () {
    // configured 35 XLM first / 4 XLM later in the test network
    expect(xlm(yield* transferFeeCeiling(at(null), false))).toBe(35)
    expect(xlm(yield* transferFeeCeiling(at(null), true))).toBe(4)
    expect(xlm(yield* transferFeeCeiling(at(10), false))).toBe(35)
    expect(xlm(yield* transferFeeCeiling(at(110), false))).toBe(88)
    expect(xlm(yield* transferFeeCeiling(at(110), true))).toBe(27.5)
    expect(xlm(yield* transferFeeCeiling(at(312), false))).toBeCloseTo(249.6)
    expect(xlm(yield* transferFeeCeiling(at(5000), false))).toBe(600)
    expect(xlm(yield* transferFeeCeiling({ ...at(5000), name: 'pubnet' as const }, false))).toBe(1)
  }),
)

const read = (bindings: Record<string, string>) =>
  Network.use(network => Effect.succeed(inviteRequired(network))).pipe(
    Effect.provide(Network.fixture.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(bindings))))),
  )

const HealthReply = Schema.Struct({ invite_required: Schema.optionalKey(Schema.Boolean) })

const health = async (network: NetworkShape) => {
  const api = makeApiHandler(testServices(undefined, undefined, network))
  try {
    const response = await api.handler(new Request('http://worker.test/api/health'))
    return Schema.decodeUnknownSync(HealthReply)(await response.json())
  } finally {
    await api.dispose()
  }
}

describe('INVITE_REQUIRED', () => {
  test('unset keeps today: invite-only on pubnet, open on testnet; "true" and "false" switch it either way', () => {
    expect(inviteRequiredFrom('pubnet', '')).toBe(true)
    expect(inviteRequiredFrom('testnet', '')).toBe(false)
    expect(inviteRequiredFrom('pubnet', 'false')).toBe(false)
    expect(inviteRequiredFrom('pubnet', ' FALSE ')).toBe(false)
    expect(inviteRequiredFrom('testnet', 'true')).toBe(true)
  })

  test('anything else keeps signup gated, so a typo never opens it', () => {
    expect(inviteRequiredFrom('pubnet', 'flase')).toBe(true)
    expect(inviteRequiredFrom('testnet', 'no')).toBe(true)
  })

  it.effect('the fixture network reads it from the bindings', () =>
    Effect.gen(function* () {
      expect(yield* read({})).toBe(false)
      expect(yield* read({ INVITE_REQUIRED: 'true' })).toBe(true)
    }),
  )
})

describe('/api/health', () => {
  test('invite_required follows the network setting', async () => {
    expect((await health(testNetwork)).invite_required).toBe(false)
    expect((await health({ ...testNetwork, inviteRequired: true })).invite_required).toBe(true)
  })
})
