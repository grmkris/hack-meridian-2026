import type { PaymentIds } from './payment-ids.ts'

/** $0.10 in USDC's 7 decimals. */
export const PRICE_STROOPS = '1000000'
export const PRICE_DISPLAY = '0.10 USDC'
export const MAX_TIMEOUT_SECONDS = 60

export type StellarNetwork = 'testnet' | 'pubnet'
export type FacilitatorName = 'x402org' | 'oz'

interface Preset {
  readonly network: 'stellar:testnet' | 'stellar:pubnet'
  /** Circle USDC's Stellar Asset Contract; undefined = must come from the `USDC_SAC` var */
  readonly usdcSac: string | undefined
  readonly usdcIssuer: string
  readonly horizon: string
  /** Facilitator URLs by name; undefined = none on this network unless a var supplies it */
  readonly facilitators: Readonly<Record<FacilitatorName, string | undefined>>
  readonly explorer: string
}

/**
 * Per-network presets, chosen by `STELLAR_NETWORK` (default testnet). Testnet is what hm26-seller runs (proven in
 * docs/spikes/s2.md). Pubnet is prepared, not deployed: its USDC SAC is the address `@x402/stellar` 2.28.0 ships
 * (`USDC_PUBNET_ADDRESS`), to be checked against docs/research/mainnet.md; x402.org is testnet-only, so a pubnet
 * deployment names its facilitator with `FACILITATOR_URL` (and `OZ_FACILITATOR_URL` + key for the fallback).
 */
export const PRESETS: Readonly<Record<StellarNetwork, Preset>> = {
  testnet: {
    network: 'stellar:testnet',
    usdcSac: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    usdcIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    horizon: 'https://horizon-testnet.stellar.org',
    facilitators: {
      x402org: 'https://www.x402.org/facilitator',
      oz: 'https://channels.openzeppelin.com/x402/testnet',
    },
    explorer: 'https://stellar.expert/explorer/testnet',
  },
  pubnet: {
    network: 'stellar:pubnet',
    usdcSac: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
    usdcIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    horizon: 'https://horizon.stellar.org',
    facilitators: { x402org: undefined, oz: undefined },
    explorer: 'https://stellar.expert/explorer/public',
  },
}

export interface Env {
  /** `testnet` (default) or `pubnet`. */
  readonly STELLAR_NETWORK?: string
  /** The seller's classic G account with a USDC trustline (scripts/demo/seeds.json → seller on testnet). */
  readonly PAY_TO: string
  /** Overrides the preset's USDC SAC (required if the preset has none). */
  readonly USDC_SAC?: string
  /** Which facilitator goes first: `x402org` (default) or `oz`. The other one is the fallback when configured. */
  readonly FACILITATOR?: string
  /** Overrides the x402org slot's URL (the primary facilitator on a network without x402.org). */
  readonly FACILITATOR_URL?: string
  /** Overrides the OpenZeppelin Channels URL. */
  readonly OZ_FACILITATOR_URL?: string
  /** OpenZeppelin Channels key (Worker secret, from apps/seller/.dev.vars). */
  readonly OZ_FACILITATOR_KEY?: string
  readonly PAYMENT_IDS: DurableObjectNamespace<PaymentIds>
}

export interface Settings {
  readonly stellar: StellarNetwork
  readonly network: Preset['network']
  readonly usdcSac: string
  readonly usdcIssuer: string
  readonly horizon: string
  readonly explorer: string
  readonly payTo: string
  /** In the order tried; each with the auth it needs. */
  readonly facilitators: ReadonlyArray<{ readonly name: FacilitatorName; readonly url: string; readonly key?: string }>
}

const G = /^G[A-Z2-7]{55}$/u
const C = /^C[A-Z2-7]{55}$/u

/** Resolves the deployment's settings from its vars, or lists what is missing (paid routes then answer 503). */
export function settings(
  env: Env,
): { readonly ok: true; readonly value: Settings } | { readonly ok: false; readonly problems: ReadonlyArray<string> } {
  const problems: Array<string> = []
  const stellar: StellarNetwork = env.STELLAR_NETWORK === 'pubnet' ? 'pubnet' : 'testnet'
  if (env.STELLAR_NETWORK !== undefined && !['testnet', 'pubnet'].includes(env.STELLAR_NETWORK))
    problems.push(`STELLAR_NETWORK must be testnet or pubnet, not ${env.STELLAR_NETWORK}`)
  const preset = PRESETS[stellar]
  const usdcSac = env.USDC_SAC ?? preset.usdcSac
  if (usdcSac === undefined || !C.test(usdcSac)) problems.push('USDC_SAC: no valid USDC contract id for this network')
  if (!G.test(env.PAY_TO)) problems.push('PAY_TO must be a G… account with a USDC trustline')
  const urls: Record<FacilitatorName, string | undefined> = {
    x402org: env.FACILITATOR_URL ?? preset.facilitators.x402org,
    oz: env.OZ_FACILITATOR_URL ?? preset.facilitators.oz,
  }
  const key = env.OZ_FACILITATOR_KEY === '' ? undefined : env.OZ_FACILITATOR_KEY
  const order: ReadonlyArray<FacilitatorName> = env.FACILITATOR === 'oz' ? ['oz', 'x402org'] : ['x402org', 'oz']
  const facilitators = order.flatMap(name => {
    const url = urls[name]
    if (url === undefined || (name === 'oz' && key === undefined)) return []
    return [name === 'oz' && key !== undefined ? { name, url, key } : { name, url }]
  })
  if (facilitators.length === 0) problems.push('no facilitator: set FACILITATOR_URL (or OZ_FACILITATOR_URL + key)')
  if (problems.length > 0 || usdcSac === undefined) return { ok: false, problems }
  return {
    ok: true,
    value: {
      stellar,
      network: preset.network,
      usdcSac,
      usdcIssuer: preset.usdcIssuer,
      horizon: preset.horizon,
      explorer: preset.explorer,
      payTo: env.PAY_TO,
      facilitators,
    },
  }
}

/** Hono context: bindings plus the payment id the dedup middleware decoded (null when the payer sent none). */
export interface AppEnv {
  readonly Bindings: Env
  readonly Variables: { paymentId: string | null }
}

/** What a payment id is bound to: the same id with different terms is a conflict, never a replay. */
export const fingerprint = (parts: ReadonlyArray<string>) => JSON.stringify(parts)
