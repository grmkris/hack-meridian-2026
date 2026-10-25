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

/** XLM fee ceilings: the first delegated payment under a new rule extends rent on the rule, signer and policy. */
export const FEE_CEILING_FIRST_PAYMENT_XLM = 25
export const FEE_CEILING_LATER_PAYMENT_XLM = 2
export const FEE_CEILING_OWNER_PAYMENT_XLM = 2
