import { Schema } from 'effect'

import { LEDGER_SECONDS } from './constants.ts'

/**
 * Grant → rule window (spike S1, "Period from a lifetime"): `L = ceil(lifetime_s / 5)` ledgers, the rule is valid
 * through `latest + L`, and the spending-limit window is `L + 720` (one hour of margin) so no spend ages out before the
 * rule expires: the grant is a non-replenishing "N USDC until T".
 */
export const PERIOD_MARGIN_LEDGERS = 720

export interface GrantWindow {
  readonly lifetimeLedgers: number
  readonly validUntilLedger: number
  readonly periodLedgers: number
}

export const grantWindow = (lifetimeSeconds: number, latestLedger: number): GrantWindow => {
  if (!Number.isFinite(lifetimeSeconds) || lifetimeSeconds <= 0) throw new RangeError('lifetimeSeconds must be > 0')
  const lifetimeLedgers = Math.ceil(lifetimeSeconds / LEDGER_SECONDS)
  return {
    lifetimeLedgers,
    validUntilLedger: latestLedger + lifetimeLedgers,
    periodLedgers: lifetimeLedgers + PERIOD_MARGIN_LEDGERS,
  }
}

/** Ledgers → seconds of wall time, for showing an expiry (the ledger number is authoritative). */
export const ledgersToSeconds = (ledgers: number): number => ledgers * LEDGER_SECONDS

/** `get_spending_limit_data(rule, account)` as `scValToNative` returns it. */
export const SpendingLimitData = Schema.Struct({
  spending_limit: Schema.BigInt,
  period_ledgers: Schema.Finite,
  spending_history: Schema.Array(Schema.Struct({ amount: Schema.BigInt, ledger_sequence: Schema.Finite })),
})
export type SpendingLimitData = typeof SpendingLimitData.Type

/**
 * What still counts against the limit at `ledger`, replaying the policy's eviction: an entry spent at ledger S is
 * dropped once `S <= ledger - period_ledgers`.
 */
export const spentAt = (data: SpendingLimitData, ledger: number): bigint => {
  const cutoff = ledger - data.period_ledgers
  return data.spending_history.reduce((sum, e) => (e.ledger_sequence > cutoff ? sum + e.amount : sum), 0n)
}

export const remainingAt = (data: SpendingLimitData, ledger: number): bigint =>
  data.spending_limit - spentAt(data, ledger)

/** A rule's `valid_until` (Option<u32>) admits `ledger` while `ledger <= valid_until`. */
export const ruleLive = (validUntil: number | null, ledger: number): boolean =>
  validUntil === null || ledger <= validUntil

/** A rule name the account accepts (≤ 20 bytes) that identifies the connection key. */
export const grantRuleName = (signerPubHex: string): string => `k_${signerPubHex.slice(0, 16)}`

/** The pocket chunk (spike S5): one pull serves several purchases, so relayer rent per purchase drops ~10×. */
export const DEFAULT_CHUNK_STROOPS = 10_000_000n

/**
 * How much to pull into the pocket before paying `price` (spike S5's chunk policy): nothing when the float covers it,
 * otherwise `min(remaining, max(shortfall, chunk))`. Returns `undefined` when float + remaining cannot cover the
 * price (owner lane). `chunk = 0n` is the exact-shortfall policy.
 */
export const pullAmount = (
  remaining: bigint,
  pocketBalance: bigint,
  price: bigint,
  chunk: bigint = DEFAULT_CHUNK_STROOPS,
): bigint | undefined => {
  if (pocketBalance >= price) return 0n
  const shortfall = price - pocketBalance
  if (remaining < shortfall) return undefined
  const want = shortfall > chunk ? shortfall : chunk
  return want < remaining ? want : remaining
}
