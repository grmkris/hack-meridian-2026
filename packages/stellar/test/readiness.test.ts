import { describe, expect, it } from 'vitest'

import { accountOf, readinessFrom, rentFactor, rentWriteFeePer1Kb } from '../src/index.ts'
import { accountKey, contractCodeKey, contractInstanceKey, usdcTrustlineKey } from '../src/readiness.ts'

const G = 'GCEM4WKCAWO6ZZAA7SSSTG4SQWLRAI36ZM45QT7QHCPO6SB5ZLVLDH4K'
const C = 'CD4B4YAP7BCINBT6CKGA3ADE2IOBUAGMH5NZGL2XTQGHTCLF2V4UA753'

describe('readiness decoding (docs/SPEC.md "Contacts and recipient readiness")', () => {
  it.each([
    ['account', { account: true, trustline: true, contract: false }, 'usdc_ready'],
    ['account', { account: true, trustline: false, contract: false }, 'trustline_required'],
    ['account', { account: false, trustline: false, contract: false }, 'account_missing'],
    ['contract', { account: false, trustline: false, contract: true }, 'contract'],
    ['contract', { account: false, trustline: false, contract: false }, 'account_missing'],
  ] as const)('%s %o → %s', (kind, found, expected) => {
    expect(readinessFrom(kind, found)).toBe(expected)
  })

  it('resolves G and M to the classic account, C to none', () => {
    expect(accountOf(G)).toBe(G)
    expect(accountOf(C)).toBeUndefined()
    expect(accountOf('not an address')).toBeUndefined()
  })

  it('builds the ledger keys it reads', () => {
    expect(accountKey(G).switch().name).toBe('account')
    expect(usdcTrustlineKey(G).switch().name).toBe('trustline')
    expect(contractInstanceKey(C).switch().name).toBe('contractData')
    expect(contractCodeKey('1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a').switch().name).toBe(
      'contractCode',
    )
  })
})

describe('rent factor (docs/spikes/s1.md "Fee anatomy")', () => {
  // Live config on 2026-10-25: state window average 4,013,716,884 B, 0.343 % over the 4 GB target.
  const config = {
    feeLow: -17_000n,
    feeHigh: 10_000n,
    targetBytes: 4_000_000_000n,
    growthFactor: 5000n,
    stateBytes: 4_013_716_884n,
  }

  it('reproduces 473,038 stroops per KB and 10,000 at target', () => {
    expect(rentWriteFeePer1Kb(config, config.stateBytes)).toBe(473_038n)
    expect(rentWriteFeePer1Kb(config, config.targetBytes)).toBe(10_000n)
    expect(rentFactor(config)).toBeCloseTo(47.3, 1)
  })

  it('never goes below the 1000-stroop floor', () => {
    expect(rentWriteFeePer1Kb(config, 0n)).toBe(1000n)
  })
})
