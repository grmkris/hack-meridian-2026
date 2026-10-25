import { Config, Context, Effect, Layer } from 'effect'

import {
  FEE_CEILING_FIRST_PAYMENT_XLM,
  FEE_CEILING_LATER_PAYMENT_XLM,
  FEE_CEILING_OWNER_PAYMENT_XLM,
  toStroops,
  USDC_SAC,
} from '@hm/protocol'
import { StellarOps } from '@hm/stellar'

/**
 * The Stellar network this stage runs on and the safety rules that come with it: the preset's name, explorer base and
 * USDC contract (from the chain layer, never hardcoded), the caps (MAX_GRANT_USDC, MAX_OWNER_PAYMENT_USDC,
 * MAX_X402_PRICE_USDC), the PAYMENTS_ENABLED kill switch, fee ceilings, whether new wallets get welcome USDC (testnet
 * only) and the invite codes wallet creation needs on mainnet. Checked before any chain call.
 */
export interface NetworkShape {
  readonly name: 'testnet' | 'pubnet'
  /** CAIP-2, as tools and intents show it. */
  readonly caip: 'stellar:testnet' | 'stellar:pubnet'
  /** What people read: "Testnet" or "Mainnet". */
  readonly label: 'Testnet' | 'Mainnet'
  /** e.g. https://stellar.expert/explorer/testnet; links are `<base>/tx/<hash>`. */
  readonly explorerBase: string
  readonly usdcSac: string
  readonly caps: {
    readonly maxGrantStroops: bigint
    readonly maxOwnerPaymentStroops: bigint
    readonly maxX402PriceStroops: bigint
    readonly paymentsEnabled: boolean
  }
  /** XLM fee ceilings shown on intents: a grant's first pull, later pulls and payments, owner payments. */
  readonly fees: { readonly firstXlm: number; readonly laterXlm: number; readonly ownerXlm: number }
  /** Live rent relative to normal (testnet: 47× → 110× on 25 Oct), cached for a minute; null when unknown. */
  readonly rentFactor: Effect.Effect<number | null>
  /** Testnet only: the treasury sends new wallets welcome USDC. */
  readonly welcomeFunding: boolean
  /** Mainnet: wallet creation needs one of these (empty = no gate). */
  readonly inviteCodes: ReadonlyArray<string>
}

export class Network extends Context.Service<Network, NetworkShape>()('hm/Network') {
  /** On the real chain: the preset and caps A2's StellarOps resolved from the same bindings. */
  static readonly fromStellar = Layer.effect(
    Network,
    Effect.gen(function* () {
      const ops = yield* StellarOps
      const params = ops.network
      const rentFactor = yield* Effect.cachedWithTTL(
        ops.rentFactor.pipe(Effect.catchTag('ChainError', () => Effect.succeed(null))),
        '60 seconds',
      )
      return {
        name: params.name,
        caip: params.name === 'pubnet' ? ('stellar:pubnet' as const) : ('stellar:testnet' as const),
        label: params.name === 'pubnet' ? ('Mainnet' as const) : ('Testnet' as const),
        explorerBase: params.explorerBase,
        usdcSac: params.contracts.usdcSac,
        caps: ops.caps,
        fees: {
          firstXlm: xlm(params.fees.firstPullMaxFeeStroops),
          laterXlm: xlm(params.fees.pullMaxFeeStroops),
          ownerXlm: xlm(params.fees.ownerMaxFeeStroops),
        },
        rentFactor,
        welcomeFunding: params.name === 'testnet',
        inviteCodes: yield* inviteCodes,
      }
    }),
  )

  /** On the fixture chain: testnet, caps from the same config names A2 reads. */
  static readonly fixture = Layer.effect(
    Network,
    Effect.gen(function* () {
      return {
        name: 'testnet' as const,
        caip: 'stellar:testnet' as const,
        label: 'Testnet' as const,
        explorerBase: 'https://stellar.expert/explorer/testnet',
        usdcSac: USDC_SAC,
        caps: {
          maxGrantStroops: yield* usdc('MAX_GRANT_USDC', '20'),
          maxOwnerPaymentStroops: yield* usdc('MAX_OWNER_PAYMENT_USDC', '100'),
          maxX402PriceStroops: yield* usdc('MAX_X402_PRICE_USDC', '1'),
          paymentsEnabled: yield* Config.Boolean('PAYMENTS_ENABLED').pipe(Config.withDefault(true)),
        },
        fees: {
          firstXlm: FEE_CEILING_FIRST_PAYMENT_XLM,
          laterXlm: FEE_CEILING_LATER_PAYMENT_XLM,
          ownerXlm: FEE_CEILING_OWNER_PAYMENT_XLM,
        },
        rentFactor: Effect.succeed(null),
        welcomeFunding: true,
        inviteCodes: yield* inviteCodes,
      }
    }),
  )
}

const xlm = (stroops: bigint) => Number(stroops) / 1e7

const usdc = (name: string, fallback: string) =>
  Config.String(name).pipe(
    Config.withDefault(fallback),
    Config.map(text => toStroops(text.trim())),
  )

const inviteCodes = Config.String('INVITE_CODES').pipe(
  Config.withDefault(''),
  Config.map(text =>
    text
      .split(',')
      .map(code => code.trim())
      .filter(code => code !== ''),
  ),
)

/**
 * XLM of fee per unit of rent factor, measured on testnet 25 Oct at 96×: a grant's first pull needed 41–51 XLM (0.53
 * per unit), a later 2 USDC payment 15.3 XLM (0.16). The multipliers leave ~50 % headroom.
 */
const XLM_PER_RENT_UNIT = { first: 0.8, later: 0.25 }
/** Never authorize more than this for one transfer, whatever the rent does. */
const HARD_MAX_TRANSFER_XLM = 250

/**
 * The fee ceiling (stroops) for a delegated transfer: the configured ceiling (the grant's first transfer extends rent
 * on the rule and costs most), raised to follow the live rent factor so a rent spike does not stop payments, capped.
 */
export const transferFeeCeiling = (network: NetworkShape, firstDone: boolean) =>
  Effect.map(network.rentFactor, factor => {
    const configured = firstDone ? network.fees.laterXlm : network.fees.firstXlm
    const following = factor === null ? 0 : factor * (firstDone ? XLM_PER_RENT_UNIT.later : XLM_PER_RENT_UNIT.first)
    const ceiling = Math.min(Math.max(configured, following), HARD_MAX_TRANSFER_XLM)
    return BigInt(Math.round(ceiling * 1e7))
  })

/** Mainnet: wallet creation needs an invite code (none configured = creation closed). */
export const inviteRequired = (network: NetworkShape) => network.name === 'pubnet'
