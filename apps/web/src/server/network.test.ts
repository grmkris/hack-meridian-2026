import { Effect } from 'effect'
import { expect } from 'vitest'

import { it } from '@effect/vitest'

import { transferFeeCeiling } from './network.ts'
import { testNetwork } from './test/layers.ts'

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
    expect(xlm(yield* transferFeeCeiling(at(5000), false))).toBe(250)
  }),
)
