import { Schema } from 'effect'

/** USDC and XLM both carry 7 decimals onchain: 1 USDC = 10_000_000 stroops. */
export const DECIMALS = 7
const UNIT = 10_000_000n

/** A decimal amount as an agent or a form writes it: "2", "2.5", "0.1000000". At most 7 decimals, never negative. */
export const DecimalAmount = Schema.String.check(Schema.isPattern(/^\d{1,12}(\.\d{1,7})?$/u))
export type DecimalAmount = typeof DecimalAmount.Type

/** An amount in stroops (7-dp integer). JSON and D1 carry it as a decimal string of the integer. */
export const Stroops = Schema.BigIntFromString
export type Stroops = typeof Stroops.Type

/** "2.5" → 25_000_000n. The input must already match DecimalAmount. */
export const toStroops = (amount: DecimalAmount): bigint => {
  const [whole = '0', fraction = ''] = amount.split('.')
  return BigInt(whole) * UNIT + BigInt(fraction.padEnd(DECIMALS, '0'))
}

/** 25_000_000n → "2.50"; keeps at least two decimals and drops trailing zeros beyond them. */
export const fromStroops = (stroops: bigint): string => {
  const negative = stroops < 0n
  const value = negative ? -stroops : stroops
  const whole = value / UNIT
  const fraction = (value % UNIT).toString().padStart(DECIMALS, '0').replace(/0+$/u, '').padEnd(2, '0')
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`
}

/**
 * XLM fee ceilings (docs/spikes/s5.md): the first pull or payment under a new rule extends rent on the rule, signer and
 * policy (≤ 20 XLM on testnet's 47× rent); every later pull or direct payment ≤ 3 XLM.
 */
export const FEE_CEILING_FIRST_PAYMENT_XLM = 20
export const FEE_CEILING_LATER_PAYMENT_XLM = 3
export const FEE_CEILING_OWNER_PAYMENT_XLM = 3

/**
 * The nod line (docs/SPEC.md, decisions 2026-10-25 17:10 UTC): inside the allowance, an amount below it goes alone; at or
 * above it the AI app asks for the owner's nod. Per allowance, set on the consent page: default 1.00, at least 0.01, at
 * most the allowance.
 */
export const DEFAULT_NOD_ABOVE_STROOPS = 10_000_000n
export const MIN_NOD_ABOVE_STROOPS = 100_000n

/** x402 pulls take at least this much into the pocket (S5 chunk policy), so a run of small purchases pulls once. */
export const POCKET_CHUNK_STROOPS = 10_000_000n
