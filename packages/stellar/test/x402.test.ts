import { describe, expect, it } from 'vitest'

import { normalizePaymentId, stroopsToUsd, USDC_SAC } from '../src/index.ts'
import { acceptable, quoteOf } from '../src/x402.ts'

const req = {
  scheme: 'exact',
  network: 'stellar:testnet',
  asset: USDC_SAC,
  amount: '1000000',
  payTo: 'GCEKVZO7QV5AC6JLDNWXEYQQ7CS5DSWRDCK3VEQWXGHI6XJN3F4UOANH',
  maxTimeoutSeconds: 60,
}

describe('x402 helpers', () => {
  it('keeps a valid payment id and derives a stable valid one otherwise', () => {
    expect(normalizePaymentId('int_mvnsfclu_0001_7fdc38cb')).toBe('int_mvnsfclu_0001_7fdc38cb')
    const short = normalizePaymentId('abc')
    expect(short).toMatch(/^pay_[0-9a-f]{40}$/u)
    expect(normalizePaymentId('abc')).toBe(short)
    expect(normalizePaymentId('has spaces and ünïcode')).toMatch(/^pay_/u)
  })

  it('formats stroops as a USD money string for spend controls', () => {
    expect(stroopsToUsd(1_000_000n)).toBe('$0.1')
    expect(stroopsToUsd(10_000_000n)).toBe('$1')
    expect(stroopsToUsd(25_000_001n)).toBe('$2.5000001')
  })

  it('accepts exact / stellar:testnet / USDC within the cap, and says why otherwise', () => {
    expect(acceptable(req, 1_000_000n)).toBeUndefined()
    expect(acceptable(req, 999_999n)).toContain('above the cap')
    expect(acceptable({ ...req, network: 'stellar:pubnet' }, 1_000_000n)).toContain('network')
    expect(
      acceptable({ ...req, asset: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC' }, 1_000_000n),
    ).toContain('asset')
    expect(acceptable({ ...req, scheme: 'upto' }, 1_000_000n)).toContain('scheme')
  })

  it('reads a quote from the seller terms', () => {
    expect(quoteOf(req, 'https://seller/paid')).toEqual({
      scheme: 'exact',
      network: 'stellar:testnet',
      asset: USDC_SAC,
      amountStroops: 1_000_000n,
      payTo: req.payTo,
      resource: 'https://seller/paid',
      maxTimeoutSeconds: 60,
    })
  })
})
