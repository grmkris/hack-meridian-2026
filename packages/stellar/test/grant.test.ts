import { describe, expect, it } from 'vitest'

import { grantRuleName, grantWindow, pullAmount, remainingAt, ruleLive, spentAt } from '../src/index.ts'

describe('grant window (docs/spikes/s1.md "Period from a lifetime")', () => {
  it('one day: L = 17280, valid through latest + L, period L + 720', () => {
    expect(grantWindow(86_400, 5_381_000)).toEqual({
      lifetimeLedgers: 17_280,
      validUntilLedger: 5_398_280,
      periodLedgers: 18_000,
    })
  })

  it('rounds partial ledgers up', () => {
    expect(grantWindow(1, 100).lifetimeLedgers).toBe(1)
    expect(grantWindow(6, 100).lifetimeLedgers).toBe(2)
    expect(grantWindow(3600, 0).periodLedgers).toBe(720 + 720)
  })

  it('refuses a non-positive lifetime', () => {
    expect(() => grantWindow(0, 1)).toThrow(RangeError)
    expect(() => grantWindow(Number.NaN, 1)).toThrow(RangeError)
  })

  it('names the rule from the key, within 20 bytes', () => {
    const name = grantRuleName('a'.repeat(64))
    expect(name).toBe(`k_${'a'.repeat(16)}`)
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(20)
  })
})

describe('spending-limit eviction (the policy drops S once S <= ledger - period)', () => {
  // S1 run: period 15, 1 USDC spent at ledger S; still counted at S+14, gone by S+17.
  const S = 5_381_084
  const data = {
    spending_limit: 10_000_000n,
    period_ledgers: 15,
    spending_history: [{ amount: 10_000_000n, ledger_sequence: S }],
  }

  it('counts the spend inside the window and drops it at S + period', () => {
    expect(spentAt(data, S)).toBe(10_000_000n)
    expect(spentAt(data, S + 14)).toBe(10_000_000n)
    expect(spentAt(data, S + 15)).toBe(0n)
    expect(spentAt(data, S + 17)).toBe(0n)
    expect(remainingAt(data, S + 14)).toBe(0n)
    expect(remainingAt(data, S + 17)).toBe(10_000_000n)
  })

  it('sums several entries (S1 claim 3: 2 + 2.5 + 0.5 = 5 of 5)', () => {
    const d = {
      spending_limit: 50_000_000n,
      period_ledgers: 18_000,
      spending_history: [
        { amount: 20_000_000n, ledger_sequence: 5_381_077 },
        { amount: 25_000_000n, ledger_sequence: 5_381_079 },
        { amount: 5_000_000n, ledger_sequence: 5_381_080 },
      ],
    }
    expect(spentAt(d, 5_381_081)).toBe(50_000_000n)
    expect(remainingAt(d, 5_381_081)).toBe(0n)
  })

  it('a rule is live through valid_until; None never expires', () => {
    expect(ruleLive(100, 100)).toBe(true)
    expect(ruleLive(100, 101)).toBe(false)
    expect(ruleLive(null, 10_000_000)).toBe(true)
  })
})

const USDC = (n: number) => BigInt(Math.round(n * 1e7))

describe('pocket chunk policy (docs/spikes/s5.md): min(remaining, max(shortfall, chunk))', () => {
  it('pays from the float when it covers the price', () => {
    expect(pullAmount(USDC(5), USDC(0.7), USDC(0.1))).toBe(0n)
  })

  it('pulls a whole chunk for a small shortfall', () => {
    expect(pullAmount(USDC(5), 0n, USDC(0.1))).toBe(USDC(1))
    expect(pullAmount(USDC(5), USDC(0.05), USDC(0.1))).toBe(USDC(1))
  })

  it('pulls the shortfall when it is above the chunk, capped at what remains', () => {
    expect(pullAmount(USDC(5), 0n, USDC(2.5))).toBe(USDC(2.5))
    expect(pullAmount(USDC(0.3), 0n, USDC(0.1))).toBe(USDC(0.3))
  })

  it('is undefined (owner lane) when float + remaining cannot cover the price', () => {
    expect(pullAmount(USDC(0.05), USDC(0.7), USDC(1))).toBeUndefined()
  })

  it('chunk 0 is the exact-shortfall policy', () => {
    expect(pullAmount(USDC(5), USDC(0.03), USDC(0.1), 0n)).toBe(USDC(0.07))
  })
})
