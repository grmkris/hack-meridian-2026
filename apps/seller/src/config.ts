import type { PaymentIds } from './payment-ids.ts'

/** stellar:testnet only. Circle's testnet USDC, through its Stellar Asset Contract (7 decimals: $0.10 = 1000000). */
export const NETWORK = 'stellar:testnet'
export const USDC_SAC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
export const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
export const PRICE = '$0.10'
export const PRICE_STROOPS = '1000000'
export const MAX_TIMEOUT_SECONDS = 60
export const HORIZON = 'https://horizon-testnet.stellar.org'

/** Hosted facilitators (docs/spikes/s2.md): x402.org needs no key; OpenZeppelin Channels takes a Bearer key. */
export const FACILITATORS = {
  x402org: 'https://www.x402.org/facilitator',
  oz: 'https://channels.openzeppelin.com/x402/testnet',
} as const
export type FacilitatorName = keyof typeof FACILITATORS

export interface Env {
  /** The seller's classic G account with a USDC trustline (scripts/demo/seeds.json → seller). */
  readonly PAY_TO: string
  /** Which facilitator goes first: `x402org` (default) or `oz`. The other one is the fallback when it has a key. */
  readonly FACILITATOR?: string
  /** OpenZeppelin Channels testnet key (Worker secret, from apps/seller/.dev.vars). */
  readonly OZ_FACILITATOR_KEY?: string
  readonly PAYMENT_IDS: DurableObjectNamespace<PaymentIds>
}

/** Hono context: bindings plus the payment id the dedup middleware decoded (null when the payer sent none). */
export interface AppEnv {
  readonly Bindings: Env
  readonly Variables: { paymentId: string | null }
}

/** What a payment id is bound to: the same id with different terms is a conflict, never a replay. */
export const fingerprint = (parts: ReadonlyArray<string>) => JSON.stringify(parts)
