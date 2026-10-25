import { xdr } from '@stellar/stellar-sdk'

/**
 * Soroban rent pricing (stellar-core `compute_rent_write_fee_per_1kb`): linear between the low and high fee up to the
 * state-size target, then multiplied by the growth factor above it. Testnet on 2026-10-25 sat 0.343 % over its 4 GB
 * target, so rent cost ~47× the at-target rate (docs/spikes/s1.md "Fee anatomy").
 */
export interface RentConfig {
  readonly feeLow: bigint
  readonly feeHigh: bigint
  readonly targetBytes: bigint
  readonly growthFactor: bigint
  /** Average of the live Soroban state size window. */
  readonly stateBytes: bigint
}

const MIN_RENT_WRITE_FEE_PER_1KB = 1000n
const divCeil = (a: bigint, b: bigint): bigint => (a + b - 1n) / b

export const rentWriteFeePer1Kb = (c: RentConfig, stateBytes: bigint): bigint => {
  const target = c.targetBytes > 0n ? c.targetBytes : 1n
  const multiplier = c.feeHigh - c.feeLow
  let fee = divCeil(multiplier * stateBytes, target) + c.feeLow
  if (stateBytes > c.targetBytes) fee += divCeil(multiplier * (stateBytes - c.targetBytes) * c.growthFactor, target)
  return fee > MIN_RENT_WRITE_FEE_PER_1KB ? fee : MIN_RENT_WRITE_FEE_PER_1KB
}

/** Current rent rate relative to the at-target rate (1 = normal). */
export const rentFactor = (c: RentConfig): number =>
  Number(rentWriteFeePer1Kb(c, c.stateBytes)) / Number(rentWriteFeePer1Kb(c, c.targetBytes))

export const rentConfigKeys = (): ReadonlyArray<xdr.LedgerKey> =>
  [
    xdr.ConfigSettingId.configSettingContractLedgerCostV0(),
    xdr.ConfigSettingId.configSettingLiveSorobanStateSizeWindow(),
  ].map(id => xdr.LedgerKey.configSetting(new xdr.LedgerKeyConfigSetting({ configSettingId: id })))

/** Decode the two config-setting entries `rentConfigKeys` asks for. */
export const decodeRentConfig = (entries: ReadonlyArray<xdr.LedgerEntryData>): RentConfig | undefined => {
  let cost: xdr.ConfigSettingContractLedgerCostV0 | undefined
  let window: ReadonlyArray<bigint> | undefined
  for (const e of entries) {
    const setting = e.configSetting()
    const name = setting.switch().name
    if (name === 'configSettingContractLedgerCostV0') cost = setting.contractLedgerCost()
    if (name === 'configSettingLiveSorobanStateSizeWindow')
      window = setting.liveSorobanStateSizeWindow().map(v => BigInt(v.toString()))
  }
  if (cost === undefined || window === undefined || window.length === 0) return undefined
  return {
    feeLow: BigInt(cost.rentFee1KbSorobanStateSizeLow().toString()),
    feeHigh: BigInt(cost.rentFee1KbSorobanStateSizeHigh().toString()),
    targetBytes: BigInt(cost.sorobanStateTargetSizeBytes().toString()),
    growthFactor: BigInt(cost.sorobanStateRentFeeGrowthFactor()),
    stateBytes: window.reduce((a, b) => a + b, 0n) / BigInt(window.length),
  }
}
