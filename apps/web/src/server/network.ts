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

/** Mainnet: wallet creation needs an invite code (none configured = creation closed). */
export const inviteRequired = (network: NetworkShape) => network.name === 'pubnet'
